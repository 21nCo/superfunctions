import { describe, it, expect, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { Adapter } from '@superfunctions/db';
import type { AuthProvider, AuthSession } from '@superfunctions/auth';
import { createUserFnService } from '../src/index.js';

export const payload = { feedback: { title: 'Unicode 文', body: 'Details', category: 'bug', tags: ['test'] }, context: { source: 'in_app', user: { id: 'claimed-user', traits: { plan: 'pro' } } } };
export function session(tenantId = 'tenant-a', scopes = ['userfn:feedback:read', 'userfn:feedback:write']): AuthSession {
  return { id: 'key-1', type: 'api-key', subject: { actorId: 'verified-actor', actorType: 'api-key', tenantId }, scopes };
}
export const auth: AuthProvider = { async authenticate(request) {
  const key = request.headers.get('authorization');
  if (key === 'Bearer a') return session();
  if (key === 'Bearer b') return session('tenant-b');
  if (key === 'Bearer read') return session('tenant-a', ['userfn:feedback:read']);
  return null;
} };
function request(value: unknown = payload, key = 'same-key', token = 'a') {
  return new Request('http://localhost/feedback', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(value) });
}

describe('UserFn authenticated persistence', () => {
  it('awaits writes, stores authoritative actor separately, scopes reads and deduplicates same-key retries', async () => {
    const raw = memoryAdapter();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const database: Adapter = { ...raw, create: async params => { await gate; return raw.create(params); } };
    const service = createUserFnService({ database, auth });
    let completed = false;
    const pending = service.router.handle(request()).then(response => { completed = true; return response; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    release();
    const response = await pending;
    expect(response.status).toBe(201);
    const receipt = await response.json();
    const get = (token: string) => service.router.handle(new Request(`http://localhost/feedback/${receipt.id}`, { headers: { authorization: `Bearer ${token}` } }));
    expect((await get('b')).status).toBe(404);
    expect(await (await get('read')).json()).toMatchObject({ tenantId: 'tenant-a', actorId: 'verified-actor', payload, status: 'open', votes: 0 });
    expect((await service.router.handle(request())).status).toBe(200);
    expect((await service.router.handle(request({ ...payload, feedback: { ...payload.feedback, body: 'different' } }))).status).toBe(409);
    expect((await service.router.handle(request(payload, 'same-key', 'b'))).status).toBe(201);
    expect(await raw.count({ model: 'userfn_feedback' })).toBe(2);
  });

  it('fails closed for missing, invalid, expired and insufficient credentials', async () => {
    const database = memoryAdapter();
    const service = createUserFnService({ database, auth });
    expect((await service.router.handle(new Request('http://localhost/feedback', { method: 'POST', body: '{}' }))).status).toBe(401);
    expect((await service.router.handle(request(payload, 'k', 'bad'))).status).toBe(401);
    expect((await service.router.handle(request(payload, 'k', 'read'))).status).toBe(403);
    for (const invalid of [null, { ...session(), expiresAt: new Date(0) }, { ...session(), expiresAt: new Date(NaN) }, { ...session(), subject: { ...session().subject, tenantId: undefined } }]) {
      const configured = createUserFnService({ database, auth: { authenticate: async () => invalid as AuthSession } });
      expect([401, 403]).toContain((await configured.router.handle(request())).status);
    }
    expect(await database.count({ model: 'userfn_feedback' })).toBe(0);
    expect(() => createUserFnService({ database, auth: undefined as unknown as AuthProvider })).toThrow('authentication');
  });

  it('does not pass ambient cookies to the auth provider or trust tenant/actor claims in bodies', async () => {
    const authenticate = vi.fn(async (req: Request) => { expect(req.headers.has('cookie')).toBe(false); return session(); });
    const service = createUserFnService({ database: memoryAdapter(), auth: { authenticate } });
    const req = request({ ...payload, tenantId: 'tenant-b' }); req.headers.set('cookie', 'session=privileged');
    expect((await service.router.handle(req)).status).toBe(400);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('validates all fields, depth, idempotency keys and bounded bodies before storage', async () => {
    const raw = memoryAdapter();
    const create = vi.fn(raw.create);
    const service = createUserFnService({ database: { ...raw, create }, auth, maxBodyBytes: 1024 });
    for (const bad of [null, [], { ...payload, feedback: { ...payload.feedback, category: 'invalid' } }, { ...payload, feedback: { ...payload.feedback, tags: [42] } }, { ...payload, context: { source: 'spoof', user: null } }]) {
      expect((await service.router.handle(request(bad))).status).toBe(400);
    }
    expect((await service.router.handle(request(payload, 'bad key'))).status).toBe(400);
    expect((await service.router.handle(request({ ...payload, feedback: { ...payload.feedback, body: 'x'.repeat(2000) } }))).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it('returns sanitized failures without acknowledging lost writes', async () => {
    const raw = memoryAdapter();
    const service = createUserFnService({ database: { ...raw, create: async () => { throw new Error('secret-database-password'); } }, auth });
    const response = await service.router.handle(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
    expect(await raw.count({ model: 'userfn_feedback' })).toBe(0);
    const failedAuth = createUserFnService({ database: raw, auth: { authenticate: async () => { throw new Error('private auth failure'); } } });
    expect((await failedAuth.router.handle(request())).status).toBe(503);
  });
});

it('uses explicit CORS origins and preserves validation failures for browser callers', async () => {
  const service = createUserFnService({ database: memoryAdapter(), auth, allowedOrigins: ['https://app.example'] });
  const preflight = await service.router.handle(new Request('http://localhost/feedback', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key,content-type' } }));
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');
  expect(preflight.headers.get('access-control-allow-headers')).toContain('Idempotency-Key');
  expect(preflight.headers.has('access-control-allow-credentials')).toBe(false);
  const req = request({}); req.headers.set('origin', 'https://app.example');
  const invalid = await service.router.handle(req);
  expect(invalid.status).toBe(400);
  expect(invalid.headers.get('access-control-allow-origin')).toBe('https://app.example');
  const other = request(); other.headers.set('origin', 'https://untrusted.example');
  expect((await service.router.handle(other)).headers.has('access-control-allow-origin')).toBe(false);
  expect(() => createUserFnService({ database: memoryAdapter(), auth, allowedOrigins: ['*'] })).toThrow('explicit');
});


it('maps authenticated AuthFn API-key sessions through trusted access policy and rejects client authority claims', async () => {
  // AuthFn API-key session shape: actor is the key ID, scopes live in metadata; no tenant is supplied.
  const keySession: AuthSession = { id: 'issued-key-id', type: 'api-key', subject: { actorId: 'issued-key-id', actorType: 'api-key' }, metadata: { scopes: ['userfn:feedback:write', 'userfn:feedback:read'] } };
  const provider: AuthProvider = { authenticate: async () => keySession };
  const database = memoryAdapter();
  expect((await createUserFnService({ database, auth: provider }).router.handle(request())).status).toBe(403);
  const resolveAccess = vi.fn(async (verified: AuthSession) => verified.subject.actorId === 'issued-key-id' ? { tenantId: 'server-owned-tenant', scopes: verified.metadata.scopes } : null);
  const service = createUserFnService({ database, auth: provider, resolveAccess });
  const response = await service.router.handle(request());
  expect(response.status).toBe(201);
  const { id } = await response.json();
  const stored = await service.router.handle(new Request(`http://localhost/feedback/${id}`, { headers: { authorization: 'Bearer a', 'x-tenant-id': 'spoof', 'x-actor-id': 'spoof', 'x-scopes': '*' } }));
  expect(await stored.json()).toMatchObject({ tenantId: 'server-owned-tenant', actorId: 'issued-key-id' });
  for (const claim of ['tenantId', 'actorId', 'scopes']) expect((await service.router.handle(request({ ...payload, [claim]: 'spoof' }))).status).toBe(400);
  expect(resolveAccess).toHaveBeenCalledWith(keySession);
  expect((await createUserFnService({ database, auth: provider, resolveAccess: () => null }).router.handle(request())).status).toBe(403);
  for (const field of ['status', 'statusCode']) {
    const denied = createUserFnService({ database, auth: { authenticate: async () => { throw Object.assign(new Error('private revocation detail'), { [field]: 401 }); } }, resolveAccess });
    const deniedResponse = await denied.router.handle(request());
    expect(deniedResponse.status).toBe(401);
    expect(await deniedResponse.text()).not.toContain('private');
  }
});


it('preserves method negotiation headers', async () => {
  const service = createUserFnService({ database: memoryAdapter(), auth });
  const response = await service.router.handle(new Request('http://localhost/feedback', { method: 'DELETE' }));
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toContain('POST');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
