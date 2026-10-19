import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from './index.js';
import { memoryAdapter } from '../memory/index.js';
import { wrapWithSchema } from '../../adapter/schema-codecs.js';
import type { TableSchemaMap } from '../../adapter/types.js';

const schema: TableSchemaMap = { calendars: { modelName: 'calendars', fields: {
  id: { type: 'string', required: true }, autoSchedule: { type: 'boolean' },
} } };

for (const legacySchema of [false, true]) {
  it(`roundtrips SQLite booleans with nested wrappers and transactions (legacy schema ${legacySchema})`, async () => {
    const database = new Database(':memory:');
    database.exec('CREATE TABLE calendars (id TEXT PRIMARY KEY, autoSchedule INTEGER)');
    const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
    const raw = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { calendars: 'calendars' }, ...(legacySchema ? { adapterSchema: schema } : {}) });
    const adapter = wrapWithSchema(wrapWithSchema(raw, schema), schema);
    expect(raw.capabilities.types.booleans).toBe(false);
    try {
      for (const [id, autoSchedule] of [['true', true], ['false', false], ['null', null]] as const) {
        expect(await adapter.create({ model: 'calendars', data: { id, autoSchedule } })).toEqual({ id, autoSchedule });
      }
      expect(database.prepare('SELECT autoSchedule FROM calendars WHERE id = ?').get('true')).toEqual({ autoSchedule: 1 });
      expect(await adapter.findMany({ model: 'calendars', where: [{ field: 'autoSchedule', operator: 'in', value: [true] }] })).toEqual([{ id: 'true', autoSchedule: true }]);
      expect(await adapter.count({ model: 'calendars', where: [{ field: 'autoSchedule', operator: 'not_in', value: [true] }] })).toBe(1);
      await adapter.transaction(async transaction => {
        expect(await transaction.update({ model: 'calendars', where: [{ field: 'autoSchedule', operator: 'eq', value: false }], data: { autoSchedule: true } })).toEqual({ id: 'false', autoSchedule: true });
        expect(await transaction.findOne({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'null' }] })).toEqual({ id: 'null', autoSchedule: null });
      });
      expect(await adapter.count({ model: 'calendars', where: [{ field: 'autoSchedule', operator: 'eq', value: true }] })).toBe(2);
      await expect(adapter.create({ model: 'calendars', data: { id: 'invalid', autoSchedule: 'true' } })).rejects.toThrow('boolean');
    } finally { await adapter.close(); }
  });
}

it('preserves native boolean adapters', async () => {
  const raw = memoryAdapter();
  const adapter = wrapWithSchema(wrapWithSchema(raw, schema), schema);
  expect(raw.capabilities.types.booleans).toBe(true);
  await adapter.create({ model: 'calendars', data: { id: 'one', autoSchedule: false } });
  expect(await raw.findOne({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'one' }] })).toEqual({ id: 'one', autoSchedule: false });
});
