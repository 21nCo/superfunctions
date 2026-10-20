import { beforeEach, afterEach, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { kyselyAdapter } from '@superfunctions/db/adapters';
import type { AuthProvider } from '@superfunctions/auth';
import { createUserFnService, getUserFnSchema } from '../src/index.js';
import { UserFnClient } from '../../typescript/src/index';
const keys = generateKeyPairSync('ed25519');
const auth: AuthProvider = { async authenticate(request) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '');
  if (!['editor-a', 'reader-a', 'editor-b'].includes(token!)) return null;
  return { id: token!, type: 'api-key', subject: { actorId: token!, actorType: 'api-key', tenantId: token!.endsWith('-b') ? 'b' : 'a' }, scopes: token!.startsWith('editor') ? ['userfn:config:read', 'userfn:config:write'] : ['userfn:config:read'] };
} };
const payload = (value: unknown = true) => ({ flags: [{ key: 'enabled', enabled: true, defaultValue: value, variations: [], rules: [] }], segments: [] });
let directory: string; let endpoint: string; let server: Server;
let databases: Kysely<any>[]; let services: ReturnType<typeof createUserFnService>[];
function connect() {
  const sqlite = new Database(join(directory, 'config.sqlite')); sqlite.pragma('journal_mode = WAL'); sqlite.pragma('busy_timeout = 100');
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqlite }) });
  databases.push(db);
  const adapter = kyselyAdapter({ db, dialect: 'sqlite', schema: { userfn_flag_config: 'userfn_flag_config' } });
  return createUserFnService({ database: adapter, auth, flagConfigSigning: { privateKey: keys.privateKey, keyId: 'key-1' }, allowedOrigins: ['https://app.example'] });
}
const request = (method: string, body?: unknown, headers: Record<string,string> = {}, environment = 'production') => fetch(endpoint + '/config/' + environment, { method, headers: { authorization: 'Bearer editor-a', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'userfn-config-')); databases = []; services = [connect()];
  const table = getUserFnSchema().userfn_flag_config;
  let migration = databases[0].schema.createTable(table.modelName);
  for (const [name, field] of Object.entries(table.fields)) migration = migration.addColumn(name, 'text', column => name === 'id' ? column.primaryKey() : field.required ? column.notNull() : column);
  await migration.execute(); services.push(connect());
  server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers(); for (const [key,value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const req = new Request('http://127.0.0.1' + incoming.url, { method: incoming.method, headers, ...(['PUT','POST'].includes(incoming.method!) ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' } : {}) } as RequestInit);
      const result = await services[headers.get('x-connection') === 'second' ? 1 : 0].router.handle(req);
      outgoing.writeHead(result.status, Object.fromEntries(result.headers)); outgoing.end(Buffer.from(await result.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end('fixture failure'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address'); endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await Promise.all(databases.map(db => db.destroy())); await rm(directory, { recursive: true, force: true }); });

it('publishes exact signed bytes, evaluates wire flags, handles conditional fetch and survives SQLite reopen', async () => {
  const publication = await request('PUT', payload({ nested: [false, 0, '文'] }), { 'if-none-match': '*' }); expect(publication.status).toBe(201);
  const body = await publication.text(); const snapshot = JSON.parse(body); const etag = publication.headers.get('etag')!; const signature = publication.headers.get('x-userfn-signature')!;
  expect(snapshot).toMatchObject({ version: 1, tenantId: 'a', environment: 'production', keyId: 'key-1', algorithm: 'Ed25519' });
  expect(etag).toBe('"' + createHash('sha256').update(body).digest('hex') + '"');
  expect(verify(null, Buffer.from(body), keys.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  for (const field of ['tenantId','environment','revision','keyId','algorithm']) expect(verify(null, Buffer.from(JSON.stringify({ ...snapshot, [field]: 'substituted' })), keys.publicKey, Buffer.from(signature, 'base64url'))).toBe(false);
  const client = new UserFnClient({ apiKey: 'unused', environment: 'production' }); client.setFlags(snapshot.flags); client.setSegments(snapshot.segments); expect(client.getFlag('enabled')).toEqual({ nested: [false, 0, '文'] });
  await Promise.all(databases.map(db => db.destroy())); databases = []; services = [connect(), connect()];
  const fetched = await request('GET'); expect(await fetched.text()).toBe(body); expect(fetched.headers.get('x-userfn-signature')).toBe(signature);
  const cached = await request('GET', undefined, { 'if-none-match': 'W/' + etag }); expect(cached.status).toBe(304); expect(await cached.text()).toBe(''); expect(cached.headers.get('etag')).toBe(etag);
  expect((await request('GET', undefined, { 'if-none-match': '"different"' })).status).toBe(200);
  expect((await request('GET', undefined, { authorization: 'Bearer editor-b', 'if-none-match': etag })).status).toBe(404);
  expect((await request('GET', undefined, {}, 'staging')).status).toBe(404);
});

it('authenticates before body parsing and never allows reader/foreign-tenant overwrites', async () => {
  expect((await request('PUT', payload(), { 'if-none-match': '*', authorization: 'Bearer reader-a' })).status).toBe(403);
  const invalid = await fetch(endpoint + '/config/production', { method: 'PUT', headers: { authorization: 'Bearer invalid', 'if-none-match': '*' }, body: '{' }); expect(invalid.status).toBe(401);
  const created = await request('PUT', payload(), { 'if-none-match': '*' }); const etag = created.headers.get('etag')!;
  expect((await request('PUT', payload(false), { 'if-match': etag, authorization: 'Bearer editor-b' })).status).toBe(412);
  expect((await request('GET', undefined, { authorization: 'Bearer reader-a' })).status).toBe(200);
  const cors = await request('GET', undefined, { origin: 'https://app.example' }); expect(cors.headers.get('access-control-expose-headers')).toContain('ETag'); expect(cors.headers.get('cache-control')).toBe('private, no-cache');
});

it('uses atomic compare-and-swap across independent SQLite connections', async () => {
  const created = await request('PUT', payload('original'), { 'if-none-match': '*' }); const etag = created.headers.get('etag')!;
  const results = await Promise.all([request('PUT', payload('first'), { 'if-match': etag }), request('PUT', payload('second'), { 'if-match': etag, 'x-connection': 'second' })]);
  expect(results.map(result => result.status).sort()).toEqual([200, 412]);
  const winner = await results.find(result => result.status === 200)!.text(); expect(await (await request('GET')).text()).toBe(winner);
  expect((await request('PUT', payload('stale'), { 'if-match': etag })).status).toBe(412);
  const creation = await Promise.all([request('PUT', payload('one'), { 'if-none-match': '*' }, 'new'), request('PUT', payload('two'), { 'if-none-match': '*', 'x-connection': 'second' }, 'new')]);
  expect(creation.map(result => result.status).sort()).toEqual([201, 412]);
});

it('rejects malformed, oversized streamed and invalid configuration before mutation', async () => {
  const original = await request('PUT', payload(), { 'if-none-match': '*' }); const etag = original.headers.get('etag')!; const originalBody = await original.text();
  for (const invalid of [{ flags: [], segments: [], unexpected: true }, { flags: [{ ...payload().flags[0], prerequisites: [{ key: 'x' }] }], segments: [] }, { flags: [], segments: [{ id: 'bad', rules: [{ id: 'x', field: 'x', operator: 'unknown' }] }] }]) expect((await request('PUT', invalid, { 'if-match': etag })).status).toBe(400);
  expect((await fetch(endpoint + '/config/production', { method: 'PUT', headers: { authorization: 'Bearer editor-a', 'if-match': etag }, body: '{' })).status).toBe(400);
  const stream = new ReadableStream({ start(controller) { for (let index = 0; index < 70; index++) controller.enqueue(new TextEncoder().encode('x'.repeat(1024))); controller.close(); } });
  const oversized = await fetch(endpoint + '/config/production', { method: 'PUT', headers: { authorization: 'Bearer editor-a', 'if-match': etag }, body: stream, duplex: 'half' } as RequestInit); expect(oversized.status).toBe(413);
  expect((await request('PUT', payload())).status).toBe(428);
  expect((await request('PUT', payload(), { 'if-match': '*' })).status).toBe(400);
  expect(await (await request('GET')).text()).toBe(originalBody);
});

it('requires explicit valid Ed25519 signing configuration', () => {
  const adapter = kyselyAdapter({ db: databases[0], dialect: 'sqlite', schema: { userfn_flag_config: 'userfn_flag_config' } });
  expect(() => createUserFnService({ database: adapter, auth, flagConfigSigning: { privateKey: keys.publicKey, keyId: 'key' } })).toThrow('Ed25519');
  expect(() => createUserFnService({ database: adapter, auth, flagConfigSigning: { privateKey: keys.privateKey, keyId: '../key' } })).toThrow('key ID');
});


it('delivers JSON compatible with the Python SDK and preserves prerequisite/environment fields', async () => {
  const definition = { flags: [
    { key: 'gate', enabled: true, defaultValue: false, variations: [], rules: [], environmentOverrides: { python: { defaultValue: true } } },
    { key: 'enabled', enabled: true, defaultValue: { nested: [false, 0, '文'] }, variations: [], rules: [], prerequisites: [{ key: 'gate', expectedValue: true }] },
  ], segments: [] };
  expect((await request('PUT', definition, { 'if-none-match': '*' }, 'python')).status).toBe(201);
  const result = await promisify(execFile)('python3', [resolve('tests/python_config_wire_acceptance.py'), endpoint], { env: { ...process.env, PYTHONPATH: resolve('../python/src') }, timeout: 10000 });
  expect(result.stdout).toContain('Python SDK evaluates actual HTTP wire configuration');
});

it('round-trips segment constraints and ordered flag rules through the signed wire snapshot', async () => {
  const definition = { flags: [{ key: 'enabled', enabled: true, defaultValue: false, variations: [{ id: 'on', value: true }], rules: [{ id: 'member', segmentId: 'members', variationId: 'on' }] }], segments: [{ id: 'members', name: 'Members', matchType: 'all', rules: [{ id: 'plan', field: 'plan', operator: 'equals', value: 'paid' }] }] };
  const response = await request('PUT', definition, { 'if-none-match': '*' }); expect(response.status).toBe(201);
  const snapshot = await response.json(); const client = new UserFnClient({ apiKey: 'unused' }); client.setFlags(snapshot.flags); client.setSegments(snapshot.segments);
  client.identify('one', { plan: 'paid' }); expect(client.getFlag('enabled')).toBe(true);
  client.identify('two', { plan: 'free' }); expect(client.getFlag('enabled')).toBe(false);
});
