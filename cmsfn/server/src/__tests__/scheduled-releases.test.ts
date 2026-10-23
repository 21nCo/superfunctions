import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import type { Adapter } from '@superfunctions/db';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRelease, addDocToRelease, getRelease, listReleases } from '../storage/releases.js';
import { executeDueReleases, executeRelease, PUBLISH_REPLAY_CAPABILITY, type ReleaseExecutorConfig } from '../releases/executor.js';
import { readExecutableRelease } from '../releases/journal.js';
import { backfillReleaseSchedules } from '../releases/migrate.js';
import { cmsfnStorageAdapter } from '../storage/schema.js';

async function fixture(run: (f: {
  config: ReleaseExecutorConfig; open: () => Adapter; create: (ids: string[], at?: string) => Promise<string>;
  advance: (ms: number) => void; now: () => number; sent: Array<{ key: string; ifRev: string; id: string }>;
  effects: Set<string>; state: { dropAck: boolean; denied: boolean; actor: string; status: boolean; hold?: Promise<void>; onSend?: () => void; reads: number };
  reopen: () => Promise<void>;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cms-schedules-'));
  const path = join(dir, 'db.sqlite');
  const setup = new Database(path);
  setup.exec('CREATE TABLE cmsfn_releases (releaseId TEXT PRIMARY KEY, dataset TEXT NOT NULL, name TEXT NOT NULL, publishAt TEXT, docIds TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, execution TEXT, nextRunAt TEXT)'); setup.close();
  const adapters: Adapter[] = [];
  const open = () => { const native = new Database(path); native.pragma('journal_mode = WAL'); const sql = new Kysely({ dialect: new SqliteDialect({ database: native }) }); const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { cmsfn_releases: 'cmsfn_releases' } }); adapters.push(db); return db; };
  const sent: Array<{ key: string; ifRev: string; id: string }> = [];
  const effects = new Set<string>(); const replies = new Map<string, object>();
  const state = { dropAck: false, denied: false, actor: 'scheduler', status: true, hold: undefined as Promise<void> | undefined, onSend: undefined as (() => void) | undefined, reads: 0 };
  let time = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => time);
  const http = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/contentfn/status') { res.end(JSON.stringify({ ok: true, result: { serverTime: new Date().toISOString(), capabilities: state.status ? ['content.docs', PUBLISH_REPLAY_CAPABILITY] : [] } })); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text) as { id: string; ifRev: string };
    if (req.url === '/contentfn/docs/get') { state.reads++; res.end(JSON.stringify({ ok: true, result: { _id: input.id, _type: 'post', _rev: 'approved-r1', _cms: { state: input.id.endsWith('unapproved') ? 'draft' : 'approved' } } })); return; }
    const key = String(req.headers['idempotency-key']); sent.push({ key, ifRev: input.ifRev, id: input.id });
    if (!replies.has(key)) { effects.add(key); replies.set(key, { ok: true, result: { _id: input.id.replace(/^drafts\./, ''), _type: 'post', _rev: 'published-r2' } }); }
    const hold = state.hold; state.hold = undefined; state.onSend?.();
    if (hold) await hold;
    if (state.dropAck) { state.dropAck = false; res.destroy(); return; }
    res.end(JSON.stringify(replies.get(key)));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const config: ReleaseExecutorConfig = { db: open(), schemaVersion: 2, contentfnBaseUrl: `http://127.0.0.1:${address.port}`, allowedDatasets: ['prod'], resolveIdentity: async () => ({ subject: state.actor, headers: { 'x-fixture-identity': state.actor }, roles: state.denied ? [] : [{ id: 'service', name: 'Service', rules: [{ datasets: ['prod'], types: '*', actions: ['release.manage', 'doc.publish'] }] }] }) };
  const create = async (ids: string[], at = new Date(time).toISOString()) => {
    const result = await createRelease({ db: config.db }, { dataset: 'prod', name: 'Scheduled', publishAt: at });
    if (!result.ok) throw new Error(result.error.message);
    for (const docId of ids) expect(await addDocToRelease({ db: config.db }, { dataset: 'prod', releaseId: result.result.releaseId, docId })).toMatchObject({ ok: true });
    return result.result.releaseId;
  };
  try { await run({ config, open, create, advance: ms => { time += ms; }, now: () => time, sent, effects, state, reopen: async () => { await config.db.close(); adapters.splice(adapters.indexOf(config.db), 1); config.db = open(); } }); }
  finally { vi.restoreAllMocks(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await Promise.all(adapters.map(db => db.close())); await rm(dir, { recursive: true }); }
}

