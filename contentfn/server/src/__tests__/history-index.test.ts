import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentfnServer } from '../server.js';
import { ALL_TABLES } from '../storage/schema.js';
import { runContentfnMigrations, upgradeHistoryIndexSchema, getHistoryIndexDefinition, type HistoryIndexDefinition } from '../storage/migrate.js';
import { documentStorageId } from '../storage/documentIdentity.js';

it('upgrades existing history idempotently and uses ordered index range seeks without temporary sorting on populated SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'content-history-index-'));
  const sqlite = new Database(join(directory, 'db.sqlite'));
  const plans: string[][] = [];
  let capture = false;
  const sql = new Kysely<Record<string, Record<string, unknown>>>({
    dialect: new SqliteDialect({ database: sqlite }),
    log(event) {
      if (capture && event.level === 'query' && /^select/i.test(event.query.sql) && event.query.sql.includes('contentfn_revisions')) {
        const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${event.query.sql}`).all(...event.query.parameters) as Array<{ detail: string }>;
        plans.push(rows.map(row => row.detail));
      }
    },
  });
  const db = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
  const { api } = createContentfnServer({ db });
  const ensureOrderedIndex = async (index: HistoryIndexDefinition) => {
    // Host schema tooling, not a second query runtime. Verify existing names too.
    const actual = sqlite.prepare(`PRAGMA index_xinfo('${index.name}')`).all() as Array<{ name: string | null; desc: number; key: number }>;
    const keys = actual.filter(row => row.key === 1);
    if (keys.length) {
      if (JSON.stringify(keys.map(row => [row.name, row.desc ? 'desc' : 'asc'])) !== JSON.stringify(index.fields.map((name, i) => [name, index.directions[i]]))) throw Error('Incompatible ordered index');
      const indexes = sqlite.prepare(`PRAGMA index_list('${index.table}')`).all() as Array<{ name: string; unique: number }>;
      if (indexes.find(row => row.name === index.name)?.unique !== Number(index.unique ?? false)) throw Error('Incompatible ordered index');
      return;
    }
    await sql.schema.createIndex(index.name).on(index.table).columns(index.fields.map((name, i) => `${name} ${index.directions[i]}`)).execute();
  };
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
    await api.datasets.create({ dataset: 'prod' });
    const timestamp = (i: number) => new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 4) * 1000).toISOString();
    const rowId = (i: number) => `target-${String(i).padStart(5, '0')}`;
    const rev = (i: number) => `rev-${String(Math.floor(i / 2)).padStart(5, '0')}`;
    const insert = sqlite.prepare('INSERT INTO contentfn_revisions (id,dataset,docId,perspective,rev,timestamp,docJson) VALUES (?,?,?,?,?,?,?)');
    sqlite.transaction(() => {
      for (let i = 0; i < 40_000; i++) insert.run(`noise-${i}`, 'prod', `unrelated-${i % 100}`, 'published', `noise-${i}`, timestamp(i), '{}');
      for (let i = 0; i < 10_000; i++) {
        const docId = i % 2 ? 'drafts.post' : 'post';
        insert.run(rowId(i), 'prod', docId, i % 2 ? 'draft' : 'published', rev(i), timestamp(i), JSON.stringify({ _id: docId, _type: 'post', _rev: rev(i), _updatedAt: timestamp(i), ordinal: i }));
      }
    })();
    await upgradeHistoryIndexSchema({ ensureOrderedIndex });
    await upgradeHistoryIndexSchema({ ensureOrderedIndex });
    expect(sqlite.prepare('SELECT count(*) AS n FROM contentfn_revisions').get()).toEqual({ n: 50_000 });
    capture = true;
    const first = await api.docs.history({ dataset: 'prod', id: 'post', limit: 17 });
    if (!first.ok || !first.result.nextCursor) throw Error('Expected first page');
    expect(first.result.revisions.map(row => row.ordinal).slice(0, 4)).toEqual([9996, 9997, 9998, 9999]);
    expect(plans).toHaveLength(2);
    const next = await api.docs.history({ dataset: 'prod', id: 'post', limit: 17, cursor: first.result.nextCursor });
    expect(next.ok).toBe(true); expect(plans).toHaveLength(8);
    // A boundary from a real deep stored row exercises all three keyset ranges.
    const cursor = Buffer.from(JSON.stringify({ version: 2, scope: documentStorageId('prod', 'post'), timestamp: timestamp(4000), rev: rev(4000), rowId: rowId(4000) })).toString('base64');
    const deep = await api.docs.history({ dataset: 'prod', id: 'post', limit: 17, cursor });
    if (!deep.ok) throw Error(deep.error.message);
    expect(deep.result.revisions.map(row => row.ordinal).slice(0, 7)).toEqual([4001, 4002, 4003, 3996, 3997, 3998, 3999]);
    expect(plans).toHaveLength(14);
    for (const plan of plans) {
      expect(plan.some(detail => detail.includes('SEARCH contentfn_revisions USING INDEX contentfn_revisions_history_v1'))).toBe(true);
      expect(plan.some(detail => /SCAN|TEMP B-TREE/.test(detail))).toBe(false);
    }
    console.log('History SQLite query plans:', JSON.stringify({ rows: 50000, statements: plans.length, distinctPlans: [...new Set(plans.flat())] }));
    capture = false;
    await sql.schema.dropIndex(getHistoryIndexDefinition().name).execute();
    await sql.schema.createIndex(getHistoryIndexDefinition().name).on('contentfn_revisions').column('dataset').execute();
    await expect(upgradeHistoryIndexSchema({ ensureOrderedIndex })).rejects.toThrow('Incompatible ordered index');
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});
