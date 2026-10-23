import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { memoryAdapter, kyselyAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentfnServer } from '../server.js';
import { ALL_TABLES } from '../storage/schema.js';
import { runContentfnMigrations } from '../storage/migrate.js';

it('pages bounded document history with equal timestamp/revision ties across independent SQLite writers and rejects crossed cursors before reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-history-pages-'));
  const path = join(directory, 'db.sqlite');
  const sqlite = new Database(path);
  const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
  const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
  let allowed = true;
  const server = createContentfnServer({ db, authorize: (_context, action) => action !== 'docs.history' || allowed });
  try {
    await runContentfnMigrations({ async createTableIfNotExists(table) {
      let builder = sql.schema.createTable(table.name).ifNotExists(); const keys: string[] = [];
      for (const [name, column] of Object.entries(table.columns)) {
        builder = builder.addColumn(name, column.type === 'number' ? 'real' : column.type === 'boolean' ? 'integer' : 'text', column.nullable ? undefined : b => b.notNull());
        if (column.primaryKey) keys.push(name);
      }
      if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys as never[]);
      await builder.execute();
    } });
    for (const dataset of ['prod', 'other']) expect(await server.api.datasets.create({ dataset })).toMatchObject({ ok: true });
    const second = new Database(path);
    try {
      // Both writers contribute equal-time rows, including a revision shared by
      // draft/published snapshots. The storage identity supplies the final tie.
      for (let index = 0; index < 8; index++) {
        const id = `row-${index}`; const docId = index % 2 ? 'drafts.post' : 'post';
        const rev = index < 2 ? 'equal' : `rev-${index}`;
        (index % 2 ? second : sqlite).prepare('INSERT INTO contentfn_revisions (id,dataset,docId,perspective,rev,timestamp,docJson) VALUES (?,?,?,?,?,?,?)').run(id, 'prod', docId, index % 2 ? 'draft' : 'published', rev, '2026-10-23T00:00:00.000Z', JSON.stringify({ _id: docId, _type: 'post', _rev: rev, _updatedAt: '2026-10-23T00:00:00.000Z', title: id }));
      }
      second.prepare('INSERT INTO contentfn_revisions (id,dataset,docId,perspective,rev,timestamp,docJson) VALUES (?,?,?,?,?,?,?)').run('noise', 'prod', 'unrelated', 'published', 'noise', '2027-01-01T00:00:00.000Z', '{}');
    } finally { second.close(); }
    const spy = vi.spyOn(db, 'findMany');
    const invoke = async (input: unknown) => (await server.router.handle(new Request('http://local/contentfn/docs/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))).json();
    const first = await server.api.docs.history({ dataset: 'prod', id: 'post', limit: 1 });
    if (!first.ok || !first.result.nextCursor) throw Error('Expected first page');
    expect(first.result.revisions.map(row => row.title)).toEqual(['row-0']);
    const cursor = first.result.nextCursor;
    for (const input of [ { dataset: 'other', id: 'post', cursor }, { dataset: 'prod', id: 'other', cursor }, { dataset: 'prod', id: 'post', cursor: Buffer.from(JSON.stringify({ timestamp: '2026-10-23T00:00:00.000Z', rev: 'equal' })).toString('base64') } ]) {
      spy.mockClear(); expect(await invoke(input)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } }); expect(spy).not.toHaveBeenCalled();
    }
    const titles = ['row-0']; let next: string | null = cursor;
    spy.mockClear();
    while (next) {
      const page = await server.api.docs.history({ dataset: 'prod', id: 'drafts.post', limit: 1, cursor: next });
      if (!page.ok) throw Error(page.error.message);
      titles.push(...page.result.revisions.map(row => String(row.title))); next = page.result.nextCursor;
    }
    expect(titles).toEqual(Array.from({ length: 8 }, (_, index) => `row-${index}`));
    for (const [query] of spy.mock.calls.filter(([query]) => query.model === 'contentfn_revisions')) {
      expect(query.limit).toBe(2); expect(query.where).toEqual(expect.arrayContaining([{ field: 'dataset', operator: 'eq', value: 'prod' }, expect.objectContaining({ field: 'docId', operator: 'eq', value: expect.stringMatching(/^(drafts\.)?post$/) })]));
    }
    sqlite.prepare("UPDATE contentfn_revisions SET timestamp = ? WHERE id = ?").run('2026-10-24T00:00:00.000Z', 'row-7');
    sqlite.prepare("UPDATE contentfn_revisions SET timestamp = ? WHERE id = ?").run('2026-10-22T00:00:00.000Z', 'row-6');
    const mixed: string[] = []; let mixedCursor: string | null = null;
    do {
      const page = await server.api.docs.history({ dataset: 'prod', id: 'post', limit: 2, cursor: mixedCursor });
      if (!page.ok) throw Error(page.error.message);
      mixed.push(...page.result.revisions.map(row => String(row.title))); mixedCursor = page.result.nextCursor;
    } while (mixedCursor);
    expect(mixed).toEqual(['row-7', 'row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6']);
    allowed = false; spy.mockClear();
    expect(await invoke({ dataset: 'prod', id: 'post' })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(spy).not.toHaveBeenCalled();
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});


