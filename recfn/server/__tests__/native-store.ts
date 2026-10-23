import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createDbStore } from '../src/store/db.js';
import { getRecFnSchema } from '../src/store/schema.js';

/** Owned file-backed fixture; production guards use the real shared adapter. */
export async function nativeStore() {
  const directory = await mkdtemp(join(tmpdir(), 'recfn-production-store-'));
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(directory, 'state.sqlite')) }) });
  try {
    const schema = getRecFnSchema();
    for (const [name, table] of Object.entries(schema)) {
      let query = db.schema.createTable(name);
      for (const [field, definition] of Object.entries(table.fields)) query = query.addColumn(field, definition.type === 'number' ? 'real' : definition.type === 'boolean' ? 'integer' : 'text', column => {
        if (field === 'id') column = column.primaryKey(); else if (definition.unique) column = column.unique(); return definition.required ? column.notNull() : column;
      });
      await query.execute();
      for (const index of table.indexes ?? []) {
        let query = db.schema.createIndex(index.name).on(name).columns(index.fields);
        if (index.unique) query = query.unique(); await query.execute();
      }
    }
    const adapter = kyselyAdapter({ db, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(schema).map(name => [name, name])) });
    return { store: createDbStore({ adapter, durable: true }), close: async () => { await adapter.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await db.destroy(); await rm(directory, { recursive: true, force: true }); throw error; }
}
