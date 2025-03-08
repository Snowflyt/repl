import { Icon } from "@iconify/react";
import { AnsiUp } from "ansi_up";
import { clsx } from "clsx";
import { transparentize } from "color2k";
import { useEffect, useRef, useState } from "react";
import { match } from "ts-pattern";

import { useHistoryStore } from "../stores/history";
import { highlightCode } from "../utils/highlight";

import type { InputAreaRef } from "./InputArea";

const ansi_up = new AnsiUp();

interface HistoryAreaProps {
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJumpToInputHistory?: (index: number) => void;
}

const HistoryArea: React.FC<HistoryAreaProps> = ({ inputAreaRef, onJumpToInputHistory }) => {
  const { history, inputHistory } = useHistoryStore();

  const historyAreaRef = useRef<HTMLDivElement>(null);

  // Scroll to the bottom of the history area when the history changes
  useEffect(() => {
    const element = historyAreaRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [history]);

  return (
    <div
      ref={historyAreaRef}
      className="flex-1 overflow-auto p-4 font-mono text-sm text-gray-100 sm:text-base">
      {history.map((entry, index) => (
        <div key={index} className="group mb-2">
          {match(entry)
            .with({ type: "input" }, ({ value }) => (
              <InputMessage
                value={value}
                inputAreaRef={inputAreaRef}
                onJump={(() => {
                  const index = inputHistory.findIndex((e) => e === entry);
                  return () => onJumpToInputHistory?.(index);
                })()}
              />
            ))
            .with({ type: "output" }, ({ backgroundColor, icon, value }) => (
              <OutputMessage value={value} icon={icon} backgroundColor={backgroundColor} />
            ))
            .with({ type: "error" }, ({ value }) => <ErrorMessage value={value} />)
            .exhaustive()}
        </div>
      ))}
    </div>
  );
};

export default HistoryArea;

const ButtonGroup: React.FC<{
  input: string;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJump?: () => void;
}> = ({ input, inputAreaRef, onJump }) => {
  const [copied, setCopied] = useState(false);

  return (
    <div className="absolute top-0 right-2 flex space-x-1.5 p-0.5">
      {/* Copy to clipboard */}
      <button
        type="button"
        title="Copy to clipboard"
        onClick={() => {
          void navigator.clipboard.writeText(input);
          setCopied(true);
          setTimeout(() => setCopied(false), 500);
        }}
        className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
        <Icon
          icon={copied ? "material-symbols:check" : "material-symbols:content-copy-outline"}
          className="size-4"
        />
      </button>

      {/* Rerun */}
      <button
        type="button"
        title="Rerun"
        onClick={() => {
          void inputAreaRef?.current?.rerun(input);
        }}
        className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
        <Icon icon="material-symbols:replay" className="size-4" />
      </button>

      {/* Load into input */}
      <button
        type="button"
        title="Load into input"
        onClick={onJump}
        className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
        <Icon icon="material-symbols:keyboard-return" className="size-4" />
      </button>
    </div>
  );
};

const InputMessage: React.FC<{
  value: string;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJump?: () => void;
}> = ({ inputAreaRef, onJump, value }) => (
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
        <code dangerouslySetInnerHTML={{ __html: highlightCode(value) }} />
      </pre>
      <ButtonGroup input={value} inputAreaRef={inputAreaRef} onJump={onJump} />
    </div>
  </div>
);

const ANSIText: React.FC<{
  value: string;
  className?: string;
  style?: React.CSSProperties;
}> = ({ className, style, value }) => (
  <pre
    className={className}
    style={style}
    dangerouslySetInnerHTML={{ __html: ansi_up.ansi_to_html(value) }}
  />
);

const OutputMessage: React.FC<{
  value: string;
  icon?: React.ReactNode;
  backgroundColor?: string;
}> = ({ backgroundColor, icon, value }) => {
  if (icon) {
    return (
      <div className="flex">
        <span className="mt-1 inline-block w-6 text-[#ff6e6e] select-none">{icon}</span>
        <ANSIText value={value} className="break-all whitespace-pre-wrap" />
      </div>
    );
  }

  return (
    <ANSIText
      value={value}
      className={clsx(
        "mt-1 break-all whitespace-pre-wrap",
        backgroundColor && "rounded-lg px-3.5 py-2",
      )}
      style={backgroundColor ? { backgroundColor: transparentize(backgroundColor, 0.8) } : {}}
    />
  );
};

const ErrorMessage: React.FC<{ value: string }> = ({ value }) => (
  <ANSIText
    value={value}
    className="mt-1 rounded-lg bg-[#dc3545]/50 px-4 py-2 break-all whitespace-pre-wrap"
  />
);
