import { Icon } from "@iconify/react";
import { clsx } from "clsx";
import * as React from "react";

export interface GitHubIconProps {
  className?: string;
  style?: React.CSSProperties;
}

const GitHubIcon = React.memo<GitHubIconProps>(function GitHubIcon({ className, style }) {
  return (
    <a
      href="https://github.com/Snowflyt/repl"
      target="_blank"
      rel="noopener noreferrer"
      className={clsx("text-gray-400 transition-colors duration-200 hover:text-white", className)}
      style={style}
      title="View source on GitHub">
      <Icon icon="mdi:github" className="size-6" />
    </a>
  );
});

export default GitHubIcon;
