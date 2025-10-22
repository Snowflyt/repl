// TypeScript Language Service Worker via @typescript/vfs
import { setupTypeAcquisition } from "@typescript/ata";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import * as ts from "typescript";

let env: ReturnType<typeof createVirtualTypeScriptEnvironment> | null = null;
let initialized = false;
let envInitPromise: Promise<void> | null = null;
let ataRunner: ReturnType<typeof setupTypeAcquisition> | null = null;
let ataInFlight: Promise<void> | null = null;
let ataResolve: (() => void) | null = null;
let ataDownloadCount = 0;
let ataPackagesInRun = new Set<string>();
const lastAtaSourceImports: string[] = [];

// Virtual filenames (use leading slash to align with vfs defaults)
// Single module file that contains history + current input
const REPL_FILE = "/repl.ts";

// Keep latest materialized history text and last user code
let historyText = "";
let lastCode = "";
let codeBaseOffset = 0; // where user code starts inside REPL_FILE

// Unicode-aware identifier character check (roughly aligns with ECMAScript ID_Continue)
const IDENT_CHAR_RE = /[\p{ID_Continue}$_]/u;
function isIdentChar(ch: string): boolean {
  if (!ch) return false;
  return IDENT_CHAR_RE.test(ch);
}

// Parse a package spec which may include a version/tag, e.g. "lodash@4.17.21" or "@scope/pkg@beta"
function parsePackageAndVersion(spec: string): { name: string; version: string | null } {
  // Relative or absolute path: not a bare package
  if (!spec || spec.startsWith(".") || spec.startsWith("/")) return { name: spec, version: null };

  // Helper to parse patterns like:
  //  - name@ver
  //  - name@ver/subpath
  //  - @scope/name@ver
  //  - @scope/name@ver/subpath
  const parseUnscoped = (): { name: string; version: string | null } => {
    const atIdx = spec.indexOf("@");
    const firstSlash = spec.indexOf("/");
    // No version marker before first slash -> no version
    if (atIdx <= 0 || (firstSlash !== -1 && atIdx > firstSlash))
      return { name: spec, version: null };
    const nextSlash = spec.indexOf("/", atIdx + 1);
    const version = spec.slice(atIdx + 1, nextSlash === -1 ? spec.length : nextSlash) || null;
    const subpath = nextSlash === -1 ? "" : spec.slice(nextSlash);
    const base = spec.slice(0, atIdx);
    return { name: base + subpath, version };
  };

  const parseScoped = (): { name: string; version: string | null } => {
    // @scope/name[@ver][/subpath]
    const slashAfterScope = spec.indexOf("/", 1);
    if (slashAfterScope === -1) return { name: spec, version: null }; // malformed, treat as no version
    // Look for '@' starting from the package name (after scope/)
    const atIdx = spec.indexOf("@", slashAfterScope + 1);
    const firstSlashAfterName = spec.indexOf("/", slashAfterScope + 1);
    if (atIdx === -1 || (firstSlashAfterName !== -1 && atIdx > firstSlashAfterName))
      return { name: spec, version: null };
    const nextSlash = spec.indexOf("/", atIdx + 1);
    const version = spec.slice(atIdx + 1, nextSlash === -1 ? spec.length : nextSlash) || null;
    const subpath = nextSlash === -1 ? "" : spec.slice(nextSlash);
    const base = spec.slice(0, atIdx); // @scope/name
    return { name: base + subpath, version };
  };

  if (spec.startsWith("@")) return parseScoped();
  return parseUnscoped();
}

