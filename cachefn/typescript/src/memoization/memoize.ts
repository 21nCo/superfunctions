/**
 * Function memoization
 */

import type {
  MemoizeOptions,
  MemoizedFunction,
  CacheStats,
} from "../core/types.js";
import { CacheFn } from "../core/cache.js";
import { generateKey } from "../utils/hash.js";

/**
 * Memoize a function with caching
 */
export function memoize<T extends (...args: any[]) => any>(
  fn: T,
  options?: MemoizeOptions<T>
): T & MemoizedFunction {
  // Create a dedicated cache instance for this function
  const cache = new CacheFn({
    name: `memoize-${fn.name || "anonymous"}`,
    storage: options?.storage ?? "memory",
    maxSize: options?.maxSize ?? 1000,
    defaultTTL: options?.ttl,
  });

  // Default key generator
  const keyGenerator =
    options?.keyGenerator ??
    ((...args: any[]) => {
      return generateKey(fn.name || "fn", args);
    });

  // Create the memoized function
  const memoized = async function (
    this: any,
    ...args: Parameters<T>
  ): Promise<ReturnType<T>> {
    const key = keyGenerator(...args);

    // Try to get from cache
    const cached = await cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Call the original function
    const result = await fn.apply(this, args);

    // Store in cache
    await cache.set(key, result, { tags: options?.tags });

    return result;
  };

  // Attach cache control methods
  memoized.clear = async () => {
    await cache.clear();
  };

  memoized.delete = async (...args: Parameters<T>) => {
    const key = keyGenerator(...args);
    await cache.delete(key);
  };

  memoized.stats = async (): Promise<CacheStats> => {
    return await cache.getStats();
  };

  return memoized as T & MemoizedFunction;
}

/**
 * Synchronous memoization (wraps async memoize but returns sync function)
 */
export function memoizeSync<T extends (...args: any[]) => any>(
  fn: T,
  options?: MemoizeOptions<T>
): T & MemoizedFunction {
  const asyncMemoized = memoize(
    async (...args: Parameters<T>) => fn(...args),
    options
  );

  const syncMemoized = function (
    this: any,
    ...args: Parameters<T>
  ): ReturnType<T> {
    // For sync functions, we need to use a sync cache approach
    // This is a simplified version that uses a Map
    const key = (
      options?.keyGenerator ??
      ((...args: any[]) => generateKey(fn.name || "fn", args))
    )(...args);

    // Use a simple Map for sync memoization
    if (!syncMemoized._cache) {
      syncMemoized._cache = new Map();
    }

    if (syncMemoized._cache.has(key)) {
      return syncMemoized._cache.get(key);
    }

    const result = fn.apply(this, args);
    syncMemoized._cache.set(key, result);

    // Apply max size limit
    const maxSize = options?.maxSize ?? 1000;
    if (syncMemoized._cache.size > maxSize) {
      const firstKey = syncMemoized._cache.keys().next().value;
      syncMemoized._cache.delete(firstKey);
    }

    return result;
  } as any;

  syncMemoized._cache = new Map();

  syncMemoized.clear = async () => {
    syncMemoized._cache.clear();
  };

  syncMemoized.delete = async (...args: Parameters<T>) => {
    const key = (
      options?.keyGenerator ??
      ((...args: any[]) => generateKey(fn.name || "fn", args))
    )(...args);
    syncMemoized._cache.delete(key);
  };

  syncMemoized.stats = async (): Promise<CacheStats> => {
    return {
      hits: 0,
      misses: 0,
      hitRate: 0,
      sets: syncMemoized._cache.size,
      deletes: 0,
      evictions: 0,
      size: syncMemoized._cache.size,
    };
  };

  return syncMemoized as T & MemoizedFunction;
}
