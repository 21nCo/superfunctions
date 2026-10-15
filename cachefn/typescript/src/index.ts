/**
 * CacheFn - Self-hosted caching solution
 * @module cachefn
 */

// Core exports
export { CacheFn } from "./core/cache.js";
export { EventEmitter } from "./core/events.js";
export type {
  CacheFnConfig,
  CachePriority,
  FetchOptions,
  QueueUpdateOptions,
  QueuedUpdateContext,
  QueuedUpdateStatus,
  ClearOptions,
  MemoryMonitoringOptions,
  SetOptions,
  CacheEntry,
  CacheStats,
  CacheEvents,
  StorageType,
  MemoizeOptions,
  MemoizedFunction,
  CacheSchema,
  ExtractValueType,
  SchemaCache,
  SchemaKeys,
} from "./core/types.js";

// Storage exports
export { LocalStorage } from './storage/local-storage.js';
export { AutoStorage } from './storage/auto-storage.js';
export type { LocalStorageConfig } from './storage/local-storage.js';
export type { AutoStorageConfig, FallbackStorageType } from './storage/auto-storage.js';
export { MemoryStorage } from "./storage/memory-storage.js";
export { IndexedDBStorage } from "./storage/indexeddb-storage.js";
export type {
  StorageBackend,
  EntryMetadata,
} from "./storage/storage-interface.js";

// Memoization exports
export { memoize, memoizeSync } from "./memoization/memoize.js";

export type { AsyncMemoized } from "./memoization/memoize.js";

// Middleware exports
export { middleware as expressMiddleware } from "./middleware/express.js";
export { hono as honoMiddleware } from "./middleware/hono.js";
export { fastify as fastifyPlugin } from "./middleware/fastify.js";

// Utility exports
export { hash, hashArgs, generateKey } from "./utils/hash.js";
export { serialize, deserialize, estimateSize } from "./utils/serialize.js";
export {
  globToRegex,
  matchesPattern,
  filterByPattern,
} from "./utils/pattern.js";

// Strategy exports
export {
  isExpired,
  calculateExpiration,
  getRemainingTTL,
} from "./strategies/ttl-manager.js";
export { LRUList } from "./strategies/lru-eviction.js";

// Analytics exports
export { StatsTracker } from "./analytics/stats.js";

// Factory function
import { CacheFn } from "./core/cache.js";
import type { CacheFnConfig, CacheSchema, SchemaCache } from "./core/types.js";

/**
 * Create a new cache instance
 */
export function cacheFn<Schema extends CacheSchema = any>(
  config: CacheFnConfig
): 0 extends (1 & Schema) ? CacheFn<any> : SchemaCache<Schema> {
  return new CacheFn(config) as 0 extends (1 & Schema) ? CacheFn<any> : SchemaCache<Schema>;
}

// Default export
export default cacheFn;

// V0 factory convenience methods; standalone imports remain supported.
import { compatibleMemoize } from './memoization/compatible.js';
import { memoizeSync as syncMemoize } from './memoization/memoize.js';
import { middleware as expressFactory } from './middleware/express.js';
import { hono as honoFactory } from './middleware/hono.js';
import { fastify as fastifyFactory } from './middleware/fastify.js';
export namespace cacheFn {
  export const memoize = Object.assign(compatibleMemoize, {
    clear: (fn: import('./core/types.js').MemoizedFunction): Promise<void> => fn.clear(),
  });
  export const memoizeSync = syncMemoize;
  export const middleware = expressFactory;
  export const hono = honoFactory;
  export const fastify = fastifyFactory;
}
