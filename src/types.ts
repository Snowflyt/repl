export type HistoryEntry =
  | { type: "input"; value: string }
  | { type: "output"; value: string; icon?: React.ReactNode; backgroundColor?: string }
  | { type: "error"; value: string };
