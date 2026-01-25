/**
 * Cache manager for storing and retrieving responses
 */

import type { CacheConfig } from './types.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
}

export class CacheManager {
  private cache = new Map<string, CacheEntry<any>>();
  private hits = 0;
  private misses = 0;

  constructor(private config: CacheConfig) {}

  /**
   * Generate cache key
   */
  private generateKey(method: string, url: string, options: any): string {
    if (this.config.keyGenerator) {
      return this.config.keyGenerator(method, url, options);
    }
    return `${method}:${url}:${JSON.stringify(options)}`;
  }

  /**
   * Get cached value
   */
  async get<T>(method: string, url: string, options: any = {}): Promise<T | null> {
    if (!this.config.enabled) return null;

    const key = this.generateKey(method, url, options);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check if expired
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.data as T;
  }

  /**
   * Set cached value
   */
  async set<T>(method: string, url: string, data: T, options: any = {}): Promise<void> {
    if (!this.config.enabled) return;

    const key = this.generateKey(method, url, options);
    const ttl = this.config.defaultTTL || 3600000; // 1 hour default

    // Check max size
    if (this.config.maxSize && this.cache.size >= this.config.maxSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl
    });
  }

  /**
   * Invalidate cache for a URL or pattern
   */
  async invalidate(urlOrPattern: string): Promise<void> {
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (key.includes(urlOrPattern)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key));
  }

  /**
   * Clear all cache
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
      size: this.cache.size
    };
  }

  /**
   * Check if key exists and is valid
   */
  has(method: string, url: string, options: any = {}): boolean {
    if (!this.config.enabled) return false;

    const key = this.generateKey(method, url, options);
    const entry = this.cache.get(key);

    if (!entry) return false;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }
}
