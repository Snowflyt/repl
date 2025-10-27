import { Icon } from "@iconify/react";
import { AnsiUp } from "ansi_up";
import { clsx } from "clsx";
import { transparentize } from "color2k";
import domtoimage from "dom-to-image-more";
import { Marked } from "marked";
import { match } from "megamatch";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useHasScrollbar, useIsTouchDevice, useScrollbarWidth } from "../hooks";
import { completionService } from "../services/completion/service";
import historyStore, { useHistoryStore } from "../stores/history";
import notificationsStore from "../stores/notifications";
import sandboxStore from "../stores/sandbox";
import { useSettingsStore } from "../stores/settings";
import type { HistoryEntry, MimeBundle } from "../types";
import { highlightCode } from "../utils/highlight";
import { liveNodeRegistry } from "../utils/sandbox";

import HeaderControls from "./HeaderControls";
import type { InputAreaRef } from "./InputArea";
import NotificationCenter from "./NotificationCenter";
import SettingsPanel from "./SettingsPanel";

const ansi_up = new AnsiUp();

interface HistoryAreaProps {
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJumpToInputHistory?: (index: number) => void;
}

const HistoryArea: React.FC<HistoryAreaProps> = ({ inputAreaRef, onJumpToInputHistory }) => {
  const history = useHistoryStore((state) => state.history);
  const historyAreaRef = useRef<HTMLDivElement>(null);

  const hasScrollbar = useHasScrollbar(historyAreaRef, [history]);
  const scrollbarWidth = useScrollbarWidth();
  const [notificationBottom, setNotificationBottom] = useState<number>(16);

  // Recalculate notification bottom offset so it doesn't overlap the InputArea (which sits below HistoryArea)
  useEffect(() => {
    const recalculate = () => {
      const el = historyAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const gap = Math.max(0, Math.round(window.innerHeight - rect.bottom));
      // Keep a base 16px padding above the InputArea
      setNotificationBottom(16 + gap);
    };
    recalculate();
    const onResize = () => recalculate();
    window.addEventListener("resize", onResize);
    let ro: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== "undefined" && historyAreaRef.current) {
        ro = new ResizeObserver(recalculate);
        ro.observe(historyAreaRef.current);
      }
    } catch (e) {
      // Ignore
    }
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, []);

  // Scroll to the bottom of the history area when the history changes
  useEffect(() => {
    const element = historyAreaRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [history]);

  // When rich content (html/img) resizes after initial render, scroll to bottom again
  useEffect(() => {
    const handler = () => {
      const el = historyAreaRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    window.addEventListener("repl:content-resized", handler);
    return () => window.removeEventListener("repl:content-resized", handler);
  }, []);

  const [showSettings, setShowSettings] = useState(false);
  const settings = useSettingsStore();

  // Subscribe to ATA events and drive notifications
  useEffect(() => {
    const unsubscribe = completionService.onAta((ev) => {
      if (ev.phase === "started") {
        const pkgs: string[] = Array.isArray(ev.packages) ? ev.packages : [];
        const head = pkgs.slice(0, 3).join(", ");
        const more = pkgs.length > 3 ? ` and ${pkgs.length - 3} more` : "";
        let msg: string;
        if (pkgs.length) msg = `Acquiring type definitions for ${head}${more}…`;
        else msg = "Acquiring type definitions…";
        notificationsStore.add({
          id: "ata-progress",
          kind: "progress",
          title: "Auto type acquisition",
          message: msg,
          progress: { mode: "indeterminate", note: undefined },
          dismissible: true,
        });
      } else if (ev.phase === "progress") {
        const files = typeof ev.filesReceived === "number" ? ev.filesReceived : undefined;
        notificationsStore.update("ata-progress", {
          progress: { mode: "indeterminate", note: files ? `${files} files` : undefined },
        });
      } else {
        // Remove progress toast
        notificationsStore.remove("ata-progress");
        const pkgs: string[] = Array.isArray(ev.packages) ? ev.packages : [];
        const files = typeof ev.filesReceived === "number" ? ev.filesReceived : undefined;
        const head = pkgs.slice(0, 3).join(", ");
        const more = pkgs.length > 3 ? ` and ${pkgs.length - 3} more` : "";
        const filesNote = files ? ` (${files} files)` : "";
        let msg: string;
        if (pkgs.length) msg = `Successfully acquired ${head}${more}${filesNote}.`;
        else msg = "Type acquisition completed.";
        notificationsStore.add({
          id: `ata-success-${Date.now()}`,
          kind: "success",
          title: "Auto type acquisition",
          message: msg,
          autoHideMs: 3000,
          dismissible: true,
        });
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Subscribe to TS lib downloads (createDefaultMapFromCDN) and drive notifications
  useEffect(() => {
    const unsubscribe = completionService.onLibDownload((ev) => {
      if (ev.phase === "started") {
        notificationsStore.add({
          id: "tslib-progress",
          kind: "progress",
          title: "Downloading TypeScript lib files",
          message: "Preparing standard library types…",
          progress: { mode: "indeterminate", note: undefined },
          dismissible: true,
        });
      } else if (ev.phase === "progress") {
        const files = typeof ev.filesReceived === "number" ? ev.filesReceived : undefined;
        notificationsStore.update("tslib-progress", {
          progress: { mode: "indeterminate", note: files ? `${files} files` : undefined },
        });
      } else {
        notificationsStore.remove("tslib-progress");
        const files = typeof ev.filesReceived === "number" ? ev.filesReceived : undefined;
        const note = files ? ` (${files} files)` : "";
        notificationsStore.add({
          id: `tslib-success-${Date.now()}`,
          kind: "success",
          title: "TypeScript lib ready",
          message: `Standard library types downloaded${note}.`,
          autoHideMs: 2500,
          dismissible: true,
        });
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div
      ref={historyAreaRef}
      className={clsx(
        "relative flex-1 overflow-auto p-4 font-mono text-gray-100",
        settings.appearance.fontSize === "sm" && "text-xs sm:text-sm",
        settings.appearance.fontSize === "md" && "text-sm sm:text-base",
        settings.appearance.fontSize === "lg" && "text-base sm:text-lg",
      )}>
      <HeaderControls
        className="fixed top-5 z-1"
        style={{ right: hasScrollbar ? `calc(1rem + ${scrollbarWidth}px)` : "1rem" }}
        onOpenSettings={() => setShowSettings(true)}
      />

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      {history.map((entry, index) =>
        entry.type === "recovered-mark" ?
          <RecoveredMark key={index} />
        : <HistoryItem
            key={index}
            entry={entry}
            history={history as HistoryEntry[]}
            index={index}
            inputAreaRef={inputAreaRef}
            historyAreaRef={historyAreaRef}
            onJumpToInputHistory={onJumpToInputHistory}
          />,
      )}

      {/* Notifications overlay in bottom-right */}
      <NotificationCenter
        style={{
          right: hasScrollbar ? `calc(1rem + ${scrollbarWidth}px)` : "1rem",
          bottom: notificationBottom,
        }}
      />
    </div>
  );
};

export default HistoryArea;

const HistoryItem = React.memo<{
  entry: HistoryEntry;
  index: number;
  history: HistoryEntry[];
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  historyAreaRef?: React.RefObject<HTMLDivElement | null>;
  onJumpToInputHistory?: (index: number) => void;
}>(function HistoryItem({
  entry,
  history,
  historyAreaRef,
  index,
  inputAreaRef,
  onJumpToInputHistory,
}) {
  // If this is an input immediately followed by a hide-input mark, skip rendering the input content
  if (entry.type === "input" && history[index + 1]?.type === "hide-input") return null;

  // Determine if current entry should show controls and which input they operate on
  let showControls = false;
  let controlsInput: string | undefined;
  let onJump: (() => void) | undefined;
  let onDelete: (() => void) | undefined;

  if (entry.type === "input") {
    // Regular input block
    showControls = true;
    controlsInput = entry.value;
    const inputEntry = entry;
    onJump = (() => {
      const index = historyStore.$get().inputHistory.findIndex((e) => e === inputEntry);
      return () => onJumpToInputHistory?.(index);
    })();
    onDelete = (() => {
      const index = historyStore.$get().history.indexOf(inputEntry);
      return () => historyStore.removeInputBlockAt(index);
    })();
  } else if (entry.type === "output" || entry.type === "rich-output") {
    // If current entry is the first visible output after a hidden input, attach controls for that input
    const i = index;
    let cursor = i - 1;
    while (cursor >= 0) {
      const e = history[cursor]!;
      if (e.type === "input") break;
      if ((e as any).type === "recovered-mark") {
        cursor = -1;
        break;
      }
      cursor--;
    }
    if (
      cursor >= 0 &&
      history[cursor]?.type === "input" &&
      history[cursor + 1]?.type === "hide-input" &&
      i === cursor + 2
    ) {
      const inputIndex = cursor;
      const inputEntry = history[inputIndex] as Extract<HistoryEntry, { type: "input" }>;
      showControls = true;
      controlsInput = inputEntry.value;
      onJump = () => {
        const index = historyStore.$get().inputHistory.findIndex((e) => e === inputEntry);
        onJumpToInputHistory?.(index);
      };
      onDelete = () => historyStore.removeInputBlockAt(inputIndex);
    }
  }

  // Render content and wrap with a container that places the ButtonGroup consistently
  const content = match(entry, {
    "{ type: 'input', value: _ }": (value) => <InputMessage value={value} />,
    "{ type: 'hide-input' }": () => null,
    "{ type: 'rich-output', bundle: _ }": (bundle) => <RichOutput bundle={bundle} />,
    "{ type: 'output', variant: 'info', value: _ }": (value) => (
      <OutputMessage
        value={value}
        icon={<Icon icon="material-symbols:info-outline" className="text-blue-100" />}
      />
    ),
    "{ type: 'output', variant: 'warn', value: _ }": (value) => (
      <OutputMessage
        value={value}
        icon={<Icon icon="carbon:warning-alt-filled" className="text-[#ffc107]" />}
        backgroundColor="#ffc107"
      />
    ),
    "{ type: 'output', variant: 'error', value: _ }": (value) => (
      <OutputMessage
        value={value}
        icon={<Icon icon="gridicons:cross-circle" className="mt-0.5 text-[#dc3545]" />}
        backgroundColor="#dc3545"
      />
    ),
    "{ type: 'output', value: _ }": (value) => <OutputMessage value={value} />,
    "{ type: 'error', value: _ }": (value) => <ErrorMessage value={value} />,
  });

  if (content == null) return null;

  return (
    <BlockContainer
      historyAreaRef={historyAreaRef}
      inputAreaRef={inputAreaRef}
      showControls={showControls}
      input={controlsInput}
      onDelete={onDelete}
      onJump={onJump}>
      {content}
    </BlockContainer>
  );
});

const RecoveredMark = React.memo(function RecoveredMark() {
  const handleRerunAll = useCallback(() => {
    const recoveredMarkIndex = historyStore
      .$get()
      .history.findIndex(({ type }) => type === "recovered-mark");
    if (recoveredMarkIndex === -1) return;
    const history = historyStore.$get().history.slice(0, recoveredMarkIndex) as HistoryEntry[];
    if (!history.length) return;

    const newHistory = historyStore.$get().history.slice();
    newHistory.splice(0, recoveredMarkIndex + 1);
    historyStore.history = newHistory;

    void sandboxStore.recover(history);
  }, []);

  return (
    <div className="my-4 flex items-center">
      <div className="grow border-t border-gray-700/50"></div>
      <div className="mx-4 flex items-center rounded-md border border-gray-700/50 bg-[#1e1625]/80 px-3 py-1.5 text-xs text-gray-400">
        <Icon icon="codicon:history" className="mr-2 size-4" />
        History recovered
        <button
          type="button"
          onClick={handleRerunAll}
          className="ml-3 rounded border border-gray-700/70 bg-[#2a1e30]/60 px-2 py-0.5 text-xs text-gray-300 transition-colors hover:bg-[#2a1e30] hover:text-white">
          <span className="flex items-center">
            <Icon icon="material-symbols:replay" className="mr-1 size-3.5" />
            Re-run all
          </span>
        </button>
      </div>
      <div className="grow border-t border-gray-700/50"></div>
    </div>
  );
});

// Maintain a global reference for tracking open menus
let openMenuId: string | null = null;

const ButtonGroup = React.memo<{
  input: string;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onJump?: () => void;
  onDelete?: () => void;
}>(function ButtonGroup({ input, inputAreaRef, onDelete, onJump }) {
  const [copied, setCopied] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const isTouchDevice = useIsTouchDevice();
  const isTypeCommand = /^\s*:(?:type|t)\s+/.test(input);

  // Generate unique ID for this instance
  const [menuId] = useState(() => `menu-${crypto.randomUUID()}`);

  // Close dropdown when clicking outside or opening another menu
  useEffect(() => {
    if (showMenu) {
      // Register this as the active menu
      openMenuId = menuId;

      const handleClick = (e: MouseEvent) => {
        // Ensure target is an Element before using closest
        if (!(e.target instanceof Element)) {
          setShowMenu(false);
          return;
        }

        // Check if the click is on this menu button
        const target = e.target;
        const isMenuButton = target.closest(`[data-menu-id="${menuId}"]`);

        // Close if clicked outside or if another menu was opened
        if (!isMenuButton || openMenuId !== menuId) {
          setShowMenu(false);
        }
      };

      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [showMenu, menuId]);

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
            title="Delete this entry"
            onClick={(e) => {
              e.stopPropagation();
              onDelete?.();
            }}
            className="rounded-md border border-gray-700/50 bg-black/70 p-1 text-gray-400 hover:bg-[#2a1e30] hover:text-[#ff6e6e]">
            <Icon icon="material-symbols:close" className="size-4" />
          </button>
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
          {!isTypeCommand && (
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
          )}
        </div>
      )}

      {/* Touch-device menu button */}
      {isTouchDevice && (
        <div className="mr-1.5">
          <button
            type="button"
            title="Actions"
            data-menu-id={menuId}
            onClick={(e) => {
              e.stopPropagation();
              // Close other menus when opening this one
              if (!showMenu && openMenuId && openMenuId !== menuId) {
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
                  onDelete?.();
                  setShowMenu(false);
                }}>
                <Icon icon="material-symbols:close" className="mr-2 size-3.5" />
                Delete
              </button>
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
              {!isTypeCommand && (
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
              )}
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

const InputMessage = React.memo<{ value: string }>(function InputMessage({ value }) {
  const settings = useSettingsStore();

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
          <code
            dangerouslySetInnerHTML={{
              __html: settings.editor.syntaxHighlighting ? highlightCode(value) : value,
            }}
          />
        </pre>
      </div>
    </div>
  );
});

// Shared wrapper for placing ButtonGroup consistently
const BlockContainer = React.memo<{
  children: React.ReactNode;
  historyAreaRef?: React.RefObject<HTMLDivElement | null>;
  input?: string;
  inputAreaRef?: React.RefObject<InputAreaRef | null>;
  onDelete?: () => void;
  onJump?: () => void;
  showControls?: boolean;
}>(function BlockContainer({
  children,
  historyAreaRef,
  input,
  inputAreaRef,
  onDelete,
  onJump,
  showControls,
}) {
  const [isTooCloseToTop, setIsTooCloseToTop] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const checkPosition = () => {
      const element = wrapRef.current;
      const container = historyAreaRef?.current;
      if (!element || !container) return;
      const elementRect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const relativeTop = elementRect.top - containerRect.top;
      setIsTooCloseToTop(relativeTop < 50);
    };
    checkPosition();
    const historyArea = historyAreaRef?.current;
    if (historyArea) {
      historyArea.addEventListener("scroll", checkPosition);
      window.addEventListener("resize", checkPosition);
      return () => {
        historyArea.removeEventListener("scroll", checkPosition);
        window.removeEventListener("resize", checkPosition);
      };
    }
  }, [historyAreaRef]);

  return (
    <div className="group relative mb-2" ref={wrapRef}>
      {children}
      {showControls && !isTooCloseToTop && input != null && (
        <div className="absolute top-0 right-0 z-40 p-0.5">
          <ButtonGroup
            input={input}
            inputAreaRef={inputAreaRef}
            onJump={onJump}
            onDelete={onDelete}
          />
        </div>
      )}
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

// Rich output renderer for Jupyter-style MIME bundles
const RichOutput = React.memo<{ bundle: MimeBundle }>(function RichOutput({ bundle }) {
  const md = useMemo(() => new Marked(), []);

  // Determine richest supported MIME
  const fixedOrder = ["text/html", "text/markdown", "image/svg+xml"] as const;
  const prefImageOrder = [
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
  ];

  let mime: string | undefined = fixedOrder.find((k) =>
    Object.prototype.hasOwnProperty.call(bundle, k),
  );
  if (!mime) {
    // Prefer known image types in our order, else pick any image/* (except SVG)
    mime = prefImageOrder.find((k) => Object.prototype.hasOwnProperty.call(bundle, k));
    if (!mime) {
      const imageKeys = Object.keys(bundle).filter(
        (k) => k.startsWith("image/") && k !== "image/svg+xml",
      );
      if (imageKeys.length) mime = imageKeys[0]!;
    }
  }
  if (!mime && Object.prototype.hasOwnProperty.call(bundle, "application/json"))
    mime = "application/json";
  if (!mime && Object.prototype.hasOwnProperty.call(bundle, "text/plain")) mime = "text/plain";

  if (!mime) return <ANSIText value={"[Unsupported rich output]"} className="mt-1" />;

  const value = bundle[mime];

  // Renderers
  if (mime === "text/html" && typeof value === "string")
    return (
      <SandboxedHtml
        html={value}
        liveId={bundle["application/x.repl-live-id"] as string | undefined}
      />
    );

  if (mime === "text/markdown" && typeof value === "string") {
    const html = md.parse(value) as string;
    return (
      <SandboxedHtml
        html={html}
        liveId={bundle["application/x.repl-live-id"] as string | undefined}
      />
    );
  }

  if (mime === "image/svg+xml" && typeof value === "string")
    return (
      <SandboxedHtml
        html={value}
        liveId={bundle["application/x.repl-live-id"] as string | undefined}
      />
    );

  if (mime.startsWith("image/") && mime !== "image/svg+xml" && value != null) {
    const src = (() => {
      if (typeof value === "string") {
        // Accept already-formed data: URLs or blob/http(s) URLs, else treat as base64
        if (/^(data:|blob:|https?:)/i.test(value)) return value;
        return `data:${mime};base64,${value}`;
      }
      if (value instanceof Uint8Array) return `data:${mime};base64,${u8ToBase64(value)}`;
      if (value instanceof ArrayBuffer)
        return `data:${mime};base64,${u8ToBase64(new Uint8Array(value))}`;
      return "";
    })();
    if (src) {
      return (
        <img
          src={src}
          alt={mime}
          className="mt-1 block h-auto max-w-full align-top"
          onLoad={() => window.dispatchEvent(new CustomEvent("repl:content-resized"))}
        />
      );
    }
  }

  if (mime === "application/json")
    return (
      <ANSIText
        value={JSON.stringify(value, null, 2)}
        className="mt-1 break-all whitespace-pre-wrap"
      />
    );

  if (mime === "text/plain" && typeof value === "string")
    return <ANSIText value={value} className="mt-1 break-all whitespace-pre-wrap" />;

  // Fallback
  return <ANSIText value={String(value)} className="mt-1 break-all whitespace-pre-wrap" />;
});

const SandboxedHtml = ({ html, liveId }: { html: string; liveId?: string }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [btnPos, setBtnPos] = useState<{ top: number; left: number } | null>(null);

  const mountLiveNode = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    if (!liveId) return;
    const host = root.querySelector<HTMLElement>("[data-repl-live-id]");
    if (!host) return;
    const node = liveNodeRegistry.get(liveId);
    if (!node) return;
    // Clear placeholder and mount the live node
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(node);
    window.dispatchEvent(new CustomEvent("repl:content-resized"));
  }, [liveId]);

  // Mute noisy dom-to-image-more logs about cross-origin CSS rules during export
  const withMutedDomToImageLogs = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const shouldMute = (msg: unknown) =>
      typeof msg === "string" &&
      (msg.startsWith("domtoimage: Error while reading CSS rules") ||
        msg.includes(
          "CSSStyleSheet.cssRules getter: Not allowed to access cross-origin stylesheet",
        ));
    console.error = ((...args: unknown[]) => {
      if (shouldMute(args[0])) return;
      return originalError.apply(console, args);
    }) as typeof console.error;
    console.warn = ((...args: unknown[]) => {
      if (shouldMute(args[0])) return;
      return originalWarn.apply(console, args);
    }) as typeof console.warn;
    try {
      return await fn();
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }
  }, []);

  // Choose the largest <svg> or <canvas> inside a root element
  const selectBestVisual = useCallback(
    (
      root: Element,
    ): {
      el: SVGSVGElement | HTMLCanvasElement | null;
      kind: "canvas" | "svg" | null;
    } => {
      let bestEl: SVGSVGElement | HTMLCanvasElement | null = null;
      let bestKind: "canvas" | "svg" | null = null;
      let bestArea = -1;
      root.querySelectorAll("canvas").forEach((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea && rect.width > 0 && rect.height > 0) {
          bestArea = area;
          bestEl = canvas;
          bestKind = "canvas";
        }
      });
      root.querySelectorAll("svg").forEach((svg) => {
        const rect = svg.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          bestEl = svg;
          bestKind = "svg";
        }
      });
      return { el: bestEl, kind: bestKind };
    },
    [],
  );

  // If there's a <figure>, export and anchor to the figure (PNG);
  // otherwise export the largest svg/canvas (SVG preferred when target is svg).
  const findExportAnchor = useCallback((): { el: Element | null; kind: "svg" | "png" | null } => {
    const root = containerRef.current;
    if (!root) return { el: null, kind: null };
    const figure = root.querySelector("figure");
    if (figure) return { el: figure, kind: "png" };
    const best = selectBestVisual(root);
    if (best.el) return { el: best.el, kind: best.kind === "svg" ? "svg" : "png" };
    return { el: null, kind: null };
  }, [selectBestVisual]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    root.innerHTML = html;
    // Attempt to mount live node if any
    mountLiveNode();

    // Observe size changes
    let resizeObserver: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          window.dispatchEvent(new CustomEvent("repl:content-resized"));
          // Reposition button on content changes
          const wrap = wrapRef.current;
          const { el, kind } = findExportAnchor();
          if (!wrap || !el || !kind) {
            setBtnPos(null);
          } else {
            const wr = wrap.getBoundingClientRect();
            const tr = el.getBoundingClientRect();
            setBtnPos({
              top: Math.round(tr.top - wr.top + 6),
              left: Math.round(tr.right - wr.left - 6),
            });
          }
        });
        resizeObserver.observe(root);
      }
    } catch (e) {
      // Ignore
    }
    const recalculate = () => {
      const wrap = wrapRef.current;
      const { el, kind } = findExportAnchor();
      if (!wrap || !el || !kind) {
        setBtnPos(null);
      } else {
        const wr = wrap.getBoundingClientRect();
        const tr = el.getBoundingClientRect();
        setBtnPos({
          top: Math.round(tr.top - wr.top + 6),
          left: Math.round(tr.right - wr.left - 6),
        });
      }
    };
    recalculate();
    window.addEventListener("resize", recalculate);
    window.addEventListener("scroll", recalculate, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", recalculate);
      window.removeEventListener("scroll", recalculate, true);
    };
  }, [html, mountLiveNode, findExportAnchor]);

  const handleDownloadPng = useCallback(async () => {
    const { el } = findExportAnchor();
    if (!el) return;
    try {
      const blob = await withMutedDomToImageLogs(() =>
        domtoimage.toBlob(el, {
          cacheBust: false,
          quality: 1,
          ...({ scale: 8 } as {}), // For better quality
        }),
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "figure.png";
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(a.href);
      a.remove();
    } catch (e) {
      console.warn("PNG export failed", e);
    }
  }, [findExportAnchor, withMutedDomToImageLogs]);

  const handleDownloadSvg = useCallback(async () => {
    const root = containerRef.current;
    if (!root) return;
    const { el } = findExportAnchor();
    if (!el) return;
    try {
      const dataUrl = await withMutedDomToImageLogs(() =>
        domtoimage.toSvg(el, {
          cacheBust: false,
          filter: () => true,
        }),
      );
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = "figure.svg";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      console.warn("SVG export failed", e);
    }
  }, [findExportAnchor, withMutedDomToImageLogs]);

  return (
    <div ref={wrapRef} className="relative">
      {btnPos && (
        <div
          className="absolute z-40 -translate-x-full transform"
          style={{ top: btnPos.top, left: btnPos.left }}>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title="Download as PNG"
              onClick={() => void handleDownloadPng()}
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/20 bg-black/60 text-gray-200 shadow-md backdrop-blur-sm backdrop-saturate-150 transition duration-150 ease-out hover:bg-white/10 hover:text-white">
              <Icon icon="mdi:file-image-outline" className="size-3.5" />
            </button>
            <button
              type="button"
              title="Download as SVG"
              onClick={() => void handleDownloadSvg()}
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-white/20 bg-black/60 text-gray-200 shadow-md backdrop-blur-sm backdrop-saturate-150 transition duration-150 ease-out hover:bg-white/10 hover:text-white">
              <Icon icon="mdi:vector-square" className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      <div ref={containerRef} className="repl-rich-html mt-1 block align-top" />
    </div>
  );
};

function u8ToBase64(u8: Uint8Array): string {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
