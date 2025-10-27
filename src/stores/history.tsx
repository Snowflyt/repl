import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { match } from "megamatch";
import { create, get } from "troza";
import { hookify } from "troza/react";

// @ts-expect-error NOTE: We import from the bundled ESM file because the default export of
// html-minifier-terser relies on Node.js built-ins that are not available in the browser
// eslint-disable-next-line sonarjs/no-internal-api-use
import { minify as minifyHTML } from "../../node_modules/html-minifier-terser/dist/htmlminifier.esm.bundle.js";
import type { HistoryEntry, HistoryEntryLike, MimeBundle } from "../types";
import { show } from "../utils/show";

import sandboxStore from "./sandbox";
import settingsStore from "./settings";

/**
 * Returns true if the given input string is a REPL command (starts with ':' after optional spaces).
 * @param input The user input string.
 * @returns Whether the input is a REPL command.
 */
export function isReplCommand(input: string): boolean {
  return /^\s*:/.test(input);
}

const historyStore = create({
  history: [] as HistoryEntryLike[],

  [get("inputHistory")]() {
    return this.history.filter((entry) => entry.type === "input");
  },

  clear() {
    this.history = [];
  },

  appendInput(value: string) {
    this.history.push({ type: "input", value });
  },

  appendHideInput() {
    this.history.push({ type: "hide-input" });
  },

  appendOutput(...args: [value: string] | [type: "info" | "warn" | "error", value: string]) {
    if (args.length === 1) {
      this.history.push({ type: "output", value: args[0] });
      return;
    }

    const [type, value] = args;
    this.history.push({ type: "output", variant: type, value });
  },

  async appendRichOutput(bundle: MimeBundle) {
    for (const [key, val] of Object.entries(bundle))
      if ((key === "text/html" || key === "image/svg+xml") && typeof val === "string")
        try {
          bundle[key] = await (minifyHTML as typeof import("html-minifier-terser").minify)(val, {
            collapseWhitespace: true,
            conservativeCollapse: false,
            removeComments: true,
            removeRedundantAttributes: true,
            removeAttributeQuotes: true,
            collapseBooleanAttributes: true,
            removeEmptyAttributes: true,
            sortAttributes: true,
            sortClassName: true,
            removeOptionalTags: true,
            useShortDoctype: true,
            keepClosingSlash: false,
            minifyCSS: true,
            minifyJS: true,
            decodeEntities: true,
            removeScriptTypeAttributes: true,
            removeStyleLinkTypeAttributes: true,
            noNewlinesBeforeTagClose: true,
          });
        } catch (e) {
          // Ignore minification errors
        }
    this.history.push({ type: "rich-output", bundle });
  },

  appendError(error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : show(error);
    this.history.push({ type: "error", value: message });
  },

  /**
   * Remove an input entry and all subsequent outputs/errors up to (but not including) the next
   * input or recovered-mark. If the index is invalid or not an input, this is a no-op.
   */
  removeInputBlockAt(historyIndex: number) {
    const history = this.history;
    if (historyIndex < 0 || historyIndex >= history.length) return;
    const entry = history[historyIndex];
    if (entry?.type !== "input") return;
    let end = historyIndex + 1;
    while (end < history.length) {
      const e = history[end]!;
      if (e.type === "input" || e.type === "recovered-mark") break;
      end++;
    }
    this.history.splice(historyIndex, end - historyIndex);
  },
});

export default historyStore;

export const useHistoryStore = hookify("history", historyStore);

// Preferred MIME order when selecting a single representation to persist
const PREFERRED_MIME_ORDER = [
  "text/html",
  "text/markdown",
  "image/svg+xml",
  // Bitmap images in preferred order
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/apng",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/tiff",
  // Structured fallback
  "application/json",
  // Plain text last
  "text/plain",
];

function pickBestMime(bundle: MimeBundle): string | undefined {
  for (const key of PREFERRED_MIME_ORDER)
    if (Object.prototype.hasOwnProperty.call(bundle, key)) return key;
  const anyImg = Object.keys(bundle).find((k) => k.startsWith("image/") && k !== "image/svg+xml");
  if (anyImg) return anyImg;
  const keys = Object.keys(bundle);
  return keys.length ? keys[0] : undefined;
}

