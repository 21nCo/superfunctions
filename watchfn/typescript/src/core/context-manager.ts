import { AsyncLocalStorage } from "async_hooks";
import { z } from "zod";

export const ContextSchema = z.object({
  requestId: z.string().optional(),
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export type Context = z.infer<typeof ContextSchema>;

export interface ContextStore {
  context: Context;
  startTime: number;
}

export class ContextManager {
  private storage = new AsyncLocalStorage<ContextStore>();
  private globalContext: Context = {};

  /**
   * Run a function with a new context
   */
  run<T>(context: Context, fn: () => T): T {
    const store: ContextStore = {
      context: { ...this.globalContext, ...context },
      startTime: Date.now(),
    };
    return this.storage.run(store, fn);
  }

  /**
   * Run an async function with a new context
   */
  async runAsync<T>(context: Context, fn: () => Promise<T>): Promise<T> {
    const store: ContextStore = {
      context: { ...this.globalContext, ...context },
      startTime: Date.now(),
    };
    return this.storage.run(store, fn);
  }

  /**
   * Get the current context
   */
  get(): Context | undefined {
    return this.storage.getStore()?.context;
  }

  /**
   * Get the current full store (context + metadata)
   */
  getStore(): ContextStore | undefined {
    return this.storage.getStore();
  }

  /**
   * Update the current context (merges with existing)
   */
  set(updates: Partial<Context>): void {
    const store = this.storage.getStore();
    if (store) {
      store.context = { ...store.context, ...updates };
    }
  }

  /**
   * Set a tag in the current context
   */
  setTag(key: string, value: string): void {
    const store = this.storage.getStore();
    if (store) {
      store.context.tags = store.context.tags || {};
      store.context.tags[key] = value;
    }
  }

  /**
   * Set multiple tags in the current context
   */
  setTags(tags: Record<string, string>): void {
    const store = this.storage.getStore();
    if (store) {
      store.context.tags = { ...store.context.tags, ...tags };
    }
  }

  /**
   * Set metadata in the current context
   */
  setMetadata(key: string, value: any): void {
    const store = this.storage.getStore();
    if (store) {
      store.context.metadata = store.context.metadata || {};
      store.context.metadata[key] = value;
    }
  }

  /**
   * Get a tag from the current context
   */
  getTag(key: string): string | undefined {
    return this.storage.getStore()?.context.tags?.[key];
  }

  /**
   * Get metadata from the current context
   */
  getMetadata(key: string): any {
    return this.storage.getStore()?.context.metadata?.[key];
  }

  /**
   * Get the request ID from the current context
   */
  getRequestId(): string | undefined {
    return this.storage.getStore()?.context.requestId;
  }

  /**
   * Get the trace ID from the current context
   */
  getTraceId(): string | undefined {
    return this.storage.getStore()?.context.traceId;
  }

  /**
   * Get the user ID from the current context
   */
  getUserId(): string | undefined {
    return this.storage.getStore()?.context.userId;
  }

  /**
   * Get the elapsed time since context started (in ms)
   */
  getElapsedTime(): number | undefined {
    const store = this.storage.getStore();
    if (!store) return undefined;
    return Date.now() - store.startTime;
  }

  /**
   * Set global context that persists across all contexts
   */
  setGlobalContext(context: Context): void {
    this.globalContext = { ...this.globalContext, ...context };
  }

  /**
   * Clear global context
   */
  clearGlobalContext(): void {
    this.globalContext = {};
  }

  /**
   * Generate a unique request ID
   */
  static generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Generate a unique trace ID
   */
  static generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * Generate a unique span ID
   */
  static generateSpanId(): string {
    return `span_${Math.random().toString(36).slice(2, 11)}`;
  }
}

// Export a singleton instance
export const contextManager = new ContextManager();