it('executes at the exact due boundary, persists future work and definitive per-document outcomes across reopen', async () => fixture(async f => {
  const id = await f.create(['unapproved','approved'], new Date(f.now() + 1000).toISOString());
  expect((await executeDueReleases(f.config)).results).toEqual([]);
  await f.reopen(); f.advance(1000);
  const result = await executeDueReleases(f.config);
  expect(result.results).toMatchObject([{ releaseId: id, outcome: { ok: true, result: { published: ['approved'], failures: [{ docId: 'unapproved', code: 'PERMISSION_DENIED' }] } } }]);
  expect(f.sent.map(item => item.ifRev)).toEqual(['approved-r1']);
  expect((await executeDueReleases(f.config)).results).toEqual([]);
  expect((await readExecutableRelease(f.config.db, 'prod', id))?.execution?.state).toBe('complete');
}));

it('recovers lost ACK after producer commit using the same key/revision after restart and does not re-read the missing draft', async () => fixture(async f => {
  const id = await f.create(['one']); f.state.dropAck = true;
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: [], execution: { state: 'uncertain', pending: ['one'] } } });
  expect(f.effects.size).toBe(1); expect(f.state.reads).toBe(1);
  await f.reopen(); f.advance(30_000);
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['one'], failures: [] } });
  expect(f.sent).toHaveLength(2); expect(f.sent[1]).toEqual(f.sent[0]); expect(f.effects.size).toBe(1); expect(f.state.reads).toBe(1);
  expect((await readExecutableRelease(f.config.db, 'prod', id))?.nextRunAt).toBeNull();
}));

it('recovers crash after intent persistence but before send without changing the stored request', async () => fixture(async f => {
  const id = await f.create(['one']); const actual = f.config.db; let writes = 0;
  f.config.db = { ...actual, updateMany: async input => { writes++; if (writes === 3) throw new Error('Simulated process termination'); return actual.updateMany(input); } };
  expect((await executeDueReleases(f.config)).results[0].outcome.ok).toBe(false);
  expect(f.sent).toHaveLength(0);
  const before = await readExecutableRelease(actual, 'prod', id);
  expect(before?.execution?.documents[0].state).toBe('sending');
  f.config.db = actual; await f.reopen(); f.advance(60_000);
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['one'] } });
  expect(f.sent[0].key).toBe(before?.execution?.documents[0].key); expect(f.effects.size).toBe(1);
}));

it('fences stale post-I/O journal writes after independent worker takeover and excludes simultaneous manual execution', async () => fixture(async f => {
  const id = await f.create(['one']); const other = { ...f.config, db: f.open() };
  let release!: () => void; f.state.hold = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; }); f.state.onSend = entered;
  const old = executeDueReleases(f.config); await began;
  expect(await executeRelease(other, { dataset: 'prod', releaseId: id, origin: 'manual' }, async () => true)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  f.advance(60_000);
  expect((await executeDueReleases(other)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['one'] } });
  const settled = await readExecutableRelease(other.db, 'prod', id);
  release(); expect((await old).results[0].outcome).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(await readExecutableRelease(other.db, 'prod', id)).toEqual(settled);
  expect(f.sent).toHaveLength(2); expect(f.sent[1]).toEqual(f.sent[0]); expect(f.effects.size).toBe(1);
}));

it('keeps outage/policy failures due with backoff, refuses subject changes, and enforces bounded configured datasets', async () => fixture(async f => {
  const id = await f.create(['one']); f.state.status = false;
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { execution: { state: 'blocked' } } });
  expect(f.sent).toHaveLength(0); expect((await executeDueReleases(f.config)).results).toHaveLength(0);
  f.advance(30_000); f.state.status = true; f.state.actor = 'changed';
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  expect(f.sent).toHaveLength(0); f.advance(30_000); f.state.actor = 'scheduler'; f.state.denied = true;
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  f.advance(30_000); f.state.denied = false;
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['one'] } });
  expect(await executeRelease(f.config, { dataset: 'other', releaseId: id, origin: 'manual' }, async () => true)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  await expect(executeDueReleases({ ...f.config, schemaVersion: undefined })).rejects.toThrow('migration');
  await expect(executeDueReleases(f.config, { limit: 51 })).rejects.toThrow('bounds');
}));

