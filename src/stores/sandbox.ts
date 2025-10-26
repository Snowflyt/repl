import { Option } from "effect";
import { create } from "troza";
import { hookify } from "troza/react";

import type { HistoryEntry } from "../types";
import type { Sandbox } from "../utils/sandbox";
import { show, showTable } from "../utils/show";

import historyStore, { scanHistoryBlock } from "./history";

let sandbox: Sandbox | null = null;
let executionAbortController: AbortController | null = null;

const consoleState = {
  level: 0,
  count: {} as Record<string, number>,
  time: {} as Record<string, Date>,
};

const indent = (str: string) =>
  str
    .split("\n")
    .map((line) => " ".repeat(consoleState.level * 2) + line)
    .join("\n");
const showArgs = (args: unknown[]) =>
  args.map((arg) => (typeof arg === "string" ? arg : show(arg))).join(" ");

let consoleMocked = false;
const mockConsole = () => {
  const { appendError, appendOutput, clear: clearHistory } = historyStore;

  if (consoleMocked) return;
  consoleMocked = true;

  const originalConsole = { ...console };

  console.clear = function clear() {
    clearHistory();
  };

  console.assert = function assert(condition: unknown, ...args: unknown[]) {
    if (condition === false) appendOutput("error", indent("Assertion failed: " + showArgs(args)));
  };

  console.count = function count(label: string) {
    const count = consoleState.count[label] ?? 0;
    consoleState.count[label] = count + 1;
    appendOutput(indent(`${label}: ${count + 1}`));
  };
  console.countReset = function countReset(label: string) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete consoleState.count[label];
  };

  console.dir = function dir(item: unknown, options: Record<string, unknown> = {}) {
    appendOutput(indent(show(item, options)));
  };
  console.dirxml = function dirxml(item: unknown, options: Record<string, unknown> = {}) {
    appendOutput(indent(show(item, options)));
  };

  console.error = function error(...args: unknown[]) {
    if (typeof args[0] === "string" && args[0].startsWith("\u8bf7\u63a5\u5165 zhihu-hybrid")) {
      // Bypass error message in Zhihu Hybrid environment
      originalConsole.error(...args);
      return;
    }
    // TODO: Support error stack
    appendOutput("error", indent(showArgs(args)));
  };

  console.group = function group(...args: unknown[]) {
    // TODO: Support group labels, indent line and collapsed groups.
    // Currently, only group indent level is supported.
    consoleState.level++;
    appendOutput(indent(showArgs(args)));
  };
  console.groupCollapsed = function groupCollapsed(...args: unknown[]) {
    // TODO: Support group labels, indent line and collapsed groups.
    // Currently, only group indent level is supported.
    consoleState.level++;
    appendOutput(indent(showArgs(args)));
  };
  console.groupEnd = function groupEnd() {
    consoleState.level = Math.max(0, consoleState.level - 1);
  };

  console.info = function info(...args: unknown[]) {
    appendOutput("info", indent(showArgs(args)));
  };

  console.debug = function debug(...args: unknown[]) {
    if (import.meta.env.DEV && typeof args[0] === "string" && args[0].startsWith("[vite]")) {
      originalConsole.debug(...args);
      return;
    }
    appendOutput(indent(showArgs(args)));
  };

  console.log = function log(...args: unknown[]) {
    if (import.meta.env.DEV && typeof args[0] === "string" && args[0].startsWith("[vite]")) {
      originalConsole.log(...args);
      return;
    }
    appendOutput(indent(showArgs(args)));
  };

  console.trace = function trace(...args: unknown[]) {
    // TODO: Support trace stack
    appendOutput(indent("Trace: " + showArgs(args)));
  };

  console.table = function table(data: unknown, properties?: string[]) {
    if (properties !== undefined && !Array.isArray(properties)) {
      appendError(
        new TypeError(
          'The "properties" argument must be an instance of Array. received ' +
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
            (properties === null ? "null" : `type ${typeof properties}`),
        ),
      );
    } else if (data === null || typeof data !== "object") {
      appendOutput(indent(showArgs([data])));
    } else {
      appendOutput(indent(showTable(data, properties?.map(String))));
    }
  };

  console.time = function time(label: string) {
    if (!consoleState.time[label]) consoleState.time[label] = new Date();
    else appendOutput("warn", indent(`Timer "${label}" already exists`));
  };
  console.timeEnd = function timeEnd(label: string) {
    const start = consoleState.time[label];
    if (start) {
      const timeSpent = new Date().getTime() - start.getTime();
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete consoleState.time[label];
      appendOutput(indent(`${label}: ${timeSpent}ms`));
    } else {
      appendOutput("warn", indent(`Timer "${label}" does not exist`));
    }
  };
  console.timeLog = function timeLog(label: string) {
    const start = consoleState.time[label];
    if (start) {
      const timeSpent = new Date().getTime() - start.getTime();
      appendOutput(indent(`${label}: ${timeSpent}ms`));
    } else {
      appendOutput("warn", indent(`Timer "${label}" does not exist`));
    }
  };

  console.timeStamp = function timeStamp(...args) {
    originalConsole.timeStamp(...args);
  };

  console.warn = function warn(...args: unknown[]) {
    appendOutput("warn", indent(showArgs(args)));
  };
};

