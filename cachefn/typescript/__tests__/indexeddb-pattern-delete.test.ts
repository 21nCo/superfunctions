import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheFn } from '../src/core/cache.js';
import { IndexedDBStorage } from '../src/storage/indexeddb-storage.js';

let sequence = 0;
const name = () => `batch-delete-${++sequence}`;
const metadata = () => ({ createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags: ['tag'] });
afterEach(() => vi.restoreAllMocks());

describe('committed IndexedDB pattern deletion', () => {
  it.each(['missing', 'wrong'] as const)('supports a database with a %s expiration index without changing its schema', async index => {
    const database = name();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`cachefn-${database}`, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('entries', { keyPath: 'key' });
        if (index === 'wrong') store.createIndex('expiresAt', 'expiresAt');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
    const storage = new IndexedDBStorage<number>({ name: database });
    await storage.set('match', 1, metadata());
    await storage.set('expired', 2, { ...metadata(), expiresAt: Date.now() - 1 });
    await storage.set('keep', 3, metadata());
    expect(await storage.deleteMatching(key => key === 'match')).toEqual(['match']);
    expect(await storage.delete('expired')).toBe(false);
    expect(await storage.get('keep')).toBe(3);
    storage.close();
  });

  it('uses inclusive expiration boundaries and does not expire absent or future timestamps', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('boundary', 1, { ...metadata(), expiresAt: 1000 });
    await storage.set('past', 2, { ...metadata(), expiresAt: 999 });
    await storage.set('future', 3, { ...metadata(), expiresAt: 1001 });
    await storage.set('absent', 4, metadata());
    expect(await storage.deleteMatching(() => false)).toEqual([]);
    expect(await storage.delete('boundary')).toBe(false);
    expect(await storage.delete('past')).toBe(false);
    expect(await storage.get('future')).toBe(3);
    expect(await storage.get('absent')).toBe(4);
    storage.close();
  });

  it('rejects an expiration-index request failure without removing records', async () => {
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('a', 1, metadata());
    vi.spyOn(IDBIndex.prototype, 'getAllKeys').mockImplementationOnce(() => { throw new Error('index read failed'); });
    await expect(storage.deleteMatching(() => true)).rejects.toThrow('index read failed');
    expect(await storage.get('a')).toBe(1);
    storage.close();
  });

  it('enumerates live keys in storage order and commits expired cleanup with the snapshot', async () => {
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('z', 1, metadata());
    await storage.set('expired', 2, { ...metadata(), expiresAt: Date.now() - 1 });
    await storage.set('a', 3, metadata());
    expect(await storage.deleteMatching(key => key === 'z')).toEqual(['z']);
    expect(await storage.keys()).toEqual(['a']);
    expect(await storage.delete('expired')).toBe(false);
    expect(await storage.getKeysByTag('tag')).toEqual(['a']);
    storage.close();
  });

  it('does not return an enumeration when expiry cleanup aborts and restores expired records', async () => {
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('expired', 1, { ...metadata(), expiresAt: Date.now() - 1 });
    await storage.set('live', 2, metadata());
    const original = IDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(storage.deleteMatching(() => false)).rejects.toThrow('aborted');
    deletion.mockRestore();
    // Direct delete intentionally reports physical existence, including expired entries.
    expect(await storage.delete('expired')).toBe(true);
    expect(await storage.get('live')).toBe(2);
    storage.close();
  });

  it('rolls back earlier matching deletions when a later predicate throws', async () => {
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('a', 1, metadata()); await storage.set('b', 2, metadata());
    await expect(storage.deleteMatching(key => {
      if (key === 'b') throw new Error('predicate failed');
      return true;
    })).rejects.toThrow('predicate failed');
    expect(await storage.get('a')).toBe(1); expect(await storage.get('b')).toBe(2);
    storage.close();
  });

  it('uses one transaction for the entire batch and waits for its commit', async () => {
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('a', 1, metadata());
    await storage.set('b', 2, metadata());
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const deleted = await storage.deleteMatching(() => true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(['a', 'b']);
    expect(await storage.size()).toBe(0);
    storage.close();
  });

  it('rolls back all removals when a later successful delete request aborts', async () => {
    const storage = new IndexedDBStorage<number>({ name: name() });
    await storage.set('a', 1, metadata());
    await storage.set('b', 2, metadata());
    const original = IDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key);
      if (key === 'b') request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(storage.deleteMatching(() => true)).rejects.toThrow('aborted');
    deletion.mockRestore();
    expect(await storage.get('a')).toBe(1);
    expect(await storage.get('b')).toBe(2);
    storage.close();
  });

  it('preserves namespaces, regex state, actual delete statistics and post-commit observer writes', async () => {
    const database = name();
    const cache = new CacheFn<number>({ name: database, storage: 'indexeddb', namespace: 'a' });
    const child = new CacheFn<number>({ name: database, storage: 'indexeddb', namespace: 'a:b' });
    await cache.set('match:a', 1); await cache.set('match:b', 2); await cache.set('keep', 3);
    await child.set('match:a', 4);
    const deletes: string[] = [];
    const invalidations: unknown[] = [];
    let replacement: Promise<void> | undefined;
    cache.on('delete', event => {
      deletes.push(event.key);
      if (event.key === 'a:match:a') replacement = cache.set('match:b', 5);
    });
    cache.on('invalidate', event => invalidations.push(event));
    const pattern = /^match:/g; pattern.lastIndex = 4;
    await cache.invalidateByPattern(pattern);
    await replacement;
    expect(pattern.lastIndex).toBe(4);
    expect(deletes).toEqual(['a:match:a', 'a:match:b']);
    expect(invalidations).toEqual([{ pattern: '^match:', count: 2 }]);
    expect((await cache.getStats()).deletes).toBe(2);
    expect(await cache.get('match:a')).toBeUndefined();
    expect(await cache.get('match:b')).toBe(5);
    expect(await cache.get('keep')).toBe(3);
    expect(await child.get('match:a')).toBe(4);
    await cache.deleteMany(['keep', 'keep', 'missing']);
    expect((await cache.getStats()).deletes).toBe(3);
    cache.dispose(); child.dispose();
  });

  it('rejects an aborted public invalidation without success events or delete statistics', async () => {
    const cache = new CacheFn<number>({ name: name(), storage: 'indexeddb' });
    await cache.set('match:a', 1); await cache.set('match:b', 2);
    const events = vi.fn(); cache.on('delete', events); cache.on('invalidate', events);
    const original = IDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key);
      if (String(key).endsWith('match:b')) request.addEventListener('success', () => this.transaction.abort());
      return request;
    });
    await expect(cache.invalidateByPattern('match:*')).rejects.toThrow('aborted');
    deletion.mockRestore();
    expect(events).not.toHaveBeenCalled();
    expect((await cache.getStats()).deletes).toBe(0);
    expect(await cache.getMany(['match:a', 'match:b'])).toEqual([1, 2]);
    cache.dispose();
  });

  it('counts each committed removal once across overlapping connections', async () => {
    const database = name();
    const first = new CacheFn<number>({ name: database, storage: 'indexeddb' });
    const second = new CacheFn<number>({ name: database, storage: 'indexeddb' });
    await first.set('match:a', 1); await first.set('match:b', 2);
    await second.has('match:a');
    const counts: number[] = [];
    first.on('invalidate', event => counts.push(event.count));
    second.on('invalidate', event => counts.push(event.count));
    await Promise.all([first.invalidateByPattern('match:*'), second.invalidateByPattern('match:*')]);
    expect(counts.sort()).toEqual([0, 2]);
    expect((await first.getStats()).deletes + (await second.getStats()).deletes).toBe(2);
    expect(await first.size()).toBe(0);
    first.dispose(); second.dispose();
  });

  it('fences an absent pending fill before public pattern deletion', async () => {
    const cache = new CacheFn<number>({ name: name(), storage: 'indexeddb' });
    let resolve!: (value: number) => void;
    let started!: () => void;
    const began = new Promise<void>(done => { started = done; });
    const pending = cache.getOrFetch('key', () => { started(); return new Promise(done => { resolve = done; }); });
    await began;
    await cache.invalidateByPattern('k*');
    resolve(9);
    expect(await pending).toBe(9);
    expect(await cache.has('key')).toBe(false);
    cache.dispose();
  });

  it('fences a refresh admitted while the matching transaction is opening', async () => {
    const cache = new CacheFn<number>({ name: name(), storage: 'indexeddb' });
    await cache.set('key', 1);
    let deliver!: (value: number) => void;
    let fetched!: () => void;
    const fetching = new Promise<void>(done => { fetched = done; });
    await cache.getOrFetch('key', { fetcher: () => {
      fetched(); return new Promise<number>(done => { deliver = done; });
    } });
    let entered!: () => void, release!: () => void;
    const opening = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    const original = IndexedDBStorage.prototype.deleteMatching;
    vi.spyOn(IndexedDBStorage.prototype, 'deleteMatching').mockImplementationOnce(async function (this: IndexedDBStorage<number>, matches) {
      entered(); await gate;
      return original.call(this, matches);
    });
    const invalidating = cache.invalidateByPattern('k*');
    await opening;
    const refreshing = cache.refresh();
    await fetching;
    release(); await invalidating;
    deliver(9); await refreshing;
    expect(await cache.has('key')).toBe(false);
    cache.dispose();
  });
});


it('preserves the fallback for backends without transactional pattern deletion', async () => {
  class FallbackCache extends CacheFn<number> {
    constructor() {
      super({ name: name(), storage: 'indexeddb' });
      this.storage.deleteMatching = undefined;
    }
  }
  const cache = new FallbackCache();
  await cache.set('match:a', 1); await cache.set('match:b', 2); await cache.set('keep', 3);
  const removed: string[] = [];
  cache.on('delete', event => removed.push(event.key));
  await cache.invalidateByPattern('match:*');
  expect(removed).toEqual(['match:a', 'match:b']);
  expect(await cache.get('keep')).toBe(3);
  expect((await cache.getStats()).deletes).toBe(2);
  cache.dispose();
});
