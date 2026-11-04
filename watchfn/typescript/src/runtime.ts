import { randomUUID } from "node:crypto";
import { WatchError, errorInfo } from "./errors.js";
import type {
  BatchIngestReceipt,
  Collector,
  EventListener,
  EventQuery,
  EventQueryResult,
  IngestReceipt,
  StoredEvent,
  Watch,
  WatchConfig,
  WatchErrorContext,
  WatchErrorInfo,
  WatchState,
} from "./types.js";
import { LIMITS, normalizeEvent, normalizeQuery, type NormalizedEvent } from "./validation.js";

function defaultOnError(error: unknown, context: WatchErrorContext): void {
  console.warn(`[watchfn] ${context.source}${context.name ? ` ${context.name}` : ""} failed:`, error);
}

/** Error message plus its direct cause, which drivers wrapped by ORMs often carry. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause && !error.message.includes(cause) ? `${error.message}: ${cause}` : error.message;
}

function validateConfig(config: WatchConfig): void {
  if (config === null || typeof config !== "object") throw new WatchError("invalid_config", "createWatch: config is required");
  const storage = config.storage as Partial<WatchConfig["storage"]> | undefined;
  if (!storage || typeof storage.write !== "function" || typeof storage.query !== "function" || typeof storage.kind !== "string") {
    throw new WatchError("invalid_config", "createWatch: config.storage must be a storage adapter with kind, write and query");
  }
  if (config.collectors !== undefined && !Array.isArray(config.collectors)) {
    throw new WatchError("invalid_config", "createWatch: config.collectors must be an array");
  }
}

/**
 * Creates a WatchFn event runtime. Nothing runs until `start()`: no collector
 * is created implicitly and storage is opened only by `start()`.
 */
