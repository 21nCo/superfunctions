/**
 * Cache manager for storing and retrieving responses.
 */

import { BrowseFnError } from './errors.js';
import type { CacheConfig } from './types.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size: number;
}

export interface NormalizedCacheConfig {
  enabled: boolean;
  ttl: number;
  storage: NonNullable<CacheConfig['storage']>;
  maxSize?: number;
  keyGenerator?: CacheConfig['keyGenerator'];
}

const SUPPORTED_CACHE_STORAGES = new Set<NonNullable<CacheConfig['storage']>>([
  'memory',
  'indexeddb',
  'file',
  'database',
]);

export class CacheManager {
  readonly config: NormalizedCacheConfig;

  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig) {
    this.config = CacheManager.normalizeConfig(config);
  }

  static normalizeConfig(config: CacheConfig): NormalizedCacheConfig {
    const storage = config.storage ?? 'memory';

    if (!SUPPORTED_CACHE_STORAGES.has(storage)) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: `Unsupported cache storage: ${storage}`,
      });
    }

    const ttl = config.ttl ?? config.defaultTTL ?? 3_600_000;
    if (ttl <= 0) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'Cache ttl must be greater than 0.',
      });
    }

    return {
      enabled: config.enabled,
      ttl,
      storage,
      maxSize: config.maxSize,
      keyGenerator: config.keyGenerator,
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  private generateKey(method: string, url: string, options: unknown): string {
    if (this.config.keyGenerator) {
      return this.config.keyGenerator(method, url, options);
    }

    return [
      method.trim().toLowerCase(),
      CacheManager.normalizeUrl(url),
      CacheManager.stableStringify(CacheManager.normalizeOptions(options)),
    ].join(':');
  }

  private static normalizeUrl(url: string): string {
    try {
      return new URL(url).toString();
    } catch {
      return url;
    }
  }

  private static normalizeOptions(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => CacheManager.normalizeOptions(item));
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    const record = value as Record<string, unknown>;
    const normalizedEntries = Object.keys(record)
      .sort()
      .filter((key) => typeof record[key] !== 'function' && record[key] !== undefined)
      .map((key) => {
        const nextValue =
          key === 'provider' && typeof record[key] === 'string'
            ? String(record[key]).trim().toLowerCase()
            : CacheManager.normalizeOptions(record[key]);
        return [key, nextValue] as const;
      });

    return Object.fromEntries(normalizedEntries);
  }

  private static stableStringify(value: unknown): string {
    return JSON.stringify(value) ?? 'null';
  }

  async get<T>(method: string, url: string, options: unknown = {}): Promise<T | null> {
    if (!this.config.enabled) {
      return null;
    }

    const key = this.generateKey(method, url, options);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses += 1;
      return null;
    }

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      this.misses += 1;
      return null;
    }

    this.hits += 1;
    return entry.data as T;
  }

  async set<T>(method: string, url: string, data: T, options: unknown = {}): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const key = this.generateKey(method, url, options);
    const ttl = this.resolveTtl(options);

    if (this.config.maxSize && this.cache.size >= this.config.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (typeof firstKey === 'string') {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl,
    });
  }

  private resolveTtl(options: unknown): number {
    if (
      options &&
      typeof options === 'object' &&
      'cache' in (options as Record<string, unknown>)
    ) {
      const cache = (options as { cache?: boolean | { ttl?: number } }).cache;
      if (cache && typeof cache === 'object' && typeof cache.ttl === 'number') {
        return cache.ttl;
      }
    }

    return this.config.ttl;
  }

  async invalidate(urlOrPattern: string): Promise<void> {
    const normalizedPattern = CacheManager.normalizeUrl(urlOrPattern);
    const keysToDelete: string[] = [];

    for (const key of this.cache.keys()) {
      if (key.includes(normalizedPattern) || key.includes(urlOrPattern)) {
        keysToDelete.push(key);
      }
    }

    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  async getStats(): Promise<CacheStats> {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
      size: this.cache.size,
    };
  }

  has(method: string, url: string, options: unknown = {}): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const key = this.generateKey(method, url, options);
    const entry = this.cache.get(key);

    if (!entry) {
      return false;
    }

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return false;
    }

    return true;
  }
}
