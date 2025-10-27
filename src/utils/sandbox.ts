import { Option } from "effect";
import { filetypemime } from "magic-bytes.js";
import * as ts from "typescript";

import historyStore from "../stores/history";
import type { MimeBundle } from "../types";

import { show } from "./show";

// Simple registry to hold live Nodes (Elements or DocumentFragments),
// so we can render them directly in the history without serializing
class LiveNodeRegistry {
  #registry = new Map<string, Node>();

  add(node: Node): string {
    const id = "live:" + crypto.randomUUID();
    this.#registry.set(id, node);
    return id;
  }

  get(id: string): Node | undefined {
    return this.#registry.get(id);
  }

  remove(id: string): void {
    this.#registry.delete(id);
  }
}

export const liveNodeRegistry = new LiveNodeRegistry();

const JUPYTER_DISPLAY_SYMBOL = Symbol.for("Jupyter.display");

// Display a value into the REPL history, similar to Deno.jupyter.display(obj)
export async function display(value: unknown): Promise<void> {
  try {
    // If value is a DOM Element or DocumentFragment, live render and persist snapshot
    if (value instanceof Element || value instanceof DocumentFragment) {
      const node = value;
      const liveId = liveNodeRegistry.add(node);

      let label: string;
      if (node instanceof Element)
        label = `<${node.tagName.toLowerCase()}>…</${node.tagName.toLowerCase()}>`;
      else label = "DocumentFragment";

      // Build conservative HTML snapshot with <canvas> placeholders
      const placeholderHtml = (() => {
        const wrapper = document.createElement("div");
        const clone = node.cloneNode(true);
        wrapper.append(clone);
        const canvases = wrapper.querySelectorAll("canvas");
        canvases.forEach((canvas) => {
          const placeholder = document.createElement("div");
          placeholder.className = "repl-live-placeholder text-gray-400 text-sm";
          placeholder.innerHTML =
            '<div class="repl-live-placeholder__inner">' +
            '<div class="repl-live-placeholder__title">Canvas not persisted</div>' +
            '<div class="repl-live-placeholder__hint">Rerun to regenerate</div>' +
            "</div>";
          const style = canvas.style;
          if (style.length > 0) {
            const allowed = new Set([
              "width",
              "height",
              "position",
              "left",
              "top",
              "right",
              "bottom",
              "transform",
              "transform-origin",
              "margin",
              "margin-left",
              "margin-right",
              "margin-top",
              "margin-bottom",
              "padding",
              "padding-left",
              "padding-right",
              "padding-top",
              "padding-bottom",
              "display",
              "z-index",
              "pointer-events",
              "user-select",
              "box-sizing",
              "overflow",
            ]);
            const decl: string[] = [];
            for (let i = 0; i < style.length; i++) {
              const name = style.item(i);
              if (!name) continue;
              const key = name.toLowerCase();
              if (!allowed.has(key)) continue;
              const val = style.getPropertyValue(name);
              if (val) decl.push(`${key}: ${val}`);
            }
            if (decl.length) placeholder.setAttribute("style", decl.join("; "));
          }
          if (!style.width) {
            const wAttr = canvas.getAttribute("width");
            if (wAttr && /(%)|(px$)/.test(wAttr)) placeholder.style.width = wAttr;
          }
          if (!style.height) {
            const hAttr = canvas.getAttribute("height");
            if (hAttr && /(%)|(px$)/.test(hAttr)) placeholder.style.height = hAttr;
          }
          canvas.replaceWith(placeholder);
        });
        return wrapper.innerHTML;
      })();

      const wrapperHtml = `<div data-repl-live-id="${liveId}" style="width: fit-content">${placeholderHtml}</div>`;
      await historyStore.appendRichOutput({
        "text/plain": label,
        "text/html": wrapperHtml,
        "application/x.repl-live-id": liveId,
      });
      return;
    }

    // If value supports Jupyter.display symbol, use its MIME bundle
    const displayFn =
      value && typeof value === "object" ? (value as any)[JUPYTER_DISPLAY_SYMBOL] : null;
    if (typeof displayFn === "function") {
      let bundle: MimeBundle | null = null;
      try {
        const result = displayFn.call(value);
        bundle = result && typeof result === "object" ? result : null;
      } catch (e) {
        // Ignore, fallback to text
      }
      if (bundle) {
        if (
          bundle["application/x.repl-hide-input"] &&
          historyStore.$get().history[historyStore.$get().history.length - 1]?.type !== "hide-input"
        )
          historyStore.appendHideInput();
        await historyStore.appendRichOutput(bundle);
        return;
      }
    }

    // Fallback
    historyStore.appendOutput(show(value));
  } catch (e) {
    historyStore.appendError(e);
  }
}