const sandboxStore = create({
  isLoading: false,
  isExecuting: false,
  showExecuting: false,

  async load(): Promise<void> {
    if (sandbox || this.isLoading) return;
    this.isLoading = true;

    // Use `requestIdleCallback` if available to avoid blocking UI
    if ("requestIdleCallback" in window)
      return await new Promise((resolve, reject) => {
        window.requestIdleCallback(() => {
          import("../utils/sandbox")
            .then(({ Sandbox }) => {
              sandbox = new Sandbox();
              mockConsole();
              this.isLoading = false;
            })
            .then(resolve, reject);
        });
      });

    const { Sandbox } = await import("../utils/sandbox");
    sandbox = new Sandbox();
    mockConsole();
    this.isLoading = false;
  },

  async execute(code: string, changeExecuting = true): Promise<void> {
    if (!code.trim() || !sandbox || (changeExecuting && this.isExecuting)) return;

    let executingTimer: ReturnType<typeof setTimeout> | null = null;
    if (changeExecuting) {
      this.isExecuting = true;
      executingTimer = setTimeout(() => {
        this.showExecuting = true;
      }, 10);
    }
    executionAbortController = new AbortController();

    historyStore.appendInput(code);

    try {
      const result = await Promise.race<Option.Option<unknown>>([
        sandbox.execute(code),
        new Promise((_, reject) => {
          executionAbortController?.signal.addEventListener("abort", () => {
            reject(new Error("REPL: Execution cancelled"));
          });
        }),
      ]);

      show(result); // Traverse the result to register promises
      // Wait for the next microtask to ensure eager promises are resolved
      await new Promise((resolve) => void Promise.resolve().then(resolve));

      if (Option.isSome(result)) historyStore.appendOutput(show(result.value));
    } catch (error) {
      if (error instanceof Error && error.message === "REPL: Execution cancelled") {
        // Ignore the error if the execution was cancelled
        return;
      }
      historyStore.appendError(error);
    } finally {
      if (changeExecuting) this.isExecuting = false;
      if (executingTimer) {
        clearTimeout(executingTimer);
        this.showExecuting = false;
      }
      executionAbortController = null;
    }
  },

  async recover(history: HistoryEntry[]): Promise<void> {
    this.isExecuting = true;
    const executingTimer = setTimeout(() => {
      this.showExecuting = true;
    }, 10);

    for (let i = 0; i < history.length; i++) {
      const entry = history[i]!;
      if (entry.type !== "input") continue;

      const { endIndex, shouldRecover } = scanHistoryBlock(history as any, i);
      const oldRelatedEntries: Exclude<HistoryEntry, { type: "input" }>[] = [];
      for (let j = i + 1; j < endIndex; j++) {
        const e = history[j]!;
        if (e.type !== "input") oldRelatedEntries.push(e);
      }

      if (!shouldRecover) {
        historyStore.history.push(entry);
        Array.prototype.push.apply(historyStore.history, oldRelatedEntries);
        continue;
      }

      await this.execute(entry.value, false);
    }

    this.isExecuting = false;
    clearTimeout(executingTimer);
    this.showExecuting = false;
  },

  abort() {
    executionAbortController?.abort();
    if (this.isExecuting) {
      this.isExecuting = false;
      historyStore.appendOutput("info", "Execution cancelled");
    }
  },
});

export default sandboxStore;

export const useSandboxStore = hookify("sandbox", sandboxStore);
