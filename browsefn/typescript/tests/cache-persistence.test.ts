import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter } from '@superfunctions/db/adapters';
import { memoryAdapter } from '@superfunctions/db/adapters';
import { CacheManager } from '../src/core/cache-manager.js';
import type { CacheConfig } from '../src/core/types.js';
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
for (const backend of ['file', 'indexeddb', 'database'] as const) describe(`${backend} persistence`, () => {
  async function config(): Promise<CacheConfig> {
    const directory = await mkdtemp(join(tmpdir(), 'browsefn-cache-')); directories.push(directory);
    return { enabled: true, storage: backend, directory, indexedDB: new IDBFactory(), database: memoryAdapter(), name: 'test', ttl: 60000 };
  }
  it('survives new managers, preserves binary values and isolates cache identities', async () => {
    const options = await config(); const first = new CacheManager(options);
    const value = { screenshot: new Uint8Array([0, 255]), date: new Date('2026-01-01'), nested: { bytes: ['bytes', [1, 2]], empty: undefined } };
    await first.set('web', 'https://example.com', value);
    const second = new CacheManager(options);
    expect(await second.hasAsync('web', 'https://example.com')).toBe(true);
    expect(await second.get('web', 'https://example.com')).toEqual(value);
    expect(() => second.has('web', 'https://example.com')).toThrow('hasAsync');
    const other = new CacheManager({ ...options, name: 'test:child' });
    await other.set('web', 'https://example.com', 'other'); await second.clear();
    expect(await other.get('web', 'https://example.com')).toBe('other'); expect(await first.get('web', 'https://example.com')).toBeNull();
  });
  it('rolls back non-serializable writes and preserves prior durable values', async () => {
    const options = await config(); const cache = new CacheManager(options);
    await cache.set('web', 'url', 'before');
    await expect(cache.set('web', 'url', { unsupported: () => {} })).rejects.toThrow();
    await expect(cache.set('web', 'url', new Map([['key', 'value']]))).rejects.toThrow('Unsupported cache object type');
    expect(await new CacheManager(options).get('web', 'url')).toBe('before');
  });
  it('invalidates matching URLs without destroying other durable records', async () => {
    const options = await config(); const first = new CacheManager(options);
    await first.set('web', 'https://example.com/a', 1); await first.set('web', 'https://other.com/a', 2);
    await new CacheManager(options).invalidate('example.com');
    expect(await first.hasAsync('web', 'https://example.com/a')).toBe(false);
    expect(await first.get('web', 'https://other.com/a')).toBe(2);
  });
});
it.each(['memory', 'file', 'indexeddb', 'database'] as const)('preserves concurrent inserts for %s', async storage => {
  const directory = await mkdtemp(join(tmpdir(), 'browsefn-cache-')); directories.push(directory);
  const config = { enabled: true, storage, directory, indexedDB: new IDBFactory(), database: memoryAdapter() };
  const a = new CacheManager(config); const b = storage === 'memory' ? a : new CacheManager(config);
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).set('web', `url${i}`, i)));
  expect((await a.getStats()).size).toBe(12);
});
it('replacement at capacity retains other entries and evicts the least recently used entry', async () => {
  const cache = new CacheManager({ enabled: true, maxSize: 2 });
  await cache.set('web', 'a', 1); await cache.set('web', 'b', 2); await cache.set('web', 'b', 3);
  expect(await cache.get('web', 'a')).toBe(1); await cache.set('web', 'c', 4);
  expect(await cache.get('web', 'b')).toBeNull(); expect(await cache.get('web', 'a')).toBe(1);
});
it('expires at exact TTL, prunes statistics and validates overrides', async () => {
  vi.useFakeTimers(); const cache = new CacheManager({ enabled: true, ttl: 10 });
  await cache.set('web', 'a', 1); vi.advanceTimersByTime(10);
  expect(cache.has('web', 'a')).toBe(false); expect((await cache.getStats()).size).toBe(0);
  for (const ttl of [0, -1, Infinity, NaN]) await expect(cache.set('web', 'b', 1, { cache: { ttl } })).rejects.toThrow('ttl');
  for (const maxSize of [0, -1, 1.2, Infinity]) expect(() => new CacheManager({ enabled: true, maxSize })).toThrow('maxSize');
});
it('detaches cached values from caller-owned and returned objects', async () => {
  const cache = new CacheManager({ enabled: true }); const input = { values: [1] };
  await cache.set('web', 'a', input); input.values.push(2);
  const first = await cache.get<typeof input>('web', 'a'); first!.values.push(3);
  expect(await cache.get('web', 'a')).toEqual({ values: [1] });
});

it('persists through the shared Drizzle SQLite adapter without application adapterSchema', async () => {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE browsefn_cache (id TEXT PRIMARY KEY COLLATE NOCASE, value TEXT NOT NULL COLLATE NOCASE, revision INTEGER NOT NULL)');
  const table = sqliteTable('browsefn_cache', { id: text('id').primaryKey(), value: text('value').notNull(), revision: integer('revision').notNull() });
  const db = drizzle(sqlite, { schema: { browsefn_cache: table } });
  const adapter = drizzleAdapter({ db, dialect: 'sqlite', schema: { browsefn_cache: table } });
  const config = { enabled: true, storage: 'database' as const, database: adapter };
  try {
    const a = new CacheManager(config), b = new CacheManager(config);
    await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).set('web', `url${i}`, { bytes: new Uint8Array([i, 255]) })));
    expect((await b.getStats()).size).toBe(8);
    expect(await b.get('web', 'url2')).toEqual({ bytes: new Uint8Array([2, 255]) });
    const other = new CacheManager({ ...config, name: 'BROWSEFN' });
    await other.set('web', 'url2', 'separate');
    await a.clear(); expect(await b.hasAsync('web', 'url2')).toBe(false);
    expect(await other.get('web', 'url2')).toBe('separate');
  } finally { sqlite.close(); }
});