// Register global variables/functions for the sandbox
(function registerGlobals() {
  (globalThis as any).show = show;
  Object.defineProperty(show, "name", { value: "show", configurable: true });

  (globalThis as any).display = display;
  Object.defineProperty(display, "name", { value: "display", configurable: true });

  // ==== Rich content helpers inspired by Deno.jupyter, exposed as `Rich.*` ====
  // They create values that the REPL recognizes as rich bundles via Symbol.for("Jupyter.display").

  type ImageMime = `image/${string}`;

  // Parse MIME from data: URL (e.g. data:image/png;base64,...)
  const parseDataUrlMime = (dataUrl: string): string | null => {
    const m = /^data:([^;,]+)[^,]*,/i.exec(dataUrl);
    return m ? m[1]!.toLowerCase() : null;
  };

  // Very fast check for inline SVG markup strings
  const isSvgMarkupString = (s: string): boolean => {
    const head = s.slice(0, 256).trimStart();
    return /^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head) || /^<!doctype\s+svg\b/i.test(head);
  };

  const toStringFromTemplate = (strings: TemplateStringsArray, values: unknown[]): string => {
    let result = "";
    for (let i = 0; i < strings.length; i++) {
      result += strings[i] ?? "";
      if (i < values.length) result += String(values[i]);
    }
    return result;
  };

  const asDisplayable = (bundle: MimeBundle) => ({
    [JUPYTER_DISPLAY_SYMBOL]() {
      return bundle;
    },
  });

  const Rich = {
    $display: JUPYTER_DISPLAY_SYMBOL,

    // HTML tagged template -> text/html
    html(strings: TemplateStringsArray, ...values: unknown[]) {
      const html = toStringFromTemplate(strings, values);
      return asDisplayable({
        "text/html": html,
      });
    },

    // Markdown tagged template -> text/markdown
    md(strings: TemplateStringsArray, ...values: unknown[]) {
      const md = toStringFromTemplate(strings, values);
      return asDisplayable({
        "text/markdown": md,
      });
    },

    // Markdown block (Jupyter-style): hides the input cell
    mdBlock(strings: TemplateStringsArray, ...values: unknown[]) {
      const md = toStringFromTemplate(strings, values);
      return asDisplayable({
        "application/x.repl-hide-input": true,
        "text/markdown": md,
      });
    },

    // SVG tagged template -> image/svg+xml
    svg(strings: TemplateStringsArray, ...values: unknown[]) {
      const svg = toStringFromTemplate(strings, values);
      return asDisplayable({
        "image/svg+xml": svg,
      });
    },

    // Image from URL/data URL/blob URL or raw bytes. When passing bytes, we try to sniff mime (fallback image/png)
    image(data: string | Uint8Array | ArrayBuffer, mimeType?: ImageMime) {
      if (typeof data === "string") {
        // data URL -> use declared MIME directly (except svg -> render via <img>)
        if (/^data:/i.test(data)) {
          const mime = mimeType ?? parseDataUrlMime(data);
          if (mime && mime.toLowerCase() !== "image/svg+xml")
            return asDisplayable({ [mime]: data });
          const escaped = data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          return asDisplayable({ "text/html": `<img src="${escaped}" alt="image" />` });
        }

        // Inline SVG markup string -> render as real SVG
        if (isSvgMarkupString(data)) return asDisplayable({ "image/svg+xml": data });

        // For other strings (URLs/paths), avoid guessing by extension; render via HTML <img>
        const escaped = data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return asDisplayable({ "text/html": `<img src="${escaped}" alt="image" />` });
      }

      // Bytes: detect using magic-bytes.js, fallback to provided mimeType or image/png
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const detected = filetypemime(bytes)[0]?.toLowerCase();
      const mime =
        mimeType ?? (detected?.startsWith("image/") ? detected : undefined) ?? "image/png";
      return asDisplayable({ [mime]: bytes });
    },
  };

  (globalThis as any).Rich = Rich;
})();

const AsyncFunction = async function () {}.constructor as FunctionConstructor;

export type ConsoleListener = <Type extends Exclude<keyof Console, "Console">>(
  type: Type,
  ...args: Parameters<Console[Type]>
) => void;

export class Sandbox {
  #context: Record<string, unknown> = {};

