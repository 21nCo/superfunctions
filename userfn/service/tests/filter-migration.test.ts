import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import type { Adapter } from '@superfunctions/db';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserFnService, getUserFnSchema, backfillFeedbackFilters } from '../src/index.js';
import { canonical } from '../src/validation.js';

it('migrates old SQLite data resumably without changing receipts and gates incomplete/overflowed filters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-filter-migration-'));
  const connect = () => {
    const sql = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(directory, 'feedback.sqlite')) }) });
    return { sql, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) }) };
  };
  let { sql, adapter } = connect();
  const auth = { authenticate: async () => ({ id: 'key', type: 'api-key', subject: { actorId: 'owner', actorType: 'api-key' as const, tenantId: 'a' }, scopes: ['userfn:feedback:read', 'userfn:feedback:write'] }) };
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const payload = { feedback: { title: 'Legacy', body: 'Unmodified', category: 'general', tags: [' Rare ', 'Rare'] }, context: { source: 'in_app', user: null } };
  const id = 'uf_' + hash(JSON.stringify(['a', 'legacy-0']));
  const fingerprint = hash(canonical({ actorId: 'owner', payload }));
  const createTables = async (old: boolean) => {
    for (const table of Object.values(getUserFnSchema()).filter(table => ['userfn_feedback', 'userfn_feedback_votes'].includes(table.modelName) === old)) {
      let migration = sql.schema.createTable(table.modelName);
      for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => {
        if (field.required) column = column.notNull(); if (name === 'id') column = column.primaryKey(); return column;
      });
      await migration.execute();
      for (const index of table.indexes ?? []) await sql.schema.createIndex(index.name).on(table.modelName).columns(index.fields).execute();
    }
  };
  const filtered = (service: ReturnType<typeof createUserFnService>, query = 'tag=Rare') => service.router.handle(new Request('http://localhost/feedback?' + query, { headers: { authorization: 'Bearer key' } }));
  const post = (service: ReturnType<typeof createUserFnService>, key = 'legacy-0') => service.router.handle(new Request('http://localhost/feedback', { method: 'POST', headers: { authorization: 'Bearer key', 'idempotency-key': key }, body: JSON.stringify(payload) }));
  try {
    await createTables(true);
    for (let i = 0; i < 501; i++) await sql.insertInto('userfn_feedback').values({
      id: 'uf_' + hash(JSON.stringify(['a', `legacy-${i}`])), tenantId: 'a', actorId: 'owner', fingerprint: i === 0 ? fingerprint : `legacy-${i}`,
      payload: JSON.stringify(i === 0 ? payload : { ...payload, feedback: { ...payload.feedback, tags: ['common'] } }), createdAt: '2026-10-20T00:00:00.000Z', status: 'open', votes: 0,
    }).execute();
    let service = createUserFnService({ database: adapter, auth });
    expect((await filtered(service)).status).toBe(503); // New tables have not been applied.
    expect((await post(service)).status).toBe(200); // Existing submission replay remains valid.
    await createTables(false);
    expect((await filtered(service)).status).toBe(503); // Schema alone does not mark old data complete.
    expect(await backfillFeedbackFilters(adapter, { batchSize: 100 })).toEqual({ processed: 100, done: false });
    expect((await filtered(service)).status).toBe(503);
    expect((await post(service, 'during-migration')).status).toBe(503);
    const before = await adapter.count({ model: 'userfn_feedback_attributes' });
    let writes = 0;
    const failing: Adapter = { ...adapter, transaction: callback => adapter.transaction(tx => callback({ ...tx, upsert: async params => { if (++writes === 3) throw new Error('interrupted batch'); return tx.upsert(params); } })) };
    await expect(backfillFeedbackFilters(failing, { batchSize: 100 })).rejects.toThrow('interrupted batch');
    expect(await adapter.count({ model: 'userfn_feedback_attributes' })).toBe(before);
    for (;;) { if ((await backfillFeedbackFilters(adapter, { batchSize: 100 })).done) break; }
    expect(await backfillFeedbackFilters(adapter)).toEqual({ processed: 0, done: true });
    expect(await adapter.count({ model: 'userfn_feedback_attributes' })).toBe(501);
    expect(await adapter.count({ model: 'userfn_feedback_tags' })).toBe(501); // Duplicate normalized tags collapse.
    const result = await filtered(service);
    expect(result.status).toBe(200);
    expect((await result.json()).items.map((row: { id: string }) => row.id)).toEqual([id]); // No whole-tenant500 ceiling.
    const limited = createUserFnService({ database: adapter, auth, maxFilterCandidates: 10 });
    expect((await filtered(limited, 'tag=common&limit=1')).status).toBe(503);
    const broken: Adapter = { ...adapter, transaction: callback => adapter.transaction(tx => callback({ ...tx, upsert: async () => { throw new Error('normalization failure'); } })) };
    expect((await post(createUserFnService({ database: broken, auth }), 'rolled-back')).status).toBe(503);
    expect(await adapter.count({ model: 'userfn_feedback' })).toBe(501);
    await adapter.close(); ({ sql, adapter } = connect());
    service = createUserFnService({ database: adapter, auth });
    expect((await filtered(service)).status).toBe(200);
    expect((await post(service)).status).toBe(200);
    const stored = await sql.selectFrom('userfn_feedback').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(stored.payload).toBe(JSON.stringify(payload)); expect(stored.fingerprint).toBe(fingerprint);
    const unsupported = { ...adapter, capabilities: { ...adapter.capabilities, transactions: { supported: false, nested: false } } };
    expect((await post(createUserFnService({ database: unsupported, auth }), 'unsupported')).status).toBe(503);
    await expect(backfillFeedbackFilters(unsupported)).rejects.toThrow('requires transactions');
  } finally { await adapter.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
