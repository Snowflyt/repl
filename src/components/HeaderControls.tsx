import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import historyStore, { persistHistoryInURL } from "../stores/history";

import Switch from "./Switch";

export interface HeaderControlsProps {
  className?: string;
  style?: React.CSSProperties;
  onOpenSettings?: () => void;
}

const HeaderControls = React.memo<HeaderControlsProps>(function HeaderControls({
  className,
  onOpenSettings,
  style,
}) {
  return (
    <div className={clsx("flex items-center space-x-3", className)} style={style}>
      <ShareIcon />
      {onOpenSettings && <SettingsIcon onClick={onOpenSettings} />}
      <GitHubIcon />
    </div>
  );
});

export default HeaderControls;

interface GitHubIconProps {
  className?: string;
}

const GitHubIcon = React.memo<GitHubIconProps>(function GitHubIcon({ className }) {
  return (
    <a
      href="https://github.com/Snowflyt/repl"
      target="_blank"
      rel="noopener noreferrer"
      className={clsx("text-gray-400 transition-colors duration-200 hover:text-white", className)}
      title="View source on GitHub">
      <Icon icon="mdi:github" className="size-6" />
    </a>
  );
});

interface SettingsIconProps {
  className?: string;
  onClick?: () => void;
}

const SettingsIcon = React.memo<SettingsIconProps>(function SettingsIcon({ className, onClick }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "group text-gray-400 transition-all duration-300 hover:cursor-pointer hover:text-white focus:outline-none",
        className,
      )}
      title="Settings"
      type="button"
      aria-label="Open settings">
      <Icon
        icon="mdi:cog"
        className="size-6 transition-transform duration-300 ease-in-out group-hover:rotate-60"
      />
    </button>
  );
});

interface ShareIconProps {
  className?: string;
}

const ShareIcon = React.memo<ShareIconProps>(function ShareIcon({ className }) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [autoRerun, setAutoRerun] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  // Generate shareable URL
  const getShareableUrl = useCallback(() => {
    // Prepare base search params reflecting rerun toggle
    const base = new URLSearchParams(window.location.search);
    if (autoRerun) base.set("rerun", "");
    else base.delete("rerun");

    const url = persistHistoryInURL(historyStore.history, base);

    // Ensure `history` parameter is last for aesthetics
    if (url.searchParams.has("history")) {
      const history = url.searchParams.get("history")!;
      url.searchParams.delete("history");
      url.searchParams.append("history", history);
    }

    return url.toString();
  }, [autoRerun]);

  // Close popup when clicking outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setIsOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(getShareableUrl());
    setCopied(true);
    setTimeout(() => setCopied(false), 1000);
  };

  return (
    <div className="relative flex items-center">
      {/* Share button */}
      <button
        type="button"
        title="Share"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          "group text-gray-400 transition-all duration-300 hover:cursor-pointer hover:text-white focus:outline-none",
          className,
        )}>
        <Icon
          icon="material-symbols:share-outline"
          className="size-6 transition-transform duration-300 ease-in-out group-hover:scale-105"
        />
      </button>

      {/* Popup */}
      {isOpen && (
        <div
          ref={popupRef}
          className="absolute top-10 right-0 z-50 w-72 rounded-md border border-gray-700/50 bg-[#1e1625] p-3 shadow-lg">
          <div className="mb-3">
            <div className="mb-2 flex items-center text-sm font-medium text-gray-200">
              <Icon icon="material-symbols:share-outline" className="mr-1.5 size-4" />
              Share this REPL
            </div>

            <div className="flex items-center space-x-1">
              <input
                type="text"
                readOnly
                value={getShareableUrl()}
                className="grow rounded border border-gray-700 bg-[#2a1e30] px-2 py-1 text-sm text-white"
                onClick={(e) => e.currentTarget.select()}
              />
              <button
                onClick={() => void handleCopy()}
                className="rounded border border-gray-700 bg-gray-700 px-2 py-1.5 text-sm text-white transition-colors hover:bg-gray-600">
                <Icon
                  icon={copied ? "material-symbols:check" : "material-symbols:content-copy-outline"}
                  className="size-4"
                />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label htmlFor="auto-rerun" className="text-xs text-gray-300">
              Auto re-run all code when opened
            </label>
            <Switch id="auto-rerun" value={autoRerun} onChange={setAutoRerun} />
          </div>
        </div>
      )}
    </div>
  );
});