// Rewrite versioned imports to bare specifiers and attach inline ATA version comments: // types: <version>
function rewriteCodeForAta(code: string): { code: string; packages: string[] } {
  const packages = new Set<string>();
  const toBasePackage = (name: string): string => {
    if (!name) return name;
    if (name.startsWith("@")) {
      const parts = name.split("/");
      return parts.length >= 2 ? parts[0]! + "/" + parts[1]! : name;
    }
    return name.split("/")[0] ?? name;
  };
  // Static import/export ... from "spec"
  const reStatic = /(\b(?:import|export)\s+[^;]*?\sfrom\s+)(["'])([^"']+)(\2)/g;
  code = code.replace(reStatic, (_m, pre: string, q: string, spec: string, q2: string) => {
    const { name, version } = parsePackageAndVersion(spec);
    if (name && !name.startsWith(".") && !name.startsWith("/")) packages.add(toBasePackage(name));
    if (!version) return pre + q + spec + q2;
    // Append end-of-line comment for ATA version
    return pre + q + name + q2 + " // types: " + version;
  });
  // Dynamic import("spec")
  const reDyn = /(\bimport\s*\(\s*)(["'])([^"']+)(\2)(\s*\))/g;
  code = code.replace(
    reDyn,
    (_m, pre: string, q: string, spec: string, _q2: string, post: string) => {
      const { name, version } = parsePackageAndVersion(spec);
      if (name && !name.startsWith(".") && !name.startsWith("/")) packages.add(toBasePackage(name));
      if (!version) return pre + q + spec + q + post;
      return pre + q + name + q + post + " // types: " + version;
    },
  );
  // require("spec")
  const reReq = /(\brequire\s*\(\s*)(["'])([^"']+)(\2)(\s*\))/g;
  code = code.replace(
    reReq,
    (_m, pre: string, q: string, spec: string, _q2: string, post: string) => {
      const { name, version } = parsePackageAndVersion(spec);
      if (name && !name.startsWith(".") && !name.startsWith("/")) packages.add(toBasePackage(name));
      if (!version) return pre + q + spec + q + post;
      return pre + q + name + q + post + " // types: " + version;
    },
  );
  return { code, packages: Array.from(packages) };
}

// Write a file into the in-memory VFS with an updateFile-first strategy
function writeVfs(file: string, content: string) {
  if (!env) return;
  if (typeof env.updateFile === "function")
    try {
      env.updateFile(file, content);
      return;
    } catch (e) {
      // Fall through to sys.writeFile
    }
  env.sys.writeFile(file, content);
}

// Ensure the REPL module file is a root script in the LS program
function ensureModuleRegistered(): void {
  if (!env) return;
  const content = env.sys.readFile(REPL_FILE) ?? "export {};\n\n";
  // Ensure it exists on the VFS
  if (!env.sys.fileExists(REPL_FILE)) writeVfs(REPL_FILE, content);
  // Ensure it's part of the program's root set
  // Build program for side effects
  const has = env.languageService.getProgram()?.getSourceFile(REPL_FILE);
  if (!has) writeVfs(REPL_FILE, content);
}

// Materialize a single script file from history keeping only the latest top-level declaration per name
// This yields precise types from real initializers while avoiding duplicate identifier errors
function buildEnvFromSnippets(snippets: string[]): string {
  const header = `// Generated from history snippets (${snippets.length})\n`;
  type Decl = { text: string; order: number };
  // Separate spaces to avoid clobbering type vs value declarations with same name
  const valueDecls = new Map<string, Decl>();
  const typeDecls = new Map<string, Decl>();
  // Import consolidation: track last-wins per local identifier across all modules,
  // and then emit merged import declarations per module.
  type ImportNamed = {
    local: string;
    imported: string; // source name (without alias)
    isTypeOnly: boolean; // specifier-level type flag
    order: number;
  };
  type ImportDefault = { local: string; isTypeOnly: boolean; order: number };
  type ImportNamespace = { local: string; isTypeOnly: boolean; order: number };
  type ModuleRecord = {
    module: string;
    named: ImportNamed[];
    defaults: ImportDefault[];
    namespaces: ImportNamespace[];
    sideEffectOrder: number | null;
    firstOrder: number | null;
  };
  const importsByModule = new Map<string, ModuleRecord>();
  // Map of local identifier -> reference to remove previous occurrence when shadowed by later imports
  const localToModule = new Map<
    string,
    { module: string; kind: "named" | "default" | "namespace" }
  >();
  const ensureModuleRecord = (mod: string): ModuleRecord => {
    let rec = importsByModule.get(mod);
    if (!rec) {
      rec = {
        module: mod,
        named: [],
        defaults: [],
        namespaces: [],
        sideEffectOrder: null,
        firstOrder: null,
      };
      importsByModule.set(mod, rec);
    }
    return rec;
  };
  let order = 0;

  // Helper: stringify a node's source from a given source file
  const slice = (sf: ts.SourceFile, code: string, node: ts.Node) =>
    code.slice(node.getStart(sf), node.getEnd());

  for (let i = 0; i < snippets.length; i++) {
    const code = snippets[i] ?? "";
    if (!code.trim()) continue;
    const sf = ts.createSourceFile(`/env/snippet_${i}.ts`, code, ts.ScriptTarget.ESNext, true);
    for (const node of sf.statements) {
      // Preserve import declarations for type acquisition and module symbol resolution (last-wins per module)
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          const mod = node.moduleSpecifier.text;
          const rec = ensureModuleRecord(mod);
          const importClause = node.importClause;
          // Track side-effect imports (import "mod");)
          if (!importClause) {
            rec.sideEffectOrder = ++order;
            if (rec.firstOrder === null) rec.firstOrder = rec.sideEffectOrder;
            continue;
          }
          const clauseIsTypeOnly = ts.isTypeOnlyImportOrExportDeclaration(node);
          // Default import
          if (importClause.name && ts.isIdentifier(importClause.name)) {
            const local = importClause.name.text;
            // Remove any previous local with same name (last-wins across modules)
            const prev = localToModule.get(local);
            if (prev) {
              const prevRec = importsByModule.get(prev.module);
              if (prevRec) {
                switch (prev.kind) {
                  case "default":
                    prevRec.defaults = prevRec.defaults.filter((d) => d.local !== local);
                    break;
                  case "named":
                    prevRec.named = prevRec.named.filter((n) => n.local !== local);
                    break;
                  case "namespace":
                    prevRec.namespaces = prevRec.namespaces.filter((n) => n.local !== local);
                    break;
                }
              }
            }
            const def: ImportDefault = { local, isTypeOnly: clauseIsTypeOnly, order: ++order };
            rec.defaults.push(def);
            rec.firstOrder =
              rec.firstOrder === null ? def.order : Math.min(rec.firstOrder, def.order);
            localToModule.set(local, { module: mod, kind: "default" });
          }
          // Named or namespace
          const nb = importClause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) {
            const local = nb.name.text;
            const prev = localToModule.get(local);
            if (prev) {
              const prevRec = importsByModule.get(prev.module);
              if (prevRec) {
                switch (prev.kind) {
                  case "default":
                    prevRec.defaults = prevRec.defaults.filter((d) => d.local !== local);
                    break;
                  case "named":
                    prevRec.named = prevRec.named.filter((n) => n.local !== local);
                    break;
                  case "namespace":
                    prevRec.namespaces = prevRec.namespaces.filter((n) => n.local !== local);
                    break;
                }
              }
            }
            const ns: ImportNamespace = { local, isTypeOnly: clauseIsTypeOnly, order: ++order };
            rec.namespaces.push(ns);
            rec.firstOrder =
              rec.firstOrder === null ? ns.order : Math.min(rec.firstOrder, ns.order);
            localToModule.set(local, { module: mod, kind: "namespace" });
          } else if (nb && ts.isNamedImports(nb)) {
            for (const specifier of nb.elements) {
              const local = specifier.name.text;
              const imported =
                specifier.propertyName ? specifier.propertyName.text : specifier.name.text;
              const isTypeOnly = (specifier as any).isTypeOnly === true || clauseIsTypeOnly;
              const prev = localToModule.get(local);
              if (prev) {
                const prevRec = importsByModule.get(prev.module);
                if (prevRec) {
                  switch (prev.kind) {
                    case "default":
                      prevRec.defaults = prevRec.defaults.filter((d) => d.local !== local);
                      break;
                    case "named":
                      prevRec.named = prevRec.named.filter((n) => n.local !== local);
                      break;
                    case "namespace":
                      prevRec.namespaces = prevRec.namespaces.filter((n) => n.local !== local);
                      break;
                  }
                }
              }
              const named: ImportNamed = { local, imported, isTypeOnly, order: ++order };
              rec.named.push(named);
              rec.firstOrder =
                rec.firstOrder === null ? named.order : Math.min(rec.firstOrder, named.order);
              localToModule.set(local, { module: mod, kind: "named" });
            }
          }
          continue;
        }
      }
      // Variables
      if (ts.isVariableStatement(node)) {
        const flags = ts.getCombinedNodeFlags(node.declarationList);
        const kind =
          flags & ts.NodeFlags.Const ? "const"
          : flags & ts.NodeFlags.Let ? "let"
          : "var";
        for (const d of node.declarationList.declarations) {
          // Simple identifier declaration: keep as-is
          if (ts.isIdentifier(d.name)) {
            const name = d.name.text;
            const declText = code.slice(d.getStart(sf), d.getEnd()); // name[=initializer]
            const full = `${kind} ${declText};`;
            valueDecls.set(name, { text: full, order: ++order });
            continue;
          }
          // Destructuring: extract each bound identifier via a block IIFE that uses the full pattern
          if (
            (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) &&
            d.initializer
          ) {
            const rhs = `(${slice(sf, code, d.initializer)})`;
            const pattern = slice(sf, code, d.name);
            const leafNames: string[] = [];
            const collectNames = (name: ts.BindingName) => {
              if (ts.isIdentifier(name)) {
                leafNames.push(name.text);
              } else if (ts.isObjectBindingPattern(name)) {
                for (const el of name.elements) collectNames(el.name);
              } else if (ts.isArrayBindingPattern(name)) {
                for (const el of name.elements) {
                  if (ts.isOmittedExpression(el)) continue;
                  if (ts.isBindingElement(el)) collectNames(el.name);
                }
              }
            };
            collectNames(d.name);
            for (const nm of leafNames) {
              const full = `${kind} ${nm} = (() => { const ${pattern} = ${rhs}; return ${nm}; })();`;
              valueDecls.set(nm, { text: full, order: ++order });
            }
          }
        }
      }
      // Functions / Classes
      else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        const name = node.name.text;
        const full = code.slice(node.getStart(sf), node.getEnd());
        valueDecls.set(name, { text: full, order: ++order });
      }
      // Types: type aliases and interfaces (lives in type space)
      else if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        ts.isIdentifier(node.name)
      ) {
        const name = node.name.text;
        const full = code.slice(node.getStart(sf), node.getEnd());
        typeDecls.set(name, { text: full, order: ++order });
      }
      // Top-level global assignments: window.foo = ..., globalThis.bar = ...
      else if (
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.expression.left)
      ) {
        const pae = node.expression.left;
        if (
          ts.isIdentifier(pae.expression) &&
          (pae.expression.text === "window" || pae.expression.text === "globalThis")
        ) {
          const name = pae.name.text;
          const rhs = slice(sf, code, node.expression.right);
          const full = `const ${name} = (${rhs});`;
          valueDecls.set(name, { text: full, order: ++order });
        }
      }
    }
  }

  // Combine both spaces and preserve original encounter order
  const ordered = Array.from(
    (function* () {
      for (const v of valueDecls.values()) yield v;
      for (const t of typeDecls.values()) yield t;
    })(),
  ).sort((a, b) => a.order - b.order);
  // Join fragments with newlines
  const body = ordered.length ? ordered.map((d) => d.text).join("\n") + "\n" : "";
  // Emit consolidated imports
  const emitImports = (): string => {
    if (importsByModule.size === 0) return "";
    // Sort modules by firstOrder for stable output
    const modules = Array.from(importsByModule.values()).sort((a, b) => {
      const ao = a.firstOrder ?? 0;
      const bo = b.firstOrder ?? 0;
      return ao - bo;
    });
    const lines: string[] = [];
    for (const rec of modules) {
      // Sort internal lists by order for predictability
      rec.named.sort((a, b) => a.order - b.order);
      rec.defaults.sort((a, b) => a.order - b.order);
      rec.namespaces.sort((a, b) => a.order - b.order);

      // Named specifiers can be combined into a single declaration; allow per-item `type` modifiers
      const namedPart =
        rec.named.length ?
          (() => {
            const specs = rec.named
              .map((n) => {
                const head = n.isTypeOnly ? "type " : "";
                const body = n.imported !== n.local ? `${n.imported} as ${n.local}` : n.local;
                return head + body;
              })
              .join(", ");
            return `{ ${specs} }`;
          })()
        : "";

      // A non-type-only default can be combined with named specifiers in one statement.
      // Keep at most one such combination; remaining defaults are emitted standalone.
      let combinedDefaultUsed: ImportDefault | null = null;
      if (namedPart) {
        const def = rec.defaults.find((d) => !d.isTypeOnly) || null;
        if (def) {
          lines.push(`import ${def.local}, ${namedPart} from ${JSON.stringify(rec.module)}`);
          combinedDefaultUsed = def;
        } else {
          lines.push(`import ${namedPart} from ${JSON.stringify(rec.module)}`);
        }
      }

      // Standalone defaults (including type-only or those not combined)
      for (const d of rec.defaults) {
        if (combinedDefaultUsed && !d.isTypeOnly && d === combinedDefaultUsed) {
          continue;
        }
        // If this default was used in combined, skip it; else emit.
        if (!combinedDefaultUsed || d.isTypeOnly) {
          const kw = d.isTypeOnly ? "import type" : "import";
          lines.push(`${kw} ${d.local} from ${JSON.stringify(rec.module)}`);
        }
      }

      // Namespace imports (cannot combine with others)
      for (const ns of rec.namespaces) {
        const kw = ns.isTypeOnly ? "import type" : "import";
        lines.push(`${kw} * as ${ns.local} from ${JSON.stringify(rec.module)}`);
      }

      // Side-effect import (only if there were no other imports for this module)
      const hasAny = rec.named.length > 0 || rec.defaults.length > 0 || rec.namespaces.length > 0;
      if (!hasAny && rec.sideEffectOrder !== null) {
        lines.push(`import ${JSON.stringify(rec.module)}`);
      }
    }
    return lines.length ? lines.join("\n") + "\n\n" : "";
  };
  const importsBlock = emitImports();
  return header + importsBlock + body;
}

async function ensureEnv(): Promise<void> {
  if (initialized && env) return;
  if (envInitPromise) {
    await envInitPromise;
    return;
  }

  envInitPromise = (async () => {
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      lib: ["ESNext", "DOM", "DOM.Iterable"],
      allowJs: true,
      checkJs: false,
      skipLibCheck: true,
      noEmit: true,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      moduleDetection: ts.ModuleDetectionKind.Force,
    };
    // Build an FS map with the correct lib files for the current TS version/options
    // Wrap fetcher to emit progress notifications similar to ATA
    let libFetchCount = 0;
    let libStarted = false;
    const notifyLib = (
      phase: "started" | "progress" | "finished",
      extra?: Record<string, unknown>,
    ) => {
      try {
        (self as unknown as Worker).postMessage({
          scope: "completion",
          event: "lib-download",
          data: { phase, ...(extra ?? {}) },
        });
      } catch {
        // ignore
      }
    };
    const wrappedFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!libStarted) {
        libStarted = true;
        notifyLib("started");
      }
      const res = await fetch(input as any, init);
      libFetchCount++;
      notifyLib("progress", { filesReceived: libFetchCount });
      return res;
    };
    const fsMap = await createDefaultMapFromCDN(
      compilerOptions,
      ts.version,
      false,
      ts,
      undefined,
      wrappedFetch,
    );
    notifyLib("finished", { filesReceived: libFetchCount, success: true });
    // Ensure lib.d.ts contains the full ESNext lib content to provide global types
    let libSource: string | null = null;
    if (fsMap.has("/lib.esnext.full.d.ts")) libSource = fsMap.get("/lib.esnext.full.d.ts")!;
    if (libSource) fsMap.set("/lib.d.ts", libSource);
    // Ensure REPL file exists from the start
    if (!fsMap.has(REPL_FILE)) fsMap.set(REPL_FILE, "export {};\n\n");

    const system = createSystem(fsMap);
    env = createVirtualTypeScriptEnvironment(system, Array.from(fsMap.keys()), ts, compilerOptions);

    initialized = true;
  })();

  try {
    await envInitPromise;
  } finally {
    envInitPromise = null;
  }
  // Initialize ATA once the env is ready
  initATA();
  // Guarantee REPL file is registered as a root
  ensureModuleRegistered();
}