  /**
   * Execute code in the sandbox.
   * @param code The code to execute.
   * @returns
   */
  async execute(code: string): Promise<Option.Option<unknown>> {
    const sourceFile = ts.createSourceFile(
      "repl.ts",
      code,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );

    const variables = new Set<string>();
    let codeToExecute = "";
    const imports: string[] = [];

    // Helper: convert bare npm specifier to CDN URL
    const toCdnUrl = (modulePath: string): string => {
      const isBare =
        /^(@(?![.-])(?!.*[.-]\/)(?!.*(\.\.|--))[a-z0-9\-_.]+\/)?(?![.-])(?!.*[.-](@|$))(?!.*(\.\.|--))[a-z0-9\-_.]+(@latest|@alpha|@beta|@[~^]?([\dvx*]+(?:[-.](?:[\dx*]+|alpha|beta))*))?(\/|$)/i.test(
          modulePath,
        );
      if (isBare) return "https://esm.sh/" + modulePath;
      return modulePath;
    };

    // Traverse every statement in the AST
    for (let i = 0; i < sourceFile.statements.length; i++) {
      const statement = sourceFile.statements[i]!;
      const isLast = i === sourceFile.statements.length - 1;

      // Handle import statements
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const importStatement = this.#transformImportToDynamic(statement);
        if (importStatement) {
          imports.push(importStatement.code);
          if (importStatement.variables.length > 0)
            for (const v of importStatement.variables) variables.add(v);
        }
        continue; // Skip normal processing for import statements
      }

      // Handle TS import equals: `import X = require("mod")` or `import A = NS.B`
      if (ts.isImportEqualsDeclaration(statement)) {
        const name = statement.name.getText();
        let codeLine = "";
        const modRef = statement.moduleReference;
        if (
          ts.isExternalModuleReference(modRef) &&
          ts.isStringLiteral((modRef as any).expression)
        ) {
          const mod = ((modRef as any).expression as ts.StringLiteral).text;
          const url = toCdnUrl(mod);
          codeLine =
            `const __mod_${name} = await import("${url}");` +
            `\nconst ${name} = ("default" in __mod_${name} ? __mod_${name}.default : __mod_${name});`;
        } else {
          const rhs = statement.moduleReference.getText();
          codeLine = `const ${name} = ${rhs};`;
        }
        imports.push(codeLine);
        variables.add(name);
        continue;
      }

      for (const v of this.#extractDeclaredVariables(statement)) variables.add(v);

      if (codeToExecute.trim() && !codeToExecute.trimEnd().endsWith(";")) codeToExecute += ";";
      if (
        isLast &&
        !ts.isVariableStatement(statement) &&
        !ts.isFunctionDeclaration(statement) &&
        !ts.isClassDeclaration(statement) &&
        !ts.isEnumDeclaration(statement) &&
        !ts.isTypeAliasDeclaration(statement) &&
        !ts.isInterfaceDeclaration(statement) &&
        !ts.isModuleDeclaration(statement) &&
        !this.#isControlFlowStatement(statement)
      ) {
        codeToExecute +=
          "\nconst __repl_result___ = " + this.#removeModuleSyntax(statement.getText()) + ";";
        variables.add("__repl_result___");
      } else {
        codeToExecute += "\n" + this.#removeModuleSyntax(statement.getText());
      }
    }

    // Ensure we also return existing context variables so reassignment like `a = 2` is flushed back
    for (const key of Object.keys(this.#context)) variables.add(key);

    // Prepend the transformed imports to the code
    if (imports.length > 0)
      codeToExecute =
        imports.join("\n") + (codeToExecute.startsWith("\n") ? "" : "\n") + codeToExecute;

    if (codeToExecute.trim() && !codeToExecute.trimEnd().endsWith(";")) codeToExecute += ";";
    codeToExecute += `\nreturn { ${Array.from(variables).join(", ")} };`;

    // Transpile the assembled TS snippet to JS (with inline source maps)
    const execTranspiled = ts.transpileModule(codeToExecute, {
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
        inlineSourceMap: true,
        inlineSources: true,
      },
      fileName: "repl_exec.ts",
      reportDiagnostics: false,
    });
    const jsExec = execTranspiled.outputText;

    let result: Record<string, unknown>;
    try {
      result = this.#evalSync("return (() => {\n" + jsExec + "\n})();") as never;
    } catch (error) {
      if (error instanceof SyntaxError)
        result = (await this.#evalAsync(
          "return await (async () => {\n" + jsExec + "\n})();",
        )) as never;
      else throw error;
    }

    // Update context only when values actually change, using Object.is
    for (const [key, value] of Object.entries(result)) {
      if (key === "__repl_result___") continue;
      const hadKey = Object.prototype.hasOwnProperty.call(this.#context, key);
      if (!hadKey || !Object.is(this.#context[key], value)) this.#context[key] = value;
    }

    return "__repl_result___" in result ? Option.some(result.__repl_result___) : Option.none();
  }

  /**
   * Transforms an import statement into a dynamic import from esm.sh CDN.
   * @param importDecl The import declaration node.
   * @returns The transformed import statement and the variables it declares.
   */
  #transformImportToDynamic(
    importDecl: ts.ImportDeclaration,
  ): { code: string; variables: string[] } | null {
    if (!ts.isStringLiteral(importDecl.moduleSpecifier)) {
      return null;
    }

    // Skip type-only import entirely (no runtime effect)
    if (importDecl.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) return null;

    const modulePath = importDecl.moduleSpecifier.text;
    const url =
      // Check if the module specifier starts with a valid npm package name
      // See: https://stackoverflow.com/a/64880672/21418758
      (
        /^(@(?![.-])(?!.*[.-]\/)(?!.*(\.\.|--))[a-z0-9\-_.]+\/)?(?![.-])(?!.*[.-](\/|@|$))(?!.*(\.\.|--))[a-z0-9\-_.]+(@latest|@alpha|@beta|@[~^]?([\dvx*]+(?:[-.](?:[\dx*]+|alpha|beta))*))?(\/|$)/i.test(
          modulePath,
        )
      ) ?
        "https://esm.sh/" + modulePath
      : modulePath;
    const variables: string[] = [];

    // Handle side-effect import: import 'module';
    if (!importDecl.importClause) {
      return { code: `await import("${url}");`, variables };
    }

    const { name, namedBindings } = importDecl.importClause;
    let code = "";

    // Handle default import: import defaultExport from 'module';
    if (name) {
      code += `const ${name.text} = (await import("${url}")).default;`;
      variables.push(name.text);
    }

    // Handle namespace import: import * as name from 'module';
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      if (code) code += "\n";
      code += `const ${namedBindings.name.text} = await import("${url}");`;
      variables.push(namedBindings.name.text);
    }

    // Handle named imports: import { export1, export2 as alias2 } from 'module';
    else if (namedBindings && ts.isNamedImports(namedBindings)) {
      // Filter out type-only specifiers. Use a safe cast for older TS versions.
      const valueElements = namedBindings.elements.filter((el) => (el as any).isTypeOnly !== true);

      if (valueElements.length > 0) {
        const imports = valueElements
          .map((element) => {
            const importName = element.name.text;
            const propertyName = element.propertyName?.text;

            variables.push(importName);

            if (propertyName) {
              return `${propertyName}: ${importName}`;
            } else {
              return importName;
            }
          })
          .join(", ");

        if (code) code += "\n";
        code += `const { ${imports} } = await import("${url}");`;
      }
    }

    // If no runtime code or variables produced (e.g., only type imports), return null
    if (!code && variables.length === 0) return null;
    return { code, variables };
  }

  /**
   * Extracts all variable names declared in a statement, including nested destructuring patterns.
   * @param statement The TypeScript statement to analyze.
   * @returns An array of declared variable names.
   */
  #extractDeclaredVariables(statement: ts.Statement): string[] {
    const variables: string[] = [];

    const hasDeclare = (node: ts.Node): boolean => {
      const mods = (node as any).modifiers as ts.NodeArray<ts.ModifierLike> | undefined;
      return !!mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);
    };

