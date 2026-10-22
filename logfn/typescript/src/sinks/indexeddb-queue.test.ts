import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IndexedDbQueue } from './indexeddb-queue.js';
import { sinkHttp } from './http.js';
import type { LogEvent } from '../types.js';
const event = (msg: string): LogEvent => ({ ts: '2026-10-18T00:00:00Z', level: 'info', msg, name: 'idb', version: '0' });
beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('persists across connection reopen and isolates queues', async () => {
  const first = new IndexedDbQueue('tenant-a', 10);
  await first.add([event('persisted')]); await first.close();
  const reopened = new IndexedDbQueue('tenant-a', 10);
  const other = new IndexedDbQueue('tenant-b', 10);
  expect((await reopened.batch(10)).map(row => row.event.msg)).toEqual(['persisted']);
  expect(await other.batch(10)).toEqual([]);
  await reopened.close(); await other.close();
});
it('bounds concurrent enqueue and acknowledges exact IDs without deleting newer writes', async () => {
  const a = new IndexedDbQueue('queue', 3), b = new IndexedDbQueue('queue', 3);
  await Promise.all([a.add([event('a'), event('b')]), b.add([event('c'), event('d')])]);
  const records = await a.batch(10); expect(records).toHaveLength(3);
  await b.add([event('new')]);
  await a.acknowledge(records);
  expect((await b.batch(10)).map(row => row.event.msg)).toEqual(['new']);
  await a.close(); await b.close();
});
it('keeps failed HTTP delivery durably queued until a later successful flush', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test', offlineBuffer: 'indexeddb', retry: { attempts: 1 } });
  await sink([event('retained')]); await expect(sink.flush!()).rejects.toThrow('503');
  const inspection = new IndexedDbQueue(JSON.stringify(['https://example.test', 'public']), 5000);
  expect((await inspection.batch(10)).map(row => row.event.msg)).toEqual(['retained']);
  await sink.close(); expect(await inspection.batch(10)).toEqual([]); await inspection.close();
});
it('recovers preexisting persisted events and honors request authentication', async () => {
  const queue = new IndexedDbQueue(JSON.stringify(['https://example.test', 'tenant']), 5000);
  await queue.add([event('before restart')]); await queue.close();
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test', offlineBuffer: 'indexeddb', offlineKey: 'tenant', auth: { token: 'secret' } });
  await sink.close();
  expect(fetch).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret' }), body: JSON.stringify({ events: [event('before restart')] }) }));
});
it('requires explicit queue isolation for credentials and refuses unavailable storage', () => {
  expect(() => sinkHttp({ url: 'https://example.test', offlineBuffer: 'indexeddb', auth: { token: 'secret' } })).toThrow('offlineKey');
  vi.stubGlobal('indexedDB', undefined);
  expect(() => sinkHttp({ url: 'https://example.test', offlineBuffer: 'indexeddb' })).toThrow('IndexedDB support');
});
it('triggers the batch threshold across separately persisted writes', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const sink = sinkHttp({ url: 'https://example.test', offlineBuffer: 'indexeddb', batch: 2 });
  await sink([event('one')]); expect(fetch).not.toHaveBeenCalled();
  await sink([event('two')]); await sink.close();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rolls back the entire enqueue transaction when an event cannot be cloned', async () => {
  const queue = new IndexedDbQueue('atomic', 10);
  await expect(queue.add([event('must roll back'), { ...event('invalid'), ctx: { fn: () => {} } }])).rejects.toThrow();
  expect(await queue.batch(10)).toEqual([]);
  await queue.close();
});
