import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseStorage, getWatchFnSchema } from '../../src/storage/database';
import { QueryEngine } from '../../src/query/query-engine';
import { indexValue } from '../../src/storage/log-index/values';

it('atomically persists log indexes, preserves migration coverage and reopens indexed SQLite data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'watch-log-index-'));
  let sql: Kysely<any> | undefined;
  const statements: string[] = [];
  function connect() {
    const native = new Database(join(directory, 'events.sqlite'));
    sql = new Kysely({ dialect: new SqliteDialect({ database: native }), log: event => { if (event.level === 'query') statements.push(event.query.sql); } });
    return { native, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { watchfn_events: 'watchfn_events', watchfn_log_index: 'watchfn_log_index' } }) };
  }
  try {
    let connection = connect();
    for (const [name, schema] of Object.entries(getWatchFnSchema())) {
      let table = sql!.schema.createTable(name);
      for (const [field, definition] of Object.entries(schema.fields)) table = table.addColumn(field, definition.type === 'number' ? 'real' : 'text', col => field === 'id' ? col.primaryKey() : definition.required ? col.notNull() : col);
      await table.execute();
      for (const index of schema.indexes ?? []) await sql!.schema.createIndex(index.name).on(name).columns(index.fields).execute();
    }
    let storage = new DatabaseStorage(connection.adapter); let query = new QueryEngine(storage);
    for (let i = 0; i < 40; i++) await storage.add({ type: 'log', message: 'indexed-' + i, service: i === 0 ? 'match' : 'other' }, { indexFields: ['service'] });
    await storage.add({ type: 'log', message: 'legacy', service: 'match' });
    await storage.add({ type: 'log', message: 'changed', service: 'match' }, { indexFields: ['level'] });
    const filter = { where: { type: 'log', service: 'match' } };
    statements.length = 0;
    expect((await query.execute(filter)).data.map(row => row.message).sort()).toEqual(['changed', 'indexed-0', 'legacy']);
    expect(statements.filter(sql => /^select \* from "watchfn_events" where "id" =/.test(sql))).toHaveLength(3);
    const scalar = indexValue('match')!;
    const plan = connection.native.prepare('EXPLAIN QUERY PLAN SELECT eventId FROM watchfn_log_index WHERE field=? AND valueType=? AND valueKey=?').all('service', scalar.valueType, scalar.valueKey) as { detail: string }[];
    expect(plan.some(row => /SEARCH.*watchfn_log_index_lookup/.test(row.detail))).toBe(true);
    connection.native.exec("CREATE TRIGGER fail_log_index BEFORE INSERT ON watchfn_log_index BEGIN SELECT RAISE(ABORT, 'owned index failure'); END");
    await expect(storage.add({ type: 'log', message: 'must-rollback', service: 'match' }, { indexFields: ['service'] })).rejects.toThrow('owned index failure');
    expect((await storage.getAll()).some(row => row.message === 'must-rollback')).toBe(false);
    connection.native.exec('DROP TRIGGER fail_log_index');
    let after: string | undefined;
    do { const page = await storage.backfillLogIndexes(['service'], { after, limit: 7 }); after = page.nextCursor ?? undefined; } while (after);
    expect((await query.execute(filter)).data.map(row => row.message).sort()).toEqual(['changed', 'indexed-0', 'legacy']);
    const before = connection.native.prepare('SELECT count(*) AS count FROM watchfn_log_index').get();
    await storage.backfillLogIndexes(['service'], { limit: 100 });
    expect(connection.native.prepare('SELECT count(*) AS count FROM watchfn_log_index').get()).toEqual(before);
    await sql!.destroy(); sql = undefined;
    connection = connect(); storage = new DatabaseStorage(connection.adapter); query = new QueryEngine(storage);
    expect((await query.execute(filter)).data).toHaveLength(3);
  } finally { if (sql) await sql.destroy(); await rm(directory, { recursive: true, force: true }); }
});
