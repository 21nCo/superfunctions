/**
 * TTL (Time-To-Live) management utilities
 */

import type { CacheEntry } from "../core/types.js";

/**
 * Check if a cache entry has expired
 */
export function isExpired<T>(entry: CacheEntry<T>): boolean {
  if (!entry.expiresAt) {
    return false;
  }
  return Date.now() >= entry.expiresAt;
}

/**
 * Calculate expiration timestamp from TTL
 */
export function calculateExpiration(ttl?: number): number | undefined {
  if (ttl === undefined || ttl === Infinity) {
    return undefined;
  }
  return Date.now() + ttl;
}

/**
 * Get remaining TTL in milliseconds
 */
export function getRemainingTTL<T>(entry: CacheEntry<T>): number | undefined {
  if (!entry.expiresAt) {
    return undefined;
  }
  const remaining = entry.expiresAt - Date.now();
  return remaining > 0 ? remaining : 0;
}
