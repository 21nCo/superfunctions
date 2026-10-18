import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { wrapWithSchema } from '@superfunctions/db/schema';
const sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
await sql.schema.createTable('rows').addColumn('id', 'text', c => c.primaryKey()).addColumn('payload', 'text').execute();
const db = wrapWithSchema(kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { rows: 'rows' } }), { rows: { modelName: 'rows', fields: { id: { type: 'string', required: true }, payload: { type: 'json', jsonStorageType: 'json-text' } } } });
try {
  await db.create({ model: 'rows', data: { id: 'one', payload: { nested: ['文', 1, false] } } });
  assert.deepEqual((await db.findOne({ model: 'rows', where: [{ field: 'id', operator: 'eq', value: 'one' }] })).payload, { nested: ['文', 1, false] });
  assert.equal(await db.count({ model: 'rows', where: [{ field: 'payload', operator: 'eq', value: { nested: ['文', 1, false] } }] }), 1);
  await assert.rejects(db.transaction(async transaction => { await transaction.create({ model: 'rows', data: { id: 'rollback', payload: null } }); throw new Error('rollback'); }), /rollback/);
  assert.equal(await db.count({ model: 'rows' }), 1);
  console.log('Native SQLite JSON codec, JSON predicate count and transaction rollback passed');
} finally { await db.close(); }
