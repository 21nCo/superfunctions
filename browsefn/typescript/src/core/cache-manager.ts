/**
 * Cache manager for storing and retrieving responses.
 */

import { Logger } from '../middleware/logging.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { BrowseFnError } from './errors.js';
import { createPersistentStore, CACHE_DATABASE_SCHEMA, type CacheStore, type Entries } from './cache-storage.js';
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
  static readonly databaseSchema = CACHE_DATABASE_SCHEMA;
  readonly config: NormalizedCacheConfig;

  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly store?: CacheStore;
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig) {
    this.config = CacheManager.normalizeConfig(config);
    if (config.enabled && this.config.storage !== 'memory') this.store = createPersistentStore(config);
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
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new BrowseFnError({
        code: 'INVALID_ARGUMENT',
        message: 'Cache ttl must be greater than 0.',
      });
    }

    if (config.maxSize !== undefined && (!Number.isInteger(config.maxSize) || config.maxSize <= 0)) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Cache maxSize must be a positive integer.' });

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
      bytesToHex(sha256(CacheManager.stableStringify(CacheManager.normalizeOptions(options)))),
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

  private run<T>(operation: (entries: Entries) => T): Promise<T> {
    if (this.store) return this.store.run(operation);
    return Promise.resolve(operation(this.cache));
  }

  private prune(entries: Entries): void {
    const now = Date.now();
    for (const [key, entry] of entries) if (now - entry.timestamp >= entry.ttl) entries.delete(key);
  }

  async get<T>(method: string, url: string, options: unknown = {}): Promise<T | null> {
    if (!this.config.enabled || Logger.hasUrlCredentials(url)) return null;
    const result = await this.run(entries => {
      this.prune(entries);
      const key = this.generateKey(method, url, options); const entry = entries.get(key);
      if (entry) { entries.delete(key); entries.set(key, entry); }
      return entry;
    });
    if (!result) { this.misses++; return null; }
    this.hits++;
    return structuredClone(result.data) as T;
  }

  async set<T>(method: string, url: string, data: T, options: unknown = {}): Promise<void> {
    if (!this.config.enabled || Logger.hasUrlCredentials(url)) return;
    const key = this.generateKey(method, url, options); const ttl = this.resolveTtl(options);
    const storedData = structuredClone(data);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Cache ttl must be greater than 0.' });
    await this.run(entries => {
      this.prune(entries);
      entries.delete(key);
      while (this.config.maxSize && entries.size >= this.config.maxSize) entries.delete(entries.keys().next().value!);
      entries.set(key, { data: storedData, timestamp: Date.now(), ttl });
    });
  }

  private resolveTtl(options: unknown): number {
    if (
      options &&
      typeof options === 'object' &&
      'cache' in (options as Record<string, unknown>)
    ) {
      const cache = (options as { cache?: boolean | { ttl?: number } }).cache;
      if (cache && typeof cache === 'object' && cache.ttl !== undefined) {
        if (typeof cache.ttl !== 'number') throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: 'Cache ttl must be a finite number.' });
        return cache.ttl;
      }
    }

    return this.config.ttl;
  }

  async invalidate(urlOrPattern: string): Promise<void> {
    const pattern = CacheManager.normalizeUrl(urlOrPattern);
    await this.run(entries => { for (const key of entries.keys()) if (key.includes(pattern) || key.includes(urlOrPattern)) entries.delete(key); });
  }

  async clear(): Promise<void> {
    await this.run(entries => entries.clear()); this.hits = 0; this.misses = 0;
  }

  async getStats(): Promise<CacheStats> {
    const size = await this.run(entries => { this.prune(entries); return entries.size; });
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total > 0 ? this.hits / total * 100 : 0, size };
  }

  /** Synchronous memory lookup. Persistent callers must use hasAsync. */
  has(method: string, url: string, options: unknown = {}): boolean {
    if (!this.config.enabled) return false;
    if (this.store) throw new Error('Persistent cache presence requires await cache.hasAsync(...)');
    this.prune(this.cache);
    return this.cache.has(this.generateKey(method, url, options));
  }

  async hasAsync(method: string, url: string, options: unknown = {}): Promise<boolean> {
    if (!this.config.enabled) return false;
    return this.run(entries => { this.prune(entries); return entries.has(this.generateKey(method, url, options)); });
  }
}
