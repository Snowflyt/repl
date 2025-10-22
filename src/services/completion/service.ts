// Lightweight completion service wrapper using a web worker

export interface CompletionItem {
  label: string;
  insertText?: string;
  detail?: string;
  kind?: string;
  sortText?: string;
  replacement?: { start: number; length: number } | null;
  source?: string;
}

export class CompletionService {
  #ready = false;
  #worker: Worker;
  #ataHandlers = new Set<(e: any) => void>();
  #libDownloadHandlers = new Set<(e: any) => void>();

  constructor() {
    // Vite-compatible worker import
    this.#worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    // Global event listener for async events (e.g., ATA)
    this.#worker.addEventListener("message", (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.scope !== "completion") return;
      if (msg.event === "ata") {
        for (const fn of this.#ataHandlers) {
          try {
            fn(msg.data);
          } catch (e) {
            // Ignore handler errors
          }
        }
      } else if (msg.event === "lib-download") {
        for (const fn of this.#libDownloadHandlers) {
          try {
            fn(msg.data);
          } catch (e) {
            // Ignore handler errors
          }
        }
      }
    });
  }

  async init(): Promise<void> {
    if (this.#ready) return;
    await this.#call("init", {});
    this.#ready = true;
  }

  async updateHistory(snippets: string[]): Promise<void> {
    await this.#call("updateHistory", { snippets });
  }

  async getCompletions(code: string, cursor: number): Promise<{ items: CompletionItem[] }> {
    const res = await this.#call("complete", { code, cursor });
    return res as { items: CompletionItem[] };
  }

  async analyzeTrigger(
    code: string,
    cursor: number,
  ): Promise<{ kind: "open" | "refresh" | "close" | "noop"; delay?: number }> {
    return this.#call("analyzeTrigger", { code, cursor });
  }

  async getDetail(
    code: string,
    cursor: number,
    item: { name: string; source?: string },
  ): Promise<{ detail?: string; documentation?: string }> {
    return this.#call("resolveDetail", {
      code,
      cursor,
      name: item.name,
      source: item.source,
    });
  }

  async getCheckType(expr: string): Promise<{ type: string }> {
    await this.init();
    const res = await this.#call("checkOf", { expr });
    return res as { type: string };
  }

  async getTypeOf(expr: string): Promise<{ type: string }> {
    await this.init();
    const res = await this.#call("typeOf", { expr });
    return res as { type: string };
  }

  #call<T = unknown>(type: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const handler = (e: MessageEvent) => {
        const msg = e.data;
        if (msg?.scope !== "completion" || msg?.id !== id) return;
        this.#worker.removeEventListener("message", handler);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result as T);
      };
      this.#worker.addEventListener("message", handler);
      this.#worker.postMessage({ id, type, payload, scope: "completion" });
    });
  }

  onAta(handler: (ev: { phase: "started" | "progress" | "finished"; [k: string]: any }) => void) {
    this.#ataHandlers.add(handler as any);
    return () => this.#ataHandlers.delete(handler as any);
  }

  onLibDownload(
    handler: (ev: { phase: "started" | "progress" | "finished"; [k: string]: any }) => void,
  ) {
    this.#libDownloadHandlers.add(handler as any);
    return () => this.#libDownloadHandlers.delete(handler as any);
  }
}

export const completionService = new CompletionService();
