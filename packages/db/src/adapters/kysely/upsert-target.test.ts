import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from './index.js';

it('uses explicit single and composite upsert targets instead of the first scoped predicate', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, namespace TEXT, external_id TEXT, label TEXT, UNIQUE(namespace, external_id))');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
  try {
    const where = [{ field: 'namespace', operator: 'eq' as const, value: 'first' }, { field: 'id', operator: 'eq' as const, value: 'one' }];
    await adapter.upsert({ model: 'records', where, conflictTarget: 'id', create: { id: 'one', namespace: 'first', external_id: 'same', label: 'initial' }, update: {} });
    expect(await adapter.upsert({ model: 'records', where, conflictTarget: 'id', create: { id: 'one', namespace: 'first', external_id: 'same', label: 'ignored' }, update: {} })).toMatchObject({ label: 'initial' });
    expect(await adapter.upsert({ model: 'records', where, conflictTarget: 'id', create: { id: 'one', namespace: 'first', external_id: 'same' }, update: { label: 'updated' } })).toMatchObject({ label: 'updated' });
    for (const namespace of ['first', 'second']) {
      await adapter.upsert({ model: 'records', conflictTarget: ['namespace', 'external_id'],
        where: [{ field: 'namespace', operator: 'eq', value: namespace }, { field: 'external_id', operator: 'eq', value: 'same' }],
        create: { id: namespace === 'first' ? 'replacement' : 'two', namespace, external_id: 'same', label: namespace }, update: { label: namespace } });
    }
    expect(await adapter.count({ model: 'records' })).toBe(2);
    expect(await adapter.update({ model: 'records', where, data: { label: 'updated-again' } })).toMatchObject({ id: 'one', label: 'updated-again' });
    expect(await adapter.update({ model: 'records', where, data: { label: 'first' }, select: ['label'] })).toEqual({ label: 'first' });
    expect(await adapter.findOne({ model: 'records', where })).toMatchObject({ id: 'one', label: 'first' });
    await expect(adapter.upsert({ model: 'records', where, conflictTarget: [], create: {}, update: {} })).rejects.toThrow('conflictTarget');
  } finally { await adapter.close(); }
});
