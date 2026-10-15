import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheFn } from '../src/core/cache.js';
const caches: CacheFn[] = [];
let online: boolean;
let seq = 0;
function create(extra: Record<string, unknown> = {}) {
  const cache = new CacheFn({ name: `offline-${++seq}`, offlineStrategy: 'cache-first', ...extra });
  caches.push(cache); return cache;
}
const deferred = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(r => resolve = r); return { promise, resolve }; };
beforeEach(() => { online = false; vi.stubGlobal('navigator', { get onLine() { return online; } }); });
afterEach(() => { caches.splice(0).forEach(cache => cache.dispose()); vi.unstubAllGlobals(); });

describe('offline fetching and refreshing', () => {
  it('prefers cached undefined, invokes offline fallback only on misses and never stores placeholder data', async () => {
    const cache = create(); const fetcher = vi.fn(async () => 5); const offlineFallback = vi.fn(() => 0);
    await cache.set('cached', undefined);
    expect(await cache.getOrFetch('cached', { fetcher, offlineFallback })).toBeUndefined();
    expect(await cache.getOrFetch('absent', { fetcher, offlineFallback })).toBe(0);
    expect(await cache.has('absent')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(offlineFallback).toHaveBeenCalledTimes(1);
    await expect(cache.getOrFetch('error', fetcher)).rejects.toThrow('offline');
  });
  it('refreshes registered hits online, remains single-flight, and preserves newer writes', async () => {
    online = true; const cache = create(); const gate = deferred(); let calls = 0;
    const fetcher = () => { calls++; return gate.promise; };
    await cache.set('key', 'cached');
    expect(await cache.getOrFetch('key', { fetcher })).toBe('cached');
    const first = cache.refresh(), second = cache.refresh(); expect(first).toBe(second);
    await vi.waitFor(() => expect(calls).toBe(1));
    await cache.set('key', 'newer'); gate.resolve('remote'); await first;
    expect(await cache.get('key')).toBe('newer');
    online = false; await expect(cache.refresh()).rejects.toThrow('offline');
  });
});

describe('offline update delivery', () => {
  it('restores ordered persistent jobs across instances, independent of cache clear/TTL and retries failures', async () => {
    const name = `persistent-${++seq}`; const delivered: string[] = []; let fail = true;
    const handler = vi.fn(async ({ id, value }) => { if (fail) throw new Error('server'); delivered.push(`${id}:${value}`); });
    const config = { name, storage: 'indexeddb', offlineQueue: { sync: handler } };
    const first = create(config);
    const a = await first.queueUpdate('key', 1, { ttl: 1 }); const b = await first.queueUpdate('key', 2);
    await first.clear(); first.dispose();
    const reopened = create(config); expect((await reopened.queuedUpdates()).map(job => job.id)).toEqual([a, b]);
    online = true; await expect(reopened.sync()).rejects.toThrow('server');
    expect((await reopened.queuedUpdates())[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    fail = false; await reopened.sync(); expect(delivered).toEqual([`${a}:1`, `${b}:2`]);
    expect(await create(config).queuedUpdates()).toEqual([]);
    expect(handler.mock.calls[1][0]).toMatchObject({ id: a, attempt: 2 });
  });
  it('serializes concurrent enqueue/sync, keeps optimistic writes, and does not duplicate active delivery', async () => {
    const cache = create(); const gate = deferred(); const values: number[] = [];
    const sync = async ({ value }: any) => { values.push(value); if (value === 1) await gate.promise; };
    await Promise.all([cache.queueUpdate('key', 1, { sync }), cache.queueUpdate('key', 2, { sync })]);
    expect(await cache.get('key')).toBe(2);
    online = true; const first = cache.sync(); expect(cache.sync()).toBe(first);
    await vi.waitFor(() => expect(values).toEqual([1]));
    const jobs = await cache.queuedUpdates(); expect(await cache.cancelQueuedUpdate(jobs[0].id)).toBe(false);
    gate.resolve(); await first; expect(values).toEqual([1, 2]); expect(await cache.get('key')).toBe(2);
  });
  it('snapshots durable values and isolates namespaced queues across reconstruction', async () => {
    const name = `snapshots-${++seq}`; const values: unknown[] = [];
    const sync = async ({ value }: any) => { values.push(value.n); value.n = 99; };
    const cache = create({ name, namespace: 'a', storage: 'indexeddb', offlineQueue: { sync } });
    const value = { n: 1 }; await cache.queueUpdate('key', value); value.n = 2;
    const neighbor = create({ name, namespace: 'a:b', storage: 'indexeddb', offlineQueue: { sync } });
    expect(await neighbor.queuedUpdates()).toEqual([]);
    online = true; await cache.sync(); expect(values).toEqual([1]);
  });
  it('detaches the online listener on disposal and exposes automatic delivery failures', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    const remove = vi.fn(target.removeEventListener.bind(target)); vi.stubGlobal('removeEventListener', remove);
    const handler = vi.fn(async () => { throw new Error('unreachable'); });
    const cache = create(); const error = vi.fn(); cache.on('sync-error', error);
    await cache.queueUpdate('key', 1, { sync: handler });
    online = true; target.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    cache.dispose(); expect(remove).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('online')); await Promise.resolve(); expect(handler).toHaveBeenCalledTimes(1);
  });
  it('retries restored in-flight records with the same id after an interrupted owner', async () => {
    const name = `interrupted-${++seq}`; const gate = deferred();
    const first = create({ name, storage: 'indexeddb', offlineQueue: { sync: () => gate.promise } });
    const id = await first.queueUpdate('key', 1); online = true;
    const active = first.sync(); await vi.waitFor(async () => expect((await first.queuedUpdates())[0].status).toBe('syncing'));
    first.dispose(); online = false;
    const restored = create({ name, storage: 'indexeddb', offlineQueue: { sync: async () => {} } });
    expect((await restored.queuedUpdates())[0]).toMatchObject({ id, status: 'pending', attempts: 1 });
    gate.resolve(); await active;
  });
  it('preserves durable jobs when persistence or cancellation is denied by the browser', async () => {
    const values = new Map<string, string>(); let denied = false;
    const check = () => { if (denied) throw new DOMException('Storage unavailable', 'SecurityError'); };
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { check(); values.set(key, value); },
      removeItem: (key: string) => { check(); values.delete(key); },
    });
    const name = `denied-${++seq}`; const config = { name, offlineQueue: { storage: 'localstorage', sync: async () => {} } };
    const cache = create(config); const id = await cache.queueUpdate('saved', 1);
    denied = true;
    await expect(cache.queueUpdate('rejected', 2)).rejects.toMatchObject({ name: 'SecurityError' });
    expect(await cache.has('rejected')).toBe(false);
    await expect(cache.cancelQueuedUpdate(id)).rejects.toMatchObject({ name: 'SecurityError' });
    expect((await cache.queuedUpdates())[0]).toMatchObject({ id, status: 'failed' });
    denied = false;
    expect((await create(config).queuedUpdates()).map(job => job.id)).toEqual([id]);
    expect(await cache.cancelQueuedUpdate(id)).toBe(true);
  });
  it('bounds durable queues without evicting jobs and cancellation persists', async () => {
    const name = `bounded-${++seq}`; const config = { name, storage: 'indexeddb', offlineQueue: { sync: async () => {}, maxSize: 1 } };
    const cache = create(config); const id = await cache.queueUpdate('first', 1);
    await expect(cache.queueUpdate('second', 2)).rejects.toThrow('full');
    expect(await cache.has('second')).toBe(false);
    expect(await cache.cancelQueuedUpdate(id)).toBe(true);
    expect(await cache.get('first')).toBe(1);
    expect(await create(config).queuedUpdates()).toEqual([]);
  });
  it('disposal lets an active delivery settle but prevents later jobs and late refresh writes', async () => {
    const cache = create(); const gate = deferred(); const handler = vi.fn(() => gate.promise);
    await cache.queueUpdate('first', 1, { sync: handler }); await cache.queueUpdate('second', 2, { sync: handler });
    online = true; const task = cache.sync(); await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    cache.dispose(); gate.resolve(); await task;
    expect((await cache.queuedUpdates()).length).toBe(1); await expect(cache.sync()).rejects.toThrow('disposed');
  });
  it('does not refresh over unsynchronized optimistic changes', async () => {
    const cache = create(); online = true;
    await cache.getOrFetch('key', { fetcher: async () => 1 }); online = false;
    await cache.queueUpdate('key', 2, { sync: async () => { throw new Error('failed'); } });
    online = true; await cache.refresh(); expect(await cache.get('key')).toBe(2);
  });
});
