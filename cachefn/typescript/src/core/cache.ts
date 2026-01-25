/**
 * Main CacheFn class
 */

import type {
  CacheFnConfig,
  SetOptions,
  CacheStats,
  StorageType,
  EventHandler,
} from "./types.js";
import type { StorageBackend } from "../storage/storage-interface.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import { IndexedDBStorage } from "../storage/indexeddb-storage.js";
import { EventEmitter } from "./events.js";
import { StatsTracker } from "../analytics/stats.js";
import { calculateExpiration } from "../strategies/ttl-manager.js";
import { filterByPattern } from "../utils/pattern.js";

/**
 * CacheFn - Self-hosted caching solution
 */
export class CacheFn<T = any> {
  private storage: StorageBackend<T>;
  private events: EventEmitter;
  private stats: StatsTracker;
  private defaultTTL?: number;
  private namespace?: string;

  constructor(config: CacheFnConfig) {
    this.defaultTTL = config.defaultTTL;
    this.namespace = config.namespace;
    this.events = new EventEmitter();
    this.stats = new StatsTracker();

    // Initialize storage backend
    const storageType = config.storage ?? "memory";
    this.storage = this.createStorage(storageType, config);
  }

  /**
   * Get a value from cache
   */
  async get(key: string): Promise<T | undefined> {
    const fullKey = this.getFullKey(key);
    const startTime = performance.now();

    const value = await this.storage.get(fullKey);
    const accessTime = performance.now() - startTime;

    if (value !== undefined) {
      this.stats.recordHit();
      this.events.emit("hit", { key: fullKey, accessTime });
    } else {
      this.stats.recordMiss();
      this.events.emit("miss", { key: fullKey });
    }

    return value;
  }

  /**
   * Set a value in cache
   */
  async set(key: string, value: T, options?: SetOptions): Promise<void> {
    const fullKey = this.getFullKey(key);
    const ttl = options?.ttl ?? this.defaultTTL;

    const metadata = {
      createdAt: Date.now(),
      expiresAt: calculateExpiration(ttl),
      tags: options?.tags,
      hits: 0,
      lastAccess: Date.now(),
    };

    await this.storage.set(fullKey, value, metadata);

    this.stats.recordSet();
    this.events.emit("set", { key: fullKey, size: 1 });
  }

  /**
   * Check if a key exists in cache
   */
  async has(key: string): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    return await this.storage.has(fullKey);
  }

  /**
   * Delete a value from cache
   */
  async delete(key: string): Promise<boolean> {
    const fullKey = this.getFullKey(key);
    const deleted = await this.storage.delete(fullKey);

    if (deleted) {
      this.stats.recordDelete();
      this.events.emit("delete", { key: fullKey });
    }

    return deleted;
  }

  /**
   * Clear all values from cache
   */
  async clear(): Promise<void> {
    await this.storage.clear();
    this.stats.reset();
  }

  /**
   * Get multiple values from cache
   */
  async getMany(keys: string[]): Promise<Array<T | undefined>> {
    return Promise.all(keys.map((key) => this.get(key)));
  }

  /**
   * Set multiple values in cache
   */
  async setMany(
    entries: Array<{ key: string; value: T; options?: SetOptions }>
  ): Promise<void> {
    await Promise.all(
      entries.map((entry) => this.set(entry.key, entry.value, entry.options))
    );
  }

  /**
   * Delete multiple values from cache
   */
  async deleteMany(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.delete(key)));
  }

  /**
   * Get all keys matching a pattern
   */
  async keys(pattern?: string): Promise<string[]> {
    const allKeys = await this.storage.keys();

    // Remove namespace prefix if present
    const keysWithoutNamespace = allKeys.map((key) =>
      this.namespace && key.startsWith(`${this.namespace}:`)
        ? key.slice(this.namespace.length + 1)
        : key
    );

    return filterByPattern(keysWithoutNamespace, pattern);
  }

  /**
   * Get the number of entries in cache
   */
  async size(): Promise<number> {
    return await this.storage.size();
  }

  /**
   * Get or fetch a value (cache-aside pattern)
   */
  async getOrFetch(
    key: string,
    fetcher: () => Promise<T>,
    options?: SetOptions
  ): Promise<T> {
    const cached = await this.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const value = await fetcher();
    await this.set(key, value, options);

    return value;
  }

  /**
   * Invalidate a single key (alias for delete)
   */
  async invalidate(key: string): Promise<boolean> {
    return await this.delete(key);
  }

  /**
   * Invalidate all keys with a specific tag
   */
  async invalidateByTag(tag: string): Promise<void> {
    const keys = await this.storage.getKeysByTag(tag);
    const count = keys.length;

    await Promise.all(keys.map((key) => this.storage.delete(key)));

    this.events.emit("invalidate", { pattern: `tag:${tag}`, count });
  }

  /**
   * Invalidate all keys with any of the specified tags
   */
  async invalidateByTags(tags: string[]): Promise<void> {
    await Promise.all(tags.map((tag) => this.invalidateByTag(tag)));
  }

  /**
   * Invalidate all keys matching a pattern
   */
  async invalidateByPattern(pattern: string | RegExp): Promise<void> {
    const allKeys = await this.storage.keys();
    const matchingKeys = filterByPattern(allKeys, pattern);
    const count = matchingKeys.length;

    await Promise.all(matchingKeys.map((key) => this.storage.delete(key)));

    const patternStr = pattern instanceof RegExp ? pattern.source : pattern;
    this.events.emit("invalidate", { pattern: patternStr, count });
  }

  /**
   * Touch a key to update its last access time
   */
  async touch(key: string): Promise<void> {
    const fullKey = this.getFullKey(key);
    const value = await this.storage.get(fullKey);

    if (value !== undefined) {
      const metadata = await this.storage.getMetadata(fullKey);
      if (metadata) {
        metadata.lastAccess = Date.now();
        await this.storage.set(fullKey, value, metadata);
      }
    }
  }

  /**
   * Get entries matching a pattern
   */
  async entries(options?: {
    pattern?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: T }>> {
    const keys = await this.keys(options?.pattern);
    const limitedKeys = options?.limit ? keys.slice(0, options.limit) : keys;

    const entries: Array<{ key: string; value: T }> = [];

    for (const key of limitedKeys) {
      const value = await this.get(key);
      if (value !== undefined) {
        entries.push({ key, value });
      }
    }

    return entries;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const size = await this.size();

    // Get memory usage if using memory storage
    let memoryUsage: number | undefined;
    if (this.storage instanceof MemoryStorage) {
      memoryUsage = this.storage.getMemoryUsage();
    }

    return this.stats.getStats(size, memoryUsage);
  }

  /**
   * Register an event listener
   */
  on(event: string, handler: EventHandler): void {
    this.events.on(event, handler);
  }

  /**
   * Unregister an event listener
   */
  off(event: string, handler: EventHandler): void {
    this.events.off(event, handler);
  }

  /**
   * Get the full key with namespace
   */
  private getFullKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  /**
   * Create storage backend based on type
   */
  private createStorage(
    type: StorageType,
    config: CacheFnConfig
  ): StorageBackend<T> {
    switch (type) {
      case "memory":
        return new MemoryStorage<T>({
          maxSize: config.maxSize,
          onEviction: (key, reason) => {
            this.stats.recordEviction();
            this.events.emit("eviction", { key, reason });
          },
        });

      case "indexeddb":
        return new IndexedDBStorage<T>({
          name: config.name,
        });

      default:
        throw new Error(`Unknown storage type: ${type}`);
    }
  }
}