// Build and write the combined module (history + code) to REPL_FILE
function writeIndex(content: string) {
  if (!env) return;
  lastCode = content;
  const header = "export {};\n"; // mark as module to avoid global pollution (e.g., window.name)
  // Rewrite versioned imports in history to bare specifiers plus inline ATA comments
  const histRewritten = historyText ? rewriteCodeForAta(historyText).code : "";
  const hist = histRewritten ? histRewritten + "\n" : "";
  const sep = hist ? "\n" : "";
  const combined = header + hist + sep + content;
  codeBaseOffset = header.length + hist.length + sep.length;
  writeVfs(REPL_FILE, combined);
}

function initATA() {
  if (!env || ataRunner) return;
  // Normalize ATA file paths into /node_modules/* to align with TS module resolution
  const normalizeAtaPath = (path: string): string => {
    let p = path.startsWith("/") ? path : "/" + path;
    if (!p.includes("/node_modules/")) {
      // Ensure files live under /node_modules for module resolver
      p = "/node_modules" + (p.startsWith("/") ? "" : "/") + p.replace(/^\/+/, "");
    }
    return p;
  };
  const pkgFromPath = (path: string): string => {
    const p = normalizeAtaPath(path);
    const base = "/node_modules/";
    const idx = p.indexOf(base);
    if (idx === -1) return "";
    const rest = p.slice(idx + base.length);
    const parts = rest.split("/");
    if (parts.length === 0) return "";
    const first = parts[0] ?? "";
    if (first.startsWith("@") && parts.length >= 2) return first + "/" + (parts[1] ?? "");
    return first;
  };
  ataRunner = setupTypeAcquisition({
    projectName: "repl-completion",
    typescript: ts,
    logger: console,
    delegate: {
      receivedFile: (code: string, path: string) => {
        const norm = normalizeAtaPath(path);
        ataDownloadCount++;
        const pkg = pkgFromPath(norm);
        if (pkg) ataPackagesInRun.add(pkg);
        if (ataDownloadCount <= 5)
          console.log(`[completion:ata] [${pkg || "<unknown>"}] Received ${norm}`);
        if (ataDownloadCount === 6)
          console.log(`[completion:ata] ...more files received, suppressing log output`);
        writeVfs(norm, code);
        try {
          (self as unknown as Worker).postMessage({
            scope: "completion",
            event: "ata",
            data: {
              phase: "progress",
              filesReceived: ataDownloadCount,
              currentPackage: pkg || null,
              packagesSoFar: Array.from(ataPackagesInRun),
            },
          });
        } catch (e) {
          // Ignore post errors
        }
      },
      started: () => {
        if (!ataInFlight) {
          ataInFlight = new Promise<void>((resolve) => {
            ataResolve = resolve;
          });
        }
        ataPackagesInRun = new Set<string>();
        const pkgs = lastAtaSourceImports.length ? lastAtaSourceImports.join(", ") : "<none>";
        console.log(`[completion:ata] Start auto type acquisition for packages: ${pkgs}`);
        try {
          (self as unknown as Worker).postMessage({
            scope: "completion",
            event: "ata",
            data: {
              phase: "started",
              packages: lastAtaSourceImports.slice(),
            },
          });
        } catch (e) {
          // Ignore post errors
        }
      },
      finished: (vfs) => {
        // Ensure all files in VFS are present
        vfs.forEach((content: string, p: string) => {
          const norm = normalizeAtaPath(p);
          writeVfs(norm, content);
        });
        const pkgLine = Array.from(ataPackagesInRun).join(", ") || "<none>";
        console.log(`[completion:ata] Received ${ataDownloadCount} files for packages: ${pkgLine}`);
        ataResolve?.();
        ataResolve = null;
        ataInFlight = null;
        try {
          (self as unknown as Worker).postMessage({
            scope: "completion",
            event: "ata",
            data: {
              phase: "finished",
              filesReceived: ataDownloadCount,
              packages: Array.from(ataPackagesInRun),
              success: true,
            },
          });
        } catch (e) {
          // Ignore
        }
      },
    },
  });
}

