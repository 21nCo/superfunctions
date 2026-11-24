import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileFn, type FileFnConfig } from '../src/index.js';

const owner = { principalId: 'owner', tenantId: 't1' };

describe('share links, grants and JSON routes (FILE-30 F-07, F-08, F-09, F-15)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-sharing-'));
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
        resolveSession: async (request) => {
          const user = request.headers.get('x-test-user');
          if (!user) return null;
          return { principalId: user, tenantId: request.headers.get('x-test-tenant') ?? 't1' };
        },
      },
      ...extra,
    });
    return { fileFn, database };
  }

  async function upload(fileFn: ReturnType<typeof makeFileFn>['fileFn']) {
    const body = Buffer.from('shared bytes');
    const session = await fileFn.createUploadSession({ policy: 'docs', fileName: 'a.txt', size: body.length, mimeType: 'text/plain' }, owner);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, owner);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
    return fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
  }

  function call(
    fileFn: ReturnType<typeof makeFileFn>['fileFn'],
    method: string,
    path: string,
    options: { body?: string; headers?: Record<string, string> } = {},
  ) {
    return fileFn.router.handle(new Request(`http://localhost${path}`, { method, headers: options.headers, body: options.body }));
  }

  it('maxDownloads holds under parallel downloads (P8)', async () => {
    const { fileFn } = makeFileFn();
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 1 }, owner);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => call(fileFn, 'GET', `/proxy/share-links/${share.token}/download`)),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status !== 200).every((status) => status === 403 || status === 409 || status === 410)).toBe(true);
  });

  it('refuses unparseable, past or non-ISO expiry dates and bad limits at creation (P8)', async () => {
    const { fileFn } = makeFileFn();
    const file = await upload(fileFn);
    for (const input of [
      { expiresAt: 'not-a-date' },
      { expiresAt: 'Tue, 01 Jan 2019 00:00:00 GMT' },
      { maxDownloads: 0 },
      { maxDownloads: 1.5 },
      { requiresAuth: 'yes' as unknown as boolean },
    ]) {
      await expect(fileFn.services.shares.createShareLink({ fileId: file.fileId, ...input }, owner)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
    }
    await expect(fileFn.services.shares.createShareLink({ fileId: file.fileId, versionId: 'ver_missing' }, owner)).rejects.toMatchObject({
      code: 'FILEFN_NOT_FOUND',
    });
  });

  it('treats a stored expiry that does not parse as expired', async () => {
    const { fileFn, database } = makeFileFn();
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId }, owner);
    await database.updateMany({
      model: 'fileShares',
      where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
      data: { expiresAt: 'not-a-date' },
      namespace: 'filefn',
    });
    await expect(fileFn.services.shares.downloadViaShareLink(share.token, {})).rejects.toMatchObject({ code: 'FILEFN_SHARE_EXPIRED' });
  });

  it('applies host share options: lifetime cap, required auth, and switching links off', async () => {
    const { fileFn } = makeFileFn({ shares: { maxTtlSeconds: 3600, requireAuth: true } });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId }, owner);
    const expiresAtMs = Date.parse(share.expiresAt!);
    expect(expiresAtMs).toBeGreaterThan(Date.now());
    expect(expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600_000);
    await expect(
      fileFn.services.shares.createShareLink({ fileId: file.fileId, expiresAt: new Date(Date.now() + 7200_000).toISOString() }, owner),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    expect((await call(fileFn, 'GET', `/proxy/share-links/${share.token}/download`)).status).toBe(401);

    const off = makeFileFn({ shares: { enabled: false } }).fileFn;
    // No route: the router answers null and the host serves its own 404.
    expect((await call(off, 'GET', `/proxy/share-links/${share.token}/download`))?.status ?? 404).toBe(404);
  });

  it('validates grants, fails closed on a bad stored expiry, and refuses cross-tenant grants by default (P8)', async () => {
    const { fileFn, database } = makeFileFn();
    const file = await upload(fileFn);
    for (const input of [
      { userId: 'reader', expiresAt: 'not-a-date' },
      { userId: 'reader', canRead: 'yes' as unknown as boolean },
      { userId: 42 as unknown as string },
    ]) {
      await expect(fileFn.services.grants.createGrant({ fileId: file.fileId, ...input }, owner)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
    }
    await expect(fileFn.services.grants.createGrant({ fileId: file.fileId, tenantId: 't2' }, owner)).rejects.toMatchObject({
      code: 'FILEFN_FORBIDDEN',
    });

    await fileFn.services.grants.createGrant({ fileId: file.fileId, userId: 'reader' }, owner);
    expect((await fileFn.getFile({ fileId: file.fileId }, { principalId: 'reader', tenantId: 't1' })).fileId).toBe(file.fileId);
    await database.updateMany({
      model: 'filePermissions',
      where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
      data: { expiresAt: 'not-a-date' },
      namespace: 'filefn',
    });
    await expect(fileFn.getFile({ fileId: file.fileId }, { principalId: 'reader', tenantId: 't1' })).rejects.toMatchObject({
      code: 'FILEFN_FORBIDDEN',
    });

    const permissive = makeFileFn({ grants: { allowCrossTenant: true } }).fileFn;
    const other = await upload(permissive);
    await expect(permissive.services.grants.createGrant({ fileId: other.fileId, tenantId: 't2' }, owner)).resolves.toMatchObject({ tenantId: 't2' });
  });

  it('refuses a cross-site text/plain POST to a JSON route (P12)', async () => {
    const { fileFn, database } = makeFileFn();
    const file = await upload(fileFn);
    const response = await call(fileFn, 'POST', `/${file.fileId}/permissions`, {
      body: JSON.stringify({ userId: 'mallory', canRead: true }),
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example', 'x-test-user': 'owner' },
    });
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('FILEFN_UNSUPPORTED_MEDIA_TYPE');
    expect(await database.findMany({ model: 'filePermissions', where: [], namespace: 'filefn' })).toHaveLength(0);

    for (const path of ['/upload/init', `/${file.fileId}/share-links`, `/${file.fileId}/process`]) {
      expect((await call(fileFn, 'POST', path, { body: '{}', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-user': 'owner' } })).status).toBe(415);
    }

    const ok = await call(fileFn, 'POST', `/${file.fileId}/permissions`, {
      body: JSON.stringify({ userId: 'reader' }),
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-test-user': 'owner' },
    });
    expect(ok.status).toBe(201);

    const huge = await call(fileFn, 'POST', `/${file.fileId}/permissions`, {
      body: JSON.stringify({ userId: 'reader', pad: 'x'.repeat(70 * 1024) }),
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner' },
    });
    expect(huge.status).toBe(413);
  });

  it('GET /policies requires auth like the other routes (P9)', async () => {
    const { fileFn } = makeFileFn();
    expect((await call(fileFn, 'GET', '/policies')).status).toBe(401);
    expect((await call(fileFn, 'GET', '/policies', { headers: { 'x-test-user': 'owner' } })).status).toBe(200);
  });
});
