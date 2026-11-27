import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAuthorizer, createFileFn, redactObservedPath, type FileFnConfig, type QuotaProvider } from '../src/index.js';

describe('FILE-30 low-severity hardening (F-13, F-14, F-16, F-18, F-24)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-hardening-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(extra: Partial<FileFnConfig> = {}) {
    const database = memoryAdapter();
    const fileFn = createFileFn({
      database,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      auth: {
        required: false,
        resolveSession: async (request) => {
          const user = request.headers.get('x-test-user');
          if (!user) return null;
          const roles = request.headers.get('x-test-roles');
          return { principalId: user, tenantId: request.headers.get('x-test-tenant') ?? 't1', roles: roles ? roles.split(',') : undefined };
        },
      },
      ...extra,
    });
    return { fileFn, database };
  }

  async function upload(fileFn: ReturnType<typeof makeFileFn>['fileFn'], ctx: { principalId: string; tenantId?: string }, fileId?: string) {
    const body = Buffer.from('hello');
    const session = await fileFn.createUploadSession({ policy: 'docs', fileName: 'a.txt', size: body.length, mimeType: 'text/plain', fileId }, ctx);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, ctx, session.uploadSessionToken);
    await fileFn.services.uploads.completePart(session.uploadSessionId, 1, part.etag, part.size, ctx, session.uploadSessionToken);
    return fileFn.services.uploads.completeSession(session.uploadSessionId, ctx, session.uploadSessionToken);
  }

  // A FileFn from a fresh module (so the process-wide sweep warning has not
  // been given yet) whose logger warns through `warn`.
  async function freshFileFnWithWarn(warn: (...args: unknown[]) => unknown) {
    vi.resetModules();
    const fresh = await import('../src/index.js');
    return fresh.createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      observability: { logger: { info() {}, warn, error() {}, debug() {} } } as never,
    });
  }

  it('passes roles from auth to the authorizer, scoped to the file tenant (F-18)', async () => {
    const database = memoryAdapter();
    const { fileFn } = makeFileFn({ database, authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }) });
    const file = await upload(fileFn, { principalId: 'owner', tenantId: 't1' });
    const get = (headers: Record<string, string>) =>
      fileFn.router.handle(new Request(`http://localhost/${file.fileId}`, { headers }));

    expect((await get({ 'x-test-user': 'admin1', 'x-test-tenant': 't1', 'x-test-roles': 'admin' }))!.status).toBe(200);
    expect((await get({ 'x-test-user': 'admin2', 'x-test-tenant': 't2', 'x-test-roles': 'admin' }))!.status).toBe(403);
    expect((await get({ 'x-test-user': 'nobody', 'x-test-tenant': 't1' }))!.status).toBe(403);
  });

  it('never lets the reserved anonymous principal read, write or delete through roles or role grants (F-02, F-18)', async () => {
    const database = memoryAdapter();
    const authorizer = createDefaultAuthorizer({ db: database, namespace: 'filefn' });
    const file = { fileId: 'file_role01', ownerId: 'owner', tenantId: 't1', visibility: 'private' } as never;
    await database.create({
      model: 'filePermissions',
      data: { permissionId: 'perm_1', fileId: 'file_role01', role: 'editor', canRead: true, canWrite: true, canDelete: true, canShare: false, createdAt: new Date().toISOString() },
      namespace: 'filefn',
    });
    for (const principalId of ['anonymous', undefined]) {
      const guest = { principalId, tenantId: 't1', roles: ['editor', 'admin'] } as never;
      expect(await authorizer.canWrite(file, guest)).toBe(false);
      expect(await authorizer.canDelete(file, guest)).toBe(false);
    }
    const editor = { principalId: 'ed', tenantId: 't1', roles: ['editor'] } as never;
    expect(await authorizer.canWrite(file, editor)).toBe(true);
    expect(await authorizer.canDelete(file, editor)).toBe(true);
    // Roles don't let a guest read a private file either (role grant or admin role).
    for (const principalId of ['anonymous', undefined]) {
      expect(await authorizer.canRead(file, { principalId, tenantId: 't1', roles: ['editor'] } as never)).toBe(false);
      expect(await authorizer.canRead(file, { principalId, tenantId: 't1', roles: ['admin'] } as never)).toBe(false);
    }
    expect(await authorizer.canRead(file, editor)).toBe(true);
  });

  it("keeps a tenant's admin away from files without a tenant (F-18)", async () => {
    const database = memoryAdapter();
    const { fileFn } = makeFileFn({ database, authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }) });
    const tenantless = await upload(fileFn, { principalId: 'loner' });
    const get = (headers: Record<string, string>) =>
      fileFn.router.handle(new Request(`http://localhost/${tenantless.fileId}`, { headers }));
    expect((await get({ 'x-test-user': 'admin1', 'x-test-tenant': 't1', 'x-test-roles': 'admin' }))!.status).toBe(403);
    // An admin without a tenant still covers files without one.
    const globalAdmin = await fileFn.getFile({ fileId: tenantless.fileId }, { principalId: 'root', roles: ['admin'] } as never);
    expect(globalAdmin.fileId).toBe(tenantless.fileId);
  });

  it('keeps anonymous and signed-in rate-limit buckets apart, whatever the IDs (F-14)', async () => {
    const { rateLimitSubject } = await import('../src/rate-limit-key.js');
    const request = new Request('http://localhost/');
    const anon = await rateLimitSubject(null, request, () => 'client-a');
    const user = await rateLimitSubject({ principalId: 'anonymous:client-a' }, request);
    const tenantUser = await rateLimitSubject({ principalId: 'b', tenantId: 'a:x' }, request);
    const otherTenantUser = await rateLimitSubject({ principalId: 'x:b', tenantId: 'a' }, request);
    expect(new Set([anon, user, tenantUser, otherTenantUser]).size).toBe(4);
    // Anonymous traffic of different resolved tenants stays apart.
    const anonT1 = await rateLimitSubject({ principalId: 'anonymous', tenantId: 't1' }, request);
    const anonT2 = await rateLimitSubject({ principalId: 'anonymous', tenantId: 't2' }, request);
    expect(anonT1).not.toBe(anonT2);
  });

  it('lets a role grant with canShare create share links within the file tenant (F-18)', async () => {
    const database = memoryAdapter();
    const { fileFn } = makeFileFn({ database, authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }) });
    const owner = { principalId: 'owner', tenantId: 't1' };
    const file = await upload(fileFn, owner);
    await fileFn.services.grants.createGrant({ fileId: file.fileId, role: 'editor', canShare: true }, owner);
    const editor = { principalId: 'ed', tenantId: 't1', roles: ['editor'] };
    await expect(fileFn.services.shares.createShareLink({ fileId: file.fileId }, editor as never)).resolves.toMatchObject({ token: expect.any(String) });
    const outsider = { principalId: 'ed2', tenantId: 't2', roles: ['editor'] };
    await expect(fileFn.services.shares.createShareLink({ fileId: file.fileId }, outsider as never)).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    // Revoking someone else's link keeps the owner/user/tenant rule.
    const ownerLink = await fileFn.services.shares.createShareLink({ fileId: file.fileId }, owner);
    await expect(fileFn.services.shares.revokeShareLink(file.fileId, ownerLink.token, editor as never)).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
  });

  it('gives anonymous callers their own rate-limit bucket when the host names them (F-14)', async () => {
    const { fileFn } = makeFileFn({
      rateLimit: {
        mode: 'local',
        limits: { uploadInit: { windowSeconds: 60, maxRequests: 1 }, processing: { windowSeconds: 60, maxRequests: 1 } },
        clientKey: (request) => request.headers.get('x-test-client'),
      },
    });
    const init = (client: string) =>
      fileFn.router.handle(new Request('http://localhost/upload/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-client': client },
        body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
      }));
    expect((await init('client-a'))!.status).toBe(200);
    expect((await init('client-a'))!.status).toBe(429);
    expect((await init('client-b'))!.status).toBe(200);
  });

  it('caps one category for a public upload and keeps guest buckets apart (F-14)', async () => {
    // Sample-style config for auth.required false: each omitted category is
    // unlimited, and clientKey is a header the edge proxy overwrites.
    const { fileFn } = makeFileFn({
      auth: { required: false, resolveSession: async () => null },
      rateLimit: {
        mode: 'local',
        algorithm: 'fixed-window',
        limits: {
          uploadInit: { windowSeconds: 60, maxRequests: 1 },
          list: { windowSeconds: 60, maxRequests: 5 },
        },
        clientKey: (request) => request.headers.get('cf-connecting-ip'),
      },
    });
    const init = (ip: string) =>
      fileFn.router.handle(new Request('http://localhost/upload/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
      }));
    const list = (ip: string) =>
      fileFn.router.handle(new Request('http://localhost/', { headers: { 'cf-connecting-ip': ip } }));

    expect((await init('203.0.113.10'))!.status).toBe(200);
    expect((await init('203.0.113.10'))!.status).toBe(429);
    // The upload cap does not spend the list category for that guest.
    expect((await list('203.0.113.10'))!.status).toBe(200);
    // A second guest has its own upload bucket.
    expect((await init('203.0.113.11'))!.status).toBe(200);
  });

  it('records route shapes, not share tokens, in observed paths (F-16)', () => {
    expect(redactObservedPath('/proxy/share-links/test-share-token/download')).toBe('/proxy/share-links/:token/download');
    expect(redactObservedPath('/files/file_1/share-links/test-share-token', '/files')).toBe('/files/file_1/share-links/:token');
    // A mount path that itself says share-links can't shift the match off the token.
    expect(redactObservedPath('/share-links/share-links/test-share-token/download', '/share-links')).toBe(
      '/share-links/share-links/:token/download',
    );
    expect(redactObservedPath('/file_1/share-links')).toBe('/file_1/share-links');
  });

  it('charges and refunds quota to the file owner, including for a writer with a grant (F-13)', async () => {
    const usage: Array<{ principalId?: string; bytes: number }> = [];
    const quota: QuotaProvider = {
      async checkQuota() {
        return { allowed: true, current: 0, limit: 1_000_000 };
      },
      async recordUsage(input) {
        usage.push({ principalId: input.principalId, bytes: input.bytes });
      },
    } as QuotaProvider;
    const database = memoryAdapter();
    const { fileFn } = makeFileFn({ database, quota, authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }) });
    const owner = { principalId: 'owner', tenantId: 't1' };
    const file = await upload(fileFn, owner);
    await fileFn.services.grants.createGrant({ fileId: file.fileId, userId: 'writer', canWrite: true }, owner);
    await upload(fileFn, { principalId: 'writer', tenantId: 't1' }, file.fileId);
    await fileFn.deleteFile({ fileId: file.fileId }, owner);

    expect(usage.filter((entry) => entry.bytes > 0).map((entry) => entry.principalId)).toEqual(['owner', 'owner']);
    expect(usage.filter((entry) => entry.bytes < 0).map((entry) => entry.principalId)).toEqual(['owner']);
  });

  it('checks and charges a new file to its session owner, whoever completes it (F-13)', async () => {
    const checked: Array<string | undefined> = [];
    const usage: Array<string | undefined> = [];
    const quota = {
      async checkQuota(input) {
        checked.push(input.principalId);
        return { allowed: true, current: 0, limit: 100 };
      },
      async recordUsage(input) {
        usage.push(input.principalId);
      },
    } as QuotaProvider;
    const { fileFn } = makeFileFn({ quota });
    const body = Buffer.from('hello');
    const starter = {};
    const session = await fileFn.createUploadSession({ policy: 'docs', fileName: 'a.txt', size: body.length, mimeType: 'text/plain' }, starter);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, starter, session.uploadSessionToken);
    await fileFn.services.uploads.completePart(session.uploadSessionId, 1, part.etag, part.size, starter, session.uploadSessionToken);
    checked.length = 0;
    // Started anonymously, completed after signing in with the session token.
    await fileFn.services.uploads.completeSession(session.uploadSessionId, { principalId: 'later', tenantId: 't1' }, session.uploadSessionToken);
    // The anonymous owner's account is the provider's unset principal, as before.
    expect(checked).toEqual([undefined]);
    expect(usage).toEqual([undefined]);
  });

  it('refuses a writer who lost access with 403 before looking at the owner quota (F-13)', async () => {
    const quota = {
      async checkQuota() {
        return { allowed: false, current: 100, limit: 100 };
      },
      async recordUsage() {},
    } as QuotaProvider;
    const database = memoryAdapter();
    const { fileFn } = makeFileFn({ database, authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }) });
    const owner = { principalId: 'owner', tenantId: 't1' };
    const writer = { principalId: 'writer', tenantId: 't1' };
    const file = await upload(fileFn, owner);
    const grant = await fileFn.services.grants.createGrant({ fileId: file.fileId, userId: 'writer', canWrite: true }, owner);
    const limited = createFileFn({
      database,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }),
      quota,
    });
    const body = Buffer.from('hello');
    const session = await fileFn.createUploadSession({ policy: 'docs', fileName: 'a.txt', size: body.length, mimeType: 'text/plain', fileId: file.fileId }, writer);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, writer, session.uploadSessionToken);
    await fileFn.services.uploads.completePart(session.uploadSessionId, 1, part.etag, part.size, writer, session.uploadSessionToken);
    await fileFn.services.grants.revokeGrant(file.fileId, grant.permissionId, owner);
    await expect(limited.services.uploads.completeSession(session.uploadSessionId, writer, session.uploadSessionToken)).rejects.toMatchObject({
      code: 'FILEFN_FORBIDDEN',
    });
  });

  it("refuses a grantee over the owner's quota without the owner's usage figures (F-13)", async () => {
    const quota = {
      async checkQuota(input) {
        return input.principalId === 'owner'
          ? { allowed: false, current: 99, limit: 100, warning: 'owner nearly full' }
          : { allowed: true, current: 0, limit: 100 };
      },
      async recordUsage() {},
    } as QuotaProvider;
    const database = memoryAdapter();
    const { fileFn } = makeFileFn({ database, authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }) });
    const owner = { principalId: 'owner', tenantId: 't1' };
    const file = await upload(fileFn, owner);
    await fileFn.services.grants.createGrant({ fileId: file.fileId, userId: 'writer', canWrite: true }, owner);
    const limited = createFileFn({
      database,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      authorizer: createDefaultAuthorizer({ db: database, namespace: 'filefn' }),
      quota,
    });
    const error = await limited
      .createUploadSession({ policy: 'docs', fileName: 'a.txt', size: 5, mimeType: 'text/plain', fileId: file.fileId }, { principalId: 'writer', tenantId: 't1' })
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: 'FILEFN_QUOTA_EXCEEDED', details: { requested: 5 } });
    expect(error.details).not.toHaveProperty('current');
    expect(error.details).not.toHaveProperty('limit');
  });

  it('warns once per process when uploads start before any cleanup sweep (F-24)', async () => {
    const warn = vi.fn();
    const logger = { info() {}, warn, error() {}, debug() {} };
    const { fileFn } = makeFileFn({ observability: { logger } as never });
    await upload(fileFn, { principalId: 'owner', tenantId: 't1' });
    await upload(fileFn, { principalId: 'owner', tenantId: 't1' });
    // A host that builds a FileFn per request shares the process: no second warning.
    const perRequest = makeFileFn({ observability: { logger } as never }).fileFn;
    await upload(perRequest, { principalId: 'owner', tenantId: 't1' });
    const sweepWarnings = warn.mock.calls.filter(([message]) => String(message).includes('cleanupExpiredSessions'));
    expect(sweepWarnings).toHaveLength(1);
  });

  it('never fails an upload because the missing-sweep warning sink throws (F-24)', async () => {
    const warn = vi.fn(() => {
      throw new Error('sink down');
    });
    const fileFn = await freshFileFnWithWarn(warn);
    await expect(upload(fileFn as never, { principalId: 'owner', tenantId: 't1' })).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never leaves an unhandled rejection from an async warning sink that rejects (F-24)', async () => {
    const warn = vi.fn(async () => {
      throw new Error('sink down');
    });
    const fileFn = await freshFileFnWithWarn(warn);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(upload(fileFn as never, { principalId: 'owner', tenantId: 't1' })).resolves.toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
  });
});
