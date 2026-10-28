import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { drizzleAdapter } from '../../adapters/drizzle/index.js';
import { memoryAdapter } from '../../adapters/memory/index.js';
import { kyselyAdapter } from '../../adapters/kysely/index.js';
import { wrapWithRowLevelNamespace } from '../row-level-namespace.js';
import { wrapWithSchema } from '../schema-codecs.js';
import type { Adapter, TableSchemaMap } from '../types.js';

const schema: TableSchemaMap = { records: { modelName: 'records', fields: {
  id: { type: 'string' }, payload: { type: 'json', jsonStorageType: 'json-text' },
} } };

for (const backend of ['memory', 'sqlite'] as const) {
  for (const configured of [false, true]) {
    it(`preserves canonical JSON through namespaces and transactions (${backend}, configured=${configured})`, async () => {
      const sqlite = backend === 'sqlite' ? new Database(':memory:') : undefined;
      sqlite?.exec('CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT, __ns TEXT)');
      const base = sqlite
        ? kyselyAdapter({ db: new Kysely({ dialect: new SqliteDialect({ database: sqlite }) }), dialect: 'sqlite', schema: { records: 'records' }, ...(configured ? { adapterSchema: schema } : {}) })
        : memoryAdapter(configured ? { adapterSchema: schema } : undefined);
      const owner = configured ? base : wrapWithSchema(base, schema);
      const db = wrapWithSchema(wrapWithRowLevelNamespace(owner, { enabled: true }), schema);
      const readRaw = async () => sqlite
        ? sqlite.prepare('SELECT * FROM records ORDER BY id').all()
        : await base.findMany({ model: 'records', orderBy: [{ field: 'id', direction: 'asc' }] });
      try {
        await db.create({ model: 'records', namespace: 'tenant', data: { id: 'one', payload: { a: 1 } } });
        // A round trip through the same chain hides symmetric double encoding.
        expect(await owner.findMany({ model: 'records' })).toEqual([{ id: 'one', payload: { a: 1 }, __ns: 'tenant' }]);
        if (sqlite || !configured) expect(await readRaw()).toEqual([{ id: 'one', payload: '{"a":1}', __ns: 'tenant' }]);
        await db.transaction(async transaction => {
          // Function-owned schemas can be reapplied to transaction CRUD methods.
          const tx = wrapWithSchema(transaction as Adapter, schema);
          expect(await tx.findMany({ model: 'records', namespace: 'tenant', where: [{ field: 'payload', operator: 'eq', value: { a: 1 } }] })).toEqual([{ id: 'one', payload: { a: 1 } }]);
          await tx.updateMany({ model: 'records', namespace: 'tenant', where: [{ field: 'id', operator: 'eq', value: 'one' }], data: { payload: ['updated'] } });
        });
        expect(await owner.findMany({ model: 'records' })).toEqual([{ id: 'one', payload: ['updated'], __ns: 'tenant' }]);
        if (sqlite || !configured) expect(await readRaw()).toEqual([{ id: 'one', payload: '["updated"]', __ns: 'tenant' }]);
        expect(await db.findMany({ model: 'records', namespace: 'other' })).toEqual([]);
      } finally { await db.close(); }
    });
  }
}

it('preserves configured Drizzle codecs when a transaction is wrapped by a function', async () => {
  const stored: unknown[] = [];
  const connection = {
    _: { fullSchema: { records: {} } },
    insert: () => ({ values: (data: unknown) => ({ returning: () => ({ execute: async () => { stored.push(data); return [data]; } }) }) }),
  };
  const base = drizzleAdapter({
    db: { ...connection, transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(connection) },
    dialect: 'postgres', adapterSchema: schema,
  });
  await base.transaction(async transaction => {
    const db = wrapWithSchema(transaction as Adapter, schema);
    await db.create({ model: 'records', data: { id: 'one', payload: { a: 1 } } });
  });
  // Observe the actual driver-bound value, independently of return decoding.
  expect(stored).toEqual([{ id: 'one', payload: '{"a":1}' }]);
});
