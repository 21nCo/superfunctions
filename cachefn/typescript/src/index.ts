/**
 * CacheFn - Self-hosted caching solution
 * @module cachefn
 */

// Core exports
export { CacheFn } from "./core/cache.js";
export { EventEmitter } from "./core/events.js";
export type {
  CacheFnConfig,
  SetOptions,
  CacheEntry,
  CacheStats,
  CacheEvents,
  StorageType,
  MemoizeOptions,
  MemoizedFunction,
  CacheSchema,
  ExtractValueType,
} from "./core/types.js";

// Storage exports
export { MemoryStorage } from "./storage/memory-storage.js";
export { IndexedDBStorage } from "./storage/indexeddb-storage.js";
export type {
  StorageBackend,
  EntryMetadata,
} from "./storage/storage-interface.js";

// Memoization exports
export { memoize, memoizeSync } from "./memoization/memoize.js";

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
import type { CacheFnConfig, CacheSchema } from "./core/types.js";

/**
 * Create a new cache instance
 */
export function cacheFn<Schema extends CacheSchema = any>(
  config: CacheFnConfig
): CacheFn<Schema[keyof Schema]> {
  return new CacheFn<Schema[keyof Schema]>(config);
}

// Default export
export default cacheFn;
