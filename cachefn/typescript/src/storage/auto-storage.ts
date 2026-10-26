/** Instance-local automatic failover; explicit backends never silently switch. */
import type { StorageBackend, EntryMetadata } from './storage-interface.js';
import { IndexedDBStorage } from './indexeddb-storage.js';
import { LocalStorage } from './local-storage.js';
import { MemoryStorage } from './memory-storage.js';
export type FallbackStorageType = 'indexeddb' | 'localstorage' | 'memory';
export interface AutoStorageConfig {
  name: string;
  fallbackOrder?: FallbackStorageType[];
  maxSize?: number;
  localStorageMaxBytes?: number;
  storageProbeTimeoutMs?: number;
  onEviction?: (key: string, reason: string) => void;
}
let probeId = 0;
export class AutoStorage<T = any> implements StorageBackend<T> {
  private readonly order: FallbackStorageType[];
  private readonly timeout: number;
  private index = -1;
  private backend?: StorageBackend<T>;
  private selecting?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: AutoStorageConfig) {
    const configured = config.fallbackOrder ?? ['indexeddb', 'localstorage', 'memory'];
    if (!configured.every(type => ['indexeddb', 'localstorage', 'memory'].includes(type))) throw new TypeError('Unknown automatic fallback backend');
    // Memory is always the terminal tier, even if omitted by the caller.
    const memoryIndex = configured.indexOf('memory');
    this.order = [...new Set(memoryIndex < 0 ? configured : configured.slice(0, memoryIndex)), 'memory'];
    this.timeout = config.storageProbeTimeoutMs ?? 1500;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) throw new RangeError('storageProbeTimeoutMs must be positive');
    // Validate configuration before any browser availability fallback can mask it.
    new MemoryStorage({ maxSize: config.maxSize });
    new LocalStorage({ name: config.name, maxSize: config.maxSize, maxBytes: config.localStorageMaxBytes });
  }
  private create(type: FallbackStorageType): StorageBackend<T> {
    if (type === 'indexeddb') return new IndexedDBStorage({ name: this.config.name });
    if (type === 'localstorage') return new LocalStorage({ name: this.config.name, maxSize: this.config.maxSize, maxBytes: this.config.localStorageMaxBytes, onEviction: this.config.onEviction });
    return new MemoryStorage({ maxSize: this.config.maxSize, onEviction: this.config.onEviction });
  }
  private async probe(type: FallbackStorageType): Promise<void> {
    if (type === 'memory') return;
    // Use a dedicated cache name: probing cannot evict or overwrite application entries.
    const name = `${this.config.name}:probe:${Date.now()}:${++probeId}:${Math.random()}`;
    const storage = type === 'indexeddb' ? new IndexedDBStorage({ name }) : new LocalStorage({ name });
    const work = (async () => {
      try {
        await storage.set('probe', 'ok', { createdAt: Date.now(), lastAccess: Date.now(), hits: 0 });
        if (await storage.get('probe') !== 'ok') throw new Error('Storage probe did not persist value');
      } finally {
        try { await storage.clear(); } finally {
          if (storage instanceof IndexedDBStorage) {
            storage.close();
            // The random database belongs only to this probe.
            await new Promise<void>((resolve, reject) => {
              const request = indexedDB.deleteDatabase(`cachefn-${name}`);
              request.onsuccess = () => resolve();
              request.onerror = () => reject(request.error);
              request.onblocked = () => reject(new Error('Probe cleanup blocked'));
            });
          }
        }
      }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Storage probe timeout')), this.timeout); })]);
    } finally { clearTimeout(timer); }
  }
  private async select(): Promise<void> {
    if (this.selecting) return this.selecting;
    this.selecting = (async () => {
      while (++this.index < this.order.length) {
        const type = this.order[this.index];
        try { await this.probe(type); this.backend = this.create(type); return; } catch { /* Try next configured tier. */ }
      }
      throw new Error('No automatic cache backend available');
    })();
    try { await this.selecting; } finally { this.selecting = undefined; }
  }
  private run<R>(operation: (backend: StorageBackend<T>) => Promise<R>): Promise<R> {
    // Serialize operations so queued writes cannot race a failover decision.
    const task = this.tail.then(async () => {
      if (!this.backend) await this.select();
      while (true) {
        try { return await operation(this.backend!); }
        catch (error) {
          const name = error instanceof Error ? error.name : '';
          // A data-clone/serialization/argument error is not storage unavailability.
          if (this.order[this.index] === 'memory' || !['SecurityError', 'QuotaExceededError', 'InvalidStateError', 'UnknownError', 'AbortError', 'NotFoundError', 'VersionError'].includes(name)) throw error;
          if (this.backend instanceof IndexedDBStorage) this.backend.close();
          this.backend = undefined;
          await this.select();
        }
      }
    });
    this.tail = task.catch(() => {});
    return task;
  }
  /** Never initializes a persistent tier merely to sample heap pressure. */
  async evictUnderPressure(owns: (key: string) => boolean): Promise<void> {
    const task = this.tail.then(() => {
      if (this.backend instanceof MemoryStorage) this.backend.evictUnderPressure(owns);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  /** Atomic only on a selected capable tier; never replay an aborted bulk operation. */
  tryDeleteMatching(matches: (key: string) => boolean): Promise<string[] | undefined> {
    const task = this.tail.then(async () => {
      if (!this.backend) await this.select();
      // Capability is checked after prior queued operations/failover have settled.
      if (!this.backend?.deleteMatching) return undefined;
      return this.backend.deleteMatching(matches);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  get(key: string): Promise<T | undefined> { return this.run(storage => storage.get(key)); }
  set(key: string, value: T, metadata: EntryMetadata): Promise<void> { return this.run(storage => storage.set(key, value, metadata)); }
  has(key: string): Promise<boolean> { return this.run(storage => storage.has(key)); }
  delete(key: string): Promise<boolean> { return this.run(storage => storage.delete(key)); }
  clear(): Promise<void> { return this.run(storage => storage.clear()); }
  keys(pattern?: string): Promise<string[]> { return this.run(storage => storage.keys(pattern)); }
  size(): Promise<number> { return this.run(storage => storage.size()); }
  getKeysByTag(tag: string): Promise<string[]> { return this.run(storage => storage.getKeysByTag(tag)); }
  addTag(tag: string, key: string): Promise<void> { return this.run(storage => storage.addTag(tag, key)); }
  removeTag(tag: string, key: string): Promise<void> { return this.run(storage => storage.removeTag(tag, key)); }
  getTagsForKey(key: string): Promise<string[]> { return this.run(storage => storage.getTagsForKey(key)); }
  getMetadata(key: string): Promise<EntryMetadata | undefined> { return this.run(storage => storage.getMetadata(key)); }
}
