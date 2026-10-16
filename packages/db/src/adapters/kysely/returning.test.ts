import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { kyselyAdapter } from './index.js';
import { wrapWithSchema } from '../../adapter/schema-codecs.js';

describe('insert returning projections', () => {
  it('returns selected columns or full rows with native SQLite', async () => {
    const database = new Database(':memory:');
    database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, label TEXT, private_value TEXT)');
    const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
    const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
    try {
      expect(await adapter.create({ model: 'records', data: { id: 'a', label: 'first', private_value: 'hidden' }, select: ['id', 'label'] })).toEqual({ id: 'a', label: 'first' });
      expect(await adapter.create({ model: 'records', data: { id: 'b', label: 'second', private_value: 'full' } })).toEqual({ id: 'b', label: 'second', private_value: 'full' });
      expect(await adapter.create({ model: 'records', data: { id: 'c', label: 'third', private_value: 'empty selection' }, select: [] })).toEqual({ id: 'c', label: 'third', private_value: 'empty selection' });
      expect(await adapter.updateMany({ model: 'records', where: [{ field: 'id', operator: 'eq', value: 'a' }], data: { label: 'updated' } })).toBe(1);
      expect(await adapter.updateMany({ model: 'records', where: [{ field: 'id', operator: 'eq', value: 'missing' }], data: { label: 'updated' } })).toBe(0);
      expect(await adapter.deleteMany({ model: 'records', where: [{ field: 'id', operator: 'in', value: ['b', 'c'] }] })).toBe(2);
    } finally { await adapter.close(); }
  });
  it('compiles the PostgreSQL returning path without select-builder methods', async () => {
    const statements: string[] = [];
    const pool = {
      async connect() { return { async query(sql: string) { statements.push(sql); return { rows: [{ id: 'a' }], rowCount: 1, command: 'INSERT' }; }, release() {} }; },
      async end() {},
    };
    const sql = new Kysely({ dialect: new PostgresDialect({ pool: pool as never }) });
    const adapter = kyselyAdapter({ db: sql, dialect: 'postgres', schema: { records: 'records' } });
    try {
      await adapter.create({ model: 'records', data: { id: 'a' }, select: ['id'] });
      await adapter.create({ model: 'records', data: { id: 'b' } });
      expect(statements[0]).toMatch(/returning "id"$/);
      expect(statements[1]).toMatch(/returning \*$/);
    } finally { await adapter.close(); }
  });
});

it('roundtrips explicit JSON text through native SQLite without double encoding', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT)');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const base = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
  const schema = { records: { modelName: 'records', fields: { id: { type: 'string' as const }, payload: { type: 'json' as const, jsonStorageType: 'json-text' as const } } } };
  const adapter = wrapWithSchema(wrapWithSchema(base, schema), schema);
  try {
    for (const [index, payload] of [{ nested: [1, false, null] }, 'null', 0, false, null].entries()) {
      const id = String(index);
      expect(await adapter.create({ model: 'records', data: { id, payload } })).toEqual({ id, payload });
      expect(database.prepare('SELECT payload FROM records WHERE id = ?').get(id)).toEqual({ payload: payload === null ? null : JSON.stringify(payload) });
      expect(await adapter.findOne({ model: 'records', where: [{ field: 'id', operator: 'eq', value: id }], select: ['id'] })).toEqual({ id });
    }
    database.prepare('UPDATE records SET payload = ? WHERE id = ?').run('broken secret JSON', '0');
    await expect(adapter.findOne({ model: 'records', where: [{ field: 'id', operator: 'eq', value: '0' }] })).rejects.toThrow('records.payload contains invalid JSON text');
  } finally { await adapter.close(); }
});
