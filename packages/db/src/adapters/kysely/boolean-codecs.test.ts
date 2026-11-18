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

it('decodes SQLite safe-integer booleans (0n/1n) on reads and returned records', async () => {
  const database = new Database(':memory:');
  database.defaultSafeIntegers(true);
  database.exec('CREATE TABLE calendars (id TEXT PRIMARY KEY, autoSchedule INTEGER)');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const adapter = wrapWithSchema(kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { calendars: 'calendars' } }), schema);
  try {
    expect(await adapter.create({ model: 'calendars', data: { id: 'on', autoSchedule: true } })).toEqual({ id: 'on', autoSchedule: true });
    expect(await adapter.create({ model: 'calendars', data: { id: 'off', autoSchedule: false } })).toEqual({ id: 'off', autoSchedule: false });
    expect(database.prepare('SELECT autoSchedule FROM calendars WHERE id = ?').get('on')).toEqual({ autoSchedule: 1n });
    expect(await adapter.findOne({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'off' }] })).toEqual({ id: 'off', autoSchedule: false });
    expect(await adapter.findMany({ model: 'calendars', where: [{ field: 'autoSchedule', operator: 'eq', value: true }] })).toEqual([{ id: 'on', autoSchedule: true }]);
    expect(await adapter.update({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'off' }], data: { autoSchedule: true } })).toEqual({ id: 'off', autoSchedule: true });
    expect(await adapter.update({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'on' }], data: { autoSchedule: false } })).toEqual({ id: 'on', autoSchedule: false });
    database.prepare('INSERT INTO calendars (id, autoSchedule) VALUES (?, ?)').run('invalid', 2n);
    await expect(adapter.findOne({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'invalid' }] })).rejects.toThrow('invalid boolean integer');
  } finally { await adapter.close(); }
});

it('preserves native boolean adapters', async () => {
  const raw = memoryAdapter();
  const adapter = wrapWithSchema(wrapWithSchema(raw, schema), schema);
  expect(raw.capabilities.types.booleans).toBe(true);
  await adapter.create({ model: 'calendars', data: { id: 'one', autoSchedule: false } });
  expect(await raw.findOne({ model: 'calendars', where: [{ field: 'id', operator: 'eq', value: 'one' }] })).toEqual({ id: 'one', autoSchedule: false });
});

it('retains existing JSON and boolean codec ownership across native declarations in SQLite', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, payload TEXT, active INTEGER)');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const raw = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
  const ownedSchema: TableSchemaMap = { records: { modelName: 'records', fields: {
    id: { type: 'string' }, payload: { type: 'json', jsonStorageType: 'json-text' }, active: { type: 'boolean' },
  } } };
  const nativeSchema: TableSchemaMap = { records: { modelName: 'records', fields: {
    payload: { type: 'json', jsonStorageType: 'native' }, active: { type: 'boolean', booleanStorageType: 'native' },
  } } };
  const owner = wrapWithSchema(raw, ownedSchema);
  const db = wrapWithSchema(wrapWithSchema(owner, nativeSchema), ownedSchema);
  try {
    const row = { id: 'one', payload: { value: 42 }, active: true };
    await owner.create({ model: 'records', data: row });
    expect(await db.findMany({ model: 'records', where: [
      { field: 'payload', operator: 'eq', value: row.payload }, { field: 'active', operator: 'eq', value: true },
    ] })).toEqual([row]);
    await db.transaction(async tx => {
      await tx.updateMany({ model: 'records', where: [{ field: 'id', operator: 'eq', value: 'one' }], data: { payload: ['updated'], active: false } });
    });
    expect(await owner.findMany({ model: 'records' })).toEqual([{ id: 'one', payload: ['updated'], active: false }]);
    expect(database.prepare('SELECT * FROM records').all()).toEqual([{ id: 'one', payload: '["updated"]', active: 0 }]);
  } finally { await db.close(); }
});
