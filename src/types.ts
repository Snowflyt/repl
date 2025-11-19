import type { Arg0, HKT } from "hkt-core";
import type { Data, Tagged } from "kind-adt";
import { make } from "kind-adt";

export type Option<A> = Data<{
  Some: [value: A];
  None: [];
}>;

export const Option = make<OptionHKT>(["Some", "None"]);
export const { None, Some } = Option;
interface OptionHKT extends HKT {
  return: Option<Arg0<this>>;
}

export type MimeBundle = Record<string, unknown> & {
  // Common Jupyter MIME keys
  "text/plain"?: string;
  "text/html"?: string;
  "text/markdown"?: string;
} & {
  // Generic support for images; SVG is markup string, others accept strings or bytes
  [K in `image/${string}`]?: K extends "image/svg+xml" ? string : string | Uint8Array | ArrayBuffer;
};

export type HistoryEntry = Data<{
  Input: { value: string };
  HideInput: {};
  Output: { variant?: "info" | "warn" | "error"; value: string };
  RichOutput: { bundle: MimeBundle };
  Error: { value: string };
}>;

export const HistoryEntry = make<HistoryEntry>([
  "Input",
  "HideInput",
  "Output",
  "RichOutput",
  "Error",
]);

export type HistoryEntryLike = HistoryEntry | Tagged<"RecoveredMark", []>;
