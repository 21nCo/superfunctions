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

  it('records route shapes, not share tokens, in observed paths (F-16)', () => {
    expect(redactObservedPath('/proxy/share-links/test-share-token/download')).toBe('/proxy/share-links/:token/download');
    expect(redactObservedPath('/files/file_1/share-links/test-share-token')).toBe('/files/file_1/share-links/:token');
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

  it('warns once when uploads start before any cleanup sweep (F-24)', async () => {
    const warn = vi.fn();
    const { fileFn } = makeFileFn({ observability: { logger: { info() {}, warn, error() {}, debug() {} } } as never });
    await upload(fileFn, { principalId: 'owner', tenantId: 't1' });
    await upload(fileFn, { principalId: 'owner', tenantId: 't1' });
    const sweepWarnings = warn.mock.calls.filter(([message]) => String(message).includes('cleanupExpiredSessions'));
    expect(sweepWarnings).toHaveLength(1);
  });
});
