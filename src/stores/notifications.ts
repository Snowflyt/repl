import { create } from "troza";
import { hookify } from "troza/react";

export type NotificationKind = "info" | "success" | "warn" | "error" | "progress";

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  title?: string;
  message?: string;
  // For progress notifications
  progress?: {
    mode: "indeterminate" | "determinate";
    value?: number; // 0..1 when determinate
    note?: string; // e.g., "5 files"
  };
  // Behavior
  autoHideMs?: number; // Auto hide after ms
  dismissible?: boolean; // Show close button
  createdAt: number;
  updatedAt: number;
}

const notificationsStore = create({
  list: [] as NotificationItem[],

  add(n: Omit<NotificationItem, "createdAt" | "updatedAt">) {
    const now = Date.now();
    const item = this.list.find((x) => x.id === n.id);
    if (item) Object.assign(item, { updatedAt: now }, n);
    else this.list.push({ createdAt: now, updatedAt: now, ...n });
  },

  update(id: string, patch: Partial<NotificationItem>) {
    const now = Date.now();
    const item = this.list.find((x) => x.id === id);
    if (item) Object.assign(item, { updatedAt: now }, patch);
  },

  remove(id: string) {
    const index = this.list.findIndex((x) => x.id === id);
    if (index !== -1) this.list.splice(index, 1);
  },

  clear() {
    this.list = [];
  },
});

export default notificationsStore;

export const useNotificationsStore = hookify("notifications", notificationsStore);