export function createWatch(config: WatchConfig): Watch {
  validateConfig(config);
  const storage = config.storage;
  const onError = config.onError ?? defaultOnError;
  const now = config.now ?? Date.now;
  const generateId = config.generateId ?? randomUUID;
  const collectors: Collector[] = [];
  const listeners = new Set<EventListener>();
  const inFlight = new Set<Promise<unknown>>();
  let state: WatchState = "stopped";
  let accepting = false;
  let lifecycle: Promise<void> = Promise.resolve();

  function addCollector(collector: Collector): void {
    if (!collector || typeof collector.name !== "string" || typeof collector.start !== "function" || typeof collector.stop !== "function") {
      throw new WatchError("invalid_config", "registerCollector: a collector needs a name, start() and stop()");
    }
    if (collectors.some((existing) => existing.name === collector.name)) {
      throw new WatchError("invalid_config", `registerCollector: a collector named "${collector.name}" is already registered`);
    }
    collectors.push(collector);
  }
  for (const collector of config.collectors ?? []) addCollector(collector);

  function report(error: unknown, context: WatchErrorContext): void {
    try {
      onError(error, context);
    } catch {
      // A failing error hook must not break ingestion or shutdown.
    }
  }

  /** Serializes lifecycle transitions so concurrent start/stop calls never interleave. */
  function enqueue(step: () => Promise<void>): Promise<void> {
    const run = lifecycle.then(step);
    lifecycle = run.catch(() => undefined);
    return run;
  }

  async function stopCollectors(started: Collector[]): Promise<void> {
    for (const collector of [...started].reverse()) {
      try {
        await collector.stop();
      } catch (error) {
        report(error, { source: "collector", name: collector.name });
      }
    }
  }

  async function drain(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  }

  async function doStart(): Promise<void> {
    state = "starting";
    const started: Collector[] = [];
    try {
      await storage.open?.();
    } catch (error) {
      state = "stopped";
      throw new WatchError("start_failed", `storage ${storage.kind} failed to open: ${describe(error)}`, { cause: error });
    }
    accepting = true;
    try {
      for (const collector of collectors) {
        await collector.start(context);
        started.push(collector);
      }
    } catch (error) {
      const failed = collectors[started.length];
      accepting = false;
      // Undo only what this start created: the collectors it started and the storage session it opened.
      await stopCollectors(started);
      if (failed) {
        try {
          await failed.stop();
        } catch (stopError) {
          report(stopError, { source: "collector", name: failed.name });
        }
      }
      await drain();
      await storage.close?.().catch((closeError: unknown) => report(closeError, { source: "storage", name: storage.kind }));
      state = "stopped";
      throw new WatchError("start_failed", `collector ${failed?.name ?? "?"} failed to start: ${describe(error)}`, { cause: error });
    }
    state = "started";
  }

  async function doStop(): Promise<void> {
    state = "stopping";
    accepting = false;
    try {
      await stopCollectors(collectors);
      await drain();
    } finally {
      try {
        await storage.close?.();
      } finally {
        state = "stopped";
      }
    }
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }

  function notStarted(): WatchErrorInfo {
    return errorInfo("not_started", state === "stopping" ? "the runtime is stopping" : "the runtime is not started");
  }

  function toStored(event: NormalizedEvent, receivedMs: number): StoredEvent {
    const stored: StoredEvent = {
      id: generateId(),
      type: event.type,
      timestamp: new Date(event.timestampMs ?? receivedMs).toISOString(),
      receivedAt: new Date(receivedMs).toISOString(),
      attributes: event.attributes,
    };
    if (event.data !== undefined) stored.data = event.data;
    return stored;
  }

  function notify(events: StoredEvent[]): void {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          listener(structuredClone(event));
        } catch (error) {
          report(error, { source: "listener" });
        }
      }
    }
  }

  async function write(events: StoredEvent[]): Promise<WatchErrorInfo | undefined> {
    try {
      await storage.write(events);
    } catch (error) {
      return errorInfo("storage_failed", `storage ${storage.kind} rejected the write: ${describe(error)}`);
    }
    notify(events);
    return undefined;
  }

  async function ingest(input: unknown): Promise<IngestReceipt> {
    if (!accepting) return { ok: false, error: notStarted() };
    const normalized = normalizeEvent(input);
    if (!normalized.ok) return { ok: false, error: errorInfo("invalid_event", "the event is invalid", normalized.issues) };
    const event = toStored(normalized.value, now());
    const failure = await track(write([event]));
    if (failure) return { ok: false, error: failure };
    return { ok: true, event: structuredClone(event), storage: storage.kind, durable: storage.durable };
  }

  async function ingestBatch(input: unknown): Promise<BatchIngestReceipt> {
    if (!accepting) return { ok: false, error: notStarted() };
    if (!Array.isArray(input) || input.length === 0 || input.length > LIMITS.maxBatchSize) {
      return { ok: false, error: errorInfo("invalid_event", `a batch must be an array of 1 to ${LIMITS.maxBatchSize} events`) };
    }
    const issues: string[] = [];
    const normalized: NormalizedEvent[] = [];
    input.forEach((item, index) => {
      const result = normalizeEvent(item, `events[${index}]`);
      if (result.ok) normalized.push(result.value);
      else issues.push(...result.issues);
    });
    if (issues.length > 0) return { ok: false, error: errorInfo("invalid_event", "the batch is invalid; nothing was written", issues) };
    const receivedMs = now();
    const events = normalized.map((event) => toStored(event, receivedMs));
    const failure = await track(write(events));
    if (failure) return { ok: false, error: failure };
    return { ok: true, events: structuredClone(events), storage: storage.kind, durable: storage.durable };
  }

  async function query(input?: EventQuery): Promise<EventQueryResult> {
    if (!accepting) throw new WatchError("not_started", notStarted().message);
    const normalized = normalizeQuery(input);
    if (!normalized.ok) throw new WatchError("invalid_query", "the query is invalid", { issues: normalized.issues });
    const limit = normalized.value.limit;
    let events: StoredEvent[];
    try {
      events = await track(storage.query({ ...normalized.value, limit: limit + 1 }));
    } catch (error) {
      throw new WatchError("storage_failed", `storage ${storage.kind} failed the query: ${describe(error)}`, { cause: error });
    }
    return { events: events.slice(0, limit), truncated: events.length > limit };
  }

  const context = { ingest: (event: unknown) => ingest(event) };

  return {
    get state() {
      return state;
    },
    start: () => enqueue(async () => (state === "started" ? undefined : doStart())),
    stop: () => enqueue(async () => (state === "started" ? doStop() : undefined)),
    ingest,
    ingestBatch,
    query,
    subscribe(listener) {
      if (typeof listener !== "function") throw new WatchError("invalid_config", "subscribe: listener must be a function");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    registerCollector(collector) {
      if (state !== "stopped") throw new WatchError("invalid_state", "registerCollector: register collectors while the runtime is stopped");
      addCollector(collector);
    },
  };
}
