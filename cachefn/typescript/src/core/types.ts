/**
 * Core type definitions for CacheFn
 */

/**
 * Storage backend type
 */
export type StorageType = "memory" | "indexeddb" | "localstorage" | "auto";

/**
 * Configuration options for CacheFn instance
 */
export type CachePriority = 'low' | 'normal' | 'high';
export interface MemoryMonitoringOptions {
  enabled?: boolean;
  /** Heap usage ratio, strictly greater than zero and at most one. Default 0.8. */
  threshold?: number;
  /** Sampling interval in milliseconds. Default 10000. */
  checkInterval?: number;
}
export interface ClearOptions { priority?: CachePriority }

export interface CacheFnConfig {
  offlineStrategy?: 'cache-first';
  offlineQueue?: {
    /** Stable application handler restored when reopening a persistent queue. */
    sync: (update: QueuedUpdateContext<any>) => Promise<void>;
    /** Defaults to the cache backend; auto caches use explicit IndexedDB here. */
    storage?: 'memory' | 'indexeddb' | 'localstorage';
    /** Reject new jobs instead of evicting queued updates. Default 1000. */
    maxSize?: number;
  };
  eviction?: 'lru' | 'adaptive';
  memoryMonitoring?: MemoryMonitoringOptions;
  /** Unique name for the cache instance */
  name: string;
  /** Storage backend to use */
  storage?: StorageType;
  /** Automatic storage preference order; memory is always the final fallback. */
  fallbackOrder?: Array<'indexeddb' | 'localstorage' | 'memory'>;
  /** UTF-16 snapshot bytes permitted in localStorage (default 4 MiB). */
  localStorageMaxBytes?: number;
  /** Automatic availability probe deadline (default 1500 ms). */
  storageProbeTimeoutMs?: number;
  /** Maximum number of entries (for memory storage) */
  maxSize?: number;
  /** Default TTL in milliseconds */
  defaultTTL?: number;
  /** Namespace for cache keys */
  namespace?: string;
}

/**
 * Options for setting cache entries
 */
export interface SetOptions {
  priority?: CachePriority;
  /** Time-to-live in milliseconds */
  ttl?: number;
  /** Tags for invalidation */
  tags?: string[];
}

export interface FetchOptions<T> extends SetOptions {
  fetcher: () => Promise<T>;
  offlineFallback?: () => T | Promise<T>;
}
export interface QueuedUpdateContext<T> {
  id: string;
  key: string;
  value: T;
  /** Increments for each attempted delivery; use id for remote idempotency. */
  attempt: number;
}
export interface QueueUpdateOptions<T> extends SetOptions {
  sync?: (update: QueuedUpdateContext<T>) => Promise<void>;
}
export interface QueuedUpdateStatus {
  id: string;
  key: string;
  attempts: number;
  status: 'pending' | 'syncing' | 'failed';
  error?: unknown;
}

/**
 * Internal cache entry structure
 */
export interface CacheEntry<T> {
  priority?: CachePriority;
  /** Cache key */
  key: string;
  /** Cached value */
  value: T;
  /** Creation timestamp */
  createdAt: number;
  /** Expiration timestamp (if TTL is set) */
  expiresAt?: number;
  /** Tags for invalidation */
  tags?: string[];
  /** Number of cache hits */
  hits: number;
  /** Last access timestamp */
  lastAccess: number;
}

/**
 * Cache statistics
 */
export interface CacheStats {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Hit rate percentage */
  hitRate: number;
  /** Total set operations */
  sets: number;
  /** Total delete operations */
  deletes: number;
  /** Total evictions */
  evictions: number;
  /** Current cache size */
  size: number;
  /** Estimated memory usage in bytes (memory storage only) */
  memoryUsage?: number;
}

/**
 * Cache event types
 */
export interface CacheEvents {
  synced: { id: string; key: string };
  'sync-error': { error: unknown };
  hit: { key: string; accessTime: number };
  miss: { key: string };
  set: { key: string; size: number };
  delete: { key: string };
  eviction: { key: string; reason: string };
  invalidate: { pattern: string; count: number };
}