function getCompletions(cursor: number) {
  if (!env) return { items: [] };
  // Make sure the index files are part of the program before asking LS
  ensureModuleRegistered();
  const ls = env.languageService;
  const idxFile = REPL_FILE;
  let info: ts.WithMetadata<ts.CompletionInfo> | undefined;
  const opts = {
    includeCompletionsWithInsertText: true,
    includeAutomaticOptionalChainCompletions: true,
    includeExternalModuleExports: false,
  } satisfies ts.GetCompletionsAtPositionOptions;
  try {
    const pos = codeBaseOffset + cursor;
    info = ls.getCompletionsAtPosition(idxFile, pos, opts) ?? undefined;
  } catch (e) {
    // LS can throw for incomplete or broken trees; return empty
    return { items: [] };
  }
  if (!info) return { items: [] };
  const allEntries = info.entries;
  // If we can identify a receiver via AST/type-checker, restrict to its properties
  // Otherwise, if we appear to be in a member context (after '.'), restrict to member-like kinds
  let entries = allEntries;
  // Fallback replacement span derived from the typed prefix
  let derivedReplacement: { start: number; length: number } | null = null;
  try {
    const src = env.sys.readFile(idxFile) ?? "";
    // Compute identifier prefix at the cursor (bounded within user code region)
    const pos = codeBaseOffset + cursor;
    let start = Math.max(codeBaseOffset, pos);
    while (start > codeBaseOffset) {
      const c = src.charCodeAt(start - 1);
      const isIdent =
        (c >= 48 && c <= 57) /* 0-9 */ ||
        (c >= 65 && c <= 90) /* A-Z */ ||
        c === 95 /* _ */ ||
        c === 36 /* $ */ ||
        (c >= 97 && c <= 122); /* a-z */
      if (!isIdent) break;
      start--;
    }
    const prefix = src.slice(start, pos);
    if (prefix.length > 0) {
      derivedReplacement = { start: start - codeBaseOffset, length: prefix.length };
    }
    // Determine if we're in member context: scan directly from cursor left for a '.'
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j]!)) j--;
    const looksLikeMember = src[j] === "." || info.isMemberCompletion;
    const program = ls.getProgram();
    const sf = program?.getSourceFile(idxFile);
    const checker = program?.getTypeChecker();
    let receiver: ts.Node | null = null;
    if (sf && checker) {
      // Find the deepest node containing position-1
      const ppos = Math.max(0, pos - 1);
      let found: ts.Node | undefined;
      const visit = (node: ts.Node) => {
        const { end: b, pos: a } = node;
        if (ppos >= a && ppos < b) {
          found = node;
          node.forEachChild(visit);
        }
      };
      sf.forEachChild(visit);
      const parent = found && (found as ts.Node & { parent?: ts.Node }).parent;
      if (
        parent &&
        (ts.isPropertyAccessExpression(parent) || (ts as any).isPropertyAccessChain?.(parent))
      ) {
        receiver = (parent as ts.PropertyAccessExpression).expression;
      } else if (parent && ts.isQualifiedName(parent)) {
        receiver = parent.left;
      }
      // If not found, heuristically try previous token's parent
      const p2 = found && (found as ts.Node & { parent?: ts.Node }).parent;
      if (!receiver && p2 && ts.isPropertyAccessExpression(p2)) {
        receiver = p2.expression;
      }
    }
    if (checker) {
      if (receiver) {
        const type = checker.getTypeAtLocation(receiver);
        const apparent = checker.getApparentType(type);
        const names = new Set<string>();
        for (const s of checker.getPropertiesOfType(type)) names.add(s.getName());
        for (const s of checker.getPropertiesOfType(apparent)) names.add(s.getName());
        entries =
          names.size > 0 ?
            allEntries.filter((e) => names.has(e.name))
            // Keep LS results as-is for member access when we cannot resolve a receiver's properties
            // This preserves namespace/module member completion (e.g., Effect.function)
          : allEntries;
      } else if (looksLikeMember) {
        // Without a resolvable receiver, do not over-filter member completion
        entries = allEntries;
      }
    }
    // Apply prefix filter when there is an identifier being typed
    if (prefix) entries = entries.filter((e) => e.name.startsWith(prefix));
  } catch (e) {
    // Filtering is best-effort; ignore errors
  }

  const items = entries.map((e) => {
    let detail: string | undefined;
    const insertText = e.insertText;
    let replacement: { start: number; length: number } | null = null;
    if (e.replacementSpan) {
      const rs = e.replacementSpan;
      replacement =
        rs.start >= codeBaseOffset ?
          { start: rs.start - codeBaseOffset, length: rs.length }
        : derivedReplacement;
    } else if (derivedReplacement) {
      replacement = derivedReplacement;
    }
    return {
      label: e.name,
      kind: e.kind,
      sortText: e.sortText,
      detail,
      insertText,
      replacement,
      source: e.source,
    };
  });
  return { items };
}

