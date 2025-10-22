import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import { match } from "megamatch";
import { create, get } from "troza";
import { hookify } from "troza/react";

import type { HistoryEntry } from "../types";
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
  history: [] as (HistoryEntry | { type: "recovered-mark" })[],

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

export const persistHistoryInURL = (
  history: (HistoryEntry | { type: "recovered-mark" })[],
): URL => {
  const searchParams = new URLSearchParams(window.location.search);
  if (!history.length) searchParams.delete("history");
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
};

// Persist history to search params
historyStore.$subscribe(
  (state) => state.history,
  (history) => {
    if (!settingsStore.history.persistInURL) return;
    window.history.replaceState(null, "", persistHistoryInURL(history));
  },
);