/**
 * Event handler type
 */
export type EventHandler<T = any> = (event: T) => void;

/**
 * Memoization options
 */
export interface MemoizeOptions<T extends (...args: any[]) => any> {
  /** Custom key generator function */
  keyGenerator?: (...args: Parameters<T>) => string;
  /** Time-to-live in milliseconds */
  ttl?: number;
  /** Maximum cache size */
  maxSize?: number;
  /** Storage backend */
  storage?: StorageType;
  /** Tags for invalidation */
  tags?: string[];
}

/**
 * Memoized function with cache control methods
 */
export interface MemoizedFunction {
  /** Clear all cached results */
  clear: () => Promise<void>;
  /** Delete specific cached result */
  delete: (...args: any[]) => Promise<void>;
  /** Get cache statistics */
  stats: () => Promise<CacheStats>;
}

/**
 * Type-safe cache schema support
 */
export type CacheSchema = Record<string, any>;

/**
 * Extract value type from cache schema pattern
 */
export type SchemaKeyPattern<Pattern extends string> =
  Pattern extends `${infer Before}*${infer After}`
    ? `${Before}${string}${SchemaKeyPattern<After>}`
    : Pattern;

export type SchemaKeys<Schema extends CacheSchema> = SchemaKeyPattern<Extract<keyof Schema, string>>;

export type ExtractValueType<Schema extends CacheSchema, Key extends string> =
  Key extends keyof Schema ? Schema[Key] : {
    [Pattern in keyof Schema]: Pattern extends string
      ? Key extends SchemaKeyPattern<Pattern> ? Schema[Pattern] : never
      : never;
  }[keyof Schema];

/** Typed view over the same CacheFn implementation; no extra runtime cache. */
export type SchemaCache<Schema extends CacheSchema> = Omit<
  import("./cache.js").CacheFn<Schema[keyof Schema]>,
  "get" | "set" | "has" | "delete" | "invalidate" | "touch" | "getMany" | "setMany" | "deleteMany" | "getOrFetch" | "queueUpdate"
> & {
  get<Key extends SchemaKeys<Schema>>(key: Key): Promise<ExtractValueType<Schema, Key> | undefined>;
  set<Key extends SchemaKeys<Schema>>(key: Key, value: NoInfer<ExtractValueType<Schema, Key>>, options?: SetOptions): Promise<void>;
  has(key: SchemaKeys<Schema>): Promise<boolean>;
  delete(key: SchemaKeys<Schema>): Promise<boolean>;
  invalidate(key: SchemaKeys<Schema>): Promise<boolean>;
  touch(key: SchemaKeys<Schema>): Promise<void>;
  getMany<Keys extends readonly SchemaKeys<Schema>[]>(keys: Keys): Promise<{
    [Index in keyof Keys]: ExtractValueType<Schema, Keys[Index]> | undefined;
  }>;
  setMany<const Entries extends readonly { key: SchemaKeys<Schema>; value: unknown; options?: SetOptions }[]>(entries: Entries & {
    [Index in keyof Entries]: { key: Entries[Index]["key"]; value: NoInfer<ExtractValueType<Schema, Entries[Index]["key"]>>; options?: SetOptions };
  }): Promise<void>;
  deleteMany(keys: SchemaKeys<Schema>[]): Promise<void>;
  getOrFetch<Key extends SchemaKeys<Schema>>(key: Key, fetcher: () => Promise<NoInfer<ExtractValueType<Schema, Key>>>, options?: SetOptions): Promise<ExtractValueType<Schema, Key>>;
  getOrFetch<Key extends SchemaKeys<Schema>>(key: Key, options: FetchOptions<NoInfer<ExtractValueType<Schema, Key>>>): Promise<ExtractValueType<Schema, Key>>;
  queueUpdate<Key extends SchemaKeys<Schema>>(key: Key, value: NoInfer<ExtractValueType<Schema, Key>>, options?: QueueUpdateOptions<NoInfer<ExtractValueType<Schema, Key>>>): Promise<string>;
};
