import { Icon } from "@iconify/react";
import { AnsiUp } from "ansi_up";
import { clsx } from "clsx";
import { transparentize } from "color2k";
import { Option } from "effect";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import "highlight.js/styles/github-dark.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { match } from "ts-pattern";
import { useImmer } from "use-immer";

import type { ConsoleListener } from "./sandbox";
import { show, showTable } from "./show";

hljs.registerLanguage("typescript", typescript);

const ansi_up = new AnsiUp();

type HistoryEntry =
  | { type: "input"; value: string }
  | { type: "output"; value: string; icon?: React.ReactNode; backgroundColor?: string }
  | { type: "error"; value: string };

const App: React.FC = () => {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempInput, setTempInput] = useState("");
  const [rows, setRows] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [showLoading, setShowLoading] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [showExecuting, setShowExecuting] = useState(false);
  const executionAbortController = useRef<AbortController | null>(null);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Measure size of the input
  const measureRef = useRef<HTMLPreElement>(null);

  const [consoleState, updateConsoleState] = useImmer({
    level: 0,
    count: {} as Record<string, number>,
    time: {} as Record<string, Date>,
  });

  const sandboxRef = useRef<InstanceType<typeof import("./sandbox").Sandbox> | null>(null);
  const sandbox = sandboxRef.current;

  useEffect(() => {
    const loadingTimer = setTimeout(() => {
      setShowLoading(true);
    }, 500);

    // Use `requestIdleCallback` if available to avoid blocking UI
    if ("requestIdleCallback" in window)
      window.requestIdleCallback(() => {
        import("./sandbox").then(({ Sandbox }) => {
          sandboxRef.current = new Sandbox();
          setIsLoading(false);
          clearTimeout(loadingTimer);
          setTimeout(() => inputRef.current?.focus(), 100);
        });
      });
    else
      import("./sandbox").then(({ Sandbox }) => {
        sandboxRef.current = new Sandbox();
        setIsLoading(false);
        clearTimeout(loadingTimer);
        setTimeout(() => inputRef.current?.focus(), 100);
      });

    return () => clearTimeout(loadingTimer);
  }, []);

  const appendOutput = useCallback(
    (...args: [value: string] | [type: "info" | "warn" | "error", value: string]) => {
      if (args.length === 1) {
        setHistory((prev) => [...prev, { type: "output", value: args[0] }]);
        return;
      }

      const [type, value] = args;
      setHistory((prev) => [
        ...prev,
        match(type)
          .returnType<HistoryEntry>()
          .with("info", () => ({
            type: "output",
            value,
            icon: <Icon icon="material-symbols:info-outline" className="text-blue-100" />,
          }))
          .with("warn", () => ({
            type: "output",
            value,
            icon: <Icon icon="carbon:warning-alt-filled" className="text-[#ffc107]" />,
            backgroundColor: "#ffc107",
          }))
          .with("error", () => ({
            type: "output",
            value,
            icon: <Icon icon="gridicons:cross-circle" className="mt-0.5 text-[#dc3545]" />,
            backgroundColor: "#dc3545",
          }))
          .exhaustive(),
      ]);
    },
    [],
  );

  const appendError = useCallback((error: unknown) => {
    setHistory((prev) => [
      ...prev,
      {
        type: "error",
        value:
          "Uncaught " + (error instanceof Error ? `${error.name}: ${error.message}` : show(error)),
      },
    ]);
  }, []);

  useEffect(() => {
    if (!sandbox) return;

    const indent = (str: string) =>
      str
        .split("\n")
        .map((line) => " ".repeat(consoleState.level * 2) + line)
        .join("\n");
    const showArgs = (args: unknown[]) =>
      args.map((arg) => (typeof arg === "string" ? arg : show(arg))).join(" ");

    const listener: ConsoleListener = (type, ...args) => {
      if (type === "clear") {
        setHistory([]);
      } else if (type === "assert") {
        if (args[0] === false)
          appendOutput("error", indent("Assertion failed: " + showArgs(args.slice(1))));
      } else if (type === "count") {
        const label = String(args[0] ?? "default");
        const count = consoleState.count[label] ?? 0;
        updateConsoleState((draft) => void (draft.count[label] = count + 1));
        appendOutput(indent(`${label}: ${count + 1}`));
      } else if (type === "countReset") {
        const label = args[0] as string;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        updateConsoleState((draft) => void delete draft.count[label]);
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
        updateConsoleState((draft) => void draft.level++);
        appendOutput(indent(showArgs(args)));
      } else if (type === "groupEnd") {
        updateConsoleState((draft) => void (draft.level = draft.level > 0 ? draft.level - 1 : 0));
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
        if (!consoleState.time[label])
          updateConsoleState((draft) => void (draft.time[label] = new Date()));
        else appendOutput("warn", indent(`Timer "${label}" already exists`));
      } else if (type === "timeEnd" || type === "timeLog") {
        const label = String(args[0] ?? "default");
        const start = consoleState.time[label];
        if (start) {
          const timeSpent = new Date().getTime() - start.getTime();
          if (type === "timeEnd")
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            updateConsoleState((draft) => void delete draft.time[label]);
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

    sandbox.addConsoleListener(listener);
    return () => {
      sandbox.removeConsoleListener(listener);
    };
  }, [sandbox, consoleState, updateConsoleState, appendOutput, appendError]);

  useEffect(() => {
    // Scroll to the bottom
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [history]);

  const executeCode = async () => {
    if (!input.trim() || !sandbox || isExecuting) return;

    setIsExecuting(true);
    executionAbortController.current = new AbortController();

    setHistory((prev) => [...prev, { type: "input", value: input }]);

    let inputReset = false;
    const resetInput = () => {
      if (inputReset) return;
      inputReset = true;
      setInput("");
      setRows(1);
      setHistoryIndex(-1);
      setTempInput("");
    };

    const executingTimer = setTimeout(() => {
      setShowExecuting(true);
      resetInput();
    }, 10);

    try {
      const result = await Promise.race<Option.Option<unknown>>([
        sandbox.execute(input),
        new Promise((_, reject) => {
          executionAbortController.current?.signal.addEventListener("abort", () => {
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
      setIsExecuting(false);
      clearTimeout(executingTimer);
      setShowExecuting(false);
      resetInput();
      executionAbortController.current = null;
    }
  };

  const updateRows = (text: string) => {
    if (!measureRef.current) return;

    // Replace each empty line with a space so that empty lines are measured properly.
    measureRef.current.textContent =
      text ?
        text
          .split("\n")
          .map((line) => (line === "" ? " " : line))
          .join("\n")
      : " ";

    const totalHeight = measureRef.current.scrollHeight;
    const lineHeight = parseInt(window.getComputedStyle(measureRef.current).lineHeight);

    // Clear the content to prevent vertical scrollbar from appearing
    measureRef.current.textContent = "";

    const actualRows = Math.ceil(totalHeight / lineHeight);
    setRows(Math.max(1, actualRows));
  };

  const highlightCode = (code: string) => {
    return hljs.highlight(code, { language: "typescript" }).value;
  };

  const handleCopy = useCallback((text: string, index: number) => {
    void navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 500);
  }, []);

  const handleJumpToHistory = useCallback(
    (index: number) => {
      const inputHistory = history.filter((entry) => entry.type === "input");
      const targetEntry = inputHistory[inputHistory.length - 1 - index];
      if (targetEntry) {
        setHistoryIndex(index);
        setInput(targetEntry.value);
        updateRows(targetEntry.value);
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(targetEntry.value.length, targetEntry.value.length);
        });
      }
    },
    [history],
  );

  const buttonGroup = (input: string, index: number) => (
    <div className="absolute top-0 right-2 flex space-x-1.5 p-0.5">
      <button
        title="Copy to clipboard"
        onClick={() => handleCopy(input, index)}
        className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
        <Icon
          icon={
            copiedIndex === index ? "material-symbols:check" : (
              "material-symbols:content-copy-outline"
            )
          }
          className="size-4"
        />
      </button>
      <button
        title="Load into input"
        onClick={() =>
          handleJumpToHistory(
            history.filter((e) => e.type === "input").length -
              1 -
              history.filter((e, i) => e.type === "input" && i <= index).length +
              1,
          )
        }
        className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
        <Icon icon="material-symbols:keyboard-return" className="size-4" />
      </button>
    </div>
  );

  const getPlaceholder = () => {
    const isMobile = window.innerWidth < 640;
    if (isExecuting) {
      return isMobile ? "Press Ctrl+C to cancel" : (
          "Waiting for execution to complete... Press Ctrl+C to ignore the result"
        );
    }
    return isMobile ?
        "Enter to run, Ctrl+Enter for newline"
      : "Press Enter to execute, Ctrl+Enter for new line, ↑↓ to browse history";
  };

  return (
    <div className="flex h-screen flex-col bg-[#1a1520] bg-[radial-gradient(ellipse_at_top_right,#4d2535_5%,transparent_50%),radial-gradient(circle_at_30%_80%,#2d1f25_0%,transparent_40%),radial-gradient(circle_at_70%_60%,#3d2530_0%,transparent_40%),linear-gradient(45deg,#1a1520_30%,#251a25_70%,#1a1520_100%)]">
      <div
        ref={outputRef}
        className="flex-1 overflow-auto p-4 font-mono text-sm text-gray-100 sm:text-base">
        {isLoading && showLoading && (
          <div className="flex h-full items-center justify-center">
            <div className="rounded-lg border border-[#3d2530] bg-[#1a1520]/70 px-6 py-4 shadow-lg backdrop-blur-sm">
              <div className="flex flex-row items-center space-x-3">
                <Icon icon="svg-spinners:180-ring" className="size-4" />
                <div className="text-gray-400">Loading JavaScript/TypeScript runtime...</div>
              </div>
            </div>
          </div>
        )}

        {history.map((entry, index) => (
          <div key={index} className="group mb-2">
            {match(entry)
              .with({ type: "input" }, ({ value }) => (
                <div className="flex flex-row">
                  <div className="flex flex-col">
                    {value.split("\n").map((_, i) => (
                      <span key={i} className="inline-block w-7 text-[#ff6e6e] select-none">
                        {i === 0 ? ">>" : ".."}
                      </span>
                    ))}
                  </div>
                  <div className="relative flex-1">
                    <pre className="w-full bg-transparent break-all whitespace-pre-wrap">
                      <code
                        dangerouslySetInnerHTML={{
                          __html: highlightCode(value),
                        }}
                      />
                    </pre>
                    {buttonGroup(value, index)}
                  </div>
                </div>
              ))
              .with({ type: "output" }, ({ backgroundColor, icon, value }) =>
                icon ?
                  <div
                    className={clsx(
                      "mt-1 flex flex-row space-x-0.5",
                      backgroundColor && "rounded-lg px-3.5 py-2",
                    )}
                    style={
                      backgroundColor ?
                        { backgroundColor: transparentize(backgroundColor, 0.8) }
                      : {}
                    }>
                    <span className="mt-1 inline-block w-6 text-[#ff6e6e] select-none">{icon}</span>
                    <pre
                      className="break-all whitespace-pre-wrap"
                      dangerouslySetInnerHTML={{ __html: ansi_up.ansi_to_html(value) }}
                    />
                  </div>
                : <pre
                    className={clsx(
                      "mt-1 break-all whitespace-pre-wrap",
                      backgroundColor && "rounded-lg px-3.5 py-2",
                    )}
                    style={
                      backgroundColor ?
                        { backgroundColor: transparentize(backgroundColor, 0.8) }
                      : {}
                    }
                    dangerouslySetInnerHTML={{ __html: ansi_up.ansi_to_html(value) }}
                  />,
              )
              .with({ type: "error" }, ({ value }) => (
                <pre
                  className="mt-1 rounded-lg bg-[#dc3545]/50 px-4 py-2 break-all whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ __html: ansi_up.ansi_to_html(value) }}
                />
              ))
              .exhaustive()}
          </div>
        ))}
      </div>

      {/* Input area */}
      <div className="max-h-[66vh] overflow-y-auto border-t border-[#3d2530] bg-[#1a1520]/50 p-4 backdrop-blur-sm">
        <div className="flex items-start rounded-lg bg-[#1a1520]/70 p-2">
          <span className="flex h-7 items-center px-1 pt-0.5 font-mono text-sm text-[#ff6e6e] select-none md:text-lg">
            {
              <Icon
                icon={
                  showExecuting ? "svg-spinners:180-ring" : "material-symbols:arrow-forward-ios"
                }
                className="size-3 md:size-4"
              />
            }
          </span>
          <div className="relative ml-2 w-full">
            <pre
              ref={measureRef}
              className="pointer-events-none invisible absolute -left-full w-full font-mono text-sm leading-6 break-all whitespace-pre-wrap sm:leading-7 md:text-lg"
            />

            <textarea
              ref={inputRef}
              value={input}
              disabled={isLoading}
              onKeyDown={(e) => {
                if (isExecuting) {
                  if (e.ctrlKey && e.key === "c") {
                    e.preventDefault();
                    executionAbortController.current?.abort();
                    setIsExecuting(false);
                    setShowExecuting(false);
                    appendOutput("info", "Execution cancelled");
                  }
                  return;
                }

                if (e.key === "Enter") {
                  if (e.ctrlKey) {
                    e.preventDefault();
                    const textarea = e.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const newValue = input.slice(0, start) + "\n" + input.slice(end);
                    setInput(newValue);
                    updateRows(newValue);
                    setTimeout(() => {
                      textarea.selectionStart = textarea.selectionEnd = start + 1;
                    });
                  } else {
                    e.preventDefault();
                    void executeCode();
                  }
                } else if (e.key === "ArrowUp") {
                  const textarea = e.currentTarget;
                  const beforeCaret = textarea.value.slice(0, textarea.selectionStart);
                  const isFirstLine = !beforeCaret.includes("\n");

                  const inputHistory = history.filter((entry) => entry.type === "input");
                  if (isFirstLine && historyIndex < inputHistory.length - 1) {
                    if (historyIndex === -1) setTempInput(input);
                    const newIndex = historyIndex + 1;
                    setHistoryIndex(newIndex);
                    setInput(inputHistory[inputHistory.length - 1 - newIndex]!.value);
                    updateRows(inputHistory[inputHistory.length - 1 - newIndex]!.value);
                    e.preventDefault();
                  }
                } else if (e.key === "ArrowDown") {
                  const textarea = e.currentTarget;
                  const afterCaret = textarea.value.slice(textarea.selectionStart);
                  const isLastLine = !afterCaret.includes("\n");

                  if (isLastLine && historyIndex > -1) {
                    const newIndex = historyIndex - 1;
                    setHistoryIndex(newIndex);
                    if (newIndex === -1) {
                      setInput(tempInput);
                      updateRows(tempInput);
                    } else {
                      const inputHistory = history.filter((entry) => entry.type === "input");
                      setInput(inputHistory[inputHistory.length - 1 - newIndex]!.value);
                      updateRows(inputHistory[inputHistory.length - 1 - newIndex]!.value);
                    }
                    e.preventDefault();
                  }
                }
              }}
              onInput={(e) => {
                if (isExecuting) return;
                const newValue = (e.target as HTMLTextAreaElement).value;
                setInput(newValue);
                updateRows(newValue);
              }}
              className="w-full resize-none appearance-none bg-transparent font-mono text-sm leading-6 break-all whitespace-pre-wrap text-gray-100 placeholder:text-[#6c7086] focus:outline-none sm:leading-7 md:text-lg"
              style={{ WebkitTextFillColor: "transparent" }}
              placeholder={getPlaceholder()}
              rows={rows}
              spellCheck={false}
            />
            <pre className="pointer-events-none absolute top-0 left-0 w-full font-mono text-sm leading-6 break-all whitespace-pre-wrap text-gray-100 sm:leading-7 md:text-lg">
              <code
                dangerouslySetInnerHTML={{
                  __html:
                    input ?
                      highlightCode(input)
                    : `<span class="text-[#6c7086]">${getPlaceholder()}</span>`,
                }}
              />
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
