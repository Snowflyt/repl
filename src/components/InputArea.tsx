import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { useHistoryStore } from "../stores/history";
import sandboxStore, { useSandboxStore } from "../stores/sandbox";
import { useSettingsStore } from "../stores/settings";
import { highlightCode } from "../utils/highlight";
import { isMacOS } from "../utils/platform";

export interface InputAreaProps {
  ref?: React.Ref<InputAreaRef>;

  inputHistoryIndex: number;
  onInputHistoryIndexChange: (index: number) => void;
}
export interface InputAreaRef {
  focus: () => void;
  rerun: (input: string) => Promise<void>;
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
  const { inputHistory } = useHistoryStore();
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
  const { isExecuting, isLoading, showExecuting } = useSandboxStore();

  const executeCode = useCallback(
    async (customInput?: string) => {
      let inputReset = false;
      const executingTimer = setTimeout(() => {
        inputReset = true;
        if (!customInput) resetInput();
      }, 10);
      await sandboxStore.execute(customInput || input);
      clearTimeout(executingTimer);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!customInput && !inputReset) resetInput();
    },
    [input, resetInput],
  );

  /* Settings */
  const settings = useSettingsStore();

  /* Expose methods */
  useImperativeHandle(
    ref,
    () => ({
      focus: refocus,
      rerun: (input) => executeCode(input),
    }),
    [refocus, executeCode],
  );

  /* Miscellaneous */
  const getPlaceholder = useCallback(() => {
    const isMobile = window.innerWidth < 640;
    const modifierKey = isMacOS() ? "⌘" : "Ctrl";

    if (isExecuting)
      return isMobile ? "Press Ctrl+C to cancel" : (
          "Waiting for execution to complete... Press Ctrl+C to ignore the result"
        );

    return isMobile ?
        `Enter to run, ${modifierKey}+Enter for newline`
      : `Press Enter to execute, ${modifierKey}+Enter for new line, ↑↓ to browse history`;
  }, [isExecuting]);

  return (
    <div className="max-h-[66vh] overflow-y-auto border-t border-[#3d2530] bg-[#1a1520]/50 p-4 backdrop-blur-sm">
      <div className="flex items-start rounded-lg bg-[#1a1520]/70 p-2">
        {/* Icon */}
        <span
          className={clsx(
            "flex items-center px-1 font-mono text-[#ff6e6e] select-none",
            settings.appearance.fontSize === "sm" && "2xl:text-md h-6 text-xs md:text-sm",
            settings.appearance.fontSize === "md" && "h-7 text-sm md:text-base 2xl:text-lg",
            settings.appearance.fontSize === "lg" && "h-7 text-base md:text-lg 2xl:text-xl",
          )}>
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
            className={clsx(
              "pointer-events-none invisible absolute -left-full w-full font-mono break-all whitespace-pre-wrap",
              settings.appearance.fontSize === "sm" &&
                "2xl:text-md text-xs leading-5 sm:leading-6 md:text-sm",
              settings.appearance.fontSize === "md" &&
                "text-sm leading-6 sm:leading-7 md:text-base 2xl:text-lg",
              settings.appearance.fontSize === "lg" &&
                "text-base leading-6 sm:leading-7 md:text-lg 2xl:text-xl",
            )}
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
                // Use `⌘` on Mac, `Ctrl` elsewhere
                const isModifierKeyPressed = isMacOS() ? e.metaKey : e.ctrlKey;

                if (isModifierKeyPressed) {
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
            className={clsx(
              "w-full resize-none appearance-none bg-transparent font-mono break-all whitespace-pre-wrap text-gray-100 placeholder:text-[#6c7086] focus:outline-none",
              settings.appearance.fontSize === "sm" &&
                "2xl:text-md text-xs leading-5 sm:leading-6 md:text-sm",
              settings.appearance.fontSize === "md" &&
                "text-sm leading-6 sm:leading-7 md:text-base 2xl:text-lg",
              settings.appearance.fontSize === "lg" &&
                "text-base leading-6 sm:leading-7 md:text-lg 2xl:text-xl",
            )}
            style={{ WebkitTextFillColor: "transparent" }}
            placeholder={getPlaceholder()}
            rows={rows}
            spellCheck={false}
          />
          <pre
            className={clsx(
              "pointer-events-none absolute top-0 left-0 w-full font-mono break-all whitespace-pre-wrap text-gray-100",
              settings.appearance.fontSize === "sm" &&
                "2xl:text-md text-xs leading-5 sm:leading-6 md:text-sm",
              settings.appearance.fontSize === "md" &&
                "text-sm leading-6 sm:leading-7 md:text-base 2xl:text-lg",
              settings.appearance.fontSize === "lg" &&
                "text-base leading-6 sm:leading-7 md:text-lg 2xl:text-xl",
            )}>
            <code
              dangerouslySetInnerHTML={{
                __html:
                  input ?
                    settings.editor.syntaxHighlighting ?
                      highlightCode(input)
                    : input
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
