import { Icon } from "@iconify/react";
import { AnsiUp } from "ansi_up";
import { clsx } from "clsx";
import { transparentize } from "color2k";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { match } from "ts-pattern";

import { useIsTouchDevice } from "../hooks";
import historyStore, { useHistoryStore } from "../stores/history";
import type { HistoryEntry } from "../types";
import { highlightCode } from "../utils/highlight";

import type { InputAreaRef } from "./InputArea";

const ansi_up = new AnsiUp();

interface HistoryAreaProps {
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJumpToInputHistory?: (index: number) => void;
}

const HistoryArea: React.FC<HistoryAreaProps> = ({ inputAreaRef, onJumpToInputHistory }) => {
  const history = useHistoryStore((state) => state.history);

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
      className="relative flex-1 overflow-auto p-4 font-mono text-sm text-gray-100 sm:text-base">
      {history.map((entry, index) => (
        <div key={index} className="group mb-2">
          <HistoryItem
            entry={entry}
            inputAreaRef={inputAreaRef}
            onJumpToInputHistory={onJumpToInputHistory}
          />
        </div>
      ))}
    </div>
  );
};

export default HistoryArea;

const HistoryItem = React.memo<{
  entry: HistoryEntry;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJumpToInputHistory?: (index: number) => void;
}>(function HistoryItem({ entry, inputAreaRef, onJumpToInputHistory }) {
  return (
    <div className="group mb-2">
      {match(entry)
        .with({ type: "input" }, ({ value }) => (
          <InputMessage
            value={value}
            inputAreaRef={inputAreaRef}
            onJump={(() => {
              const index = historyStore.$get().inputHistory.findIndex((e) => e === entry);
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
  );
});

// Maintain a global reference for tracking open menus
let openMenuId: string | null = null;

const ButtonGroup = React.memo<{
  input: string;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJump?: () => void;
}>(function ButtonGroup({ input, inputAreaRef, onJump }) {
  const [copied, setCopied] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const isTouchDevice = useIsTouchDevice();

  // Generate unique ID for this instance
  // eslint-disable-next-line sonarjs/pseudo-random
  const menuId = useRef(`menu-${Math.random().toString(36).substring(2, 9)}`);

  // Close dropdown when clicking outside or opening another menu
  useEffect(() => {
    if (showMenu) {
      // Register this as the active menu
      openMenuId = menuId.current;

      const handleClick = (e: MouseEvent) => {
        // Ensure target is an Element before using closest
        if (!(e.target instanceof Element)) {
          setShowMenu(false);
          return;
        }

        // Check if the click is on this menu button
        const target = e.target;
        const isMenuButton = target.closest(`[data-menu-id="${menuId.current}"]`);

        // Close if clicked outside or if another menu was opened
        if (!isMenuButton || openMenuId !== menuId.current) {
          setShowMenu(false);
        }
      };

      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [showMenu]);

  return (
    <div className="absolute top-0 right-0 flex items-center p-0.5">
      {/* Indicator for hidden actions (only when not hovering) */}
      {!isTouchDevice && (
        <div className="mr-1.5 group-hover:hidden">
          <div
            className="rounded-md border border-gray-700/50 bg-black/50 p-1 text-gray-500"
            title="Hover for more options">
            <Icon icon="material-symbols:more-horiz" className="size-4" />
          </div>
        </div>
      )}

      {/* Show secondary buttons on hover for non-touch devices */}
      {!isTouchDevice && (
        <div className="mr-1.5 hidden space-x-1.5 group-hover:flex">
          <button
            type="button"
            title="Copy to clipboard"
            onClick={(e) => {
              e.stopPropagation();
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

          <button
            type="button"
            title="Rerun"
            onClick={(e) => {
              e.stopPropagation();
              void inputAreaRef?.current?.rerun(input);
            }}
            className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <Icon icon="material-symbols:replay" className="size-4" />
          </button>
        </div>
      )}

      {/* Touch-device menu button */}
      {isTouchDevice && (
        <div className="mr-1.5">
          <button
            type="button"
            title="Actions"
            data-menu-id={menuId.current}
            onClick={(e) => {
              e.stopPropagation();
              // Close other menus when opening this one
              if (!showMenu && openMenuId && openMenuId !== menuId.current) {
                // Trigger a document click to close other menus
                document.dispatchEvent(new MouseEvent("click"));
              }
              setShowMenu(!showMenu);
            }}
            className="rounded-md border border-gray-700/50 bg-black/70 p-1.5 text-gray-400 hover:bg-white/10 hover:text-gray-200">
            <Icon icon="material-symbols:more-vert" className="size-4" />
          </button>

          {/* Touch-device dropdown menu */}
          {showMenu && (
            <div className="absolute top-8 right-0 z-10 min-w-32 rounded-md border border-gray-700/50 bg-black/90 py-0.5 shadow-lg">
              <button
                type="button"
                className="flex w-full items-center px-2.5 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  void navigator.clipboard.writeText(input);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 500);
                  setShowMenu(false);
                }}>
                <Icon
                  icon={copied ? "material-symbols:check" : "material-symbols:content-copy-outline"}
                  className="mr-2 size-3.5"
                />
                Copy
              </button>
              <button
                type="button"
                className="flex w-full items-center px-2.5 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  void inputAreaRef?.current?.rerun(input);
                  setShowMenu(false);
                }}>
                <Icon icon="material-symbols:replay" className="mr-2 size-3.5" />
                Rerun
              </button>
              <button
                type="button"
                className="flex w-full items-center px-2.5 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  onJump?.();
                  setShowMenu(false);
                }}>
                <Icon icon="material-symbols:keyboard-return" className="mr-2 size-3.5" />
                Load
              </button>
            </div>
          )}
        </div>
      )}

      {/* Primary action always visible on non-touch devices */}
      {!isTouchDevice && (
        <button
          type="button"
          title="Load into input"
          onClick={(e) => {
            e.stopPropagation();
            onJump?.();
          }}
          className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-white/10 hover:text-gray-200">
          <Icon icon="material-symbols:keyboard-return" className="size-4" />
        </button>
      )}
    </div>
  );
});

const InputMessage = React.memo<{
  value: string;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJump?: () => void;
}>(function InputMessage({ inputAreaRef, onJump, value }) {
  return (
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
});

const ANSIText = React.memo<{
  value: string;
  className?: string;
  style?: React.CSSProperties;
}>(function ANSIText({ className, style, value }) {
  return (
    <pre
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: ansi_up.ansi_to_html(value) }}
    />
  );
});

const OutputMessage = React.memo<{
  value: string;
  icon?: React.ReactNode;
  backgroundColor?: string;
}>(function OutputMessage({ backgroundColor, icon, value }) {
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
});

const ErrorMessage = React.memo<{ value: string }>(function ErrorMessage({ value }) {
  return (
    <ANSIText
      value={value}
      className="mt-1 rounded-lg bg-[#dc3545]/50 px-4 py-2 break-all whitespace-pre-wrap"
    />
  );
});
