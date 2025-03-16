import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import * as React from "react";
import { useEffect, useRef } from "react";

import { useInOutAnimation } from "../hooks";
import settingsStore, { useSettingsStore } from "../stores/settings";

import Switch from "./Switch";

export interface SettingsPanelProps {
  onClose?: () => void;
}

const SettingsPanel = React.memo<SettingsPanelProps>(function SettingsPanel({ onClose }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { handleClose, isClosing, isVisible } = useInOutAnimation({ duration: 200, onClose });

  // Handle click outside to close
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) handleClose();
    };

    // Add after a slight delay to prevent immediate closing
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [handleClose]);

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  return (
    <>
      {/* Backdrop overlay */}
      <div
        className={clsx(
          "fixed inset-0 z-20 bg-black/35 transition-opacity duration-200",
          isClosing ? "opacity-0"
          : isVisible ? "opacity-100"
          : "opacity-0",
        )}
      />

      {/* Settings panel */}
      <div
        ref={panelRef}
        className={clsx(
          "fixed top-0 right-0 bottom-0 z-30 w-80 transform overflow-y-auto border-l border-gray-700/50 bg-[#1e1625] p-4 shadow-lg transition-transform duration-200",
          isClosing ? "animate-slide-out" : "animate-slide-in",
        )}>
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-white">Settings</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 transition-colors hover:text-white"
            aria-label="Close settings">
            <Icon icon="mdi:close" className="size-6" />
          </button>
        </div>

        <div className="space-y-6">
          <AppearanceSection />
          <EditorSection />
        </div>
      </div>
    </>
  );
});

export default SettingsPanel;

// --- Section Components ---
interface SectionProps {
  title: string;
  children: React.ReactNode;
}

const Section = React.memo<SectionProps>(function Section({ children, title }) {
  return (
    <section>
      <h3 className="mb-2 text-lg font-medium text-gray-200">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
});

interface SettingRowProps {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}

const SettingRow = React.memo<SettingRowProps>(function SettingRow({ children, htmlFor, label }) {
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={htmlFor} className="text-gray-300">
        {label}
      </label>
      {children}
    </div>
  );
});

// --- Functional Sections ---
const AppearanceSection = React.memo(function AppearanceSection() {
  const { appearance } = useSettingsStore();

  return (
    <Section title="Appearance">
      <SettingRow label="Font Size" htmlFor="fontSize">
        <select
          id="fontSize"
          className="rounded border border-gray-700 bg-[#2a1e30] px-2 py-1 text-white"
          value={appearance.fontSize}
          onChange={(e) =>
            (settingsStore.appearance.fontSize = e.target.value as "sm" | "md" | "lg")
          }>
          <option value="sm">Small</option>
          <option value="md">Medium (Default)</option>
          <option value="lg">Large</option>
        </select>
      </SettingRow>
    </Section>
  );
});

const EditorSection = React.memo(function EditorSection() {
  const { editor } = useSettingsStore();

  return (
    <Section title="Editor">
      <SettingRow label="Syntax Highlighting" htmlFor="highlighting">
        <Switch
          id="highlighting"
          value={editor.syntaxHighlighting}
          onChange={() => (settingsStore.editor.syntaxHighlighting = !editor.syntaxHighlighting)}
        />
      </SettingRow>
    </Section>
  );
});
