/**
 * Idempotency store for mutation deduplication
 */

export interface MutationResult {
  ok: boolean;
  mutationId: string;
  affectedIds: string[];
  errors: Array<{
    code: string;
    message: string;
    path: string;
    retryable: boolean;
  }>;
  deduped: boolean;
}

export interface IdempotencyStore {
  /** Initialize backing storage before an enclosing transaction begins. */
  ensureReady?(): Promise<void>;

  /**
   * Get a previously stored mutation result
   */
  get(clientId: string, mutationId: string): Promise<MutationResult | null>;

  /**
   * Store a mutation result for deduplication
   */
  set(
    clientId: string,
    mutationId: string,
    result: MutationResult
  ): Promise<void>;

  /** Return an equivalent store bound to a transaction-scoped adapter. */
  withDb?(db: import("@superfunctions/db").Adapter): IdempotencyStore;

  /**
   * Return a view of this store whose records belong to one namespace and
   * actor. Stores that do not implement this are wrapped by
   * `scopeIdempotencyStore`, which qualifies the client id instead.
   */
  scoped?(scope: IdempotencyScope): IdempotencyStore;
}

/** The tenant and caller an idempotency record belongs to. */
export interface IdempotencyScope {
  namespace: string;
  actorId?: string;
}

const SCOPED = Symbol.for("datafn.idempotency.scoped");

type ScopedStore = IdempotencyStore & { [SCOPED]?: string };

function scopeKey(scope: IdempotencyScope): string {
  return JSON.stringify([scope.namespace, scope.actorId ?? null]);
}

/**
 * Qualify a client id with the actor that sent it (null for an anonymous
 * caller). Always encoded, so no raw client id can equal another actor's key.
 * Exported for stores that keep the namespace in a column of its own.
 */
export function actorQualifiedClientId(
  clientId: string,
  actorId: string | undefined,
): string {
  return JSON.stringify([actorId ?? null, clientId]);
}

/**
 * Carry the scope guard from a scoped store to a store derived from it (for
 * example by `withDb`), so the derived store cannot be re-scoped elsewhere.
 */
export function carryIdempotencyScope<T extends IdempotencyStore>(
  from: IdempotencyStore,
  to: T,
): T {
  const key = (from as ScopedStore)[SCOPED];
  if (key !== undefined) (to as ScopedStore)[SCOPED] = key;
  return to;
}

/**
 * DFN-01: bind an idempotency store to the request's namespace and actor, so a
 * (clientId, mutationId) pair used by one tenant or user never matches a
 * record written for another. Scoping an already-scoped store for the same
 * scope returns it unchanged; a different scope is an error.
 */
export function scopeIdempotencyStore(
  store: IdempotencyStore,
  scope: IdempotencyScope,
): IdempotencyStore {
  const key = scopeKey(scope);
  const existing = (store as ScopedStore)[SCOPED];
  if (existing !== undefined) {
    if (existing === key) return store;
    throw new Error("Idempotency store is already bound to another scope");
  }
  const scoped: ScopedStore = store.scoped
    ? store.scoped(scope)
    : wrapScoped(store, scope);
  scoped[SCOPED] = key;
  return scoped;
}

function wrapScoped(store: IdempotencyStore, scope: IdempotencyScope): IdempotencyStore {
  const qualify = (clientId: string) =>
    JSON.stringify([scope.namespace, scope.actorId ?? null, clientId]);
  const view: IdempotencyStore = {
    get: (clientId, mutationId) => store.get(qualify(clientId), mutationId),
    set: (clientId, mutationId, result) =>
      store.set(qualify(clientId), mutationId, result),
  };
  if (store.ensureReady) view.ensureReady = () => store.ensureReady!();
  if (store.withDb) {
    view.withDb = (db) => scopeIdempotencyStore(store.withDb!(db), scope);
  }
  return view;
}

export function isRetryableMutationResult(
  result: MutationResult | null | undefined,
): boolean {
  return Boolean(
    result &&
      !result.ok &&
      result.errors.some(
        (error) =>
          error.retryable ||
          error.code === "INTERNAL" ||
          error.code === "MUTATION_FAILED" ||
          error.code === "FORBIDDEN" ||
          error.code === "NOT_FOUND" ||
          (error.code === "CONFLICT" && error.path === "id"),
      ),
  );
}

interface StoredEntry {
  result: MutationResult;
  createdAt: number;
}

/**
 * SCA-004: In-memory idempotency store with TTL sweep + LRU eviction.
 *
 * - Entries have a `createdAt` timestamp.
 * - A sweep timer (5 min) evicts entries older than `ttlMs`.
 * - Map insertion order used for LRU: on `get()`, delete+re-insert to move to end.
 * - On `set()`: if `size >= maxEntries`, delete oldest entry (first Map entry).
 * - `destroy()` clears the sweep timer.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private store: Map<string, StoredEntry> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private ttlMs: number;
  private maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 86_400_000; // 24 hours
    this.maxEntries = opts.maxEntries ?? 100_000;

    // Start sweep timer (every 5 minutes)
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    // Unref so it doesn't keep the process alive
    if (this.sweepTimer && typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  private getKey(clientId: string, mutationId: string): string {
    return `${clientId}:${mutationId}`;
  }

  async get(
    clientId: string,
    mutationId: string
  ): Promise<MutationResult | null> {
    const key = this.getKey(clientId, mutationId);
    const entry = this.store.get(key);
    if (!entry) return null;

    // LRU: move to end by deleting and re-inserting
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.result;
  }

  async set(
    clientId: string,
    mutationId: string,
    result: MutationResult
  ): Promise<void> {
    const key = this.getKey(clientId, mutationId);

    // EXE-006: Prevent overwriting an existing result (race condition guard)
    const existing = this.store.get(key);
    if (existing && !isRetryableMutationResult(existing.result)) return;

    // LRU eviction: if at capacity, remove oldest entry (first Map entry)
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }

    this.store.set(key, {
      result,
      createdAt: Date.now(),
    });
  }

  /**
   * TTL sweep: remove entries older than ttlMs
   */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clean up the sweep timer. Call when shutting down.
   */
  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Visible for testing */
  get size(): number {
    return this.store.size;
  }
}
