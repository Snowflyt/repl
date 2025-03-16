import { create } from "troza";
import { hookify } from "troza/react";

const settingsStore = create({
  appearance: {
    fontSize: "md" as "sm" | "md" | "lg",
  },
  editor: {
    syntaxHighlighting: true,
  },
});

export default settingsStore;

export const useSettingsStore = hookify("settings", settingsStore);

// Initialize settings from local storage
for (const key of Object.keys(localStorage).filter((key) => key.startsWith("settings."))) {
  const path = key.slice("settings.".length).split(".");
  let obj: any = settingsStore;
  while (path.length > 1) {
    const prop = path.shift()!;
    obj = obj[prop];
  }
  const prop = path.shift()!;
  obj[prop] = JSON.parse(localStorage.getItem(key)!);
}

const diffState = (state: object, prevState: object, path = ""): [string, unknown][] => {
  const diffs: [string, unknown][] = [];

  for (const key of Object.keys(state)) {
    const value: unknown = state[key as keyof typeof state];
    const prevValue: unknown = prevState[key as keyof typeof prevState];

    if (value !== prevValue) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof prevValue === "object" &&
        prevValue !== null &&
        !Array.isArray(prevValue)
      )
        Array.prototype.push.apply(diffs, diffState(value, prevValue, path + key + "."));
      else diffs.push([path + key, value]);
    }
  }

  return diffs;
};

const getByPath = (obj: object, path: string) => {
  const parts = path.split(".");
  let value: any = obj;
  for (const part of parts) {
    value = value[part];
    if (value === undefined) break;
  }
  return value;
};

// Listen for changes and save to local storage
settingsStore.$subscribe((state, prevState) => {
  for (const [key, value] of diffState(state, prevState)) {
    if (value === getByPath(settingsStore.$getInitialState(), key))
      localStorage.removeItem(`settings.${key}`);
    else localStorage.setItem(`settings.${key}`, JSON.stringify(value));
  }
});
