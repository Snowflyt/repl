import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import * as React from "react";

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
