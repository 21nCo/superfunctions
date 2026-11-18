import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from './index.js';
import { wrapWithSchema } from '../../adapter/schema-codecs.js';
import type { TableSchemaMap } from '../../adapter/types.js';

const schema: TableSchemaMap = { calendars: { modelName: 'calendars', fields: {
  id: { type: 'string', required: true }, autoSchedule: { type: 'boolean' },
} } };

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
