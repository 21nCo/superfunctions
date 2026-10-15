/** Function memoization with instance-local caches. */
import type { MemoizeOptions, MemoizedFunction } from "../core/types.js";
import { CacheFn } from "../core/cache.js";
import { StatsTracker } from "../analytics/stats.js";
import { generateKey } from "../utils/hash.js";
import { calculateExpiration } from "../strategies/ttl-manager.js";

export type AsyncMemoized<T extends (...args: any[]) => any> =
  ((this: ThisParameterType<T>, ...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>>) & MemoizedFunction;

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
  const cache = new CacheFn<{ value: Awaited<ReturnType<T>> }>({
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

  const memoized = async function (this: ThisParameterType<T>, ...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> {
    const key = keyGenerator(...args);
    const existing = flights.get(key);
    if (existing) return existing;
    const token = {};
    pending.set(key, token);
    const result = (async (): Promise<Awaited<ReturnType<T>>> => {
      const cached = await cache.get(key);
      if (cached !== undefined && pending.get(key) === token) return cached.value;
      const value: Awaited<ReturnType<T>> = await fn.apply(this, args);
      // Invalidation must not allow an earlier computation to repopulate the cache.
      if (maxSize > 0 && pending.get(key) === token) {
        await cache.set(key, { value }, { tags: options?.tags });
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
  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt !== undefined && now >= entry.expiresAt) cache.delete(key);
    }
  };
  const memoized = function (this: ThisParameterType<T>, ...args: Parameters<T>): ReturnType<T> {
    const key = keyGenerator(...args);
    prune();
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
      stats.recordHit();
      return entry.value;
    }
    stats.recordMiss();
    const value = fn.apply(this, args);
    if (maxSize > 0) {
      // Re-entrant calls may have filled the cache while computing this result.
      cache.delete(key);
      while (cache.size >= maxSize) {
        cache.delete(cache.keys().next().value!);
        stats.recordEviction();
      }
      cache.set(key, { value, expiresAt: calculateExpiration(options?.ttl) });
      stats.recordSet();
    }
    return value;
  };
  memoized.clear = async () => { cache.clear(); stats.reset(); };
  memoized.delete = async (...args: Parameters<T>) => {
    if (cache.delete(keyGenerator(...args))) stats.recordDelete();
  };
  memoized.stats = async () => { prune(); return stats.getStats(cache.size); };
  return memoized as T & MemoizedFunction;
}
