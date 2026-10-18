import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { Kysely, PostgresDialect, MysqlDialect, sql as sqlExpression } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createContentfnServer } from '../server.js';
import { ALL_TABLES } from '../storage/schema.js';
import { runContentfnMigrations } from '../storage/migrate.js';

// Explicit opt-in: these databases must be disposable and contain no application data.
// Drivers may be installed separately and supplied through CONTENTFN_SQL_DRIVER_ROOT.
const requireDriver = createRequire(process.env.CONTENTFN_SQL_DRIVER_ROOT
  ? `${process.env.CONTENTFN_SQL_DRIVER_ROOT}/package.json` : import.meta.url);
for (const dialect of ['postgres', 'mysql'] as const) {
  const connectionString = process.env[dialect === 'postgres' ? 'CONTENTFN_TEST_POSTGRES_URL' : 'CONTENTFN_TEST_MYSQL_URL'];
  it.skipIf(!connectionString)(`roundtrips large documents, revisions, CAS and durable idempotency on real ${dialect}`, async () => {
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: dialect === 'postgres'
      ? new PostgresDialect({ pool: new (requireDriver('pg').Pool)({ connectionString }) })
      : new MysqlDialect({ pool: requireDriver('mysql2').createPool(connectionString) }) });
    const db = kyselyAdapter({ db: sql, dialect, schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
    const createdTables: string[] = [];
    try {
      await runContentfnMigrations({ async createTableIfNotExists(table) {
        let builder = sql.schema.createTable(table.name);
        const keys: string[] = [];
        for (const [name, column] of Object.entries(table.columns)) {
          const type = column.primaryKey ? 'varchar(64)' : column.type === 'number' ? 'double precision'
            : column.type === 'boolean' ? 'boolean' : dialect === 'mysql' ? 'longtext' : 'text';
          builder = builder.addColumn(name, sqlExpression.raw(type), column.nullable ? undefined : value => value.notNull());
          if (column.primaryKey) keys.push(name);
        }
        if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys as never[]);
        await builder.execute();
        createdTables.push(table.name);
      } });
      const server = createContentfnServer({ db });
      const api = server.api;
      expect(await api.datasets.create({ dataset: 'prod' })).toMatchObject({ ok: true });
      expect(await api.schema.upsert({ dataset: 'prod', schema: { version: 1, documentTypes: [{ name: 'post', fields: [{ name: 'title', type: { kind: 'primitive', type: 'string' }, required: true }] }] } })).toMatchObject({ ok: true });
      for (const caseId of ['Post', 'post', 'café', 'cafe', 'space', 'space ']) {
        expect(await api.docs.create({ dataset: 'prod', id: caseId, type: 'post', doc: { title: caseId } })).toMatchObject({ ok: true });
        expect(await api.docs.get({ dataset: 'prod', id: caseId })).toMatchObject({ ok: true, result: { _id: caseId, title: caseId } });
      }
      expect(await api.docs.patch({ dataset: 'prod', id: 'Post', ops: [{ op: 'set', path: 'title', value: 'updated' }] })).toMatchObject({ ok: true });
      expect(await api.docs.get({ dataset: 'prod', id: 'post' })).toMatchObject({ ok: true, result: { title: 'post' } });
      expect(await api.docs.delete({ dataset: 'prod', id: 'Post' })).toMatchObject({ ok: true });
      expect(await api.docs.get({ dataset: 'prod', id: 'post' })).toMatchObject({ ok: true, result: { title: 'post' } });
      const id = '文'.repeat(1000);
      const title = '文'.repeat(40000);
      const draft = await api.docs.create({ dataset: 'prod', id, type: 'post', doc: { title }, asDraft: true });
      expect(draft).toMatchObject({ ok: true });
      if (!draft.ok) throw new Error(JSON.stringify(draft));
      expect(await api.docs.publish({ dataset: 'prod', id, ifRev: draft.result._rev })).toMatchObject({ ok: true, result: { _id: id, title } });
      expect(await api.docs.publish({ dataset: 'prod', id, ifRev: draft.result._rev })).toMatchObject({ ok: false, error: { code: 'REV_CONFLICT' } });
      expect(await api.docs.patch({ dataset: 'prod', id, ops: [{ op: 'unset', path: 'title' }] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
      const before = await api.docs.get({ dataset: 'prod', id });
      expect(before).toMatchObject({ ok: true, result: { title } });
      if (!before.ok) throw new Error(JSON.stringify(before));
      const writes = await Promise.all(['first', 'second'].map(value => api.docs.patch({ dataset: 'prod', id, ifRev: before.result._rev, ops: [{ op: 'set', path: 'title', value }] })));
      expect(writes.filter(result => result.ok)).toHaveLength(1);
      expect(writes.filter(result => !result.ok)).toMatchObject([{ error: { code: 'REV_CONFLICT' } }]);
      const request = () => new Request('http://local/contentfn/docs/create', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'durable' }, body: JSON.stringify({ dataset: 'prod', type: 'post', doc: { title: 'Once' } }) });
      const first = await (await server.router.handle(request())).json();
      expect(first).toMatchObject({ ok: true });
      const restarted = createContentfnServer({ db });
      expect(await (await restarted.router.handle(request())).json()).toEqual(first);
      expect(await api.docs.query({ dataset: 'prod' })).toMatchObject({ ok: true, result: { data: expect.arrayContaining([expect.objectContaining({ title: 'Once' })]) } });
      expect(await api.docs.history({ dataset: 'prod', id })).toMatchObject({ ok: true });
      expect(await api.datasets.export({ dataset: 'prod' })).toMatchObject({ ok: true });
      const rows = await sql.selectFrom('contentfn_docs_published').select(['id', 'documentId']).where('documentId', '=', id).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toMatch(/^[a-f0-9]{64}$/);
      expect(await api.datasets.delete({ dataset: 'prod' })).toMatchObject({ ok: true });
      expect(await sql.selectFrom('contentfn_docs_published').selectAll().execute()).toEqual([]);
    } finally {
      try {
        for (const table of createdTables.reverse()) await sql.schema.dropTable(table).ifExists().execute();
      } finally { await db.close(); }
    }
  }, 120000);
}
