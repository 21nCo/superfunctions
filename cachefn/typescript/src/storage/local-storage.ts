/** Bounded, atomic localStorage snapshots with authoritative entry metadata. */
import type { EntryMetadata, StorageBackend } from './storage-interface.js';
import { serialize, deserialize } from '../utils/serialize.js';
import { filterByPattern } from '../utils/pattern.js';

interface Entry<T> { key: string; value: T; metadata: EntryMetadata }
export interface LocalStorageConfig {
  name: string;
  maxBytes?: number;
  maxSize?: number;
  onEviction?: (key: string, reason: string) => void;
}
export class LocalStorage<T = any> implements StorageBackend<T> {
  private readonly key: string;
  private readonly maxBytes: number;
  private readonly maxSize: number;
  constructor(private readonly config: LocalStorageConfig) {
    this.key = `cachefn:local:v1:${JSON.stringify(config.name)}`;
    this.maxBytes = config.maxBytes ?? 4 * 1024 * 1024;
    this.maxSize = config.maxSize ?? 1000;
    for (const [name, value] of [['maxBytes', this.maxBytes], ['maxSize', this.maxSize]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
    }
  }
  private read(): Entry<T>[] {
    const raw = globalThis.localStorage.getItem(this.key);
    if (raw === null) return [];
    let entries: Entry<T>[];
    try {
      entries = deserialize(raw);
      if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.key !== 'string' || !entry.metadata ||
        typeof entry.metadata.createdAt !== 'number' || typeof entry.metadata.lastAccess !== 'number' || typeof entry.metadata.hits !== 'number' ||
        (entry.metadata.tags !== undefined && (!Array.isArray(entry.metadata.tags) || entry.metadata.tags.some(tag => typeof tag !== 'string'))))) throw new Error('Invalid cache snapshot');
    } catch {
      // Corrupt cache data is a miss, never application data or a partial index.
      globalThis.localStorage.removeItem(this.key);
      return [];
    }
    const live = entries.filter(entry => entry.metadata.expiresAt === undefined || Date.now() < entry.metadata.expiresAt);
    if (live.length !== entries.length) this.write(live);
    return live;
  }
  private write(entries: Entry<T>[]): void {
    if (!entries.length) { globalThis.localStorage.removeItem(this.key); return; }
    const payload = serialize(entries);
    if ((this.key.length + payload.length) * 2 > this.maxBytes) throw new DOMException('CacheFn localStorage byte limit exceeded', 'QuotaExceededError');
    // setItem replaces atomically, including when the browser rejects its quota.
    globalThis.localStorage.setItem(this.key, payload);
  }
  async get(key: string): Promise<T | undefined> {
    const entries = this.read();
    const index = entries.findIndex(entry => entry.key === key);
    if (index < 0) return undefined;
    const [entry] = entries.splice(index, 1);
    entry.metadata.hits++;
    entry.metadata.lastAccess = Date.now();
    entries.push(entry);
    this.write(entries);
    return entry.value;
  }
  async set(key: string, value: T, metadata: EntryMetadata): Promise<void> {
    if (this.maxSize === 0) return;
    const entries = this.read().filter(entry => entry.key !== key);
    const removed: Entry<T>[] = [];
    while (entries.length >= this.maxSize) removed.push(entries.shift()!);
    const entry = { key, value, metadata: { ...metadata, tags: metadata.tags ? [...new Set(metadata.tags)] : undefined } };
    entries.push(entry);
    // Evict older entries to respect the configured byte cap. An oversized single
    // entry rejects without replacing the old snapshot, allowing auto failover.
    while (entries.length > 1 && (this.key.length + serialize(entries).length) * 2 > this.maxBytes) removed.push(entries.shift()!);
    this.write(entries);
    for (const evicted of removed) this.config.onEviction?.(evicted.key, 'lru');
  }
  async has(key: string): Promise<boolean> { return this.read().some(entry => entry.key === key); }
  async delete(key: string): Promise<boolean> {
    const entries = this.read();
    const rest = entries.filter(entry => entry.key !== key);
    if (rest.length === entries.length) return false;
    this.write(rest); return true;
  }
  async clear(): Promise<void> { globalThis.localStorage.removeItem(this.key); }
  async keys(pattern?: string): Promise<string[]> { return filterByPattern(this.read().map(entry => entry.key), pattern); }
  async size(): Promise<number> { return this.read().length; }
  async getKeysByTag(tag: string): Promise<string[]> { return this.read().filter(entry => entry.metadata.tags?.includes(tag)).map(entry => entry.key); }
  async addTag(tag: string, key: string): Promise<void> { this.mutateTags(key, tags => [...new Set([...tags, tag])]); }
  async removeTag(tag: string, key: string): Promise<void> { this.mutateTags(key, tags => tags.filter(value => value !== tag)); }
  private mutateTags(key: string, mutate: (tags: string[]) => string[]): void {
    const entries = this.read(), entry = entries.find(entry => entry.key === key);
    if (!entry) return;
    entry.metadata.tags = mutate(entry.metadata.tags ?? []); this.write(entries);
  }
  async getTagsForKey(key: string): Promise<string[]> { return this.read().find(entry => entry.key === key)?.metadata.tags ?? []; }
  async getMetadata(key: string): Promise<EntryMetadata | undefined> { return this.read().find(entry => entry.key === key)?.metadata; }
}