    // Handle variable declarations (let, const, var)
    if (ts.isVariableStatement(statement)) {
      if (hasDeclare(statement)) return variables;
      for (const declaration of statement.declarationList.declarations) {
        this.#extractBindingNames(declaration.name, variables);
      }
    }
    // Handle function/class/enum declarations
    else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      if (hasDeclare(statement)) return variables;
      variables.push(statement.name.text);
    } else if (ts.isEnumDeclaration(statement)) {
      if (!hasDeclare(statement)) variables.push(statement.name.text);
    }
    // Handle namespace/module declarations
    else if (ts.isModuleDeclaration(statement)) {
      if (hasDeclare(statement)) return variables;
      // ModuleDeclaration name can be Identifier or StringLiteral; we only handle Identifier for variable export
      if (ts.isIdentifier(statement.name)) variables.push(statement.name.text);
    }

    return variables;
  }

  /**
   * Recursively extracts names from a binding pattern (identifier, object or array pattern).
   * @param bindingName The binding pattern node.
   * @param variables Array to collect variable names.
   */
  #extractBindingNames(bindingName: ts.BindingName, variables: string[]): void {
    // Simple variable names
    if (ts.isIdentifier(bindingName)) {
      variables.push(bindingName.text);
    }
    // Object destructuring (const { a, b: c, ...rest } = ...)
    else if (ts.isObjectBindingPattern(bindingName)) {
      for (const element of bindingName.elements)
        this.#extractBindingNames(element.name, variables);
    }
    // Array destructuring (const [, b, ...rest] = ...)
    else if (ts.isArrayBindingPattern(bindingName)) {
      for (const element of bindingName.elements) {
        if (ts.isOmittedExpression(element)) {
          // Skip empty slots [, , c]
          continue;
        }
        this.#extractBindingNames(element.name, variables);
      }
    }
  }

  #isControlFlowStatement(statement: ts.Statement): boolean {
    // List of control flow syntax kinds
    const controlFlowKinds = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.BreakStatement,
      ts.SyntaxKind.ContinueStatement,
      ts.SyntaxKind.DebuggerStatement,
      ts.SyntaxKind.DoStatement,
      ts.SyntaxKind.EmptyStatement,
      ts.SyntaxKind.ForStatement,
      ts.SyntaxKind.ForInStatement,
      ts.SyntaxKind.ForOfStatement,
      ts.SyntaxKind.IfStatement,
      ts.SyntaxKind.LabeledStatement,
      ts.SyntaxKind.NotEmittedStatement,
      ts.SyntaxKind.ReturnStatement,
      ts.SyntaxKind.SwitchStatement,
      ts.SyntaxKind.ThrowStatement,
      ts.SyntaxKind.TryStatement,
      ts.SyntaxKind.WhileStatement,
      ts.SyntaxKind.WithStatement,
    ]);
    if (controlFlowKinds.has(statement.kind)) return true;

    // Check if the statement is an expression statement calling `console` or `clear`
    if (ts.isExpressionStatement(statement)) {
      const expr = statement.expression;
      if (ts.isCallExpression(expr)) {
        // If it’s a property access (e.g., console.log)
        if (ts.isPropertyAccessExpression(expr.expression)) {
          const target = expr.expression.expression;
          if (ts.isIdentifier(target) && target.text === "console") return true;
        }
        // If it’s a call to an identifier (e.g., clear())
        else if (ts.isIdentifier(expr.expression) && expr.expression.text === "clear") return true;
      }
    }
    return false;
  }

  /**
   * Replace module syntax with whitespace from a JavaScript statement.
   * @param statement The statement to process.
   * @returns The processed statement.
   */
  #removeModuleSyntax(statement: string): string {
    // Remove export keywords and the synthetic `export {}` emitted by TS
    statement = statement.replace(/^(\s*export\s+)default(\s+)/, "$1      $2");
    statement = statement.replace(/^(\s*)export(\s+)/, "$1      $2");
    // Drop pure module marker and re-export forms (no runtime effect for REPL)
    if (/^\s*export\s*\{\s*\}\s*;?\s*$/.test(statement)) return "";
    if (/^\s*export\s+type\s*\{[\s\S]*?\}(\s*from\s+("[^"]+"|'[^']+'))?\s*;?\s*$/.test(statement))
      return "";
    if (/^\s*export\s*\{[\s\S]*?\}(\s*from\s+("[^"]+"|'[^']+'))?\s*;?\s*$/.test(statement))
      return "";
    if (/^\s*export\s*\*\s*from\s+("[^"]+"|'[^']+')\s*;?\s*$/.test(statement)) return "";
    if (/^\s*export\s*=\s*/.test(statement)) return ""; // export = X
    return statement;
  }

  /**
   * Evaluate a snippet of synchronous JavaScript code.
   * @param code The code to evaluate.
   * @returns The result of the evaluation.
   */
  #evalSync(code: string): unknown {
    const context = this.#prepareFunctionContext();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(...Object.keys(context), code)(...Object.values(context));
  }

  /**
   * Evaluate a snippet of asynchronous JavaScript code.
   * @param code The code to evaluate.
   * @returns The result of the evaluation.
   */
  async #evalAsync(code: string): Promise<unknown> {
    const context = this.#prepareFunctionContext();
    return await new AsyncFunction(...Object.keys(context), code)(...Object.values(context));
  }

  /**
   * Prepare the function context for execution.
   * @returns
   */
  #prepareFunctionContext(): Record<string, unknown> {
    return {
      globals: this.#context,
      clear: console.clear,
      ...this.#context,
    };
  }
}
