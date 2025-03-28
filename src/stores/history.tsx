import { Icon } from "@iconify/react";
import { create, get } from "troza";
import { hookify } from "troza/react";
import { match } from "ts-pattern";

import type { HistoryEntry } from "../types";
import { show } from "../utils/show";

const historyStore = create({
  history: [] as HistoryEntry[],

  [get("inputHistory")]() {
    return this.history.filter((entry) => entry.type === "input");
  },

  clear() {
    this.history = [];
  },

  appendInput(value: string) {
    this.history.push({ type: "input", value });
  },

  appendOutput(...args: [value: string] | [type: "info" | "warn" | "error", value: string]) {
    if (args.length === 1) {
      this.history.push({ type: "output", value: args[0] });
      return;
    }

    const [type, value] = args;
    const output = match(type)
      .returnType<Omit<Extract<HistoryEntry, { type: "input" }>, "type">>()
      .with("info", () => ({
        value,
        icon: <Icon icon="material-symbols:info-outline" className="text-blue-100" />,
      }))
      .with("warn", () => ({
        value,
        icon: <Icon icon="carbon:warning-alt-filled" className="text-[#ffc107]" />,
        backgroundColor: "#ffc107",
      }))
      .with("error", () => ({
        value,
        icon: <Icon icon="gridicons:cross-circle" className="mt-0.5 text-[#dc3545]" />,
        backgroundColor: "#dc3545",
      }))
      .exhaustive();
    this.history.push({ type: "output", ...output });
  },

  appendError(error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : show(error);
    this.history.push({ type: "error", value: message });
  },
});

export default historyStore;

export const useHistoryStore = hookify("history", historyStore);
