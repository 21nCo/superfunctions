import { randomUUID } from "node:crypto";
import { WatchError, describeError as describe, errorInfo, observeResult } from "./errors.js";
import type {
  BatchIngestReceipt,
  Collector,
  CollectorContext,
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
import { LIMITS, normalizeEvent, normalizeQuery, ownField, type NormalizedEvent } from "./validation.js";

function defaultOnError(error: unknown, context: WatchErrorContext): void {
  console.warn(`[watchfn] ${context.source}${context.name ? ` ${context.name}` : ""} failed:`, error);
}

function validateConfig(config: WatchConfig): void {
  if (config === null || typeof config !== "object") throw new WatchError("invalid_config", "createWatch: config is required");
  const storage = config.storage as Partial<WatchConfig["storage"]> | undefined;
  if (
    !storage ||
    typeof storage.write !== "function" ||
    typeof storage.query !== "function" ||
    typeof storage.kind !== "string" ||
    typeof storage.durable !== "boolean"
  ) {
    throw new WatchError("invalid_config", "createWatch: config.storage must be a storage adapter with kind, durable, write and query");
  }
  if (config.collectors !== undefined && !Array.isArray(config.collectors)) {
    throw new WatchError("invalid_config", "createWatch: config.collectors must be an array");
  }
  for (const hook of ["onError", "now", "generateId"] as const) {
    if (config[hook] !== undefined && typeof config[hook] !== "function") {
      throw new WatchError("invalid_config", `createWatch: config.${hook} must be a function`);
    }
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
  /** The most recently requested lifecycle step, so a repeated start() can join a pending one. */
  let latest: { kind: "start" | "stop"; run: Promise<void>; settled: boolean } | undefined;

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
      // A failing error hook, sync or async, must not break ingestion or shutdown.
      observeResult(onError(error, context), () => undefined);
    } catch {
      // Same for a hook that throws synchronously.
    }
  }

  /**
   * Serializes lifecycle transitions so concurrent start/stop calls never interleave.
   * A call that repeats the latest, still pending step joins it and shares its outcome,
   * so concurrent start() calls open storage once and all see the same failure.
   * Once that step settles, a new call runs again (for example a retry after a failed start).
   */
  function enqueue(kind: "start" | "stop", step: () => Promise<void>): Promise<void> {
    if (latest && latest.kind === kind && !latest.settled) return latest.run;
    const run = lifecycle.then(step);
    const entry = { kind, run, settled: false };
    latest = entry;
    lifecycle = run.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
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
        await collector.start(contextFor(collector));
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
      try {
        await storage.close?.();
      } catch (closeError) {
        report(closeError, { source: "storage", name: storage.kind });
      }
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

  /**
   * Runs a storage call as tracked in-flight work, so stop() can wait for it.
   * The call's return value may be anything a buggy or hostile adapter returns
   * (a plain value, undefined, a foreign thenable, or a synchronous throw); it is
   * always adopted into a native promise, and that promise always leaves
   * `inFlight` once it settles, so drain() and stop() always terminate.
   */
  function track<T>(task: () => Promise<T>): Promise<T> {
    const run = (async () => task())();
    inFlight.add(run);
    const done = (): void => {
      inFlight.delete(run);
    };
    run.then(done, done);
    return run;
  }

  function notStarted(): WatchErrorInfo {
    return errorInfo("not_started", state === "stopping" ? "the runtime is stopping" : "the runtime is not started");
  }

  function toStored(event: NormalizedEvent, receivedMs: number): StoredEvent {
    // Optional fields are read as own fields too, so an inherited `data` or `timestampMs` never reaches storage.
    const timestampMs = ownField(event, "timestampMs") as number | undefined;
    const data = ownField(event, "data") as NormalizedEvent["data"];
    const stored: StoredEvent = {
      id: generateId(),
      type: event.type,
      timestamp: new Date(timestampMs ?? receivedMs).toISOString(),
      receivedAt: new Date(receivedMs).toISOString(),
      attributes: event.attributes,
    };
    if (data !== undefined) stored.data = data;
    return stored;
  }

  function notify(events: StoredEvent[]): void {
    for (const event of events) {
      for (const listener of [...listeners]) {
        try {
          // An async listener's rejection is reported like a synchronous throw.
          observeResult(listener(structuredClone(event)), (error) => report(error, { source: "listener" }));
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

  /** Reading caller input can run getters or proxy traps; a throw becomes a failed result. */
  function readEvent(input: unknown, path?: string): ReturnType<typeof normalizeEvent> | WatchErrorInfo {
    try {
      return normalizeEvent(input, path);
    } catch (error) {
      return errorInfo("ingest_failed", `${path ?? "the event"} could not be read: ${describe(error)}`);
    }
  }

  /** Runs the `now` and `generateId` hooks; a throwing or invalid hook fails the ingestion. */
  function stamp(events: NormalizedEvent[]): StoredEvent[] | WatchErrorInfo {
    try {
      const receivedMs = now();
      if (!Number.isSafeInteger(receivedMs) || receivedMs < 0 || receivedMs > LIMITS.maxTimestampMs) {
        return errorInfo("ingest_failed", "config.now() did not return valid epoch milliseconds");
      }
      const stored = events.map((event) => toStored(event, receivedMs));
      if (stored.some((event) => typeof event.id !== "string" || event.id.length === 0 || event.id.length > 200)) {
        return errorInfo("ingest_failed", "config.generateId() did not return a non-empty string of at most 200 characters");
      }
      return stored;
    } catch (error) {
      return errorInfo("ingest_failed", `a runtime hook failed: ${describe(error)}`);
    }
  }

  async function ingest(input: unknown): Promise<IngestReceipt> {
    if (!accepting) return { ok: false, error: notStarted() };
    const normalized = readEvent(input);
    if ("code" in normalized) return { ok: false, error: normalized };
    if (!normalized.ok) return { ok: false, error: errorInfo("invalid_event", "the event is invalid", normalized.issues) };
    const stamped = stamp([normalized.value]);
    if (!Array.isArray(stamped)) return { ok: false, error: stamped };
    const failure = await track(() => write(stamped));
    if (failure) return { ok: false, error: failure };
    return { ok: true, event: structuredClone(stamped[0]), storage: storage.kind, durable: storage.durable };
  }

  async function ingestBatch(input: unknown): Promise<BatchIngestReceipt> {
    if (!accepting) return { ok: false, error: notStarted() };
    let items: unknown[];
    try {
      if (!Array.isArray(input) || input.length === 0 || input.length > LIMITS.maxBatchSize) {
        return { ok: false, error: errorInfo("invalid_event", `a batch must be an array of 1 to ${LIMITS.maxBatchSize} events`) };
      }
      // Copy own slots by index: holes become undefined and fail validation instead of being skipped
      // or read through a polluted Array.prototype.
      items = Array.from({ length: input.length }, (_, index) => ownField(input, index));
    } catch (error) {
      return { ok: false, error: errorInfo("ingest_failed", `the batch could not be read: ${describe(error)}`) };
    }
    const issues: string[] = [];
    const normalized: NormalizedEvent[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const result = readEvent(items[index], `events[${index}]`);
      if ("code" in result) return { ok: false, error: result };
      if (result.ok) normalized.push(result.value);
      else issues.push(...result.issues);
    }
    if (issues.length > 0) return { ok: false, error: errorInfo("invalid_event", "the batch is invalid; nothing was written", issues) };
    const stamped = stamp(normalized);
    if (!Array.isArray(stamped)) return { ok: false, error: stamped };
    const failure = await track(() => write(stamped));
    if (failure) return { ok: false, error: failure };
    return { ok: true, events: structuredClone(stamped), storage: storage.kind, durable: storage.durable };
  }

  async function query(input?: EventQuery): Promise<EventQueryResult> {
    if (!accepting) throw new WatchError("not_started", notStarted().message);
    let normalized: ReturnType<typeof normalizeQuery>;
    try {
      normalized = normalizeQuery(input);
    } catch (error) {
      throw new WatchError("invalid_query", `the query could not be read: ${describe(error)}`, { cause: error });
    }
    if (!normalized.ok) throw new WatchError("invalid_query", "the query is invalid", { issues: normalized.issues });
    const limit = normalized.value.limit;
    let events: StoredEvent[];
    try {
      events = await track(() => storage.query({ ...normalized.value, limit: limit + 1 }));
    } catch (error) {
      throw new WatchError("storage_failed", `storage ${storage.kind} failed the query: ${describe(error)}`, { cause: error });
    }
    if (!Array.isArray(events)) throw new WatchError("storage_failed", `storage ${storage.kind} returned a query result that is not an array`);
    return { events: events.slice(0, limit), truncated: events.length > limit };
  }

  /**
   * A collector's ingestion runs unattended, so a failed receipt (for example a storage
   * failure) also goes to `onError` with source `collector`; the collector still gets it.
   */
  function contextFor(collector: Collector): CollectorContext {
    return {
      async ingest(event) {
        const receipt = await ingest(event);
        if (!receipt.ok) {
          const { code, message, issues } = receipt.error;
          const error = new WatchError(code, `collector ${collector.name} could not ingest an event: ${message}`, { issues });
          report(error, { source: "collector", name: collector.name });
        }
        return receipt;
      },
    };
  }

  return {
    get state() {
      return state;
    },
    start: () => enqueue("start", async () => (state === "started" ? undefined : doStart())),
    stop: () => enqueue("stop", async () => (state === "started" ? doStop() : undefined)),
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
