import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import type { CSSProperties, Ref } from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface CompletionItemView {
  label: string;
  insertText?: string;
  detail?: string;
  kind?: string;
  source?: string;
  replacement?: { start: number; length: number } | null;
}

export interface CompletionPopupProps {
  className?: string;
  containerRef?: Ref<HTMLDivElement>;
  items: CompletionItemView[];
  maxVisibleRows?: number;
  onMeasured?: (m: {
    rowHeight: number;
    width: number;
    height: number;
    hasOverflow: boolean;
  }) => void;
  onPick: (index: number) => void;
  onSelectIndex: (index: number) => void;
  selectedIndex: number;
  style?: CSSProperties;
}

const CompletionPopup: React.FC<CompletionPopupProps> = ({
  className,
  containerRef,
  items,
  maxVisibleRows = 6,
  onMeasured,
  onPick,
  onSelectIndex,
  selectedIndex,
  style,
}) => {
  // Internal ref retained for future use, but height is computed deterministically from rem
  const internalListRef = useRef<HTMLDivElement | null>(null);
  const setListRef = useCallback((el: HTMLDivElement | null) => {
    internalListRef.current = el;
  }, []);

  const visibleRows = Math.min(maxVisibleRows, items.length);
  // text-sm line-height (1.25rem) + py-1.5 vertical padding (0.75rem) = 2.0rem per row
  const rem =
    typeof document !== "undefined" ?
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    : 16;
  const fallbackRowHeight = Math.round(2 * rem);
  const [measuredRowHeight, setMeasuredRowHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const first = internalListRef.current?.children[0] as HTMLElement | undefined;
    let raf = 0;
    if (first) {
      const h = Math.round(first.getBoundingClientRect().height);
      if (h > 0 && h !== measuredRowHeight) {
        raf = window.requestAnimationFrame(() => setMeasuredRowHeight(h));
      }
    }
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [items, measuredRowHeight]);

  const rowHeight = measuredRowHeight ?? fallbackRowHeight;
  const hasOverflow = items.length > visibleRows;
  const fixedHeight = hasOverflow ? rowHeight * visibleRows : rowHeight * items.length;
  // Deprecated: scrollbar visibility is now handled on the inner list element

  // Inject scrollbar styles at runtime
  useLayoutEffect(() => {
    const styleId = "repl-scroll-style";
    if (typeof document === "undefined") return;
    if (document.getElementById(styleId)) return;
    const el = document.createElement("style");
    el.id = styleId;
    el.textContent =
      ".repl-scroll-stable { scrollbar-gutter: stable; }\n" +
      ".repl-scroll { scrollbar-width: thin; scrollbar-color: #6b7280 transparent; }\n" +
      ".repl-scroll.no-scrollbar { scrollbar-width: none; }\n" +
      ".repl-scroll.no-scrollbar::-webkit-scrollbar { width: 0; height: 0; }\n" +
      ".repl-scroll::-webkit-scrollbar { width: 8px; height: 8px; }\n" +
      ".repl-scroll::-webkit-scrollbar-track { background: transparent; }\n" +
      ".repl-scroll::-webkit-scrollbar-thumb { background-color: rgba(107,114,128,0.5); border-radius: 4px; }\n" +
      ".repl-scroll::-webkit-scrollbar-thumb:hover { background-color: rgba(156,163,175,0.8); }\n";
    document.head.appendChild(el);
  }, []);

  // Report measured metrics to parent so it can predict final position within the same frame
  useLayoutEffect(() => {
    const container = internalListRef.current?.parentElement as HTMLElement | undefined;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (onMeasured) {
      onMeasured({ rowHeight, width, height, hasOverflow });
    }
  }, [items, rowHeight, hasOverflow, onMeasured]);

  const kindMeta = useMemo(() => {
    const color = (raw: string) => {
      const k = raw.toLowerCase();
      if (k.includes("method") || k.includes("function")) return "text-blue-400";
      if (k.includes("property")) return "text-blue-400";
      if (
        k.includes("var") ||
        k.includes("let") ||
        k.includes("const") ||
        k.includes("parameter") ||
        k.includes("alias")
      )
        return "text-purple-400";
      if (k.includes("class")) return "text-green-400";
      if (k.includes("type")) return "text-green-400";
      if (k.includes("interface")) return "text-green-400";
      if (k.includes("enum")) return "text-orange-400";
      if (k.includes("module") || k.includes("namespace")) return "text-pink-400";
      return "text-gray-300";
    };
    const icon = (raw: string) => {
      const k = raw.toLowerCase();
      if (k.includes("method") || k.includes("function")) return "codicon:symbol-method";
      if (k.includes("property")) return "codicon:symbol-property";
      if (
        k.includes("var") ||
        k.includes("let") ||
        k.includes("const") ||
        k.includes("parameter") ||
        k.includes("alias")
      )
        return "codicon:symbol-variable";
      if (k.includes("class")) return "codicon:symbol-class";
      if (k.includes("type")) return "codicon:symbol-class";
      if (k.includes("interface")) return "codicon:symbol-interface";
      if (k.includes("enum")) return "codicon:symbol-enum";
      if (k.includes("namespace")) return "codicon:symbol-namespace";
      return "codicon:symbol-keyword";
    };
    const label = (raw: string) => {
      const k = raw.toLowerCase();
      if (k.includes("method")) return "Method";
      if (k.includes("function")) return "Function";
      if (k.includes("property")) return "Property";
      if (k.includes("var") || k.includes("let") || k.includes("const")) return "Variable";
      if (k.includes("parameter")) return "Parameter";
      if (k.includes("alias")) return "Alias";
      if (k.includes("class")) return "Class";
      if (k.includes("type")) return "Type";
      if (k.includes("interface")) return "Interface";
      if (k.includes("enum")) return "Enum";
      if (k.includes("module")) return "Module";
      if (k.includes("namespace")) return "Namespace";
      if (k.includes("keyword")) return "Keyword";
      return "Symbol";
    };
    return { color, icon, label };
  }, []);

  // Snap wheel scrolling to full rows using a non-passive listener on the inner list
  useLayoutEffect(() => {
    const list = internalListRef.current;
    if (!list) return;
    const onWheel = (e: WheelEvent) => {
      if (!hasOverflow) return;
      e.preventDefault();
      const dir = e.deltaY > 0 ? 1 : -1;
      const maxScroll = list.scrollHeight - list.clientHeight;
      const target = Math.max(
        0,
        Math.min(maxScroll, Math.round((list.scrollTop + dir * rowHeight) / rowHeight) * rowHeight),
      );
      list.scrollTop = target;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, [hasOverflow, rowHeight]);

  return (
    <div
      ref={containerRef}
      className={clsx("repl-scroll fixed z-40 text-gray-200", className)}
      style={{
        ...style,
        overflow: "visible",
        boxSizing: "content-box",
      }}>
      {/* Left list: its own card */}
      <div className="max-h-[60vh] w-80 max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-gray-700/60 bg-[#1a1520]/80">
        <div
          ref={setListRef}
          data-list="1"
          className={clsx(
            "repl-scroll repl-scroll-stable max-h-full overflow-y-auto",
            !hasOverflow && "no-scrollbar",
          )}
          style={{
            height: fixedHeight,
            scrollSnapType: "y mandatory",
            overscrollBehavior: "contain",
          }}>
          {items.map((s, i) => {
            const kind = (s.kind || "").toLowerCase();
            const colorClass = kindMeta.color(kind);
            const iconName = kindMeta.icon(kind);
            const kindLabel = kindMeta.label(kind);
            return (
              <div
                key={`${s.label}-${i}`}
                className={clsx(
                  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-white/10",
                  i === selectedIndex && "bg-white/10",
                )}
                style={{ scrollSnapAlign: "start" }}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  onPick(i);
                }}
                onMouseEnter={() => onSelectIndex(i)}>
                <Icon icon={iconName} className={clsx("shrink-0", colorClass)} />
                <div className="min-w-0 flex-1 truncate">{s.label}</div>
                <div className={clsx("ml-2 shrink-0 text-xs", colorClass)}>{kindLabel}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default CompletionPopup;
