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

it('returns the conflicting row within the caller scope when the conflict target is not in the where clause', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, tenant TEXT, email TEXT, label TEXT, UNIQUE(tenant, email))');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
  try {
    await adapter.create({ model: 'records', data: { id: 'other', tenant: 't1', email: 'b@example.test', label: 'unrelated' } });
    await adapter.create({ model: 'records', data: { id: 'existing', tenant: 't1', email: 'a@example.test', label: 'original' } });
    const result = await adapter.upsert({
      model: 'records',
      where: [{ field: 'tenant', operator: 'eq', value: 't1' }],
      conflictTarget: ['tenant', 'email'],
      create: { id: 'new', tenant: 't1', email: 'a@example.test', label: 'ignored' },
      update: {},
    });
    expect(result).toMatchObject({ id: 'existing', label: 'original' });
  } finally { await adapter.close(); }
});

it('never returns a conflicting row outside the caller scope', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, tenant TEXT, email TEXT UNIQUE, label TEXT)');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
  try {
    await adapter.create({ model: 'records', data: { id: 'theirs', tenant: 't2', email: 'a@example.test', label: 'other tenant' } });
    const result = await adapter.upsert({
      model: 'records',
      where: [{ field: 'tenant', operator: 'eq', value: 't1' }, { field: 'id', operator: 'eq', value: 'mine' }],
      conflictTarget: 'email',
      create: { id: 'mine', tenant: 't1', email: 'a@example.test', label: 'ignored' },
      update: {},
    });
    expect(result ?? null).toBeNull();
  } finally { await adapter.close(); }
});

it('falls back to the caller where when a case-insensitive unique index finds the conflict', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE people (id TEXT PRIMARY KEY, email TEXT); CREATE UNIQUE INDEX people_email ON people (email COLLATE NOCASE);');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { people: 'people' } });
  try {
    database.prepare('INSERT INTO people (id, email) VALUES (?, ?)').run('existing', 'ada@example.test');
    const row = await adapter.upsert({
      model: 'people',
      where: [{ field: 'id', operator: 'eq', value: 'existing' }],
      conflictTarget: 'email',
      create: { id: 'new', email: 'ADA@example.test' },
      update: {},
    });
    expect(row).toMatchObject({ id: 'existing', email: 'ada@example.test' });
  } finally {
    await adapter.close();
  }
});

it('matches the exact conflict key even when the caller where is broader', async () => {
  const database = new Database(':memory:');
  database.exec('CREATE TABLE records (id TEXT PRIMARY KEY, tenant TEXT, email TEXT, UNIQUE(tenant, email))');
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const adapter = kyselyAdapter({ db: sql, dialect: 'sqlite', schema: { records: 'records' } });
  try {
    await adapter.create({ model: 'records', data: { id: 'a', tenant: 't1', email: 'a@example.test' } });
    await adapter.create({ model: 'records', data: { id: 'z', tenant: 't1', email: 'z@example.test' } });
    const result = await adapter.upsert({
      model: 'records',
      where: [
        { field: 'tenant', operator: 'eq', value: 't1' },
        { field: 'email', operator: 'in', value: ['a@example.test', 'z@example.test'] },
      ],
      conflictTarget: ['tenant', 'email'],
      create: { id: 'new', tenant: 't1', email: 'z@example.test' },
      update: {},
    });
    expect(result).toMatchObject({ id: 'z' });
  } finally { await adapter.close(); }
});
