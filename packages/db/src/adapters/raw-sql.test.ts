import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter } from '../adapter/types.js';
import { wrapWithRowLevelNamespace } from '../adapter/row-level-namespace.js';
import { wrapWithSchema } from '../adapter/schema-codecs.js';
import { drizzleAdapter } from './drizzle/index.js';
import { createDrizzleRawSql } from './drizzle/internal.js';
import { kyselyAdapter } from './kysely/index.js';

const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function sqlite(): Database.Database {
  const db = new Database(':memory:');
  open.push(db);
  return db;
}

const targets: [string, () => Adapter][] = [
  ['drizzle (better-sqlite3)', () => drizzleAdapter({ db: drizzle(sqlite()), dialect: 'sqlite' })],
  [
    'kysely (better-sqlite3)',
    () => kyselyAdapter({ db: new Kysely<any>({ dialect: new SqliteDialect({ database: sqlite() }) }), dialect: 'sqlite', schema: {} }),
  ],
];

describe.each(targets)('rawSql on %s', (_name, create) => {
  it('binds positional parameters and returns rows from RETURNING', async () => {
    const { rawSql } = create();
    expect(rawSql?.dialect).toBe('sqlite');
    await rawSql!.execute('CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, state TEXT)');
    await rawSql!.execute('INSERT INTO jobs (name, state) VALUES (?, ?)', ['a', 'pending']);
    await rawSql!.execute('INSERT INTO jobs (name, state) VALUES (?, ?)', ["b'); DROP TABLE jobs; --", null]);

    const claimed = await rawSql!.query(
      "UPDATE jobs SET state = 'leased' WHERE id = (SELECT id FROM jobs WHERE state = ? ORDER BY id LIMIT 1) RETURNING id, name",
      ['pending']
    );
    expect(claimed).toEqual([{ id: 1, name: 'a' }]);
    expect(await rawSql!.query('SELECT name, state FROM jobs WHERE id > ? ORDER BY id', [0])).toEqual([
      { name: 'a', state: 'leased' },
      { name: "b'); DROP TABLE jobs; --", state: null },
    ]);
    expect(await rawSql!.query('SELECT id FROM jobs WHERE id = ?', [99])).toEqual([]);
  });

  it('rejects a placeholder and parameter count mismatch before running', async () => {
    const { rawSql } = create();
    await expect(rawSql!.query('SELECT ? AS a, ? AS b', [1])).rejects.toThrow(
      'rawSql: statement has 2 placeholders but 1 params'
    );
    await expect(rawSql!.execute('SELECT 1', [1])).rejects.toThrow('rawSql: statement has 0 placeholders but 1 params');
    await expect(rawSql!.query('  ')).rejects.toThrow('rawSql: statement must be a non-empty string');
  });

  it('survives the schema and row-level namespace wrappers', async () => {
    const adapter = create();
    const wrapped = wrapWithRowLevelNamespace(wrapWithSchema(adapter, []), { enabled: true });
    expect(wrapped.rawSql).toBe(adapter.rawSql);
  });
});

describe('rawSql dialect rendering', () => {
  it('renders $n placeholders for Postgres through Drizzle', async () => {
    const executed: { sql: string; params: unknown[] }[] = [];
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const pg = new PgDialect();
    const rawSql = createDrizzleRawSql(
      {
        async execute(query: any) {
          const { sql, params } = pg.sqlToQuery(query);
          executed.push({ sql, params });
          return { rows: [{ id: 7 }] };
        },
      },
      'postgres'
    );
    expect(await rawSql.query('UPDATE t SET a = ? WHERE id = ? RETURNING id', ['x', 7])).toEqual([{ id: 7 }]);
    expect(executed).toEqual([{ sql: 'UPDATE t SET a = $1 WHERE id = $2 RETURNING id', params: ['x', 7] }]);
  });

  it('renders $n placeholders for Postgres through Kysely', async () => {
    const executed: { sql: string; parameters: readonly unknown[] }[] = [];
    const db = new Kysely<any>({
      dialect: new PostgresDialect({
        pool: {
          async connect() {
            return {
              async query(sql: string, parameters: unknown[]) {
                executed.push({ sql, parameters });
                return { rows: [{ id: 7 }], command: 'UPDATE', rowCount: 1 };
              },
              release() {},
            };
          },
          async end() {},
        } as any,
      }),
    });
    const { rawSql } = kyselyAdapter({ db, dialect: 'postgres', schema: {} });
    expect(await rawSql!.query('UPDATE t SET a = ? WHERE id = ? RETURNING id', ['x', 7])).toEqual([{ id: 7 }]);
    expect(executed).toEqual([{ sql: 'UPDATE t SET a = $1 WHERE id = $2 RETURNING id', parameters: ['x', 7] }]);
    await db.destroy();
  });
});
