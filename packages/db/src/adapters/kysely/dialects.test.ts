import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  sql,
  type PostgresPool,
  type PostgresPoolClient,
  type PostgresQueryResult,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError } from '../../adapter/errors.js';
import type { Adapter } from '../../adapter/types.js';
import { kyselyAdapter, type KyselyDialect } from './index.js';

/**
 * Test-local pool shim: lets Kysely's PostgresDialect drive PGlite, the real
 * Postgres engine running in-process. Kysely reads `rowCount` and `command`
 * from a node-postgres result; PGlite reports `affectedRows` and no command,
 * so the shim maps the first and derives the second from the statement.
 */
function pgliteAsPool(pg: PGlite): PostgresPool {
  const client: PostgresPoolClient = {
    async query<R>(sqlText: string, parameters: readonly unknown[]) {
      const result = await pg.query<R>(sqlText, [...parameters]);
      const command = (/^\s*(\w+)/.exec(sqlText)?.[1] ?? '').toUpperCase();
      return {
        command: command as PostgresQueryResult<R>['command'],
        rowCount: result.affectedRows ?? result.rows.length,
        rows: result.rows,
      };
    },
    release() {},
  } as PostgresPoolClient;
  return {
    async connect() {
      return client;
    },
    async end() {
      await pg.close();
    },
  };
}

interface Item {
  id: string;
  label: string;
  status: string;
  qty: number;
}

const createItems = sql`CREATE TABLE items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  qty INTEGER NOT NULL
)`;

const dialects: Array<{ name: string; dialect: KyselyDialect; open: () => Kysely<any> }> = [
  {
    name: 'SQLite (better-sqlite3)',
    dialect: 'sqlite',
    open: () => new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) }),
  },
  {
    name: 'Postgres (PGlite)',
    dialect: 'postgres',
    open: () => new Kysely<any>({ dialect: new PostgresDialect({ pool: pgliteAsPool(new PGlite()) }) }),
  },
];

const alpha: Item = { id: 'a', label: 'Alpha', status: 'open', qty: 1 };
const beta: Item = { id: 'b', label: 'Beta', status: 'open', qty: 2 };
const gamma: Item = { id: 'c', label: 'Gamma', status: 'closed', qty: 3 };

describe.each(dialects)('kyselyAdapter on $name', ({ dialect, open }) => {
  let db: Kysely<any>;
  let adapter: Adapter;

  const readAll = async (): Promise<Item[]> =>
    (await db.selectFrom('items').selectAll().orderBy('id').execute()) as Item[];

  beforeAll(async () => {
    db = open();
    await createItems.execute(db);
    adapter = kyselyAdapter({ db, dialect, schema: { item: 'items' } });
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom('items').execute();
  });

  const seed = async (...rows: Item[]) => {
    await db.insertInto('items').values(rows).execute();
  };

  describe('create', () => {
    it.each([
      ['without select', undefined],
      ['with an empty select', [] as string[]],
    ])('returns the full written row %s', async (_label, select) => {
      const row = await adapter.create<Item>({ model: 'item', data: alpha, select });
      expect(row).toEqual(alpha);
      expect(await readAll()).toEqual([alpha]);
    });

    it('returns exactly the selected keys', async () => {
      const row = await adapter.create({ model: 'item', data: alpha, select: ['id', 'label'] });
      expect(row).toEqual({ id: 'a', label: 'Alpha' });
    });
  });

  describe('update', () => {
    const where = [{ field: 'id', operator: 'eq' as const, value: 'a' }];

    it('returns the full updated row', async () => {
      await seed(alpha, beta);
      const row = await adapter.update<Item>({ model: 'item', where, data: { label: 'Alpha 2', qty: 9 } });
      expect(row).toEqual({ ...alpha, label: 'Alpha 2', qty: 9 });
      expect(await readAll()).toEqual([{ ...alpha, label: 'Alpha 2', qty: 9 }, beta]);
    });

    it('returns exactly the selected keys of the updated row', async () => {
      await seed(alpha);
      const row = await adapter.update({ model: 'item', where, data: { label: 'Alpha 2' }, select: ['id', 'label'] });
      expect(row).toEqual({ id: 'a', label: 'Alpha 2' });
    });

    it('throws NotFoundError when no row matches', async () => {
      await seed(beta);
      await expect(adapter.update({ model: 'item', where, data: { label: 'x' } })).rejects.toBeInstanceOf(NotFoundError);
      expect(await readAll()).toEqual([beta]);
    });
  });

  it('createMany returns both written rows', async () => {
    const rows = await adapter.createMany<Item>({ model: 'item', data: [alpha, beta] });
    expect([...rows].sort((x, y) => x.id.localeCompare(y.id))).toEqual([alpha, beta]);
    expect(await readAll()).toEqual([alpha, beta]);
  });

  describe('upsert', () => {
    const where = [{ field: 'id', operator: 'eq' as const, value: 'a' }];

    it('insert path returns the new row', async () => {
      const row = await adapter.upsert<Item>({ model: 'item', where, create: alpha, update: { label: 'unused' } });
      expect(row).toEqual(alpha);
      expect(await readAll()).toEqual([alpha]);
    });

    it('update path returns the updated row', async () => {
      await seed(alpha);
      const row = await adapter.upsert<Item>({
        model: 'item',
        where,
        create: { ...alpha, label: 'unused' },
        update: { label: 'Alpha 2' },
      });
      expect(row).toEqual({ ...alpha, label: 'Alpha 2' });
      expect(await readAll()).toEqual([{ ...alpha, label: 'Alpha 2' }]);
    });

    it('doNothing path returns the existing row', async () => {
      await seed(alpha);
      const row = await adapter.upsert<Item>({ model: 'item', where, create: { ...alpha, label: 'unused' }, update: {} });
      expect(row).toEqual(alpha);
      expect(await readAll()).toEqual([alpha]);
    });
  });

  describe('row counts', () => {
    const open2 = [{ field: 'status', operator: 'eq' as const, value: 'open' }];
    const none = [{ field: 'status', operator: 'eq' as const, value: 'missing' }];

    beforeEach(async () => {
      await seed(alpha, beta, gamma);
    });

    it('count returns the matching row counts', async () => {
      expect(await adapter.count({ model: 'item', where: open2 })).toBe(2);
      expect(await adapter.count({ model: 'item', where: none })).toBe(0);
    });

    it('updateMany returns the number of updated rows', async () => {
      expect(await adapter.updateMany({ model: 'item', where: open2, data: { qty: 7 } })).toBe(2);
      expect(await adapter.updateMany({ model: 'item', where: none, data: { qty: 8 } })).toBe(0);
      expect((await readAll()).map((row) => row.qty)).toEqual([7, 7, 3]);
    });

    it('deleteMany returns the number of deleted rows', async () => {
      expect(await adapter.deleteMany({ model: 'item', where: open2 })).toBe(2);
      expect(await adapter.deleteMany({ model: 'item', where: none })).toBe(0);
      expect(await readAll()).toEqual([gamma]);
    });
  });

  it('isHealthy reports healthy', async () => {
    await expect(adapter.isHealthy()).resolves.toMatchObject({ healthy: true });
  });
});
