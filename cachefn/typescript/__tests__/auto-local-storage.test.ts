import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { LocalStorage } from '../src/storage/local-storage.js';
import { CacheFn } from '../src/core/cache.js';

class BrowserStorage {
  values = new Map<string, string>();
  fail = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.fail) throw new DOMException('Browser quota exhausted', 'QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}
let local: BrowserStorage;
let sequence = 0;
const name = () => `auto-test-${++sequence}`;
const metadata = (tags = ['one'], expiresAt?: number) => ({ createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags, expiresAt });
beforeEach(() => { local = new BrowserStorage(); vi.stubGlobal('localStorage', local); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('bounded localStorage', () => {
  it('does not report another namespace eviction as its own event', async () => {
    const shared = name();
    const first = new CacheFn({ name: shared, namespace: 'first', storage: 'localstorage', maxSize: 1 });
    const second = new CacheFn({ name: shared, namespace: 'second', storage: 'localstorage', maxSize: 1 });
    const listener = vi.fn();
    second.on('eviction', listener);
    await first.set('secret', 1);
    await second.set('own', 2);
    expect(listener).not.toHaveBeenCalled();
    await second.set('replacement', 3);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('roundtrips typed values, consistent tags and metadata across instances', async () => {
    const config = { name: name() };
    const first = new LocalStorage(config), second = new LocalStorage(config);
    const value = { date: new Date(1000), map: new Map([['a', 1n]]), missing: undefined };
    await first.set('key', value, metadata());
    expect(await second.get('key')).toEqual(value);
    await second.addTag('two', 'key'); await second.removeTag('one', 'key');
    expect(await first.getTagsForKey('key')).toEqual(['two']);
    expect((await first.getMetadata('key'))?.tags).toEqual(['two']);
    expect(await first.getKeysByTag('one')).toEqual([]);
    await first.set('key', value, (await first.getMetadata('key'))!);
    expect(await second.getKeysByTag('two')).toEqual(['key']);
  });
  it('expires entries and never creates orphan tags', async () => {
    const storage = new LocalStorage({ name: name() });
    await storage.set('expired', 1, metadata(['tag'], Date.now()-1));
    await storage.addTag('tag', 'absent');
    expect(await storage.keys()).toEqual([]);
    expect(await storage.size()).toBe(0);
    expect(await storage.getKeysByTag('tag')).toEqual([]);
    expect(await storage.getMetadata('expired')).toBeUndefined();
  });
  it('preserves prior data when browser quota rejects an atomic replacement', async () => {
    const storage = new LocalStorage({ name: name() });
    await storage.set('key', 'original', metadata());
    local.fail = true;
    await expect(storage.set('key', 'replacement', metadata(['replacement']))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    local.fail = false;
    expect(await storage.get('key')).toBe('original');
    expect(await storage.getKeysByTag('one')).toEqual(['key']);
  });
  it('applies LRU entry and byte caps without replacing a snapshot with an oversized value', async () => {
    const storage = new LocalStorage({ name: name(), maxSize: 2, maxBytes: 2500 });
    await storage.set('a', 'a', metadata()); await storage.set('b', 'b', metadata());
    await storage.get('a'); await storage.set('c', 'c', metadata());
    expect(await storage.keys()).toEqual(['a', 'c']);
    await expect(storage.set('huge', 'x'.repeat(3000), metadata())).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(await storage.keys()).toEqual(['a', 'c']);
  });
  it('clears/invalidate only the owning namespace and named cache', async () => {
    const shared = name();
    const a = new CacheFn({ name: shared, storage: 'localstorage', namespace: 'a' });
    const b = new CacheFn({ name: shared, storage: 'localstorage', namespace: 'a:b' });
    const root = new CacheFn({ name: shared, storage: 'localstorage' });
    local.values.set('application-data', 'keep');
    await a.set('b:key', 1, { tags: ['same'] }); await b.set('key', 2, { tags: ['same'] }); await root.set('key', 3, { tags: ['same'] });
    await a.invalidateByTag('same'); await root.clear();
    expect(await b.get('key')).toBe(2);
    expect(local.values.get('application-data')).toBe('keep');
  });
  it('treats malformed snapshots as misses', async () => {
    const cacheName = name();
    local.values.set(`cachefn:local:v1:${JSON.stringify(cacheName)}`, '{broken');
    expect(await new LocalStorage({ name: cacheName }).keys()).toEqual([]);
  });
});

describe('automatic storage fallback', () => {
  it('probes IndexedDB writes and removes its dedicated probe database', async () => {
    const cacheName = name(), cache = new CacheFn({ name: cacheName, storage: 'auto' });
    await cache.set('key', 1);
    expect(await cache.get('key')).toBe(1);
    expect(local.values.size).toBe(0);
    expect((await indexedDB.databases()).filter(db => db.name?.includes(`${cacheName}:probe:`))).toEqual([]);
  });
  it('falls from disabled IndexedDB to persistent localStorage without leftover probes', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    const cacheName = name();
    const cache = new CacheFn({ name: cacheName, storage: 'auto' });
    await cache.set('key', 1);
    expect(await new CacheFn({ name: cacheName, storage: 'localstorage' }).get('key')).toBe(1);
    expect([...local.values.keys()].some(key => key.includes(':probe:'))).toBe(false);
  });
  it('falls to memory when a storage property throws SecurityError', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError'); });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new DOMException('Denied', 'SecurityError'); } });
    const cache = new CacheFn({ name: name(), storage: 'auto' });
    await cache.set('key', 1); expect(await cache.get('key')).toBe(1);
  });
  it('honors configured localStorage preference and makes runtime quota fallback sticky', async () => {
    const cache = new CacheFn({ name: name(), storage: 'auto', fallbackOrder: ['localstorage'] });
    await cache.set('warm', 1);
    const before = local.values.size;
    local.fail = true;
    await cache.set('key', 2);
    local.fail = false;
    expect(await cache.get('key')).toBe(2);
    expect(await cache.get('warm')).toBeUndefined();
    expect(local.values.size).toBe(before);
    await cache.set('memory-only', 3);
    expect([...local.values.values()].join('')).not.toContain('memory-only');
  });
  it('falls through runtime IndexedDB quota errors and serializes concurrent writes during selection', async () => {
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value: any) {
      if (String(value.key).startsWith('cachefn:v2:')) throw new DOMException('full', 'QuotaExceededError');
      return original.call(this, value);
    });
    const cacheName = name(), cache = new CacheFn({ name: cacheName, storage: 'auto' });
    await Promise.all(Array.from({length: 10}, (_, i) => cache.set(`k${i}`, i)));
    expect(await cache.size()).toBe(10);
    expect(await new CacheFn({ name: cacheName, storage: 'localstorage' }).get('k9')).toBe(9);
  });
  it('does not mask serialization errors or change explicit backend selection', async () => {
    const cache = new CacheFn({ name: name(), storage: 'auto', fallbackOrder: ['localstorage'] });
    await expect(cache.set('function', () => 1)).rejects.toThrow('serialization');
    const explicit = new CacheFn({ name: name(), storage: 'localstorage' });
    local.fail = true;
    await expect(explicit.set('key', 1)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  });
  it('uses memory immediately if it is first and validates invalid fallback configuration', async () => {
    const open = vi.spyOn(indexedDB, 'open');
    const cache = new CacheFn({ name: name(), storage: 'auto', fallbackOrder: ['memory', 'indexeddb'] });
    await cache.set('key', 1); expect(await cache.get('key')).toBe(1);
    expect(open).not.toHaveBeenCalled(); expect(local.values.size).toBe(0);
    expect(() => new CacheFn({ name: name(), storage: 'auto', fallbackOrder: ['invalid'] as any })).toThrow();
  });
});
