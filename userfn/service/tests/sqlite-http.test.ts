import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthProvider } from '@superfunctions/auth';
import { createUserFnService, getUserFnSchema } from '../src/index.js';
import { UserFnClient, FeedbackHTTPError } from '../../typescript/src/index';

const auth: AuthProvider = { async authenticate(request) {
  const token = request.headers.get('authorization');
  const tenant = token === 'Bearer tenant-a-key' ? 'a' : token === 'Bearer tenant-b-key' ? 'b' : null;
  return tenant ? { id: 'test-key', type: 'api-key', subject: { actorId: 'verified-' + tenant, actorType: 'api-key', tenantId: tenant }, scopes: ['userfn:feedback:write', 'userfn:feedback:read'] } : null;
} };
const idFor = (key: string) => 'uf_' + createHash('sha256').update(JSON.stringify(['a', key])).digest('hex');

it('persists actual TS/Python HTTP submissions and retry races across SQLite close/reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'userfn-feedback-'));
  const connect = () => {
    const sql = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(join(directory, 'feedback.sqlite')) }) });
    return { sql, adapter: kyselyAdapter({ db: sql, dialect: 'sqlite', schema: Object.fromEntries(Object.keys(getUserFnSchema()).map(key => [key, key])) }) };
  };
  let { sql, adapter } = connect();
  let service = createUserFnService({ database: adapter, auth });
  let lostResponse = false;
  const deliveredKeys: string[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers,
        ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const response = await service.router.handle(request);
      const key = headers.get('idempotency-key');
      if (incoming.method === 'POST' && key) deliveredKeys.push(key);
      if (key === 'ts-stable' && !lostResponse && response.status === 201) {
        lostResponse = true; incoming.socket.destroy(); return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { outgoing.writeHead(500); outgoing.end('fixture failure'); }
  });
  try {
    for (const table of Object.values(getUserFnSchema())) {
    let migration = sql.schema.createTable(table.modelName);
    for (const [name, field] of Object.entries(table.fields)) {
      migration = migration.addColumn(name, field.type === 'number' ? 'integer' : 'text', column => {
        if (field.required) column = column.notNull();
        if (name === 'id') column = column.primaryKey();
        return column;
      });
    }
    await migration.execute();
    }
    for (const index of getUserFnSchema().userfn_feedback.indexes ?? []) {
      await sql.schema.createIndex(index.name).on('userfn_feedback').columns(index.fields).execute();
    }
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const client = new UserFnClient({ endpoint, apiKey: 'tenant-a-key', feedbackMaxAttempts: 2 });
    client.identify('claimed-ts-user', { locale: '文', nested: { enabled: true } });
    const feedback = { title: 'TS 文', body: 'Actually stored', category: 'bug' as const, score: 7, tags: ['ts'] };
    await client.submitFeedback(feedback, { idempotencyKey: 'ts-stable' });
    expect(deliveredKeys.filter(key => key === 'ts-stable')).toHaveLength(2);
    await Promise.all(Array.from({ length: 6 }, () => client.submitFeedback(feedback, { idempotencyKey: 'ts-stable' })));
    await expect(client.submitFeedback({ ...feedback, body: 'conflict' }, { idempotencyKey: 'ts-stable' })).rejects.toMatchObject({ status: 409 });
    await expect(new UserFnClient({ endpoint, apiKey: 'bad', feedbackMaxAttempts: 1 }).submitFeedback(feedback)).rejects.toBeInstanceOf(FeedbackHTTPError);
    const python = await promisify(execFile)('uv', ['run', '--isolated', '--no-project', '--python', '3.10', 'python', resolve('tests/python_http_acceptance.py'), endpoint], {
      env: { ...process.env, PYTHONPATH: [resolve('../python/src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter) }, timeout: 20000,
    });
    expect(python.stdout).toContain('actual HTTP acceptance');
    await Promise.all(Array.from({ length: 6 }, () => client.submitFeedback(feedback, { idempotencyKey: 'new-race' })));
    const conflicting = await Promise.allSettled(['first', 'second'].map(body => client.submitFeedback({ ...feedback, body }, { idempotencyKey: 'conflicting-race' })));
    expect(conflicting.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = conflicting.find(result => result.status === 'rejected');
    expect(rejected && rejected.status === 'rejected' && rejected.reason.status).toBe(409);
    expect(await adapter.count({ model: 'userfn_feedback' })).toBe(4);
    await adapter.close();
    ({ sql, adapter } = connect());
    service = createUserFnService({ database: adapter, auth });
    const read = (id: string, key = 'tenant-a-key') => fetch(`${endpoint}/feedback/${id}`, { headers: { authorization: `Bearer ${key}` } });
    const tsStored = await (await read(idFor('ts-stable'))).json();
    expect(tsStored).toMatchObject({ actorId: 'verified-a', tenantId: 'a', payload: { feedback, context: { source: 'in_app', user: { id: 'claimed-ts-user', traits: { locale: '文' } } } } });
    const pyStored = await (await read(idFor('python-stable'))).json();
    expect(pyStored.payload.feedback).toMatchObject({ title: 'Python 文', category: 'feature' });
    expect(pyStored.payload.context.user.traits.nested).toEqual([true, null, 7]);
    expect((await read(idFor('ts-stable'), 'tenant-b-key')).status).toBe(404);
    await client.submitFeedback(feedback, { idempotencyKey: 'ts-stable' });
    expect(await adapter.count({ model: 'userfn_feedback' })).toBe(4);
    await sql.schema.dropTable('userfn_feedback').execute();
    await expect(client.submitFeedback(feedback, { idempotencyKey: 'database-down' })).rejects.toMatchObject({ status: 503 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
