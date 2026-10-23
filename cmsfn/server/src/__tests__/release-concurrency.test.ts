import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import type { Adapter } from '@superfunctions/db';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDocToRelease, createRelease, getRelease } from '../storage/releases.js';
import { cmsfnStorageAdapter } from '../storage/schema.js';

it.each([0, 499])('preserves concurrent SQLite additions and the capacity limit from %i docs', async initial => {
  const dir = await mkdtemp(join(tmpdir(), 'cms-release-cas-'));
  const path = join(dir, 'db.sqlite');
  const first = new Database(path); first.pragma('journal_mode = WAL');
  first.exec('CREATE TABLE cmsfn_releases (releaseId TEXT PRIMARY KEY, dataset TEXT NOT NULL, name TEXT NOT NULL, publishAt TEXT, nextRunAt TEXT, execution TEXT, docIds TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  const second = new Database(path);
  const connections = [first, second].map(database => new Kysely({ dialect: new SqliteDialect({ database }) }));
  const adapters = connections.map(db => kyselyAdapter({ db, dialect: 'sqlite', schema: { cmsfn_releases: 'cmsfn_releases' } }));
  try {
    const created = await createRelease({ db: adapters[0] }, { dataset: 'prod', name: 'Concurrent' });
    if (!created.ok) throw new Error('create failed');
    const input = { dataset: 'prod', releaseId: created.result.releaseId };
    const initialDocs = Array.from({ length: initial }, (_, i) => `doc-${i}`);
    await cmsfnStorageAdapter(adapters[0]).updateMany({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: input.releaseId }], data: { docIds: initialDocs } });
    let reads = 0; let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const writers: Adapter[] = adapters.map(adapter => ({ ...adapter, findOne: async params => {
      const row = await adapter.findOne(params);
      if (reads < 2) { reads++; if (reads === 2) release(); await barrier; }
      return row;
    } }));
    const results = await Promise.all(writers.map((db, index) => addDocToRelease({ db }, { ...input, docId: `new-${index}` })));
    expect(results.filter(result => result.ok)).toHaveLength(initial === 499 ? 1 : 2);
    const stored = await getRelease({ db: adapters[0] }, input);
    expect(stored?.docIds).toHaveLength(initial === 499 ? 500 : 2);
    expect(stored?.docIds).toEqual([...initialDocs, ...results.flatMap((result, index) => result.ok ? [`new-${index}`] : [])].sort());
    if (initial === 499) expect(results.find(result => !result.ok)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await addDocToRelease({ db: adapters[1] }, { ...input, docId: stored!.docIds[0] })).toEqual({ ok: true, result: {} });
    expect(await getRelease({ db: adapters[0] }, { ...input, dataset: 'other' })).toBeNull();
  } finally { await Promise.all(connections.map(db => db.destroy())); await rm(dir, { recursive: true }); }
});

it('bounds repeated CAS conflicts and rejects invalid or exhausted timestamp tokens', async () => {
  const { memoryAdapter } = await import('@superfunctions/db/adapters');
  const db = memoryAdapter();
  try {
    const created = await createRelease({ db }, { dataset: 'prod', name: 'Memory' });
    if (!created.ok) throw new Error('create failed');
    const input = { dataset: 'prod', releaseId: created.result.releaseId, docId: 'new' };
    let attempts = 0;
    const conflicting: Adapter = { ...db, updateMany: async () => { attempts++; return 0; } };
    expect(await addDocToRelease({ db: conflicting }, input)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(attempts).toBe(8);
    for (const updatedAt of ['invalid', '2026-10-23', '+275760-09-13T00:00:00.000Z']) {
      await db.updateMany({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: input.releaseId }], data: { updatedAt } });
      expect(await addDocToRelease({ db }, input)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      expect((await getRelease({ db }, input))?.docIds).toEqual([]);
    }
  } finally { vi.restoreAllMocks(); await db.close(); }
});

it('preserves two memory writers with the clock fixed to the existing token', async () => {
  const { memoryAdapter } = await import('@superfunctions/db/adapters');
  const db = memoryAdapter();
  try {
    const created = await createRelease({ db }, { dataset: 'prod', name: 'Memory' });
    if (!created.ok) throw new Error('create failed');
    const input = { dataset: 'prod', releaseId: created.result.releaseId };
    const before = await getRelease({ db }, input);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(before!.updatedAt));
    const results = await Promise.all(['a', 'b'].map(docId => addDocToRelease({ db }, { ...input, docId })));
    expect(results.every(value => value.ok)).toBe(true);
    const after = await getRelease({ db }, input);
    expect(after?.docIds).toEqual(['a', 'b']);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
  } finally { vi.restoreAllMocks(); await db.close(); }
});
