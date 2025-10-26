import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { match } from "megamatch";
import { create, get } from "troza";
import { hookify } from "troza/react";

import type { HistoryEntry, HistoryEntryLike } from "../types";
import { isReplCommand } from "../utils/sandbox";
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

  appendOutput(...args: [value: string] | [type: "info" | "warn" | "error", value: string]) {
    if (args.length === 1) {
      this.history.push({ type: "output", value: args[0] });
      return;
    }

    const [type, value] = args;
    this.history.push({ type: "output", variant: type, value });
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

const encodeHistoryEntry = match<string, HistoryEntry>()({
  "{ type: 'input', value: _ }": (value) => "i" + value,
  "{ type: 'output', variant: 'info', value: _ }": (value) => "f" + value,
  "{ type: 'output', variant: 'warn', value: _ }": (value) => "w" + value,
  "{ type: 'output', variant: 'error', value: _ }": (value) => "r" + value,
  "{ type: 'output', value: _ }": (value) => "o" + value,
  "{ type: 'error', value: _ }": (value) => "e" + value,
});
const decodeHistoryEntry = match<HistoryEntry, readonly [string, string]>()({
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
    const history = (JSON.parse(decompressFromEncodedURIComponent(historyParam)) as string[])
      .map((raw) => [raw[0]!, raw.slice(1)] as const)
      .map(decodeHistoryEntry);
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
    searchParams.set(
      "history",
      compressToEncodedURIComponent(
        JSON.stringify(
          history.filter((entry) => entry.type !== "recovered-mark").map(encodeHistoryEntry),
        ),
      ),
    );

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