// ---- Compact history encoding (v2) with binary-friendly framing ----
// Format: "V2" + sequence of frames. Each frame starts with a 1-char code:
//   i: input, o: output, f: info, w: warn, r: error (output), e: error, j: rich-output
// After the code, fields are written in fixed order using 32-bit length-prefixed segments.
//   writeStr: 2 chars (hi16, lo16) length in code units + string data
//   writeBytes: 2 chars (hi16, lo16) length in bytes + data with charCode 0..255 per byte
// For 'j' rich-output: [mime (writeStr)] [valType ('S'|'B')] [value (writeStr|writeBytes)] [flags (1 char)] [optional liveId (writeStr if bit0 of flags set)]
function u32To2Chars(n: number): string {
  const hi = (n >>> 16) & 0xffff;
  const lo = n & 0xffff;
  return String.fromCharCode(hi) + String.fromCharCode(lo);
}
function twoCharsToU32(a: string, i: number): number {
  const hi = a.charCodeAt(i);
  const lo = a.charCodeAt(i + 1);
  return (hi << 16) | lo;
}
function writeStr(s: string): string {
  return u32To2Chars(s.length) + s;
}
function readStr(a: string, i: number): [value: string, next: number] {
  const len = twoCharsToU32(a, i);
  const start = i + 2;
  const end = start + len;
  return [a.slice(start, end), end];
}
function writeBytes(u8: Uint8Array): string {
  let s = "";
  for (const byte of u8) s += String.fromCharCode(byte);
  return u32To2Chars(u8.length) + s;
}
function readBytes(a: string, i: number): [value: Uint8Array, next: number] {
  const len = twoCharsToU32(a, i);
  const start = i + 2;
  const end = start + len;
  const out = new Uint8Array(len);
  for (let k = 0; k < len; k++) out[k] = a.charCodeAt(start + k) & 0xff;
  return [out, end];
}

function encodeHistoryV2(history: HistoryEntryLike[]): string {
  let result = "V2";
  for (const entry of history) {
    if (entry.type === "recovered-mark") continue;
    switch (entry.type) {
      case "input": {
        result += "i" + writeStr(entry.value);
        break;
      }
      case "hide-input": {
        result += "h";
        break;
      }
      case "output": {
        const code =
          entry.variant === "info" ? "f"
          : entry.variant === "warn" ? "w"
          : entry.variant === "error" ? "r"
          : "o";
        result += code + writeStr(entry.value);
        break;
      }
      case "error": {
        result += "e" + writeStr(entry.value);
        break;
      }
      case "rich-output": {
        const mime = pickBestMime(entry.bundle) ?? "text/plain";
        const val = entry.bundle[mime];
        let flags = 0;
        const liveId = entry.bundle["application/x.repl-live-id"] as string | undefined;
        if (typeof liveId === "string") flags |= 1;
        result += "j" + writeStr(mime);
        if (val instanceof Uint8Array) result += "B" + writeBytes(val);
        else if (val instanceof ArrayBuffer) result += "B" + writeBytes(new Uint8Array(val));
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        else result += "S" + writeStr(String(val ?? ""));
        result += String.fromCharCode(flags);
        if (flags & 1) result += writeStr(liveId!);
        break;
      }
    }
  }
  return result;
}

function decodeHistoryV2(data: string): HistoryEntry[] {
  if (!data.startsWith("V2")) throw new TypeError("Invalid history v2 data");
  const result: HistoryEntry[] = [];
  let i = 2;
  while (i < data.length) {
    const code = data[i++]!;
    switch (code) {
      case "i": {
        const [s, j] = readStr(data, i);
        i = j;
        result.push({ type: "input", value: s });
        break;
      }
      case "h": {
        result.push({ type: "hide-input" });
        break;
      }
      case "o":
      case "f":
      case "w":
      case "r": {
        const [s, j] = readStr(data, i);
        i = j;
        result.push({
          type: "output",
          variant:
            code === "o" ? undefined
            : code === "f" ? "info"
            : code === "w" ? "warn"
            : "error",
          value: s,
        });
        break;
      }
      case "e": {
        const [s, j] = readStr(data, i);
        i = j;
        result.push({ type: "error", value: s });
        break;
      }
      case "j": {
        const [mime, j1] = readStr(data, i);
        i = j1;
        const kind = data[i++]!; // 'S' | 'B'
        const bundle = {} as MimeBundle;
        if (kind === "S") {
          const [s, j2] = readStr(data, i);
          i = j2;
          bundle[mime] = s;
        } else {
          const [b, j2] = readBytes(data, i);
          i = j2;
          bundle[mime] = b;
        }
        const flags = data.charCodeAt(i++);
        if (flags & 1) {
          const [live, j3] = readStr(data, i);
          i = j3;
          bundle["application/x.repl-live-id"] = live;
        }
        result.push({ type: "rich-output", bundle });
        break;
      }
      default:
        // Unknown code -> stop parsing to avoid infinite loop
        i = data.length;
        break;
    }
  }
  return result;
}