function applyMultilineHeuristics(text: string): string {
  if (!text) return text;
  let s = text;
  s = s.replace(/\{( {4,})/g, (_m, spaces: string) => "{\n" + spaces);
  s = s.replace(/;( {4,})/g, (_m, spaces: string) => ";\n" + spaces);
  s = s.replace(/;}/g, ";\n}");
  return s;
}

const handlers = {
  async init() {
    await ensureEnv();
    // Ensure placeholder REPL file exists
    if (!env!.sys.fileExists(REPL_FILE)) writeVfs(REPL_FILE, "export {};\n\n");
    ensureModuleRegistered();
    return true;
  },

  async typeOf({ expr }: { expr: string }) {
    await ensureEnv();
    // Build a synthetic type alias to evaluate a type-level expression provided by the user
    // Users will pass a type expression (use 'typeof foo' for value expressions):
    //   type __repl_type_result___ = <type expr>;
    const wrapperName = "__repl_type_result___";
    const asType = `type ${wrapperName} = ${expr};`;
    writeIndex(asType);
    ensureModuleRegistered();
    // Trigger ATA for any bare imports present in the combined module content
    if (ataRunner) {
      const combined = env!.sys.readFile(REPL_FILE) ?? asType;
      const { code: ataCode, packages } = rewriteCodeForAta(combined);
      if (packages.length > 0) {
        lastAtaSourceImports.splice(0, lastAtaSourceImports.length, ...packages);
        try {
          await ataRunner(ataCode);
        } catch (e) {
          // Log and continue; type info for external packages may be partial
          console.error("[completion:ata] runner error", e);
        }
        // If an ATA run is in-flight, wait for it to settle so we can provide accurate types
        if (ataInFlight)
          try {
            await ataInFlight;
          } catch (e) {
            // Ignore
          } finally {
            ensureModuleRegistered();
          }
      } else {
        lastAtaSourceImports.splice(0, lastAtaSourceImports.length);
      }
    }
    // Helper to extract type text for current REPL_FILE by inspecting the alias node directly
    const extractTypeText = (): string => {
      const ls = env!.languageService;
      const program = ls.getProgram();
      const sf = program?.getSourceFile(REPL_FILE);
      if (!sf) return "";
      const checker = program!.getTypeChecker();
      let typeText = "";
      sf.forEachChild((node) => {
        if (ts.isTypeAliasDeclaration(node) && ts.isIdentifier(node.name)) {
          if (node.name.text === wrapperName) {
            try {
              const t = checker.getTypeFromTypeNode(node.type);
              typeText = applyMultilineHeuristics(
                checker.typeToString(
                  t,
                  node,
                  ts.TypeFormatFlags.NoTruncation |
                    ts.TypeFormatFlags.UseFullyQualifiedType |
                    ts.TypeFormatFlags.MultilineObjectLiterals |
                    ts.TypeFormatFlags.InTypeAlias,
                ),
              );
            } catch (e) {
              // ignore
            }
          }
        }
      });
      return (typeText || "").trim();
    };

    // Extract the resolved type from the synthetic type alias, without any typeof fallback
    try {
      const ls = env!.languageService;
      const program = ls.getProgram();
      const sf = program?.getSourceFile(REPL_FILE);
      if (!sf) return { type: "<unknown>" } as const;
      const typeText = extractTypeText();
      return { type: typeText || "<unknown>" } as const;
    } catch (e) {
      return { type: "<unknown>" } as const;
    }
  },

  async updateHistory({ snippets }: { snippets: string[] }) {
    await ensureEnv();
    const envText = buildEnvFromSnippets(snippets);
    historyText = envText;
    // Log once for visibility when history materializes
    // Print the rewritten version so versioned imports appear as inline ATA comments instead of pkg@ver
    const envTextForLog = rewriteCodeForAta(envText).code;
    console.log("[completion:history]\n" + envTextForLog);
    // Refresh combined with last code so LS sees latest history immediately
    writeIndex(lastCode);
    // Proactively trigger ATA after history changes so third-party types are acquired on import
    if (ataRunner) {
      const combined = env!.sys.readFile(REPL_FILE) ?? lastCode;
      const { code: ataCode, packages } = rewriteCodeForAta(combined);
      if (packages.length > 0) {
        lastAtaSourceImports.splice(0, lastAtaSourceImports.length, ...packages);
        Promise.resolve()
          .then(() => ataRunner!(ataCode))
          .catch((e: unknown) => console.error("[completion:ata] runner error", e));
      } else {
        lastAtaSourceImports.splice(0, lastAtaSourceImports.length);
      }
    }
    return true;
  },

  async complete({ code, cursor }: { code: string; cursor: number }) {
    await ensureEnv();
    // Put code as index file (keep cursor offsets consistent with UI)
    writeIndex(code);
    ensureModuleRegistered();
    // Kick ATA on demand to resolve third-party types from import specifiers
    if (ataRunner) {
      const combined = env!.sys.readFile(REPL_FILE) ?? code;
      const { code: ataCode, packages } = rewriteCodeForAta(combined);
      if (packages.length > 0) {
        lastAtaSourceImports.splice(0, lastAtaSourceImports.length, ...packages);
        // Fire-and-forget ATA; swallow errors via catch to avoid lint complaints
        Promise.resolve()
          // Pass the combined module content so imports from history are included
          .then(() => ataRunner!(ataCode))
          .catch((e: unknown) => {
            console.error("[completion:ata] runner error", e);
          });
      } else {
        lastAtaSourceImports.splice(0, lastAtaSourceImports.length);
      }
    }
    return getCompletions(cursor);
  },

  async resolveDetail({
    code,
    cursor,
    name,
    source,
  }: {
    code: string;
    cursor: number;
    name: string;
    source?: string;
  }) {
    await ensureEnv();
    writeIndex(code);
    ensureModuleRegistered();
    const ls = env!.languageService;
    const idxFile = REPL_FILE;
    try {
      const posForDetails = codeBaseOffset + cursor;
      const det =
        ls.getCompletionEntryDetails(
          idxFile,
          posForDetails,
          name,
          undefined,
          source,
          undefined,
          undefined,
        ) ?? undefined;
      if (!det) return { detail: undefined, documentation: undefined };
      const detail = det.displayParts.map((p) => p.text).join("");
      const toText = (t: string | readonly ts.SymbolDisplayPart[] | undefined): string => {
        if (!t) return "";
        if (typeof t === "string") return t;
        return t.map((p) => p.text).join("");
      };
      const stripLeadingSep = (s: string): string =>
        (s || "")
          .trim()
          .replace(/^(?:[-\u2013\u2014:\u2012]\s*)+/, "")
          .trim();
      const docSummary = det.documentation?.map((p) => p.text).join("") ?? "";
      // Convert JSDoc tags into a Markdown block so the renderer can display params/examples/etc.
      const tags = det.tags ?? [];
      const paramItems: string[] = [];
      const templateItems: string[] = [];
      const throwsItems: string[] = [];
      const otherLines: string[] = [];
      const exampleBlocks: string[] = [];
      const returnsLines: string[] = [];

      for (const tag of tags) {
        const name = tag.name.toLowerCase();
        const text = toText(tag.text as any).trim();
        if (name === "param") {
          // Attempt to split into name and description, common shapes:
          // "foo – description", "foo - description", or "foo description"
          let paramName = "";
          let desc = "";
          const m = /^(\S+)\s*(?:[-\u2014\u2013:\u2012]\s*)?(.*)$/.exec(text);
          if (m) {
            paramName = m[1] ?? "";
            desc = stripLeadingSep((m[2] ?? "").trim());
          } else {
            // Fallback: treat the whole text as description
            desc = stripLeadingSep(text);
          }
          const item = `- \`${paramName || "param"}\`${desc ? " - " + desc : ""}`.trim();
          paramItems.push(item);
          continue;
        }
        if (name === "returns" || name === "return") {
          if (!text.trim()) continue;
          const line = `**Returns**\n\n${text}`.trim();
          returnsLines.push(line);
          continue;
        }
        if (name === "template" || name === "typeparam") {
          // Support both forms:
          // - T - description
          // - {Constraint} T - description (rendered as `T <: Constraint`)
          const brace = /^\s*\{([^}]+)\}\s*(\S+)\s*(.*)$/.exec(text);
          if (brace) {
            const constraint = (brace[1] ?? "").trim();
            const tName = (brace[2] ?? "").trim();
            const desc = stripLeadingSep((brace[3] ?? "").trim());
            const head = tName + (constraint ? ` <: ${constraint}` : "");
            const item = `- \`${head}\`${desc ? " - " + desc : ""}`.trim();
            templateItems.push(item);
            continue;
          }
          let tName = "";
          let desc = "";
          const m = /^(\S+)\s*(?:[-\u2014\u2013:\u2012]\s*)?(.*)$/.exec(text);
          if (m) {
            tName = m[1] ?? "";
            desc = stripLeadingSep((m[2] ?? "").trim());
          } else {
            desc = stripLeadingSep(text);
          }
          const item = `- \`${tName || "T"}\`${desc ? " - " + desc : ""}`.trim();
          templateItems.push(item);
          continue;
        }
        if (name === "throws" || name === "exception") {
          // @throws {Error} description
          const m = /^(?:\{([^}]+)\}\s*)?(.*)$/.exec(text);
          const typ = (m?.[1] ?? "").trim();
          const desc = stripLeadingSep((m?.[2] ?? "").trim());
          const item =
            typ ? `- \`${typ}\`${desc ? " - " + desc : ""}` : `- ${desc || stripLeadingSep(text)}`;
          throwsItems.push(item.trim());
          continue;
        }
        if (name === "example") {
          // Render examples; respect pre-fenced content, otherwise wrap as ts
          const code = text.trim();
          if (code) {
            const preFenced = /^```[A-Za-z0-9+#-]*/.test(code);
            const block = preFenced ? code : "```ts\n" + code + "\n```";
            exampleBlocks.push("**Example**\n\n" + block);
          }
          continue;
        }
        if (name === "deprecated") {
          otherLines.push(`> Deprecated: ${text}`.trim());
          continue;
        }
        if (name === "remarks") {
          otherLines.push(text);
          continue;
        }
        // Generic fallback for unhandled tags
        otherLines.push(`@${tag.name} ${text}`.trim());
      }

      const blocks: string[] = [];
      if (docSummary) blocks.push(docSummary);
      if (templateItems.length) blocks.push(["**Type Parameters**", ...templateItems].join("\n"));
      if (paramItems.length) blocks.push(["**Parameters**", ...paramItems].join("\n"));
      if (returnsLines.length) blocks.push(returnsLines.join("\n"));
      if (throwsItems.length) blocks.push(["**Throws**", ...throwsItems].join("\n"));
      if (otherLines.length) blocks.push(otherLines.join("\n\n"));
      if (exampleBlocks.length) blocks.push(exampleBlocks.join("\n\n"));

      return { detail, documentation: blocks.join("\n\n") };
    } catch (e) {
      return { detail: undefined, documentation: undefined };
    }
  },

  async analyzeTrigger({ code, cursor }: { code: string; cursor: number }) {
    await ensureEnv();
    // Capture previous code to detect single-character deletions (e.g., Backspace)
    const prevCode = lastCode;
    writeIndex(code);
    ensureModuleRegistered();
    // Don't open on empty/whitespace-only input
    if (code.trim().length === 0) return { kind: "close" as const };
    // Suppress suggestions when the last edit was deleting a single whitespace character
    // This mirrors VS Code behavior: typing "const foo ", then Backspace should not pop suggestions for "foo"
    const detectSingleDeletion = (
      prev: string,
      curr: string,
    ): { index: number; deleted: string } | null => {
      const diff = prev.length - curr.length;
      if (diff <= 0 || diff > 2) return null; // support 1–2 code units (surrogate pair)
      let i = 0;
      const min = curr.length;
      while (i < min && prev[i] === curr[i]) i++;
      // i is the deletion index in prev
      if (prev.slice(i + diff) === curr.slice(i)) {
        const deleted = prev.slice(i, i + diff);
        return { index: i, deleted };
      }
      return null;
    };
    const del = detectSingleDeletion(prevCode, code);
    if (del) {
      const allNonIdent = Array.from(del.deleted).every((ch) => !isIdentChar(ch));
      if (allNonIdent) return { kind: "close" as const };
    }
    const last = code[cursor - 1];
    // '.' opens immediately
    if (last === ".") return { kind: "open" as const, delay: 0 };

    // Use TS scanner to determine if inside string/comment
    const scanner = ts.createScanner(
      ts.ScriptTarget.ESNext,
      /* skipTrivia */ false,
      ts.LanguageVariant.Standard,
      code,
    );
    let token: ts.SyntaxKind;
    let tokenStart = 0;
    let tokenEnd = 0;
    const lastKinds: ts.SyntaxKind[] = [];
    function pushNonTrivia(kind: ts.SyntaxKind) {
      lastKinds.push(kind);
      if (lastKinds.length > 4) lastKinds.shift();
    }
    while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
      tokenStart = scanner.getTokenStart();
      tokenEnd = scanner.getTokenEnd();
      const kind = token;
      // If cursor lies within this token
      if (cursor > tokenStart && cursor <= tokenEnd) {
        // Inside strings or template parts: allow only when in element access (receiver["|
        if (
          kind === ts.SyntaxKind.StringLiteral ||
          kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
          kind === ts.SyntaxKind.TemplateHead ||
          kind === ts.SyntaxKind.TemplateMiddle ||
          kind === ts.SyntaxKind.TemplateTail
        ) {
          const n = lastKinds.length;
          if (n >= 1 && lastKinds[n - 1] === ts.SyntaxKind.OpenBracketToken) {
            return { kind: "open" as const, delay: 0 };
          }
          return { kind: "close" as const };
        }
        // Close inside comments
        if (
          kind === ts.SyntaxKind.SingleLineCommentTrivia ||
          kind === ts.SyntaxKind.MultiLineCommentTrivia
        )
          return { kind: "close" as const };
      }
      // Track non-trivia tokens for potential context checks
      if (
        kind !== ts.SyntaxKind.WhitespaceTrivia &&
        kind !== ts.SyntaxKind.NewLineTrivia &&
        kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
        kind !== ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        if (tokenEnd <= cursor) pushNonTrivia(kind);
      }
      if (tokenEnd >= cursor) break;
    }

    // If last typed char is not an identifier character (Unicode-aware), proactively close
    if (!last || !isIdentChar(last)) return { kind: "close" as const };

    // Typing identifiers should open quickly
    return { kind: "open" as const, delay: 35 };
  },
};

// Dedicated worker: additionally we enforce a message scope to gate handling
// Note: in dedicated workers, origin verification is limited; we rely on a scoped message contract
self.onmessage = (e: MessageEvent) => {
  // Protocol check: only handle our structured messages
  const data = e.data;
  if (!data || typeof data !== "object") return;
  // Best-effort protocol guard only; origin checks are limited in dedicated workers
  const { id, payload, scope, type } = data as {
    id?: string;
    type?: string;
    payload?: unknown;
    scope?: string;
  };
  if (scope !== "completion") return;
  const allowed: Record<string, true> = {
    init: true,
    complete: true,
    updateHistory: true,
    analyzeTrigger: true,
    resolveDetail: true,
    debugGetHistory: true,
    typeOf: true,
  };
  if (typeof id !== "string" || typeof type !== "string" || !allowed[type]) return;
  // Execute handler synchronously and resolve promise responses
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  (async () => {
    try {
      const fn = handlers[type as keyof typeof handlers] as any;
      if (!fn) throw new Error(`Unknown message type: ${type}`);
      const result = await fn(payload ?? {});
      (self as unknown as Worker).postMessage({ id, result, scope: "completion" });
    } catch (e) {
      (self as unknown as Worker).postMessage({
        id,
        error: (e as Error).message,
        scope: "completion",
      });
    }
  })();
};
