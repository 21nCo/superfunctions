/** Function memoization with instance-local caches. */
import type { MemoizeOptions, MemoizedFunction } from "../core/types.js";
import { CacheFn } from "../core/cache.js";
import { StatsTracker } from "../analytics/stats.js";
import { generateKey } from "../utils/hash.js";
import { calculateExpiration } from "../strategies/ttl-manager.js";

export type AsyncMemoized<T extends (...args: any[]) => any> =
  ((this: ThisParameterType<T>, ...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>) & MemoizedFunction & { cache: CacheFn<Awaited<ReturnType<T>>> };

let instanceId = 0;

function capacity(value = 1000): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("maxSize must be a non-negative safe integer");
  }
  return value;
}

/** Always returns a Promise, including when the original function is synchronous. */
export function memoize<T extends (...args: any[]) => any>(
  fn: T,
  options?: MemoizeOptions<T>
): AsyncMemoized<T> {
  const maxSize = capacity(options?.maxSize);
  const cache = new CacheFn<Awaited<ReturnType<T>>>({
    // Function names are not unique; persistent backends must also be isolated.
    name: `memoize-${Date.now()}-${++instanceId}-${Math.random().toString(36).slice(2)}`,
    storage: options?.storage ?? "memory",
    maxSize,
    defaultTTL: options?.ttl,
  });
  const keyGenerator = options?.keyGenerator ??
    ((...args: Parameters<T>) => generateKey(fn.name || "fn", args));
  const pending = new Map<string, object>();
  const flights = new Map<string, Promise<Awaited<ReturnType<T>>>>();

  const clearCache = cache.clear.bind(cache), deleteCache = cache.delete.bind(cache), setCache = cache.set.bind(cache);
  cache.clear = async options => { pending.clear(); flights.clear(); await clearCache(options); };
  cache.delete = async key => { pending.delete(key); flights.delete(key); return deleteCache(key); };
  cache.set = async (key, value, options) => { pending.delete(key); flights.delete(key); await setCache(key, value, options); };
  const invalidateTag = cache.invalidateByTag.bind(cache), invalidatePattern = cache.invalidateByPattern.bind(cache);
  cache.invalidateByTag = async tag => { pending.clear(); flights.clear(); await invalidateTag(tag); };
  cache.invalidateByPattern = async pattern => { pending.clear(); flights.clear(); await invalidatePattern(pattern); };

  const memoized = async function (this: ThisParameterType<T>, ...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
    const key = keyGenerator(...args);
    const existing = flights.get(key);
    if (existing) return existing;
    const token = {};
    pending.set(key, token);
    const result = (async (): Promise<Awaited<ReturnType<T>>> => {
      const cached = await cache.get(key);
      if ((cached !== undefined || await cache.has(key)) && pending.get(key) === token) return cached as Awaited<ReturnType<T>>;
      const value: Awaited<ReturnType<T>> = await fn.apply(this, args);
      // Invalidation must not allow an earlier computation to repopulate the cache.
      if (maxSize > 0 && pending.get(key) === token) {
        await cache.set(key, value, { tags: options?.tags });
      }
      return value;
    })();
    flights.set(key, result);
    const cleanup = () => {
      if (pending.get(key) === token) {
        pending.delete(key);
        flights.delete(key);
      }
    };
    result.then(cleanup, cleanup);
    return result;
  };
  memoized.cache = cache;
  memoized.clear = async () => {
    pending.clear();
    flights.clear();
    await cache.clear();
  };
  memoized.delete = async (...args: Parameters<T>) => {
    const key = keyGenerator(...args);
    pending.delete(key);
    flights.delete(key);
    await cache.delete(key);
  };
  memoized.stats = () => cache.getStats();
  return memoized;
}

/** Synchronous, memory-only memoization with TTL and LRU eviction. */
export function memoizeSync<T extends (...args: any[]) => any>(
  fn: T,
  options?: MemoizeOptions<T>
): T & MemoizedFunction {
  if (options?.storage && options.storage !== "memory") {
    throw new TypeError("memoizeSync supports only memory storage");
  }
  const maxSize = capacity(options?.maxSize);
  const cache = new Map<string, { value: ReturnType<T>; expiresAt?: number }>();
  const stats = new StatsTracker();
  const keyGenerator = options?.keyGenerator ??
    ((...args: Parameters<T>) => generateKey(fn.name || "fn", args));
  // A conservative lower bound: deleting an entry may leave an earlier hint,
  // causing one extra scan, but can never postpone reclamation of a live entry.
  let nextExpiration = Infinity;
  const prune = () => {
    const now = Date.now();
    if (now < nextExpiration) return;
    nextExpiration = Infinity;
    for (const [key, entry] of cache) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) cache.delete(key);
      else if (entry.expiresAt !== undefined && entry.expiresAt < nextExpiration) nextExpiration = entry.expiresAt;
    }
  };
  const memoized = function (this: ThisParameterType<T>, ...args: Parameters<T>): ReturnType<T> {
    const key = keyGenerator(...args);
    const entry = cache.get(key);
    const expired = entry?.expiresAt !== undefined && Date.now() >= entry.expiresAt;
    if (entry && !expired) {
      cache.delete(key);
      cache.set(key, entry);
      stats.recordHit();
      return entry.value;
    }
    // An expired lookup is a miss, not an eviction. Cold expired entries are
    // reclaimed when capacity is needed, or when exact size statistics are read.
    if (entry) cache.delete(key);
    stats.recordMiss();
    const value = fn.apply(this, args);
    if (maxSize > 0) {
      // Re-entrant calls may have filled the cache while computing this result.
      cache.delete(key);
      // Reclaim expired entries before evicting a live LRU value. Check after
      // computation, which may itself advance time or recursively populate us.
      if (cache.size >= maxSize) prune();
      while (cache.size >= maxSize) {
        cache.delete(cache.keys().next().value!);
        stats.recordEviction();
      }
      const expiresAt = calculateExpiration(options?.ttl);
      cache.set(key, { value, expiresAt });
      if (expiresAt !== undefined && expiresAt < nextExpiration) nextExpiration = expiresAt;
      stats.recordSet();
    }
    return value;
  };
  memoized.clear = async () => { cache.clear(); nextExpiration = Infinity; stats.reset(); };
  memoized.delete = async (...args: Parameters<T>) => {
    if (cache.delete(keyGenerator(...args))) stats.recordDelete();
  };
  memoized.stats = async () => { prune(); return stats.getStats(cache.size); };
  return memoized as T & MemoizedFunction;
}
