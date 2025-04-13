export type HistoryEntry =
  | { type: "input"; value: string }
  | { type: "output"; variant?: "info" | "warn" | "error"; value: string }
  | { type: "error"; value: string };