// Backward-compat decoder for legacy (v1) JSON-encoded entries
const decodeHistoryEntryV1 = match<HistoryEntry, readonly [string, string]>()({
  "['i', _]": (value) => ({ type: "input", value }),
  "['f', _]": (value) => ({ type: "output", variant: "info", value }),
  "['w', _]": (value) => ({ type: "output", variant: "warn", value }),
  "['r', _]": (value) => ({ type: "output", variant: "error", value }),
  "['o', _]": (value) => ({ type: "output", value }),
  "['e', _]": (value) => ({ type: "error", value }),
  "[_, *]": (format) => {
    throw new Error(`Invalid history entry format '${format}'`);
  },
});

// Initialize history from search params
const searchParams = new URLSearchParams(window.location.search);
const historyParam = searchParams.get("history");
if (historyParam)
  try {
    const decompressed = decompressFromEncodedURIComponent(historyParam);
    const history =
      decompressed.startsWith("V2") ?
        decodeHistoryV2(decompressed)
      : (JSON.parse(decompressed) as string[])
          .map((raw) => [raw[0]!, raw.slice(1)] as const)
          .map(decodeHistoryEntryV1);
    if (searchParams.has("rerun")) {
      historyStore.history = history;
      const unsubscribe = sandboxStore.$subscribe(
        (state) => state.isLoading,
        (isLoading) => {
          if (isLoading) return;
          unsubscribe();
          historyStore.clear();
          void sandboxStore.recover(history);
        },
      );
    } else {
      historyStore.history = (history as typeof historyStore.history).concat([
        { type: "recovered-mark" },
      ]);
    }
  } catch {
    // Ignore
  }

/**
 * Scan a history block starting at a given input index and determine whether recover() would re-execute it.
 * @param history Full history array (may include recovered-mark entries).
 * @param startIndex Index of an input entry to start scanning from.
 * @returns Object with `endIndex` pointing to the next input (or end), and `shouldRecover` decision.
 */
export function scanHistoryBlock(
  history: HistoryEntryLike[],
  startIndex: number,
): { endIndex: number; shouldRecover: boolean } {
  const start = startIndex;
  const entry = history[start];
  if (entry?.type !== "input") return { endIndex: startIndex + 1, shouldRecover: false };

  // REPL commands are not re-executed
  if (isReplCommand(entry.value)) {
    let j = start + 1;
    while (j < history.length && history[j]!.type !== "input") j++;
    return { endIndex: j, shouldRecover: false };
  }

  let j = start + 1;
  let shouldRecover = true;
  while (j < history.length) {
    const next = history[j]!;
    if (next.type === "input") break;
    if (
      next.type === "error" ||
      (next.type === "output" && next.variant === "info" && next.value === "Execution cancelled")
    )
      shouldRecover = false;
    j++;
  }

  return { endIndex: j, shouldRecover };
}

/**
 * Filter history for rerun mode by removing outputs for blocks that would be re-executed by recover().
 * @param history Full history array (may include recovered-mark entries).
 * @returns Filtered history array with only inputs for re-runnable blocks.
 */
export function filterHistoryForRerun(history: HistoryEntryLike[]): HistoryEntryLike[] {
  const result: HistoryEntryLike[] = [];

  let i = 0;
  while (i < history.length) {
    const entry = history[i]!;
    if (entry.type !== "input") {
      result.push(entry);
      i++;
      continue;
    }
    const { endIndex, shouldRecover } = scanHistoryBlock(history, i);
    if (shouldRecover) result.push(entry);
    else for (let k = i; k < endIndex; k++) result.push(history[k]!);
    i = endIndex;
  }

  return result;
}

export function persistHistoryInURL(
  history: HistoryEntryLike[],
  baseSearchParams?: URLSearchParams,
): URL {
  const searchParams = new URLSearchParams(baseSearchParams ?? window.location.search);

  const historyToPersist = searchParams.has("rerun") ? filterHistoryForRerun(history) : history;

  if (!historyToPersist.length) searchParams.delete("history");
  else
    searchParams.set("history", compressToEncodedURIComponent(encodeHistoryV2(historyToPersist)));

  return new URL(
    window.location.pathname + (searchParams.size ? "?" + searchParams.toString() : ""),
    window.location.origin,
  );
}

// Persist history to search params
historyStore.$subscribe(
  (state) => state.history,
  (history) => {
    if (!settingsStore.history.persistInURL) return;
    window.history.replaceState(null, "", persistHistoryInURL(history));
  },
);
