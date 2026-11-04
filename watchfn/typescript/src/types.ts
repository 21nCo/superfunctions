/** A flat, queryable attribute value. */
export type AttributeValue = string | number | boolean;

/** Flat attributes attached to an event. Queries match them by exact value and type. */
export type Attributes = Record<string, AttributeValue>;

/** Strict JSON value stored as an event's opaque, non-queryable payload. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Timestamp input: a valid `Date`, integer epoch milliseconds or an ISO 8601 string with a time zone. */
export type TimestampInput = Date | number | string;

/** An event as callers hand it to `ingest`. */
export interface WatchEventInput {
  /** Event type, for example `sdk.failure`. */
  type: string;
  /** When the event happened. Defaults to the time of ingestion. */
  timestamp?: TimestampInput;
  /** Flat attributes that queries can filter on. */
  attributes?: Attributes;
  /** Opaque JSON payload returned with the event but never filtered on. */
  data?: JsonValue;
}

/** An event as storage persisted it. */
export interface StoredEvent {
  id: string;
  type: string;
  /** ISO 8601 UTC time the event happened. */
  timestamp: string;
  /** ISO 8601 UTC time the runtime accepted the event. */
  receivedAt: string;
  attributes: Attributes;
  data?: JsonValue;
}

export type WatchErrorCode =
  /** The event or batch failed validation; nothing was written. */
  | "invalid_event"
  /** The query failed validation. */
  | "invalid_query"
  /** The runtime is not started (or is stopping); nothing was written. */
  | "not_started"
  /** Storage rejected the write or query; the write may not be assumed persisted. */
  | "storage_failed"
  /** The input could not be read or a runtime hook (`now`, `generateId`) threw; nothing was written. */
  | "ingest_failed"
  /** Thrown by `start()`: storage failed to open or a collector failed to start; the start was rolled back. */
  | "start_failed"
  /** Thrown by `createWatch`, `subscribe` and `registerCollector` for an invalid argument. */
  | "invalid_config"
  /** Thrown by `registerCollector` unless the runtime is stopped. */
  | "invalid_state";

export interface WatchErrorInfo {
  code: WatchErrorCode;
  message: string;
  /** Validation problems, one per offending field. */
  issues?: string[];
}

/** Receipt for one ingested event. `ok: true` is only returned after storage confirmed the write. */
export type IngestReceipt =
  | { ok: true; event: StoredEvent; storage: string; durable: boolean }
  | { ok: false; error: WatchErrorInfo };

/** Receipt for an all-or-nothing batch. */
export type BatchIngestReceipt =
  | { ok: true; events: StoredEvent[]; storage: string; durable: boolean }
  | { ok: false; error: WatchErrorInfo };

export type QueryOrder = "asc" | "desc";

/** Query by time range, type and attribute equality. */
export interface EventQuery {
  /** Inclusive lower bound on the event timestamp. */
  from?: TimestampInput;
  /** Exclusive upper bound on the event timestamp. */
  to?: TimestampInput;
  /** One type or any of several types. */
  type?: string | string[];
  /** Every attribute must be present with the same value and type. */
  attributes?: Attributes;
  /** Maximum events returned, 1 to 1000. Defaults to 100. */
  limit?: number;
  /**
   * Timestamp order. `asc` returns ties in ingestion order; `desc` is the exact
   * reverse of `asc`. Defaults to `desc` (newest first).
   */
  order?: QueryOrder;
}

export interface EventQueryResult {
  events: StoredEvent[];
  /** True when more events matched than `limit` allowed. */
  truncated: boolean;
}

/** A validated query as storage adapters receive it. */
export interface StorageQuery {
  /** Inclusive lower bound in epoch milliseconds. */
  fromMs?: number;
  /** Exclusive upper bound in epoch milliseconds. */
  toMs?: number;
  /** Match any of these types; absent means every type. */
  types?: string[];
  /** Attribute equality filters, all of which must match. */
  attributes: Array<[string, AttributeValue]>;
  /** Return at most this many events. */
  limit: number;
  order: QueryOrder;
}

/**
 * Storage adapter contract. `write` is atomic for the whole batch and resolves
 * only once the adapter has persisted every event; it rejects otherwise.
 * `query` returns at most `query.limit` matching events in timestamp order,
 * breaking ties by write order; `desc` is the exact reverse of `asc`.
 */
export interface StorageAdapter {
  /** Short adapter name reported on receipts, for example `memory` or `sqlite`. */
  readonly kind: string;
  /** Whether writes outlive the process. The memory adapter is not durable. */
  readonly durable: boolean;
  /** Prepares the adapter. Called by `start()`; must be safe to call again after `close()`. */
  open?(): Promise<void>;
  /** Releases only what `open()` acquired. Never closes a connection the caller passed in. */
  close?(): Promise<void>;
  write(events: readonly StoredEvent[]): Promise<void>;
  query(query: StorageQuery): Promise<StoredEvent[]>;
}

/** What a collector may do while the runtime runs. */
export interface CollectorContext {
  ingest(event: WatchEventInput): Promise<IngestReceipt>;
}

/** An explicitly registered event source. No collector runs unless the caller registers it. */
export interface Collector {
  readonly name: string;
  start(context: CollectorContext): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type WatchState = "stopped" | "starting" | "started" | "stopping";

/**
 * Called with each event after it was written. It may be async: a rejection is
 * reported to `onError` with source `listener`, like a synchronous throw. It
 * never changes the receipt, and the runtime does not wait for it.
 */
export type EventListener = (event: StoredEvent) => void;

export interface WatchErrorContext {
  source: "listener" | "collector" | "storage";
  name?: string;
}

export interface WatchConfig {
  /** Where events are written and queried. Required: the runtime never picks storage implicitly. */
  storage: StorageAdapter;
  /** Collectors started with the runtime. None run by default. */
  collectors?: Collector[];
  /**
   * Receives listener errors (including async listener rejections), a `WatchError` for each
   * failed receipt of an event a collector ingested (source `collector`), collector stop errors
   * and storage close errors after a failed start. Defaults to `console.warn`. Its own
   * throw or rejection is swallowed.
   */
  onError?: (error: unknown, context: WatchErrorContext) => void;
  /** Clock in epoch milliseconds, for tests. */
  now?: () => number;
  /** Event ID generator, for tests. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
}

export interface Watch {
  readonly state: WatchState;
  /** Opens storage and starts registered collectors. Idempotent; concurrent calls share one start. */
  start(): Promise<void>;
  /** Stops collectors, waits for in-flight writes and closes storage. Idempotent. */
  stop(): Promise<void>;
  /** Validates and writes one event. Never throws; failures are `ok: false` receipts. */
  ingest(event: unknown): Promise<IngestReceipt>;
  /** Validates every event, then writes them in one atomic storage write. */
  ingestBatch(events: unknown): Promise<BatchIngestReceipt>;
  /** Returns persisted events. Rejects with `WatchError` on an invalid query, when stopped or on a storage failure. */
  query(query?: EventQuery): Promise<EventQueryResult>;
  /** Calls `listener` with each event after it was written. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Adds a collector. Allowed only while stopped; it starts with the next `start()`. */
  registerCollector(collector: Collector): void;
}
