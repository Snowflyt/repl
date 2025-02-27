import { Icon } from "@iconify/react";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";

import { useHistoryStore } from "../stores/history";
import sandboxStore, { useSandboxStore } from "../stores/sandbox";
import { highlightCode } from "../utils/highlight";

export interface InputAreaProps {
  ref?: React.Ref<InputAreaRef>;

  inputHistoryIndex: number;
  onInputHistoryIndexChange: (index: number) => void;
}
export interface InputAreaRef {
  focus: () => void;
}

const InputArea: React.FC<InputAreaProps> = ({
  inputHistoryIndex,
  onInputHistoryIndexChange,
  ref,
}) => {
  /* Input */
  const [input, setInput] = useState("");
  const tempInputRef = useRef("");
  const [rows, setRows] = useState(1);

  const resetInput = useCallback(() => {
    setInput("");
    setRows(1);
    onInputHistoryIndexChange(-1);
    tempInputRef.current = "";
  }, [onInputHistoryIndexChange]);

  const inputAreaRef = useRef<HTMLTextAreaElement>(null);

  const refocus = useCallback(() => {
    const element = inputAreaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      focus: refocus,
    }),
    [refocus],
  );

  const measureRef = useRef<HTMLPreElement>(null);

  const updateRows = useCallback((text: string) => {
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
  }, []);

  /* History */
  const history = useHistoryStore((state) => state.history);
  const inputHistory = useMemo(() => history.filter((e) => e.type === "input"), [history]);
  const prevInputHistoryIndexRef = useRef(inputHistoryIndex);

  useEffect(() => {
    if (inputHistoryIndex === prevInputHistoryIndexRef.current) return;

    const prevInputHistoryIndex = prevInputHistoryIndexRef.current;
    prevInputHistoryIndexRef.current = inputHistoryIndex;

    if (inputHistoryIndex === -1) {
      setInput(tempInputRef.current);
      updateRows(tempInputRef.current);
      return;
    }

    if (prevInputHistoryIndex === -1) tempInputRef.current = input;

    const targetEntry = inputHistory[inputHistoryIndex];
    if (targetEntry) {
      setInput(targetEntry.value);
      updateRows(targetEntry.value);
      refocus();
    }
  }, [inputHistory, inputHistoryIndex, updateRows, refocus, input]);

  /* Sandbox */
  const isLoading = useSandboxStore((state) => state.isLoading);
  const isExecuting = useSandboxStore((state) => state.isExecuting);
  const [showExecuting, setShowExecuting] = useState(false);

  const executeCode = useCallback(async () => {
    let inputReset = false;
    const executingTimer = setTimeout(() => {
      setShowExecuting(true);
      inputReset = true;
      resetInput();
    }, 10);
    await sandboxStore.execute(input);
    clearTimeout(executingTimer);
    setShowExecuting(false);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!inputReset) resetInput();
  }, [input, resetInput]);

  const getPlaceholder = useCallback(() => {
    const isMobile = window.innerWidth < 640;
    if (isExecuting) {
      return isMobile ? "Press Ctrl+C to cancel" : (
          "Waiting for execution to complete... Press Ctrl+C to ignore the result"
        );
    }
    return isMobile ?
        "Enter to run, Ctrl+Enter for newline"
      : "Press Enter to execute, Ctrl+Enter for new line, ↑↓ to browse history";
  }, [isExecuting]);

  return (
    <div className="max-h-[66vh] overflow-y-auto border-t border-[#3d2530] bg-[#1a1520]/50 p-4 backdrop-blur-sm">
      <div className="flex items-start rounded-lg bg-[#1a1520]/70 p-2">
        {/* Icon */}
        <span className="flex h-7 items-center px-1 font-mono text-sm text-[#ff6e6e] select-none md:text-base 2xl:text-lg">
          {
            <Icon
              icon={showExecuting ? "svg-spinners:180-ring" : "material-symbols:arrow-forward-ios"}
              className="size-3 md:size-4"
            />
          }
        </span>

        {/* Input */}
        <div className="relative ml-2 w-full">
          <pre
            ref={measureRef}
            className="pointer-events-none invisible absolute -left-full w-full font-mono text-sm leading-6 break-all whitespace-pre-wrap sm:leading-7 md:text-base 2xl:text-lg"
          />

          <textarea
            ref={inputAreaRef}
            value={input}
            disabled={isLoading}
            onKeyDown={(e) => {
              if (isExecuting) {
                if (e.ctrlKey && e.key === "c") {
                  e.preventDefault();
                  sandboxStore.abort();
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

                if (isFirstLine && inputHistoryIndex !== 0) {
                  onInputHistoryIndexChange(
                    (inputHistoryIndex === -1 ? inputHistory.length : inputHistoryIndex) - 1,
                  );
                  e.preventDefault();
                }
              } else if (e.key === "ArrowDown") {
                const textarea = e.currentTarget;
                const afterCaret = textarea.value.slice(textarea.selectionStart);
                const isLastLine = !afterCaret.includes("\n");

                if (isLastLine && inputHistoryIndex >= 0) {
                  onInputHistoryIndexChange(
                    inputHistoryIndex >= inputHistory.length - 1 ? -1 : inputHistoryIndex + 1,
                  );
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
            className="w-full resize-none appearance-none bg-transparent font-mono text-sm leading-6 break-all whitespace-pre-wrap text-gray-100 placeholder:text-[#6c7086] focus:outline-none sm:leading-7 md:text-base 2xl:text-lg"
            style={{ WebkitTextFillColor: "transparent" }}
            placeholder={getPlaceholder()}
            rows={rows}
            spellCheck={false}
          />
          <pre className="pointer-events-none absolute top-0 left-0 w-full font-mono text-sm leading-6 break-all whitespace-pre-wrap text-gray-100 sm:leading-7 md:text-base 2xl:text-lg">
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
  );
};

export default InputArea;
