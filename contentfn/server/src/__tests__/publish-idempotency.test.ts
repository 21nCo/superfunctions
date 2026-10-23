import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentfnServer } from '../server.js';
import { ALL_TABLES } from '../storage/schema.js';
import { runContentfnMigrations } from '../storage/migrate.js';

it('binds publish replay to actor, dataset and exact payload across SQLite reopen, without replaying audit or publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-publish-replay-'));
  let allowed = true;
  const open = () => {
    const sqlite = new Database(join(directory, 'db.sqlite'));
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
    const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
    const server = createContentfnServer({ db, context: request => ({ subject: request.headers.get('x-fixture-subject') }), authorize: async (_context, action) => action !== 'docs.publish' || allowed });
    return { sqlite, sql, db, server };
  };
  let current = open();
  const invoke = async (input: unknown, actor: string | null = 'scheduler', key = 'stable-key') => {
    const headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': key });
    if (actor !== null) headers.set('x-fixture-subject', actor);
    return (await current.server.router.handle(new Request('http://local/contentfn/docs/publish', { method: 'POST', headers, body: JSON.stringify(input) }))).json();
  };
  try {
    await runContentfnMigrations({ async createTableIfNotExists(table) {
      let builder = current.sql.schema.createTable(table.name).ifNotExists();
      const keys: string[] = [];
      for (const [name, column] of Object.entries(table.columns)) {
        builder = builder.addColumn(name, column.type === 'number' ? 'real' : column.type === 'boolean' ? 'integer' : 'text', column.nullable ? undefined : b => b.notNull());
        if (column.primaryKey) keys.push(name);
      }
      if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys as never[]);
      await builder.execute();
    } });
    for (const dataset of ['prod', 'other']) {
      expect(await current.server.api.datasets.create({ dataset })).toMatchObject({ ok: true });
      expect(await current.server.api.schema.upsert({ dataset, schema: { version: 1, documentTypes: [{ name: 'post', fields: [] }] } })).toMatchObject({ ok: true });
    }
    const draft = await current.server.api.docs.create({ dataset: 'prod', id: 'post', type: 'post', doc: {}, asDraft: true });
    if (!draft.ok) throw new Error('Fixture draft creation failed');
    const input = { dataset: 'prod', id: 'post', ifRev: draft.result._rev };
    expect(await invoke(input, null)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const first: unknown = await invoke(input);
    expect(first).toMatchObject({ ok: true, result: { _id: 'post' } });
    expect(await current.server.api.docs.get({ dataset: 'prod', id: 'drafts.post' })).toMatchObject({ ok: false });
    const count = current.sqlite.prepare("SELECT count(*) AS n FROM contentfn_audit WHERE action = 'docs.publish'").get();
    await current.db.close(); current = open();
    expect(await invoke(input)).toEqual(first);
    expect(current.sqlite.prepare("SELECT count(*) AS n FROM contentfn_audit WHERE action = 'docs.publish'").get()).toEqual(count);
    allowed = false;
    expect(await invoke(input)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    allowed = true;
    expect(await invoke(input, 'another-actor')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await invoke({ ...input, ifRev: 'changed' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(await invoke({ ...input, dataset: 'other' })).toMatchObject({ ok: false });
    // Anonymous legacy success cannot become a fresh write or leak its response after enabling actor binding.
    const legacy = createContentfnServer({ db: current.db });
    const legacyDraft = await legacy.api.docs.create({ dataset: 'prod', id: 'legacy', type: 'post', doc: {}, asDraft: true });
    if (!legacyDraft.ok) throw new Error('Fixture legacy draft creation failed');
    const legacyInput = { dataset: 'prod', id: 'legacy', ifRev: legacyDraft.result._rev };
    const legacyRequest = new Request('http://local/contentfn/docs/publish', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'legacy' }, body: JSON.stringify(legacyInput) });
    expect(await (await legacy.router.handle(legacyRequest)).json()).toMatchObject({ ok: true });
    expect(await invoke(legacyInput, 'scheduler', 'legacy')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    for (const [server, expected] of [[current.server, true], [legacy, false]] as const) {
      const status: unknown = await (await server.router.handle(new Request('http://local/contentfn/status'))).json();
      expect(status).toMatchObject({ ok: true, result: { capabilities: expected ? expect.arrayContaining(['content.docs.publish.idempotency.v1']) : expect.not.arrayContaining(['content.docs.publish.idempotency.v1']) } });
    }
  } finally { await current.db.close(); await rm(directory, { recursive: true, force: true }); }
});
