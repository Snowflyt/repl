export type MimeBundle = Record<string, unknown> & {
  // Common Jupyter MIME keys
  "text/plain"?: string;
  "text/html"?: string;
  "text/markdown"?: string;
} & {
  // Generic support for images; SVG is markup string, others accept strings or bytes
  [K in `image/${string}`]?: K extends "image/svg+xml" ? string : string | Uint8Array | ArrayBuffer;
};

export type HistoryEntry =
  | { type: "input"; value: string }
  | { type: "hide-input" }
  | { type: "output"; variant?: "info" | "warn" | "error"; value: string }
  | { type: "rich-output"; bundle: MimeBundle }
  | { type: "error"; value: string };

export type HistoryEntryLike = HistoryEntry | { type: "recovered-mark" };
