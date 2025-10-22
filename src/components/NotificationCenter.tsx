import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import type { CSSProperties } from "react";
import * as React from "react";
import { useEffect, useMemo, useRef } from "react";

import notificationsStore, { useNotificationsStore } from "../stores/notifications";

const kindIcon: Record<string, string> = {
  info: "material-symbols:info-outline",
  success: "material-symbols:check-circle-rounded",
  warn: "carbon:warning-alt-filled",
  error: "gridicons:cross-circle",
  progress: "svg-spinners:3-dots-fade",
};

const cardBase =
  "pointer-events-auto rounded-md border border-gray-700/60 bg-[#1a1520]/85 text-gray-200 shadow-lg backdrop-blur-md";

const ProgressBar = React.memo<{ mode: "determinate" | "indeterminate"; value?: number }>(
  function ProgressBar({ mode, value }) {
    if (mode === "determinate") {
      const pct = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)));
      return (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-white/10">
          <div
            className="h-full rounded bg-linear-to-r from-[#9c6bff] via-[#7aa2ff] to-[#6affb0]"
            style={{ width: pct + "%" }}
          />
        </div>
      );
    }

    return (
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-white/10">
        <div
          className="h-full w-1/3 animate-[slide_1.2s_ease-in-out_infinite] rounded bg-linear-to-r from-[#9c6bff] via-[#7aa2ff] to-[#6affb0]"
          style={{ transform: "translateX(-100%)" }}
        />

        <style>
          {"@keyframes slide {\n" +
            "  0% {\n" +
            "    transform: translateX(-100%);\n" +
            "  }\n" +
            "  50% {\n" +
            "    transform: translateX(200%);\n" +
            "  }\n" +
            "  100% {\n" +
            "    transform: translateX(200%);\n" +
            "  }\n" +
            "}"}
        </style>
      </div>
    );
  },
);

const NotificationCard = React.memo<{
  id: string;
  kind: string;
  message?: string;
  title?: string;
  progress?: { mode: "determinate" | "indeterminate"; value?: number; note?: string };
  autoHideMs?: number;
  dismissible?: boolean;
}>(function NotificationCard({
  autoHideMs,
  dismissible = true,
  id,
  kind,
  message,
  progress,
  title,
}) {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (autoHideMs && autoHideMs > 0) {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => notificationsStore.remove(id), autoHideMs);
    }
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [id, autoHideMs]);

  return (
    <div className={clsx(cardBase, "w-full max-w-full p-3")} role="status" aria-live="polite">
      <div className="flex items-start">
        <div className="mt-0.5 mr-2 text-gray-300">
          <Icon icon={kindIcon[kind] ?? kindIcon.info!} className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {title && <div className="text-sm font-medium text-gray-100">{title}</div>}
          {message && <div className="mt-0.5 text-xs leading-5 text-gray-300">{message}</div>}
          {progress && (
            <>
              <ProgressBar mode={progress.mode} value={progress.value} />
              {progress.note && (
                <div className="mt-1 text-[11px] text-gray-400">{progress.note}</div>
              )}
            </>
          )}
        </div>
        {dismissible && (
          <button
            onClick={() => notificationsStore.remove(id)}
            className="ml-2 rounded p-1 text-gray-400 transition-colors hover:text-white"
            aria-label="Dismiss notification">
            <Icon icon="mdi:close" className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
});

const NotificationCenter = React.memo<{
  className?: string;
  style?: CSSProperties;
}>(function NotificationCenter({ className, style }) {
  const { list } = useNotificationsStore();

  const ordered = useMemo(() => [...list].sort((a, b) => a.createdAt - b.createdAt), [list]);

  // Default to 16px offsets; allow caller to override via style
  const mergedStyle: CSSProperties = {
    right: 16,
    bottom: 16,
    ...style,
  };

  return (
    <div
      className={clsx(
        "pointer-events-none fixed z-20 flex max-h-[55vh] w-104 max-w-[calc(100vw-32px)] flex-col gap-2 overflow-hidden",
        className,
      )}
      style={mergedStyle}>
      {ordered.map((n) => (
        <NotificationCard key={n.id} {...n} />
      ))}
    </div>
  );
});

export default NotificationCenter;
