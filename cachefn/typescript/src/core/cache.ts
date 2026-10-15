/**
 * Main CacheFn class
 */

import type {
  CacheFnConfig,
  ClearOptions,
  FetchOptions,
  QueueUpdateOptions,
  QueuedUpdateStatus,
  SetOptions,
  CacheStats,
  StorageType,
  EventHandler,
} from "./types.js";
import type { StorageBackend } from "../storage/storage-interface.js";
import { MemoryStorage } from "../storage/memory-storage.js";
import { AutoStorage } from "../storage/auto-storage.js";
import { LocalStorage } from "../storage/local-storage.js";
import { IndexedDBStorage } from "../storage/indexeddb-storage.js";
import { EventEmitter } from "./events.js";
import { StatsTracker } from "../analytics/stats.js";
import { calculateExpiration } from "../strategies/ttl-manager.js";
import { serialize, deserialize } from "../utils/serialize.js";
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
  private memoryTimer?: ReturnType<typeof setInterval>;
  private monitoring = false;
  private disposed = false;
  private offlineEnabled = false;
  private onlineListener?: () => void;
  private fetchers = new Map<string, FetchOptions<T>>();
  private queue: Array<QueuedUpdateStatus & { value: T; sync: NonNullable<QueueUpdateOptions<T>['sync']>; durable: boolean; order: number }> = [];
  private queueStorage?: StorageBackend<any>;
  private queueHandler?: NonNullable<QueueUpdateOptions<T>['sync']>;
  private queueReady?: Promise<void>;
  private queueLimit = 1000;
  private enqueueTail: Promise<unknown> = Promise.resolve();
  private syncing?: Promise<void>;
  private refreshing?: Promise<void>;
  private queueSequence = 0;
  private readonly queuePrefix = `${Date.now()}:${Math.random()}`;
  private pending = new Map<string, Promise<T>>();

  constructor(config: CacheFnConfig) {
    this.defaultTTL = config.defaultTTL;
    this.namespace = config.namespace;
    this.events = new EventEmitter();
    this.stats = new StatsTracker();

    // Initialize storage backend
    const storageType = config.storage ?? "memory";
    this.storage = this.createStorage(storageType, config);
    if (config.offlineStrategy !== undefined && config.offlineStrategy !== 'cache-first') throw new TypeError('Unknown offline strategy');
    this.offlineEnabled = config.offlineStrategy === 'cache-first';
    if (config.offlineQueue) {
      if (!this.offlineEnabled || typeof config.offlineQueue.sync !== 'function') throw new TypeError('offlineQueue requires cache-first and a sync handler');
      this.queueLimit = config.offlineQueue.maxSize ?? 1000;
      if (!Number.isSafeInteger(this.queueLimit) || this.queueLimit < 1) throw new RangeError('offlineQueue.maxSize must be a positive safe integer');
      this.queueHandler = config.offlineQueue.sync;
      const type = config.offlineQueue.storage ?? (storageType === 'auto' ? 'indexeddb' : storageType);
      if (!['memory', 'indexeddb', 'localstorage'].includes(type)) throw new TypeError('Unknown offline queue storage');
      const name = `offline-queue:${JSON.stringify([config.name, config.namespace ?? null])}`;
      // Queue storage never falls back or evicts acknowledged local work.
      this.queueStorage = type === 'memory' ? new MemoryStorage({ maxSize: Number.MAX_SAFE_INTEGER })
        : type === 'localstorage' ? new LocalStorage({ name, maxSize: Number.MAX_SAFE_INTEGER, maxBytes: Number.MAX_SAFE_INTEGER })
        : new IndexedDBStorage({ name });
    }
    this.startMemoryMonitoring(config);
    if (this.offlineEnabled && typeof globalThis.addEventListener === 'function') {
      this.onlineListener = () => {
        void this.sync().then(() => this.refresh()).catch(error => this.events.emit('sync-error', { error }));
      };
      globalThis.addEventListener('online', this.onlineListener);
    }
    if (this.queueHandler && this.isOnline()) void Promise.resolve().then(() => this.disposed ? undefined : this.sync()).catch(error => this.events.emit('sync-error', { error }));
  }

  /** Stop adaptive monitoring. Cached data remains available; safe to call repeatedly. */
  dispose(): void {
    this.disposed = true;
    clearInterval(this.memoryTimer);
    this.memoryTimer = undefined;
    if (this.onlineListener) globalThis.removeEventListener('online', this.onlineListener);
    this.onlineListener = undefined;
    this.pending.clear();
  }

  private heapUsage(): number | undefined {
    try {
      const memory = (globalThis.performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })?.memory;
      if (!memory || !Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.jsHeapSizeLimit) || memory.usedJSHeapSize < 0 || memory.jsHeapSizeLimit <= 0) return;
      return memory.usedJSHeapSize / memory.jsHeapSizeLimit;
    } catch { return; }
  }

  private startMemoryMonitoring(config: CacheFnConfig): void {
    if (config.eviction !== undefined && !['lru', 'adaptive'].includes(config.eviction)) throw new TypeError('Unknown eviction strategy');
    const { enabled = true, threshold = 0.8, checkInterval = 10000 } = config.memoryMonitoring ?? {};
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new RangeError('memoryMonitoring.threshold must be in (0, 1]');
    if (!Number.isSafeInteger(checkInterval) || checkInterval <= 0 || checkInterval > 2147483647) throw new RangeError('memoryMonitoring.checkInterval must be a positive timer interval');
    if (config.eviction !== 'adaptive' || !enabled || this.heapUsage() === undefined || !(this.storage instanceof MemoryStorage || this.storage instanceof AutoStorage)) return;
    this.memoryTimer = setInterval(() => {
      if (this.disposed || this.monitoring || (this.heapUsage() ?? 0) <= threshold) return;
      this.monitoring = true;
      const owns = (key: string) => !this.disposed && this.ownsKey(key);
      const storage = this.storage as MemoryStorage<T> | AutoStorage<T>;
      // Monitoring is best-effort and cannot turn observer errors into unhandled rejections.
      void Promise.resolve().then(() => storage.evictUnderPressure(owns)).catch(() => {}).finally(() => { this.monitoring = false; });
    }, checkInterval);
    (this.memoryTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Get a value from cache
   */
  async get(key: string): Promise<T | undefined> {
    const fullKey = this.getFullKey(key);
    const startTime = performance.now();

    const value = await this.storage.get(fullKey);
    const accessTime = performance.now() - startTime;

    if (value !== undefined || await this.storage.has(fullKey)) {
      this.stats.recordHit();
      this.events.emit("hit", { key: this.eventKey(key), accessTime });
    } else {
      this.stats.recordMiss();
      this.events.emit("miss", { key: this.eventKey(key) });
    }

    return value;
  }

  /**
   * Set a value in cache
   */
  async set(key: string, value: T, options?: SetOptions): Promise<void> {
    if (options?.priority !== undefined && !['low', 'normal', 'high'].includes(options.priority)) throw new TypeError('Unknown cache priority');
    const fullKey = this.getFullKey(key);
    this.pending.delete(fullKey);
    const ttl = options?.ttl ?? this.defaultTTL;

    const metadata = {
      createdAt: Date.now(),
      expiresAt: calculateExpiration(ttl),
      tags: options?.tags,
      priority: options?.priority,
      hits: 0,
      lastAccess: Date.now(),
    };

    await this.storage.set(fullKey, value, metadata);

    this.stats.recordSet();
    this.events.emit("set", { key: this.eventKey(key), size: 1 });
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
    this.pending.delete(fullKey);
    const deleted = await this.storage.delete(fullKey);

    if (deleted) {
      this.stats.recordDelete();
      this.events.emit("delete", { key: this.eventKey(key) });
    }

    return deleted;
  }

  /**
   * Clear all values from cache
   */
  async clear(options?: ClearOptions): Promise<void> {
    if (options?.priority !== undefined) {
      if (!['low', 'normal', 'high'].includes(options.priority)) throw new TypeError('Unknown cache priority');
      for (const key of (await this.storage.keys()).filter(key => this.ownsKey(key))) {
        const metadata = await this.storage.getMetadata(key);
        if (metadata && (metadata.priority ?? 'normal') === options.priority) {
          this.pending.delete(key);
          if (await this.storage.delete(key)) this.stats.recordDelete();
        }
      }
      return;
    }
    this.pending.clear();
    const keys = (await this.storage.keys()).filter((key) => this.ownsKey(key));
    await Promise.all(keys.map((key) => this.storage.delete(key)));
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

    const keysWithoutNamespace = allKeys.filter((key) => this.ownsKey(key))
      .map((key) => key.slice(this.keyPrefix().length));

    return filterByPattern(keysWithoutNamespace, pattern);
  }

  /**
   * Get the number of entries in cache
   */
  async size(): Promise<number> {
    return (await this.keys()).length;
  }

  /**
   * Get or fetch a value (cache-aside pattern)
   */
  getOrFetch(key: string, fetcher: () => Promise<T>, options?: SetOptions): Promise<T>;
  getOrFetch(key: string, options: FetchOptions<T>): Promise<T>;
  getOrFetch(key: string, fetcherOrOptions: (() => Promise<T>) | FetchOptions<T>, options?: SetOptions): Promise<T> {
    const config = typeof fetcherOrOptions === 'function' ? { ...options, fetcher: fetcherOrOptions } : fetcherOrOptions;
    if (this.offlineEnabled || typeof fetcherOrOptions !== 'function') this.fetchers.set(key, config);
    return this.fetchValue(key, config, false);
  }

  private isOnline(): boolean {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  private fetchValue(key: string, config: FetchOptions<T>, force: boolean): Promise<T> {
    const fullKey = this.getFullKey(key);
    const existing = this.pending.get(fullKey);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      await this.loadQueue();
      if (!force) {
        const cached = await this.get(key);
        if (cached !== undefined || await this.has(key)) return cached as T;
      }
      if (!this.isOnline() && (this.offlineEnabled || config.offlineFallback)) {
        if (config.offlineFallback) return await config.offlineFallback();
        throw new Error('CacheFn is offline and no cached value or offlineFallback is available');
      }
      const value = await config.fetcher();
      if (!this.disposed && this.pending.get(fullKey) === task && !this.queue.some(update => update.key === key)) await this.set(key, value, config);
      return value;
    }).finally(() => {
      if (this.pending.get(fullKey) === task) this.pending.delete(fullKey);
    });
    this.pending.set(fullKey, task);
    return task;
  }

  /** Refresh registered fetchers online without overwriting queued optimistic writes. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    if (this.disposed) return Promise.reject(new Error('CacheFn is disposed'));
    if (!this.isOnline()) return Promise.reject(new Error('CacheFn is offline'));
    const task = Promise.resolve().then(async () => {
      await this.loadQueue();
      for (const [key, config] of this.fetchers) {
        if (this.disposed || !this.isOnline()) break;
        if (this.queue.some(update => update.key === key)) continue;
        await this.pending.get(this.getFullKey(key));
        if (!this.disposed && this.isOnline() && !this.queue.some(update => update.key === key)) await this.fetchValue(key, config, true);
      }
    }).finally(() => { if (this.refreshing === task) this.refreshing = undefined; });
    this.refreshing = task;
    return task;
  }

  private loadQueue(): Promise<void> {
    if (!this.queueReady) {
      const work = (async () => {
        if (!this.queueStorage) return;
        const records = [];
        for (const id of await this.queueStorage.keys()) {
          const record = await this.queueStorage.get(id);
          if (record) records.push({ ...record, status: record.status === 'syncing' ? 'pending' : record.status, sync: this.queueHandler!, durable: true });
        }
        records.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        this.queue = records;
      })();
      this.queueReady = work.catch(error => { this.queueReady = undefined; throw error; });
    }
    return this.queueReady;
  }

  private async persistJob(update: typeof this.queue[number]): Promise<void> {
    if (!update.durable) return;
    const { id, key, value, attempts, status, order } = update;
    await this.queueStorage!.set(id, { id, key, value, attempts, status, order }, { createdAt: order, hits: 0, lastAccess: order });
  }

  /** Optimistic local write plus durable delivery when a config handler is supplied. */
  queueUpdate(key: string, value: T, options: QueueUpdateOptions<T> = {}): Promise<string> {
    const task = this.enqueueTail.then(async () => {
      if (!this.offlineEnabled) throw new Error('queueUpdate requires offlineStrategy: cache-first');
      if (this.disposed) throw new Error('CacheFn is disposed');
      if (options.priority !== undefined && !['low', 'normal', 'high'].includes(options.priority)) throw new TypeError('Unknown cache priority');
      const handler = options.sync ?? this.queueHandler;
      if (typeof handler !== 'function') throw new TypeError('queueUpdate requires a sync handler');
      await this.loadQueue();
      if (this.queue.length >= this.queueLimit) throw new Error('Offline update queue is full');
      const order = Math.max(Date.now(), (this.queue[this.queue.length - 1]?.order ?? 0) + 1);
      const durable = !options.sync && !!this.queueStorage;
      const snapshot = durable ? deserialize<T>(serialize(value)) : value;
      const update = { id: `${this.queuePrefix}:${++this.queueSequence}`, key, value: snapshot, sync: handler, attempts: 0, status: 'pending' as const, durable, order };
      await this.persistJob(update);
      this.queue.push(update);
      // A local-cache failure leaves the durable delivery job available to inspect/cancel.
      await this.set(key, value, options);
      if (this.isOnline()) void this.sync().catch(error => this.events.emit('sync-error', { error }));
      return update.id;
    });
    this.enqueueTail = task.catch(() => {});
    return task;
  }

  async queuedUpdates(): Promise<QueuedUpdateStatus[]> {
    await this.loadQueue();
    return this.queue.map(({ id, key, attempts, status, error }) => ({ id, key, attempts, status, error }));
  }

  /** Cancel an undelivered job without reverting optimistic cache data. */
  async cancelQueuedUpdate(id: string): Promise<boolean> {
    await this.loadQueue();
    const update = this.queue.find(item => item.id === id);
    if (!update || update.status === 'syncing') return false;
    // Reserve it against sync while the persistent deletion commits.
    update.status = 'syncing';
    try { if (update.durable) await this.queueStorage!.delete(id); }
    catch (error) { update.status = 'failed'; throw error; }
    this.queue = this.queue.filter(item => item !== update);
    return true;
  }

  /** FIFO single-flight delivery. Retained failures block later deliveries until retry/cancel. */
  sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    if (this.disposed) return Promise.reject(new Error('CacheFn is disposed'));
    if (!this.isOnline()) return Promise.reject(new Error('CacheFn is offline'));
    const task = Promise.resolve().then(async () => {
      await this.enqueueTail;
      await this.loadQueue();
      while (this.queue.length && !this.disposed && this.isOnline()) {
        const update = this.queue[0];
        if (update.status === 'syncing') break;
        update.status = 'syncing'; update.attempts++; delete update.error;
        try {
          await this.persistJob(update);
          if (this.disposed || !this.isOnline()) {
            update.status = 'pending'; await this.persistJob(update); break;
          }
          await update.sync({ id: update.id, key: update.key, value: update.durable ? deserialize<T>(serialize(update.value)) : update.value, attempt: update.attempts });
          if (update.durable) await this.queueStorage!.delete(update.id);
          this.queue = this.queue.filter(item => item !== update);
          this.events.emit('synced', { id: update.id, key: this.eventKey(update.key) });
        } catch (error) {
          update.status = 'failed'; update.error = error;
          try { await this.persistJob(update); } catch { /* Keep the original failure and retained record. */ }
          throw error;
        }
      }
    }).finally(() => { if (this.syncing === task) this.syncing = undefined; });
    this.syncing = task;
    return task;
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
    // Pending fetches may not have stored their tags yet.
    this.pending.clear();
    const keys = (await this.storage.getKeysByTag(tag)).filter((key) => this.ownsKey(key));
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
    for (const key of this.pending.keys()) {
      if (filterByPattern([key.slice(this.keyPrefix().length)], pattern).length) {
        this.pending.delete(key);
      }
    }
    const allKeys = await this.keys();
    const matchingKeys = filterByPattern(allKeys, pattern);
    const count = matchingKeys.length;

    await Promise.all(matchingKeys.map((key) => this.delete(key)));

    const patternStr = pattern instanceof RegExp ? pattern.source : pattern;
    this.events.emit("invalidate", { pattern: patternStr, count });
  }

  /**
   * Touch a key to update its last access time
   */
  async touch(key: string): Promise<void> {
    // Both backends update access metadata atomically during get.
    // A second write could overwrite an intervening set or resurrect a delete.
    await this.storage.get(this.getFullKey(key));
  }

  /**
   * Get entries matching a pattern
   */
  async entries(options?: {
    pattern?: string;
    limit?: number;
  }): Promise<Array<{ key: string; value: T }>> {
    const limit = options?.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError("limit must be a non-negative safe integer");
    }
    if (limit === 0) return [];
    const keys = await this.keys(options?.pattern);
    const limitedKeys = limit === undefined ? keys : keys.slice(0, limit);

    const entries: Array<{ key: string; value: T }> = [];

    for (const key of limitedKeys) {
      const value = await this.get(key);
      if (value !== undefined || await this.has(key)) {
        entries.push({ key, value: value as T });
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
  private eventKey(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  private keyPrefix(): string {
    // JSON encoding makes delimiters in namespace names unambiguous.
    return `cachefn:v2:${JSON.stringify([this.namespace ?? ""])}:`;
  }

  private ownsKey(key: string): boolean {
    return key.startsWith(this.keyPrefix());
  }

  private getFullKey(key: string): string {
    return this.keyPrefix() + key;
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
            if (!this.ownsKey(key)) return;
            this.stats.recordEviction();
            this.events.emit("eviction", { key: this.eventKey(key.slice(this.keyPrefix().length)), reason });
          },
        });

      case "indexeddb":
        return new IndexedDBStorage<T>({
          name: config.name,
        });

      case "localstorage":
        return new LocalStorage<T>({ name: config.name, maxSize: config.maxSize, maxBytes: config.localStorageMaxBytes,
          onEviction: (key, reason) => {
            if (!this.ownsKey(key)) return;
            this.stats.recordEviction();
            this.events.emit('eviction', { key: this.eventKey(key.slice(this.keyPrefix().length)), reason });
          },
        });
      case "auto":
        return new AutoStorage<T>({ ...config,
          onEviction: (key, reason) => {
            if (!this.ownsKey(key)) return;
            this.stats.recordEviction();
            this.events.emit('eviction', { key: this.eventKey(key.slice(this.keyPrefix().length)), reason });
          },
        });

      default:
        throw new Error(`Unknown storage type: ${type}`);
    }
  }
}
