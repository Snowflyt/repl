import { clsx } from "clsx";
import { getLuminance } from "color2k";
import * as React from "react";
import { useCallback, useRef } from "react";

export interface SwitchProps {
  value: boolean;
  onChange: (value: boolean) => void;
  className?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
}

const Switch = React.memo<SwitchProps>(function Switch({
  className,
  disabled = false,
  id,
  name,
  onChange,
  value,
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const isDark = getLuminance(window.getComputedStyle(document.body).backgroundColor) < 0.5;

  // The following colors and shadows are extracted from naive-ui
  // https://www.naiveui.com/en-US/os-theme/components/switch
  const switchBackgroundColor = {
    dark: { on: "bg-[#2a947d]", off: "bg-[#464649]" },
    light: { on: "bg-[#18a058]", off: "bg-[#dbdbdb]" },
  }[isDark ? "dark" : "light"][value ? "on" : "off"];
  const toggleBoxShadow = {
    dark: "shadow-[0_2px_4px_0_rgba(0,0,0,0.4)]",
    light: "shadow-[0_1px_4px_0_rgba(0,0,0,0.3),inset_0_0_1px_0_rgba(0,0,0,0.05)]",
  }[isDark ? "dark" : "light"];

  const handleClick = useCallback(() => {
    if (disabled) return;
    onChange(!value);

    // Update the hidden input for form submission
    if (inputRef.current) {
      inputRef.current.checked = !value;
      inputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, [onChange, value, disabled]);

  return (
    <>
      {/* Hidden real checkbox for form submission */}
      <input
        ref={inputRef}
        type="checkbox"
        id={id}
        name={name}
        className="sr-only" // visually hidden but accessible
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />

      {/* Visual toggle appearance */}
      <div
        onClick={handleClick}
        className={clsx(
          "relative inline-block h-5 w-9 cursor-pointer rounded-full transition-colors duration-200",
          switchBackgroundColor,
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        role="switch"
        aria-checked={value}
        tabIndex={disabled ? undefined : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}>
        <div
          className={clsx(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-all duration-200",
            toggleBoxShadow,
            value && "translate-x-4",
          )}
        />
      </div>
    </>
  );
});

export default Switch;