it('detaches native memory snapshots so history callers cannot mutate stored history or restore inputs', async () => {
  const db = memoryAdapter(); const { api } = createContentfnServer({ db });
  try {
    await api.datasets.create({ dataset: 'prod' });
    await api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' } }] }] } });
    const created = await api.docs.create({ dataset: 'prod', id: 'one', type: 'post', doc: { title: 'original' }, asDraft: true });
    if (!created.ok) throw Error('Creation failed');
    const page = await api.docs.history({ dataset: 'prod', id: 'one' });
    if (!page.ok) throw Error('History failed');
    page.result.revisions[0].title = 'corrupted';
    expect(await api.docs.history({ dataset: 'prod', id: 'one' })).toMatchObject({ ok: true, result: { revisions: [{ title: 'original' }] } });
    expect(await api.docs.restore({ dataset: 'prod', id: 'one', rev: created.result._rev })).toMatchObject({ ok: true, result: { title: 'original' } });
  } finally { await db.close(); }
});


it('bounds cursor size for unrestricted public IDs and accepts safe previous scoped cursors', async () => {
  const db = memoryAdapter(); const { api } = createContentfnServer({ db });
  try {
    await api.datasets.create({ dataset: 'prod' });
    await api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [] }] } });
    const id = 'unicode-文'.repeat(3000);
    expect(await api.docs.create({ dataset: 'prod', id, type: 'post', doc: {}, asDraft: true })).toMatchObject({ ok: true });
    expect(await api.docs.patch({ dataset: 'prod', id: `drafts.${id}`, ops: [] })).toMatchObject({ ok: true });
    const first = await api.docs.history({ dataset: 'prod', id, limit: 1 });
    if (!first.ok || !first.result.nextCursor) throw Error('Expected pagination');
    expect(first.result.nextCursor.length).toBeLessThan(1024);
    const next = await api.docs.history({ dataset: 'prod', id, limit: 1, cursor: first.result.nextCursor });
    expect(next).toMatchObject({ ok: true, result: { revisions: [expect.any(Object)], nextCursor: null } });
    await api.docs.create({ dataset: 'prod', id: 'short', type: 'post', doc: {}, asDraft: true });
    await api.docs.patch({ dataset: 'prod', id: 'drafts.short', ops: [] });
    const short = await api.docs.history({ dataset: 'prod', id: 'short', limit: 1 });
    if (!short.ok || !short.result.nextCursor) throw Error('Expected short pagination');
    const current: unknown = JSON.parse(Buffer.from(short.result.nextCursor, 'base64').toString('utf8'));
    if (!current || typeof current !== 'object') throw Error('Expected cursor');
    const legacy = Buffer.from(JSON.stringify({ ...current, version: 1, dataset: 'prod', docId: 'short' })).toString('base64');
    expect(await api.docs.history({ dataset: 'prod', id: 'short', limit: 1, cursor: legacy })).toMatchObject({ ok: true });
    expect(await api.docs.history({ dataset: 'prod', id: 'another', cursor: legacy })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  } finally { await db.close(); }
});