it('resumes a bounded captured batch rather than treating partial execution as complete', async () => fixture(async f => {
  const id = await f.create(['a','b']);
  expect((await executeDueReleases(f.config, { maxDocuments: 1 })).results[0].outcome).toMatchObject({ ok: true, result: { published: ['a'], execution: { state: 'blocked', pending: ['b'] } } });
  await addDocToRelease({ db: f.config.db }, { dataset: 'prod', releaseId: id, docId: 'after-snapshot' });
  f.advance(30_000); await f.reopen();
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['a','b'], failures: [] } });
  expect(f.sent.map(row => row.id)).toEqual(['a','b']);
}));

it('backfills legacy schedules in idempotent bounded pages and reports invalid times without inventing chronology', async () => fixture(async f => {
  const id = await f.create(['one']);
  const wrapped = cmsfnStorageAdapter(f.config.db);
  await wrapped.updateMany({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: id }], data: { nextRunAt: null } });
  const first = await backfillReleaseSchedules(f.config.db, { limit: 1 }); expect(first).toEqual({ changed: 1, invalid: [], nextCursor: id });
  await f.reopen(); expect(await backfillReleaseSchedules(f.config.db)).toEqual({ changed: 0, invalid: [], nextCursor: null });
  await cmsfnStorageAdapter(f.config.db).updateMany({ model: 'cmsfn_releases', where: [{ field: 'releaseId', operator: 'eq', value: id }], data: { publishAt: 'yesterday', nextRunAt: null } });
  expect(await backfillReleaseSchedules(f.config.db)).toEqual({ changed: 0, invalid: [id], nextCursor: null });
  expect(await createRelease({ db: f.config.db }, { dataset: 'prod', name: 'Bad', publishAt: 'tomorrow' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
}));
it('upgrades an actual legacy SQLite release table with additive columns then resumes bounded backfill', async () => {
  const native = new Database(':memory:');
  native.exec('CREATE TABLE cmsfn_releases (releaseId TEXT PRIMARY KEY, dataset TEXT NOT NULL, name TEXT NOT NULL, publishAt TEXT, docIds TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  native.prepare('INSERT INTO cmsfn_releases VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy', 'prod', 'Legacy', '2030-01-01T00:00:00.000Z', '["one"]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  native.exec('ALTER TABLE cmsfn_releases ADD COLUMN nextRunAt TEXT; ALTER TABLE cmsfn_releases ADD COLUMN execution TEXT; CREATE INDEX cmsfn_releases_due ON cmsfn_releases(dataset, nextRunAt, releaseId)');
  const sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
  const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { cmsfn_releases: 'cmsfn_releases' } });
  try {
    expect(await backfillReleaseSchedules(db)).toEqual({ changed: 1, invalid: [], nextCursor: null });
    expect(await backfillReleaseSchedules(db)).toEqual({ changed: 0, invalid: [], nextCursor: null });
    expect(await readExecutableRelease(db, 'prod', 'legacy')).toMatchObject({ docIds: ['one'], nextRunAt: '2030-01-01T00:00:00.000Z', execution: null });
  } finally { await db.close(); }
});
it('allows only one of two independent SQLite adapters to claim the same due snapshot', async () => fixture(async f => {
  const id = await f.create(['one']);
  let count = 0; let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapters = [f.config.db, f.open()].map(db => ({ ...db, findOne: async (input: Parameters<Adapter['findOne']>[0]) => {
    const row = await db.findOne(input);
    if (count < 2) { count++; if (count === 2) release(); await barrier; }
    return row;
  } }));
  const outcomes = await Promise.all(adapters.map(db => executeDueReleases({ ...f.config, db })));
  expect(outcomes.map(value => value.results[0].outcome.ok).sort()).toEqual([false, true]);
  expect(f.effects.size).toBe(1); expect(f.sent).toHaveLength(1);
  expect((await readExecutableRelease(f.config.db, 'prod', id))?.execution?.state).toBe('complete');
}));
it('retains unsent work when host policy throws between claim and document authorization', async () => fixture(async f => {
  await f.create(['one']);
  const original = f.config.resolveIdentity!; let calls = 0;
  f.config.resolveIdentity = async input => { if (++calls === 2) throw new Error('Temporary policy outage'); return original(input); };
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { failures: [], execution: { state: 'blocked', pending: ['one'] } } });
  expect(f.sent).toHaveLength(0);
  f.advance(30_000);
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['one'] } });
}));
it('does not let mutable native JSON references bypass the journal CAS in memory storage', async () => {
  const { memoryAdapter } = await import('@superfunctions/db/adapters');
  const { newExecution, saveExecution } = await import('../releases/journal.js');
  const db = memoryAdapter();
  try {
    const created = await createRelease({ db }, { dataset: 'prod', name: 'Aliasing' });
    if (!created.ok) throw new Error('Fixture creation failed');
    await addDocToRelease({ db }, { dataset: 'prod', releaseId: created.result.releaseId, docId: 'one' });
    const row = await readExecutableRelease(db, 'prod', created.result.releaseId);
    if (!row) throw new Error('Missing fixture release');
    const publicRead = await getRelease({ db }, { dataset: 'prod', releaseId: row.releaseId });
    publicRead!.docIds.push('uncommitted-public');
    const listed = await listReleases({ db }, { dataset: 'prod' });
    if (!listed.ok) throw new Error('Fixture list failed');
    listed.result.releases[0].docIds.push('uncommitted-list');
    const executableRead = await readExecutableRelease(db, 'prod', row.releaseId);
    executableRead!.docIds.push('uncommitted-executable');
    expect(await getRelease({ db }, { dataset: 'prod', releaseId: row.releaseId })).toMatchObject({ docIds: ['one'], updatedAt: row.updatedAt });
    const run = newExecution(row, 'manual', null, false, Date.now(), 60_000);
    expect(await saveExecution(db, row, run, null)).toBe(true);
    run.documents[0].state = 'published'; run.owner = 'uncommitted';
    const persisted = await readExecutableRelease(db, 'prod', row.releaseId);
    expect(persisted?.execution?.documents[0].state).toBe('pending'); expect(persisted?.execution?.owner).not.toBe('uncommitted');
    persisted!.execution!.documents[0].state = 'failed';
    expect((await readExecutableRelease(db, 'prod', row.releaseId))?.execution?.documents[0].state).toBe('pending');
  } finally { await db.close(); }
});
it('quarantines an uncertain legacy manual send instead of blindly repeating it', async () => fixture(async f => {
  const id = await f.create(['one']); const legacy = { ...f.config, resolveIdentity: undefined };
  f.state.dropAck = true;
  const input = { dataset: 'prod', releaseId: id, origin: 'manual' as const };
  expect(await executeRelease(legacy, input, async () => true)).toMatchObject({ ok: true, result: { execution: { state: 'uncertain', pending: ['one'] } } });
  f.advance(60_000);
  expect(await executeRelease(legacy, input, async () => true)).toMatchObject({ ok: true, result: { execution: { state: 'uncertain', pending: ['one'] } } });
  expect(f.sent).toHaveLength(1);
  expect((await readExecutableRelease(f.config.db, 'prod', id))?.nextRunAt).toBeNull();
}));


it('keeps an empty due schedule unclaimed until documents are added, including across restart', async () => fixture(async f => {
  const id = await f.create([]);
  const before = await readExecutableRelease(f.config.db, 'prod', id);
  expect(await executeRelease(f.config, { dataset: 'prod', releaseId: id, origin: 'manual' }, async () => true)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  expect(await readExecutableRelease(f.config.db, 'prod', id)).toEqual(before);
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  const waiting = await readExecutableRelease(f.config.db, 'prod', id);
  expect(waiting?.execution).toBeNull();
  expect(waiting?.nextRunAt).toBe(new Date(f.now() + 30_000).toISOString());
  expect(f.state.reads).toBe(0); expect(f.sent).toHaveLength(0);
  expect((await executeDueReleases(f.config)).results).toEqual([]);
  await f.reopen();
  expect(await addDocToRelease({ db: f.config.db }, { dataset: 'prod', releaseId: id, docId: 'one' })).toMatchObject({ ok: true });
  f.advance(30_000);
  expect((await executeDueReleases(f.config)).results[0].outcome).toMatchObject({ ok: true, result: { published: ['one'], failures: [] } });
  expect(f.sent).toHaveLength(1);
  expect((await executeDueReleases(f.config)).results).toEqual([]);
}));
