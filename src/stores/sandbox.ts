import { Option } from "effect";

import type { ConsoleListener, Sandbox } from "../utils/sandbox";
import { show, showTable } from "../utils/show";
import { createStore, hookify } from "../utils/store";

import historyStore from "./history";

const { appendError, appendInput, appendOutput, clear: clearHistory } = historyStore;

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

const consoleListener: ConsoleListener = (type, ...args) => {
  if (type === "clear") {
    clearHistory();
  } else if (type === "assert") {
    if (args[0] === false)
      appendOutput("error", indent("Assertion failed: " + showArgs(args.slice(1))));
  } else if (type === "count") {
    const label = String(args[0] ?? "default");
    const count = consoleState.count[label] ?? 0;
    consoleState.count[label] = count + 1;
    appendOutput(indent(`${label}: ${count + 1}`));
  } else if (type === "countReset") {
    const label = args[0] as string;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete consoleState.count[label];
  } else if (type === "dir" || type === "dirxml") {
    const item = args[0];
    const options = args[1] != null ? args[1] : {};
    appendOutput(indent(show(item, options)));
  } else if (type === "error") {
    // TODO: Support error stack
    appendOutput("error", indent(showArgs(args)));
  } else if (type === "group" || type === "groupCollapsed") {
    // TODO: Support group labels, indent line and collapsed groups.
    // Currently, only group indent level is supported.
    consoleState.level++;
    appendOutput(indent(showArgs(args)));
  } else if (type === "groupEnd") {
    consoleState.level = Math.max(0, consoleState.level - 1);
  } else if (type === "info") {
    appendOutput("info", indent(showArgs(args)));
  } else if (type === "debug" || type === "log") {
    appendOutput(indent(showArgs(args)));
  } else if (type === "trace") {
    // TODO: Support trace stack
    appendOutput(indent("Trace: " + showArgs(args)));
  } else if (type === "table") {
    if (args.length > 1 && args[1] !== undefined && !Array.isArray(args[1])) {
      appendError(
        new TypeError(
          'The "properties" argument must be an instance of Array. received ' +
            (args[1] === null ? "null" : `type ${typeof args[1]}`),
        ),
      );
    } else if (args[0] === null || typeof args[0] !== "object") {
      appendOutput(indent(showArgs([args[0]])));
    } else {
      appendOutput(indent(showTable(args[0], args[1]?.map(String))));
    }
  } else if (type === "time") {
    const label = String(args[0] ?? "default");
    if (!consoleState.time[label]) consoleState.time[label] = new Date();
    else appendOutput("warn", indent(`Timer "${label}" already exists`));
  } else if (type === "timeEnd" || type === "timeLog") {
    const label = String(args[0] ?? "default");
    const start = consoleState.time[label];
    if (start) {
      const timeSpent = new Date().getTime() - start.getTime();
      if (type === "timeEnd")
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete consoleState.time[label];
      appendOutput(indent(`${label}: ${timeSpent}ms`));
    } else {
      appendOutput("warn", indent(`Timer "${label}" does not exist`));
    }
  } else if (type === "timeStamp") {
    console.timeStamp(...args);
  } else if (type === "warn") {
    appendOutput("warn", indent(showArgs(args)));
  }
};

const sandboxStore = createStore({
  isLoading: false,
  isExecuting: false,

  on: {
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
                void sandbox.checkCdnAccessibility();
                sandbox.addConsoleListener(consoleListener);
                this.isLoading = false;
              })
              .then(resolve, reject);
          });
        });

      const { Sandbox } = await import("../utils/sandbox");
      sandbox = new Sandbox();
      void sandbox.checkCdnAccessibility();
      sandbox.addConsoleListener(consoleListener);
      this.isLoading = false;
    },

    async execute(code: string): Promise<void> {
      if (!code.trim() || !sandbox || this.isExecuting) return;

      this.isExecuting = true;
      executionAbortController = new AbortController();

      appendInput(code);

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

        if (Option.isSome(result)) appendOutput(show(result.value));
      } catch (error) {
        if (error instanceof Error && error.message === "REPL: Execution cancelled") {
          // Ignore the error if the execution was cancelled
          return;
        }
        appendError(error);
      } finally {
        this.isExecuting = false;
        executionAbortController = null;
      }
    },

    abort() {
      executionAbortController?.abort();
      if (this.isExecuting) {
        this.isExecuting = false;
        appendOutput("info", "Execution cancelled");
      }
    },
  },
});

export default sandboxStore;

export const useSandboxStore = hookify("sandbox", sandboxStore);
