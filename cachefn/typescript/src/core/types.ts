/**
 * Core type definitions for CacheFn
 */

/**
 * Storage backend type
 */
export type StorageType = "memory" | "indexeddb";

/**
 * Configuration options for CacheFn instance
 */
export interface CacheFnConfig {
  /** Unique name for the cache instance */
  name: string;
  /** Storage backend to use */
  storage?: StorageType;
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
  /** Time-to-live in milliseconds */
  ttl?: number;
  /** Tags for invalidation */
  tags?: string[];
}

/**
 * Internal cache entry structure
 */
export interface CacheEntry<T> {
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
export type ExtractValueType<
  Schema extends CacheSchema,
  Key extends string,
> = Key extends keyof Schema
  ? Schema[Key]
  : {
      [K in keyof Schema]: K extends string
        ? Key extends `${K extends `${infer Prefix}:*` ? Prefix : K}${string}`
          ? Schema[K]
          : never
        : never;
    }[keyof Schema];
