import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { CompletionItem } from "../services/completion/service";
import { completionService } from "../services/completion/service";
import historyStore, { isReplCommand, useHistoryStore } from "../stores/history";
import sandboxStore, { useSandboxStore } from "../stores/sandbox";
import { useSettingsStore } from "../stores/settings";
import { createMarkedRenderer, highlightCode } from "../utils/highlight";
import { isMacOS } from "../utils/platform";

import CompletionDetailPane from "./CompletionDetailPane";
import CompletionPopup from "./CompletionPopup";

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
  const md = useMemo(createMarkedRenderer, []);

  // Normalize compiler-printed type indentation: if lines start with many spaces (often 4-space indents),
  // reduce leading spaces by half per line to approximate 2-space indentation without custom pretty-printing.
  const normalizeTypeIndent = useCallback((type: string): string => {
    if (!type) return type;
    const lines = type.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length <= 1) return type.trimEnd();
    // Decide whether to halve based on most lines using multiples of 4 spaces
    const spaceCounts = lines
      .map((l) => {
        const m = /^( +)/.exec(l);
        return m ? m[1]!.length : 0;
      })
      .filter((n) => n > 0);
    const div4 = spaceCounts.filter((n) => n % 4 === 0).length;
    const shouldHalve = spaceCounts.length > 0 && div4 >= Math.ceil(spaceCounts.length * 0.6);
    const out =
      shouldHalve ?
        lines.map((l) => {
          const m = /^( +)/.exec(l);
          if (!m) return l;
          const n = m[1]!.length;
          const nn = Math.max(0, Math.floor(n / 2));
          return (nn ? " ".repeat(nn) : "") + l.slice(n);
        })
      : lines;
    return out
      .join("\n")
      .replace(/[ \t]+$/gm, "")
      .trimEnd();
  }, []);

  /* Input */
  const [input, setInput] = useState("");
  const tempInputRef = useRef("");
  const [rows, setRows] = useState(1);
  const [suggestions, setSuggestions] = useState<CompletionItem[] | null>(null);
  const [selIndex, setSelIndex] = useState(0);
  const [selectedDetail, setSelectedDetail] = useState<{
    detail?: string;
    documentation?: string;
  } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Cache for completion details to avoid flicker and redundant worker calls
  const detailCacheRef = useRef<Map<string, { detail?: string; documentation?: string }>>(
    new Map(),
  );
  const MAX_DETAIL_CACHE = 400;
  // Cache for rendered HTML of documentation to avoid parsing on hot path
  const docHtmlCacheRef = useRef<Map<string, string>>(new Map());
  const [docHtmlVersion, setDocHtmlVersion] = useState(0); // trigger re-render when HTML gets ready
  // Schedule heavy work (like markdown parse) off the hot render path
  const scheduleIdle = useCallback((fn: () => void) => {
    const anyWin = window as unknown as { requestIdleCallback?: (cb: () => void) => void };
    if (typeof anyWin.requestIdleCallback === "function") anyWin.requestIdleCallback(fn);
    else setTimeout(fn, 0);
  }, []);
  // Right detail pane positioning
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [detailPos, setDetailPos] = useState<{ left: number; top: number } | null>(null);
  // Constrain detail pane width to available space to the right of the list
  const [detailMaxWidth, setDetailMaxWidth] = useState<number | null>(null);
  // Guard against out-of-order async completion results
  const completionSeqRef = useRef(0);
  // Invalidate in-flight completion requests/results across mode changes (execute, reset, etc.)
  const requestGenRef = useRef(0);
  // Token to detect stale scheduled callbacks across rapid key events
  const keySeqRef = useRef(0);
  // Fast-path hint for '.' member access to reduce overscan in the popup
  const dotFastRef = useRef(false);

  const resetInput = useCallback(() => {
    // Invalidate any pending completion or detail requests and hide UI
    requestGenRef.current++;
    if (detailDebounceRef.current) {
      window.clearTimeout(detailDebounceRef.current);
      detailDebounceRef.current = null;
    }
    if (debounceTimerRef.current) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setSuggestions(null);
    setSelectedDetail(null);
    setLoadingDetail(false);
    dotFastRef.current = false;
    // Clear input
    setInput("");
    setRows(1);
    onInputHistoryIndexChange(-1);
    tempInputRef.current = "";
  }, [onInputHistoryIndexChange]);

  // Transform ':type' / ':t' command input into an expression-completion context
  // Example: ':type Foo' => 'type __repl_type_value__ = Foo' with cursor adjusted
  const TYPE_PREFIX = "type __repl_type_result___ = ";
  const transformForTypeMode = useCallback(
    (
      value: string,
      cursor: number,
    ): { code: string; pos: number; typePrefix: number; cmdPrefix: number } | null => {
      const m = /^\s*:(?:type|t)\s+/.exec(value);
      if (!m) return null;
      const exprStart = m[0].length;
      if (cursor <= exprStart) return null; // No completions in command prefix
      const code = TYPE_PREFIX + value.slice(exprStart);
      const pos = TYPE_PREFIX.length + (cursor - exprStart);
      return { code, pos, typePrefix: TYPE_PREFIX.length, cmdPrefix: exprStart };
    },
    [],
  );

  // Detect ':check' / ':c' command context and return the expression start when the cursor is past the prefix
  const getCheckExprStart = useCallback((value: string, cursor: number): number | null => {
    const m = /^\s*:(?:check|c)\s+/.exec(value);
    if (!m) return null;
    const exprStart = m[0].length;
    if (cursor <= exprStart) return null; // no completions in command prefix
    return exprStart;
  }, []);

  const inputAreaRef = useRef<HTMLTextAreaElement>(null);
  const caretMeasureRef = useRef<HTMLPreElement>(null);
  const [caretPos, setCaretPos] = useState<{ left: number; top: number } | null>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{ left: number; top: number } | null>(null);
  // Whether to render the right detail pane (hidden on very narrow screens)
  const [showDetailPane, setShowDetailPane] = useState(true);
  // Track whether the popup position recalculation is triggered by a size change
  const recalculateFromSizeRef = useRef(false);
  // Only show popup after we've positioned it with real measurements for this session
  const [popupReady, setPopupReady] = useState(false);
  const hadSuggestionsRef = useRef(false);
  // IME composition state (mobile keyboards / CJK input)
  const composingRef = useRef(false);
  // Last measured metrics from popup component
  const lastPopupMetricsRef = useRef<{
    rowHeight: number;
    width: number;
    height: number;
    hasOverflow: boolean;
  } | null>(null);
  useEffect(() => {
    const has = !!suggestions?.length;
    const prev = hadSuggestionsRef.current;
    if (has && !prev) {
      // New session: reset position and hide until measured/positioned
      setPopupPos(null);
      setPopupReady(false);
      setSelectedDetail(null);
      setLoadingDetail(false);
    }
    hadSuggestionsRef.current = has;
  }, [suggestions]);

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

  const updateCaretPosition = useCallback(() => {
    const el = inputAreaRef.current;
    const pre = caretMeasureRef.current;
    if (!el || !pre) return;
    const caret = el.selectionStart;
    const value = el.value;
    // Prepare mirror content up to caret from the live DOM value
    pre.textContent = value.slice(0, caret) || "";
    const marker = document.createElement("span");
    marker.textContent = "";
    marker.style.display = "inline-block";
    marker.style.width = "1px";
    marker.style.height = "1em";
    pre.appendChild(marker);
    const rect = marker.getBoundingClientRect();
    setCaretPos({ left: rect.left, top: rect.bottom });
    marker.remove();
  }, []);

  // Keep caret position in sync with viewport changes (resize/scroll/keyboard)
  useLayoutEffect(() => {
    let raf: number | null = null;
    const onChange = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        updateCaretPosition();
      });
    };
    window.addEventListener("resize", onChange);
    window.addEventListener("scroll", onChange);
    window.addEventListener("orientationchange", onChange);
    window.visualViewport?.addEventListener("resize", onChange);
    window.visualViewport?.addEventListener("scroll", onChange);
    return () => {
      window.removeEventListener("resize", onChange);
      window.removeEventListener("scroll", onChange);
      window.removeEventListener("orientationchange", onChange);
      window.visualViewport?.removeEventListener("resize", onChange);
      window.visualViewport?.removeEventListener("scroll", onChange);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [updateCaretPosition]);

  // Layout gaps for completion popup
  const POPUP_GAP_ABOVE = 16; // distance between caret and popup when shown above
  const POPUP_GAP_BELOW = 6; // small spacing when shown below

  // Recalculate popup position to stay on screen and above when needed
  useLayoutEffect(() => {
    if (!suggestions || !caretPos) {
      setPopupPos((prev) => (prev === null ? prev : null));
      setDetailPos(null);
      setShowDetailPane(true);
      return;
    }
    const calculate = () => {
      const padding = 8;
      const vv = window.visualViewport;
      const vw = Math.round(vv?.width ?? window.innerWidth);
      const vh = Math.round(vv?.height ?? window.innerHeight);
      const rect = suggestionsRef.current?.getBoundingClientRect();
      // Accurate fallback width: 20rem content width + ~2px border (w-80 + border)
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const fallbackWidth = Math.round(20 * rem + 2);
      const width = rect?.width ? Math.round(rect.width) : fallbackWidth;
      // Prefer measured row height reported by popup to predict final height for this suggestions length
      const measured = lastPopupMetricsRef.current;
      const rowHeight = measured?.rowHeight ?? Math.round(2 * rem);
      const visibleRows = Math.min(6, suggestions.length);
      const height = rowHeight * visibleRows;
      // Group layout: decide whether to show detail and shift list+detail together
      const anchorToPrev = recalculateFromSizeRef.current;
      const gap = 8; // keep a small separation to avoid border overlap
      const MIN_DETAIL_WIDTH = 200; // px (more permissive on medium widths)
      const canShowDetail = vw - 2 * padding >= width + gap + MIN_DETAIL_WIDTH;
      const dEl = detailRef.current;
      const dRect = dEl?.getBoundingClientRect();
      const predictedDetailWidth = Math.min(
        Math.round(40 * rem),
        Math.max(0, vw - 2 * padding - width - gap),
      );
      const dWidth = Math.round(dRect?.width || (canShowDetail ? predictedDetailWidth : 0));

      // Vertical placement for the list
      const desiredAbove = caretPos.top - height - POPUP_GAP_ABOVE;
      let listTop = anchorToPrev ? (popupPos?.top ?? desiredAbove) : desiredAbove;
      if (listTop < padding) {
        listTop = Math.min(
          vh - padding - height,
          Math.max(padding, caretPos.top + POPUP_GAP_BELOW),
        );
      }
      if (listTop < padding) listTop = padding;

      // Horizontal placement
      let listLeft = caretPos.left + 2;
      if (canShowDetail) {
        const groupWidth = width + gap + dWidth;
        const groupMaxLeft = vw - padding - groupWidth;
        if (groupMaxLeft < padding) {
          // Fallback safeguard: clamp list alone
          listLeft = Math.max(padding, Math.min(listLeft, vw - padding - width));
        } else {
          listLeft = Math.max(padding, Math.min(listLeft, groupMaxLeft));
        }
      } else {
        if (listLeft + width + padding > vw) listLeft = Math.max(padding, vw - width - padding);
        if (listLeft < padding) listLeft = padding;
      }

      // Apply computed list position
      setPopupPos((prev) => {
        const unchanged = prev ? prev.left === listLeft && prev.top === listTop : false;
        return unchanged ? prev : { left: listLeft, top: listTop };
      });

      // Apply detail pane position if shown
      if (canShowDetail) {
        const dHeight = Math.round(dRect?.height || 0);
        const dLeft = listLeft + width + gap;
        let dTop = Math.round(listTop + height - (dHeight || 0));
        if (dTop < padding) dTop = padding;
        setDetailPos((prev) => {
          const unchanged = prev ? prev.left === dLeft && prev.top === dTop : false;
          return unchanged ? prev : { left: dLeft, top: dTop };
        });
        // Ensure the pane doesn't overflow into the list by limiting its max width to remaining space
        const remainingRight = Math.max(0, vw - padding - dLeft);
        setDetailMaxWidth(remainingRight);
      } else {
        setDetailPos(null);
        setDetailMaxWidth(null);
      }

      // Update visibility flag for render
      setShowDetailPane(canShowDetail);
      // After we've measured a real rect and set the position at least once, reveal the popup next frame
      if (!popupReady && rect && rect.height > 0)
        window.requestAnimationFrame(() => setPopupReady(true));
      // Reset the flag after a single recalculation
      recalculateFromSizeRef.current = false;
    };
    // Measure now and on viewport and element size changes
    calculate();
    const onResize = () => {
      recalculateFromSizeRef.current = false;
      calculate();
    };
    window.addEventListener("resize", onResize);
    const onVVResize = () => {
      recalculateFromSizeRef.current = false;
      calculate();
    };
    const onVVScroll = () => {
      recalculateFromSizeRef.current = false;
      calculate();
    };
    window.visualViewport?.addEventListener("resize", onVVResize);
    window.visualViewport?.addEventListener("scroll", onVVScroll);
    const onScroll = (ev: Event) => {
      const listContainer = suggestionsRef.current;
      const paneContainer = detailRef.current;
      const target = ev.target as Node | null;
      // If the scroll originates within the detail pane, skip repositioning to avoid interrupting horizontal drag
      if (paneContainer && target && paneContainer.contains(target)) return;
      // If the scroll comes from inside the popup list, anchor to previous position; otherwise follow caret
      recalculateFromSizeRef.current = !!(
        listContainer &&
        target &&
        listContainer.contains(target)
      );
      calculate();
    };
    window.addEventListener("scroll", onScroll, true);
    let ro: ResizeObserver | null = null;
    let roDetail: ResizeObserver | null = null;
    try {
      if (typeof ResizeObserver !== "undefined" && suggestionsRef.current) {
        ro = new ResizeObserver(() => {
          recalculateFromSizeRef.current = true;
          calculate();
        });
        ro.observe(suggestionsRef.current);
      }
      if (typeof ResizeObserver !== "undefined" && detailRef.current) {
        roDetail = new ResizeObserver(() => {
          // Detail height changed (e.g., markdown rendered) — realign bottom to list bottom
          calculate();
        });
        roDetail.observe(detailRef.current);
      }
    } catch (e) {
      // Ignore
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onVVResize);
      window.visualViewport?.removeEventListener("scroll", onVVScroll);
      window.removeEventListener("scroll", onScroll, true);
      ro?.disconnect();
      roDetail?.disconnect();
    };
  }, [
    suggestions,
    caretPos,
    popupReady,
    selIndex,
    selectedDetail,
    loadingDetail,
    docHtmlVersion,
    popupPos,
  ]);

  /* History */
  const { inputHistory } = useHistoryStore();
  const storeState = useHistoryStore((s) => s.history);
  const historyRef = useRef(storeState);
  useEffect(() => {
    historyRef.current = storeState;
  }, [storeState]);
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
      const raw = customInput ?? input;
      const trimmed = raw.trimStart();

      // Invalidate any pending or in-flight completions to avoid stale popups after execution
      requestGenRef.current++;
      keySeqRef.current++;
      if (detailDebounceRef.current) {
        window.clearTimeout(detailDebounceRef.current);
        detailDebounceRef.current = null;
      }
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      setSuggestions(null);
      setSelectedDetail(null);
      setLoadingDetail(false);

      // Handle :check / :c command (print the value type of an expression)
      if (trimmed.startsWith(":check ") || trimmed.startsWith(":c ")) {
        const expr = trimmed.startsWith(":check ") ? trimmed.slice(7) : trimmed.slice(3);
        await completionService.init();
        // Update worker history for accurate types
        const snippets: string[] = [];
        let pending: string | null = null;
        for (const e of historyRef.current) {
          if (e.type === "input") {
            if (pending) snippets.push(pending);
            pending = isReplCommand(e.value) ? null : e.value;
          } else if (e.type === "error") {
            pending = null;
          } else if (e.type === "output") {
            if (e.variant === "info" && e.value === "Execution cancelled") pending = null;
          }
        }
        if (pending) snippets.push(pending);
        await completionService.updateHistory(snippets);
        const { type } = await completionService.getCheckType(expr);
        historyStore.appendInput(raw);
        const pretty = normalizeTypeIndent(type);
        historyStore.appendOutput(pretty);
        resetInput();
        return;
      }

      // Handle :type / :t command (print the static type of an expression)
      if (trimmed.startsWith(":type ") || trimmed.startsWith(":t ")) {
        // Extract the expression following the command and a space
        const expr = trimmed.startsWith(":type ") ? trimmed.slice(6) : trimmed.slice(3);
        // Ensure the type service is ready regardless of intellisense setting
        await completionService.init();
        // Keep worker history up-to-date for accurate types
        const snippets: string[] = [];
        let pending: string | null = null;
        for (const e of historyRef.current) {
          if (e.type === "input") {
            if (pending) snippets.push(pending);
            // Skip REPL commands (e.g., :type)
            pending = isReplCommand(e.value) ? null : e.value;
          } else if (e.type === "error") {
            pending = null;
          } else if (e.type === "output") {
            if (e.variant === "info" && e.value === "Execution cancelled") pending = null;
          }
        }
        if (pending) snippets.push(pending);
        await completionService.updateHistory(snippets);
        const { type } = await completionService.getTypeOf(expr);
        // Append to history like a normal execution
        historyStore.appendInput(raw);
        // Pretty-print the type into multi-line with 2-space indentation
        const pretty = normalizeTypeIndent(type);
        historyStore.appendOutput(pretty);
        // Local reset mirrors normal execution UX
        resetInput();
        return;
      }

      let inputReset = false;
      const executingTimer = setTimeout(() => {
        inputReset = true;
        if (!customInput) resetInput();
      }, 10);
      await sandboxStore.execute(raw);
      clearTimeout(executingTimer);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!customInput && !inputReset) resetInput();
    },
    [input, normalizeTypeIndent, resetInput],
  );

  /* Settings */
  const settings = useSettingsStore();

  /* Completions */
  useEffect(() => {
    if (settings.editor.intellisense) void completionService.init();
  }, [settings.editor.intellisense]);

  // Compute success snippets (simplified: input followed by no error until next input)
  const computeSuccessSnippets = useCallback((): string[] => {
    const result: string[] = [];
    let pending: string | null = null;
    for (const e of historyRef.current) {
      if (e.type === "input") {
        if (pending) result.push(pending);
        // Skip REPL commands (e.g., :type)
        pending = isReplCommand(e.value) ? null : e.value;
      } else if (e.type === "error") {
        pending = null;
      } else if (e.type === "output") {
        if (e.variant === "info" && e.value === "Execution cancelled") pending = null;
      }
    }
    if (pending) result.push(pending);
    return result;
  }, []);

  useEffect(() => {
    if (!settings.editor.intellisense) return;
    const snippets = computeSuccessSnippets();
    void completionService.updateHistory(snippets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useHistoryStore().history, settings.editor.intellisense]);

  const requestCompletions = useCallback(
    async (code: string, pos: number) => {
      if (!settings.editor.intellisense) return;

      // Allow completions in :type / :check mode (cursor past the command prefix),
      // but suppress for other REPL commands or when within the command prefix.
      const transformed = transformForTypeMode(code, pos);
      const checkStart = getCheckExprStart(code, pos);
      if (isReplCommand(code) && !transformed && checkStart === null) {
        setSuggestions(null);
        return;
      }

      // Capture a content-change token so we can invalidate results if the input changes
      // after the request is sent (even if no newer completion request is issued).
      const contentTokenAtRequest = keySeqRef.current;

      await completionService.init();
      // Special handling for :type mode to provide expression completions
      const reqCode = transformed ? transformed.code : code;
      const reqPos = transformed ? transformed.pos : pos;
      const seq = ++completionSeqRef.current;
      const gen = requestGenRef.current;
      const { items } = await completionService.getCompletions(reqCode, reqPos);
      // Ignore stale results if a newer request has started
      if (seq !== completionSeqRef.current) return;
      // Drop results if the request generation has been invalidated (e.g., user executed code)
      if (gen !== requestGenRef.current) return;
      // Invalidate if the editor content changed since this request was made
      if (contentTokenAtRequest !== keySeqRef.current) return;
      // Map replacement spans back to original positions when transformed
      let mapped = items;
      if (transformed) {
        mapped = items.map((it) => {
          const rep = it.replacement;
          if (rep && typeof rep.start === "number") {
            const start = Math.max(0, rep.start - transformed.typePrefix + transformed.cmdPrefix);
            return { ...it, replacement: { ...rep, start } } as CompletionItem;
          }
          return it;
        });
      }

      setSuggestions(mapped);
      setSelIndex(0);
      setSelectedDetail(null);
      setLoadingDetail(false);
      updateCaretPosition();
    },
    [updateCaretPosition, settings.editor.intellisense, transformForTypeMode, getCheckExprStart],
  );

  // Apply selected completion using TS-provided replacement span when available
  const applySuggestion = useCallback(
    (
      s:
        | {
            label: string;
            insertText?: string;
            detail?: string;
            replacement?: { start: number; length: number } | null;
          }
        | undefined,
      el?: HTMLTextAreaElement,
    ) => {
      if (!s) return;
      const textarea = el ?? inputAreaRef.current;
      if (!textarea) return;
      const base = textarea.value;
      const text = s.insertText ?? s.label;
      // Use replacement span if provided; otherwise fall back to current selection
      const rep = s.replacement;
      const start = rep ? rep.start : textarea.selectionStart;
      const end = rep ? rep.start + rep.length : textarea.selectionEnd;
      const newValue = base.slice(0, start) + text + base.slice(end);
      setInput(newValue);
      updateRows(newValue);
      setSuggestions(null);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
        updateCaretPosition();
      });
    },
    [setInput, updateRows, updateCaretPosition],
  );

  // Debounced scheduler to coalesce rapid triggers and reduce jitter
  const debounceTimerRef = useRef<number | null>(null);
  const detailDebounceRef = useRef<number | null>(null);
  const detailSeqRef = useRef(0);

  // Lazy fetch detail/docs for the selected item
  useEffect(() => {
    if (!suggestions || suggestions.length === 0) return;
    if (!inputAreaRef.current) return;
    const idx = Math.max(0, Math.min(selIndex, suggestions.length - 1));
    const item = suggestions[idx];
    if (!item) return;
    if (detailDebounceRef.current) {
      window.clearTimeout(detailDebounceRef.current);
      detailDebounceRef.current = null;
    }
    const key = `${item.source ?? ""}|${item.label}`;
    const cached = detailCacheRef.current.get(key);
    if (cached) {
      setSelectedDetail(cached);
      setLoadingDetail(false);
      // Ensure rendered HTML is prepared asynchronously if missing
      const doc = cached.documentation;
      if (doc && !docHtmlCacheRef.current.has(key)) {
        scheduleIdle(() => {
          try {
            const html = (md.parse(doc) as string) || "";
            docHtmlCacheRef.current.set(key, html);
            setDocHtmlVersion((v) => v + 1);
          } catch (e) {
            // Ignore rendering errors
          }
        });
      }
      return;
    }
    const code = inputAreaRef.current.value;
    const cursor = inputAreaRef.current.selectionStart;
    const token = ++detailSeqRef.current;
    const gen = requestGenRef.current;
    setLoadingDetail(true);
    detailDebounceRef.current = window.setTimeout(() => {
      const tf = transformForTypeMode(code, cursor);
      const reqCode = tf ? tf.code : code;
      const reqPos = tf ? tf.pos : cursor;
      void completionService
        .getDetail(reqCode, reqPos, { name: item.label, source: item.source })
        .then((d) => {
          if (token !== detailSeqRef.current) return; // Stale sequence
          if (gen !== requestGenRef.current) return; // Invalidated generation
          // Cache result (cap size)
          detailCacheRef.current.set(key, d);
          if (detailCacheRef.current.size > MAX_DETAIL_CACHE) {
            const it = detailCacheRef.current.keys().next();
            if (!it.done) detailCacheRef.current.delete(it.value);
          }
          setSelectedDetail(d);
          // Pre-render documentation HTML off the hot path
          const doc = d.documentation;
          if (doc) {
            scheduleIdle(() => {
              try {
                const html = (md.parse(doc) as string) || "";
                docHtmlCacheRef.current.set(key, html);
                setDocHtmlVersion((v) => v + 1);
              } catch (e) {
                // Ignore rendering errors
              }
            });
          }
        })
        .finally(() => {
          if (token === detailSeqRef.current && gen === requestGenRef.current)
            setLoadingDetail(false);
        });
    }, 120);
  }, [suggestions, selIndex, md, scheduleIdle, transformForTypeMode]);

  // Current selected item's cache key (for doc HTML lookup)
  const currentDetailKey = useMemo(() => {
    const len = suggestions?.length ?? 0;
    if (!len) return null;
    const idx = Math.max(0, Math.min(selIndex, len - 1));
    const item = suggestions?.[idx];
    return item ? `${item.source ?? ""}|${item.label}` : null;
  }, [suggestions, selIndex]);

  // Variant that reads fresh code/pos at execution time and skips if a newer key event occurred
  const scheduleCompletionsFromEl = useCallback(
    (el: HTMLTextAreaElement, delay = 50) => {
      const token = keySeqRef.current;
      if (debounceTimerRef.current) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      debounceTimerRef.current = window.setTimeout(() => {
        if (token !== keySeqRef.current) return; // stale scheduled task
        if (!settings.editor.intellisense) return;
        const pos = el.selectionStart;
        const code = el.value;
        void requestCompletions(code, pos);
      }, delay);
    },
    [requestCompletions, settings.editor.intellisense],
  );

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

  // If user disables intellisense while suggestions are visible, hide them
  useEffect(() => {
    if (!settings.editor.intellisense) setSuggestions(null);
  }, [settings.editor.intellisense]);

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
              "pointer-events-none invisible absolute -left-full z-0 w-full font-mono break-all whitespace-pre-wrap",
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
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              // After committing composition, trigger completions immediately
              if (!settings.editor.intellisense) return;
              const el = e.currentTarget as HTMLTextAreaElement;
              // Allow :type / :check expression completions; suppress other commands or when in command prefix
              const pos = el.selectionStart;
              const tf = transformForTypeMode(el.value, pos);
              const ck = getCheckExprStart(el.value, pos);
              if (isReplCommand(el.value) && !tf && ck === null) return;
              updateCaretPosition();
              if (el.selectionStart === el.selectionEnd) {
                dotFastRef.current = false;
                scheduleCompletionsFromEl(el, 0);
              }
            }}
            onKeyDown={(e) => {
              // Handle completion popup interactions first
              if (suggestions?.length) {
                const ensureRowVisible = (index: number) => {
                  const list = suggestionsRef.current?.querySelector(
                    '[data-list="1"]',
                  ) as HTMLElement | null;
                  if (!list) return;
                  // No need to adjust when there's no overflow
                  if (list.scrollHeight <= list.clientHeight) return;
                  const metrics = lastPopupMetricsRef.current;
                  const rem =
                    typeof document !== "undefined" ?
                      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
                    : 16;
                  const rowH = metrics?.rowHeight ?? Math.round(2 * rem);
                  if (rowH <= 0) return;
                  const firstVisible = Math.floor(list.scrollTop / rowH);
                  const visibleRows = Math.max(1, Math.floor(list.clientHeight / rowH));
                  const lastVisible = firstVisible + visibleRows - 1;
                  // If outside the visible window, jump so the row is fully visible
                  if (index > lastVisible) {
                    const target = index * rowH - (visibleRows - 1) * rowH;
                    list.scrollTop = Math.min(
                      list.scrollHeight - list.clientHeight,
                      Math.max(0, Math.round(target / rowH) * rowH),
                    );
                  } else if (index < firstVisible) {
                    const target = index * rowH;
                    list.scrollTop = Math.max(0, Math.round(target / rowH) * rowH);
                  }
                };
                if (e.key === "Backspace") {
                  // After the deletion occurs, decide whether to keep and refresh suggestions
                  const el = e.currentTarget;
                  setTimeout(() => {
                    // For commands, only suppress when not in :check or :type expression context
                    const pos = el.selectionStart;
                    const val = el.value;
                    const tf = transformForTypeMode(val, pos);
                    const ck = getCheckExprStart(val, pos);
                    if (isReplCommand(val) && !tf && ck === null) {
                      setSuggestions(null);
                      return;
                    }
                    if (el.selectionStart !== el.selectionEnd) {
                      // If there's a selection, hide popup and skip
                      setSuggestions(null);
                      return;
                    }
                    if (!settings.editor.intellisense) {
                      setSuggestions(null);
                      return;
                    }
                    const reqCode = tf ? tf.code : val;
                    const reqPos = tf ? tf.pos : pos;
                    void completionService.analyzeTrigger(reqCode, reqPos).then((action) => {
                      if (action.kind === "close") {
                        setSuggestions(null);
                        dotFastRef.current = false;
                        return;
                      }
                      if (action.kind === "open" || action.kind === "refresh") {
                        if (el.selectionStart !== el.selectionEnd) return;
                        updateCaretPosition();
                        // Backspace-led triggers are not dot-initiated
                        dotFastRef.current = false;
                        scheduleCompletionsFromEl(el, action.delay ?? 35);
                      }
                    });
                  }, 0);
                  // Do not prevent default; allow deletion
                }
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  const len = suggestions.length;
                  const prev = selIndex;
                  const next = (prev + 1 + len) % len;
                  // handle wrap-around to first
                  if (prev === len - 1 && next === 0) {
                    const list = suggestionsRef.current?.querySelector(
                      '[data-list="1"]',
                    ) as HTMLElement | null;
                    if (list) list.scrollTop = 0;
                  } else {
                    ensureRowVisible(next);
                  }
                  setSelIndex(next);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  const len = suggestions.length;
                  const prev = selIndex;
                  const next = (prev - 1 + len) % len;
                  // handle wrap-around to last
                  if (prev === 0 && next === len - 1) {
                    const list = suggestionsRef.current?.querySelector(
                      '[data-list="1"]',
                    ) as HTMLElement | null;
                    if (list) list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
                  } else {
                    ensureRowVisible(next);
                  }
                  setSelIndex(next);
                  return;
                }
                if (e.key === "Tab" && !e.shiftKey) {
                  e.preventDefault();
                  const len = suggestions.length;
                  const prev = selIndex;
                  const next = (prev + 1 + len) % len;
                  if (prev === len - 1 && next === 0) {
                    const list = suggestionsRef.current?.querySelector(
                      '[data-list="1"]',
                    ) as HTMLElement | null;
                    if (list) list.scrollTop = 0;
                  } else {
                    ensureRowVisible(next);
                  }
                  setSelIndex(next);
                  return;
                }
                if (e.key === "Tab" && e.shiftKey) {
                  e.preventDefault();
                  const len = suggestions.length;
                  const prev = selIndex;
                  const next = (prev - 1 + len) % len;
                  if (prev === 0 && next === len - 1) {
                    const list = suggestionsRef.current?.querySelector(
                      '[data-list="1"]',
                    ) as HTMLElement | null;
                    if (list) list.scrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
                  } else {
                    ensureRowVisible(next);
                  }
                  setSelIndex(next);
                  return;
                }
                if (e.key === "Escape") {
                  setSuggestions(null);
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  applySuggestion(suggestions[selIndex], e.currentTarget);
                  return;
                }
              }

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
              } else if ((isMacOS() ? e.metaKey : e.ctrlKey) && e.key === " ") {
                // Trigger completion on Ctrl/Cmd+Space (no value change here)
                if (!settings.editor.intellisense) {
                  setSuggestions(null);
                  return;
                }
                const el = e.currentTarget;
                // Allow :type or :check expression completions; suppress other commands or when in command prefix
                {
                  const pos = el.selectionStart;
                  const tf = transformForTypeMode(el.value, pos);
                  const ck = getCheckExprStart(el.value, pos);
                  if (isReplCommand(el.value) && !tf && ck === null) {
                    setSuggestions(null);
                    return;
                  }
                }
                updateCaretPosition();
                if (el.selectionStart === el.selectionEnd) {
                  // Manual trigger: not a dot context
                  dotFastRef.current = false;
                  scheduleCompletionsFromEl(el, 0);
                } else {
                  setSuggestions(null);
                }
              }
            }}
            onKeyUp={() => {
              updateCaretPosition();
            }}
            onClick={() => {
              updateCaretPosition();
            }}
            onSelect={(e) => {
              // Hide popup when user has a non-collapsed selection
              const el = e.currentTarget as HTMLTextAreaElement;
              updateCaretPosition();
              if (el.selectionStart !== el.selectionEnd) setSuggestions(null);
            }}
            onInput={(e) => {
              keySeqRef.current++;
              if (isExecuting) return;
              const el = e.target as HTMLTextAreaElement;
              // Suppress intellisense triggers for non-typing or non-character changes
              // See UI Events spec inputType list: https://w3c.github.io/input-events/#interface-InputEvent-Attributes
              const inputEvent = e.nativeEvent as unknown as { inputType?: string };
              const it = inputEvent.inputType ?? "";
              const nonTyping =
                // Pasting / dragging / yank buffer
                it === "insertFromPaste" ||
                it === "insertFromPasteAsQuotation" ||
                it === "insertFromDrop" ||
                it === "insertFromYank" ||
                // Auto replacements (spell check / suggestions)
                it === "insertReplacementText" ||
                // Newline/paragraph inserts shouldn't pop completions
                it === "insertLineBreak" ||
                it === "insertParagraph" ||
                // Transpose (editor command)
                it === "insertTranspose" ||
                // History actions
                it === "historyUndo" ||
                it === "historyRedo";
              // For such events, update UI state but do not trigger completion/signature
              const newValue = el.value;
              setInput(newValue);
              updateRows(newValue);
              updateCaretPosition();
              if (nonTyping) {
                setSuggestions(null);
                setCallDetail(null);
                return;
              }
              // During IME composition (mobile/CJK), allow showing completions as user types
              // We treat composition text as regular typing here to keep suggestions responsive.
              if (composingRef.current && settings.editor.intellisense) {
                const pos = el.selectionStart;
                const tf = transformForTypeMode(newValue, pos);
                const ck = getCheckExprStart(newValue, pos);
                if (!(isReplCommand(newValue) && !tf && ck === null)) {
                  const reqCode = tf ? tf.code : newValue;
                  const reqPos = tf ? tf.pos : pos;
                  void completionService.analyzeTrigger(reqCode, reqPos).then((action) => {
                    if (action.kind === "open" || action.kind === "refresh") {
                      if (el.selectionStart !== el.selectionEnd) return;
                      dotFastRef.current = false;
                      scheduleCompletionsFromEl(el, action.delay ?? 35);
                    }
                  });
                }
              }
              if (!settings.editor.intellisense) {
                setSuggestions(null);
                return;
              }
              // Allow :check or :type expression completions; suppress for other commands or when in command prefix
              const pos = el.selectionStart;
              const tf = transformForTypeMode(newValue, pos);
              const ck = getCheckExprStart(newValue, pos);
              if (isReplCommand(newValue) && !tf && ck === null) {
                setSuggestions(null);
                dotFastRef.current = false;
                return;
              }
              const reqCode = tf ? tf.code : newValue;
              const reqPos = tf ? tf.pos : pos;
              void completionService.analyzeTrigger(reqCode, reqPos).then((action) => {
                if (action.kind === "close") {
                  setSuggestions(null);
                  dotFastRef.current = false;
                  return;
                }
                if (action.kind === "open" || action.kind === "refresh") {
                  if (el.selectionStart !== el.selectionEnd) {
                    setSuggestions(null);
                    return;
                  }
                  // Fast-path: if the last typed character was a dot, reduce overscan
                  const isDot = reqPos > 0 && reqCode[reqPos - 1] === ".";
                  dotFastRef.current = isDot;
                  scheduleCompletionsFromEl(el, action.delay ?? 35);
                }
              });
            }}
            className={clsx(
              "order-0 w-full resize-none appearance-none bg-transparent p-0 font-mono tracking-normal break-all whitespace-pre-wrap text-gray-100 placeholder:text-[#6c7086] focus:outline-none",
              settings.appearance.fontSize === "sm" &&
                "2xl:text-md text-xs leading-5 sm:leading-6 md:text-sm",
              settings.appearance.fontSize === "md" &&
                "text-sm leading-6 sm:leading-7 md:text-base 2xl:text-lg",
              settings.appearance.fontSize === "lg" &&
                "text-base leading-6 sm:leading-7 md:text-lg 2xl:text-xl",
            )}
            style={{ WebkitTextFillColor: "transparent", fontVariantLigatures: "none" }}
            placeholder={getPlaceholder()}
            rows={rows}
            spellCheck={false}
          />
          {/* Hidden mirror for caret measurement */}
          <pre
            ref={caretMeasureRef}
            aria-hidden
            className={clsx(
              "pointer-events-none invisible absolute top-0 left-0 z-0 w-full p-0 font-mono tracking-normal break-all whitespace-pre-wrap",
              settings.appearance.fontSize === "sm" &&
                "2xl:text-md text-xs leading-5 sm:leading-6 md:text-sm",
              settings.appearance.fontSize === "md" &&
                "text-sm leading-6 sm:leading-7 md:text-base 2xl:text-lg",
              settings.appearance.fontSize === "lg" &&
                "text-base leading-6 sm:leading-7 md:text-lg 2xl:text-xl",
            )}
            style={{ fontVariantLigatures: "none" }}
          />
          <pre
            className={clsx(
              "pointer-events-none absolute top-0 left-0 z-0 w-full p-0 font-mono tracking-normal break-all whitespace-pre-wrap text-gray-100",
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
              style={{ fontVariantLigatures: "none" }}
            />
          </pre>
          {/* Suggestions popup near caret */}
          {suggestions &&
            suggestions.length > 0 &&
            caretPos &&
            createPortal(
              <CompletionPopup
                containerRef={suggestionsRef}
                items={suggestions}
                maxVisibleRows={6}
                overscan={dotFastRef.current ? 2 : 6}
                onMeasured={(m) => {
                  lastPopupMetricsRef.current = m;
                }}
                selectedIndex={selIndex}
                onSelectIndex={(i) => setSelIndex(i)}
                onPick={(i) => {
                  applySuggestion(suggestions[i], inputAreaRef.current ?? undefined);
                }}
                style={{
                  left: (popupPos ?? caretPos).left,
                  top: (popupPos ?? { left: 0, top: caretPos.top - POPUP_GAP_ABOVE }).top,
                  visibility: popupReady ? "visible" : "hidden",
                  pointerEvents: popupReady ? "auto" : "none",
                }}
              />,
              document.body,
            )}

          {/* Independent right detail pane, bottom-aligned to list */}
          {suggestions &&
            suggestions.length > 0 &&
            caretPos &&
            showDetailPane &&
            createPortal(
              <CompletionDetailPane
                ref={detailRef}
                loading={loadingDetail}
                detail={selectedDetail}
                docHtml={docHtmlCacheRef.current.get(currentDetailKey ?? "") ?? ""}
                style={{
                  left: (detailPos ?? { left: (popupPos ?? caretPos).left, top: 0 }).left,
                  top: (detailPos ?? { left: 0, top: (popupPos ?? caretPos).top }).top,
                  maxWidth: detailMaxWidth ?? undefined,
                  visibility: popupReady ? "visible" : "hidden",
                  pointerEvents: popupReady ? "auto" : "none",
                }}
              />,
              document.body,
            )}
        </div>
      </div>
    </div>
  );
};

export default InputArea;
