import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  /** A FileFn whose counting writes always lose; `onLost(n)` runs before the n-th loss is reported. */
  function contendedFileFn(onLost: (count: number, settle: () => Promise<unknown>) => Promise<void>) {
    const database = memoryAdapter();
    let lost = 0;
    const contended = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') {
          return { ...target.capabilities, operations: { ...target.capabilities.operations, returning: false } };
        }
        if (prop === 'updateMany') {
          return async (params: Parameters<typeof target.updateMany>[0]) => {
            if (params.model === 'fileShares' && params.where.some((w) => w.field === 'downloads')) {
              lost += 1;
              await onLost(lost, () => target.updateMany({ ...params, where: [params.where[0]!], data: { downloads: 1 } }));
              return 0;
            }
            return target.updateMany(params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fileFn = createFileFn({
      database: contended,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    return { fileFn, lost: () => lost };
  }

  it('answers DOWNLOADS_EXCEEDED, not a retryable conflict, when the last lost write used the link up', async () => {
    // The 20th lost write loses to a download that takes the last slot.
    const { fileFn, lost } = contendedFileFn(async (count, takeLastSlot) => {
      if (count === 20) await takeLastSlot();
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 1 }, owner);
    await expect(fileFn.services.shares.getDownloadStreamViaShareLink(share.token, {})).rejects.toMatchObject({
      code: 'FILEFN_SHARE_DOWNLOADS_EXCEEDED',
    });
    expect(lost()).toBe(20);
  });

  it('answers a retryable 409 SHARE_DOWNLOAD_CONFLICT when the link still has room after 20 lost writes', async () => {
    const { fileFn, lost } = contendedFileFn(async () => {});
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 5 }, owner);
    await expect(fileFn.services.shares.getDownloadStreamViaShareLink(share.token, {})).rejects.toMatchObject({
      code: 'FILEFN_SHARE_DOWNLOAD_CONFLICT',
      status: 409,
      details: { retryable: true },
    });
    expect(lost()).toBe(20);
  });

  it('counts downloads on adapters that read the row back after update (Prisma, MySQL)', async () => {
    const database = memoryAdapter();
    // Like Prisma or MySQL: no RETURNING, and update() re-reads the row with the
    // same filter after writing it, so a successful conditional write throws.
    const readBack = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') {
          return { ...target.capabilities, operations: { ...target.capabilities.operations, returning: false } };
        }
        if (prop === 'update') {
          return async (params: Parameters<typeof target.update>[0]) => {
            await target.updateMany(params);
            throw Object.assign(new Error('Record not found'), { name: 'NotFoundError', code: 'ADAPTER_NOT_FOUND' });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fileFn = createFileFn({
      database: readBack,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 2 }, owner);
    await fileFn.services.shares.getDownloadStreamViaShareLink(share.token, {});
    await fileFn.services.shares.getDownloadStreamViaShareLink(share.token, {});
    await expect(fileFn.services.shares.getDownloadStreamViaShareLink(share.token, {})).rejects.toMatchObject({
      code: 'FILEFN_SHARE_DOWNLOADS_EXCEEDED',
    });
    const [row] = await database.findMany<{ downloads: number }>({ model: 'fileShares', where: [], namespace: 'filefn' });
    expect(row!.downloads).toBe(2);
  });

  it('never uses up a download when storage fails, and never signs a URL past the link expiry', async () => {
    const local = createLocalStorageAdapter({ rootDir });
    let failSigning = true;
    const signed: number[] = [];
    const storage = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, signedDownloadUrls: true };
        if (prop === 'signDownloadUrl') {
          return async ({ expiresInSeconds }: { expiresInSeconds?: number }) => {
            if (failSigning) throw new Error('storage unavailable');
            signed.push(expiresInSeconds ?? -1);
            return { url: 'https://storage.example/object' };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage,
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      signedUrlTtlSeconds: 900,
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink(
      { fileId: file.fileId, maxDownloads: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() },
      owner,
    );
    await expect(fileFn.services.shares.downloadViaShareLink(share.token, {})).rejects.toThrow('storage unavailable');
    failSigning = false;
    await expect(fileFn.services.shares.downloadViaShareLink(share.token, {})).resolves.toMatchObject({ url: 'https://storage.example/object' });
    expect(signed).toHaveLength(1);
    expect(signed[0]).toBeGreaterThan(0);
    expect(signed[0]).toBeLessThanOrEqual(60);
  });

  it('gives a failed download back exactly once, even after another download counted', async () => {
    const local = createLocalStorageAdapter({ rootDir });
    let calls = 0;
    let fileFn: ReturnType<typeof createFileFn>;
    let token = '';
    const storage = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, signedDownloadUrls: true };
        if (prop === 'signDownloadUrl') {
          return async () => {
            calls += 1;
            if (calls === 1) {
              // While A signs, B counts and succeeds; then A's signing fails.
              await fileFn.services.shares.downloadViaShareLink(token, {});
              throw new Error('storage unavailable');
            }
            return { url: 'https://storage.example/object' };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const database = memoryAdapter();
    fileFn = createFileFn({
      database,
      storage,
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    const file = await upload(fileFn);
    token = (await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 2 }, owner)).token;
    await expect(fileFn.services.shares.downloadViaShareLink(token, {})).rejects.toThrow('storage unavailable');
    const [row] = await database.findMany<{ downloads: number }>({ model: 'fileShares', where: [], namespace: 'filefn' });
    expect(row!.downloads).toBe(1);
    await expect(fileFn.services.shares.downloadViaShareLink(token, {})).resolves.toMatchObject({ url: 'https://storage.example/object' });
  });

  it('withholds a URL signed while its link was revoked, and gives the download back', async () => {
    const local = createLocalStorageAdapter({ rootDir });
    let fileFn: ReturnType<typeof createFileFn>;
    let token = '';
    let fileId = '';
    const storage = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, signedDownloadUrls: true };
        if (prop === 'signDownloadUrl') {
          return async () => {
            await fileFn.services.shares.revokeShareLink(fileId, token, owner);
            return { url: 'https://storage.example/object' };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const database = memoryAdapter();
    fileFn = createFileFn({
      database,
      storage,
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    const file = await upload(fileFn);
    fileId = file.fileId;
    token = (await fileFn.services.shares.createShareLink({ fileId, maxDownloads: 1 }, owner)).token;
    await expect(fileFn.services.shares.downloadViaShareLink(token, {})).rejects.toMatchObject({ code: 'FILEFN_SHARE_REVOKED' });
    const [row] = await database.findMany<{ downloads: number }>({ model: 'fileShares', where: [], namespace: 'filefn' });
    expect(row!.downloads).toBe(0);
  });

  it('gives the download back when the check after signing fails', async () => {
    const local = createLocalStorageAdapter({ rootDir });
    let failNextShareRead = false;
    let signings = 0;
    const storage = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, signedDownloadUrls: true };
        if (prop === 'signDownloadUrl') {
          return async () => {
            signings += 1;
            // Only the first download's post-signing read fails.
            failNextShareRead = signings === 1;
            return { url: 'https://storage.example/object' };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const database = memoryAdapter();
    const flaky = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === 'findOne') {
          return async (params: Parameters<typeof target.findOne>[0]) => {
            if (failNextShareRead && params.model === 'fileShares') {
              failNextShareRead = false;
              throw new Error('database timeout');
            }
            return target.findOne(params);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fileFn = createFileFn({
      database: flaky,
      storage,
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 1 }, owner);
    await expect(fileFn.services.shares.downloadViaShareLink(share.token, {})).rejects.toThrow('database timeout');
    await expect(fileFn.services.shares.downloadViaShareLink(share.token, {})).resolves.toMatchObject({ url: 'https://storage.example/object' });
  });

  it('reads expiry dates strictly as ISO 8601, and an empty expiresAt as none', async () => {
    const { fileFn, database } = makeFileFn();
    const file = await upload(fileFn);
    for (const expiresAt of ['12/31/2099', 'Tue, 01 Jan 2099 00:00:00 GMT', '2099-02-31T00:00:00Z']) {
      await expect(fileFn.services.shares.createShareLink({ fileId: file.fileId, expiresAt }, owner)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
      await expect(fileFn.services.grants.createGrant({ fileId: file.fileId, userId: 'reader', expiresAt }, owner)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
    }
    const dateOnly = await fileFn.services.shares.createShareLink({ fileId: file.fileId, expiresAt: '2099-12-31' }, owner);
    expect(dateOnly.expiresAt).toBe('2099-12-31T00:00:00.000Z');
    const noExpiry = await fileFn.services.shares.createShareLink({ fileId: file.fileId, expiresAt: '' }, owner);
    expect(noExpiry.expiresAt).toBeNull();
    // An empty versionId still means the current version.
    const currentVersion = await fileFn.services.shares.createShareLink({ fileId: file.fileId, versionId: '' }, owner);
    await expect(fileFn.services.shares.downloadViaShareLink(currentVersion.token, {})).resolves.toBeDefined();

    // A legacy row stored in a non-ISO format counts as expired.
    await database.updateMany({
      model: 'fileShares',
      where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
      data: { expiresAt: '12/31/2099' },
      namespace: 'filefn',
    });
    await expect(fileFn.services.shares.downloadViaShareLink(noExpiry.token, {})).rejects.toMatchObject({ code: 'FILEFN_SHARE_EXPIRED' });
  });

  it('keeps the earlier deadline for a legacy share row stored with a zone offset', async () => {
    const { fileFn, database } = makeFileFn();
    const file = await upload(fileFn);
    const link = await fileFn.services.shares.createShareLink({ fileId: file.fileId }, owner);
    // An hour ago as UTC wall time, written with a -05:00 offset: older servers
    // compared the text with the UTC ISO time, so this link expired an hour ago,
    // although the parsed instant is four hours ahead.
    const wall = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19);
    for (const expiresAt of [`${wall}-05:00`, `${wall}-0500`]) {
      await database.updateMany({
        model: 'fileShares',
        where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
        data: { expiresAt },
        namespace: 'filefn',
      });
      await expect(fileFn.services.shares.downloadViaShareLink(link.token, {})).rejects.toMatchObject({ code: 'FILEFN_SHARE_EXPIRED' });
    }
  });

  it('signs share URLs after counting, never past the link, and proxies a link in its last second', async () => {
    let signingTakesMs = 0;
    let streaming = true;
    const local = createLocalStorageAdapter({ rootDir });
    const storage = new Proxy(local, {
      get(target, prop, receiver) {
        if (prop === 'capabilities') return { ...target.capabilities, signedDownloadUrls: true, proxyStreamingDownload: streaming };
        if (prop === 'signDownloadUrl') {
          return async ({ expiresInSeconds }: { expiresInSeconds: number }) => {
            lifetimes.push(expiresInSeconds);
            // Signing "takes" this long: the clock moves on while it runs.
            vi.setSystemTime(Date.now() + signingTakesMs);
            return { url: 'https://storage.example/object' };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const database = memoryAdapter();
    const fileFn = createFileFn({
      database,
      storage,
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId }, owner);
    const setExpiry = (ms: number) =>
      database.updateMany({
        model: 'fileShares',
        where: [{ field: 'fileId', operator: 'eq', value: file.fileId }],
        data: { expiresAt: new Date(Date.now() + ms).toISOString() },
        namespace: 'filefn',
      });
    const resolve = () => fileFn.services.shares.downloadViaShareLink(share.token, {});

    const lifetimes: number[] = [];
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Under a second left: the proxy (which checks expiry again) serves it.
      await setExpiry(500);
      expect((await resolve()).url).toMatch(/^\/proxy\/share-links\//);

      // Signed after counting, with the lifetime left then: never past the link.
      await setExpiry(10_000);
      signingTakesMs = 2000;
      expect((await resolve()).url).toBe('https://storage.example/object');
      expect(lifetimes.at(-1)).toBeLessThanOrEqual(10);

      // Signing-only storage: a short link is still signed, and under a second left it is expired.
      streaming = false;
      signingTakesMs = 0;
      await setExpiry(30_000);
      expect((await resolve()).url).toBe('https://storage.example/object');
      expect(lifetimes.at(-1)).toBeLessThanOrEqual(30);
      await setExpiry(500);
      await expect(resolve()).rejects.toMatchObject({ code: 'FILEFN_SHARE_EXPIRED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a shares.maxTtlSeconds whose expiries would leave years 0001-9999', () => {
    expect(() => makeFileFn({ shares: { maxTtlSeconds: 1e15 } })).toThrow(/maxTtlSeconds/);
    expect(() => makeFileFn({ shares: { maxTtlSeconds: 100 * 365 * 24 * 60 * 60 } })).not.toThrow();
  });

  it('treats the anonymous principal as a guest for links that require auth', async () => {
    const database = memoryAdapter();
    const fileFn = createFileFn({
      database,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      auth: { resolveSession: async () => ({ principalId: 'anonymous' }) },
      shares: { requireAuth: true },
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId }, owner);
    expect((await call(fileFn, 'GET', `/share-links/${share.token}/download`)).status).toBe(401);
    expect((await call(fileFn, 'GET', `/proxy/share-links/${share.token}/download`)).status).toBe(401);
  });

  it('refuses expiry dates that leave years 0001-9999 once converted to UTC', async () => {
    const { fileFn } = makeFileFn();
    const file = await upload(fileFn);
    for (const expiresAt of ['9999-12-31T23:59:59-01:00']) {
      await expect(fileFn.services.shares.createShareLink({ fileId: file.fileId, expiresAt }, owner)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
      await expect(fileFn.services.grants.createGrant({ fileId: file.fileId, userId: 'reader', expiresAt }, owner)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
    }
    const latest = await fileFn.services.shares.createShareLink({ fileId: file.fileId, expiresAt: '9999-12-31T22:59:59-01:00' }, owner);
    expect(latest.expiresAt).toBe('9999-12-31T23:59:59.000Z');
    await expect(fileFn.services.shares.getDownloadStreamViaShareLink(latest.token, {})).resolves.toBeDefined();
  });

  it('answers 413 for an oversized chunked body without cancelling the request stream', async () => {
    const { readJsonBody } = await import('../src/http-body.js');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    await expect(readJsonBody(request)).rejects.toMatchObject({ code: 'FILEFN_BODY_TOO_LARGE' });
    expect(cancelled).toBe(false);
  });

  it('accepts any valid +json media type and refuses malformed ones', async () => {
    const { fileFn } = makeFileFn();
    const file = await upload(fileFn);
    const post = (contentType: string) =>
      call(fileFn, 'POST', `/${file.fileId}/permissions`, {
        body: JSON.stringify({ userId: 'reader' }),
        headers: { 'content-type': contentType, 'x-test-user': 'owner' },
      });
    expect((await post('application/vnd.example_internal+json')).status).toBe(201);
    expect((await post('model/gltf+json')).status).toBe(201);
    expect((await post('application/+json')).status).toBe(415);
    expect((await post('application/json/x')).status).toBe(415);
    expect((await post('text/json')).status).toBe(415);
  });

  it('GET /policies requires auth like the other routes (P9)', async () => {
    const { fileFn } = makeFileFn();
    expect((await call(fileFn, 'GET', '/policies')).status).toBe(401);
    const allowed = await call(fileFn, 'GET', '/policies', { headers: { 'x-test-user': 'owner' } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps the old reading of a stored zone-less expiry: local for grants, UTC for share links', async () => {
    const { parseIsoInstant } = await import('../src/authz/grant-expiry.js');
    expect(parseIsoInstant('2030-01-01T18:00:00')).toBe(new Date(2030, 0, 1, 18, 0, 0).getTime());
    expect(parseIsoInstant('2030-01-01T18:00:00', 'utc')).toBe(Date.UTC(2030, 0, 1, 18));
    expect(parseIsoInstant('2030-01-01T18:00:00Z')).toBe(Date.UTC(2030, 0, 1, 18));
    expect(parseIsoInstant('2030-01-01')).toBe(Date.UTC(2030, 0, 1));
    expect(parseIsoInstant('2030-01-01T18:00:00+0530')).toBe(Date.UTC(2030, 0, 1, 12, 30));
    expect(parseIsoInstant('2030-01-01T18:00:00+05:30')).toBe(Date.UTC(2030, 0, 1, 12, 30));
    expect(parseIsoInstant('2030-01-01T18:00:00-0130')).toBe(Date.UTC(2030, 0, 1, 19, 30));
    expect(parseIsoInstant('2030-01-01T18:00:00+0560')).toBeNull();
    expect(parseIsoInstant('2030-01-01T18:00:00+053')).toBeNull();
  });

  it('hands out no proxied stream for a link revoked while it was being counted', async () => {
    const database = memoryAdapter();
    let revokeOnNextUpdate = false;
    const racing = new Proxy(database, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return async (params: Parameters<typeof target.update>[0]) => {
            const result = await target.update(params);
            if (revokeOnNextUpdate && params.model === 'fileShares') {
              revokeOnNextUpdate = false;
              await target.updateMany({ model: 'fileShares', where: [], data: { revokedAt: new Date().toISOString() }, namespace: 'filefn' });
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const fileFn = createFileFn({
      database: racing,
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
    });
    const file = await upload(fileFn);
    const share = await fileFn.services.shares.createShareLink({ fileId: file.fileId, maxDownloads: 1 }, owner);
    revokeOnNextUpdate = true;
    await expect(fileFn.services.shares.getDownloadStreamViaShareLink(share.token, {})).rejects.toMatchObject({ code: 'FILEFN_SHARE_REVOKED' });
    const [row] = await database.findMany<{ downloads: number }>({ model: 'fileShares', where: [], namespace: 'filefn' });
    expect(row!.downloads).toBe(0);
  });

  it('treats the anonymous principal as a guest on GET /policies and refuses non-object JSON bodies', async () => {
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      auth: { resolveSession: async (request) => (request.headers.get('x-test-user') ? { principalId: request.headers.get('x-test-user')! } : { principalId: 'anonymous' }) },
    });
    expect((await call(fileFn, 'GET', '/policies'))!.status).toBe(401);
    const file = await upload(fileFn);
    for (const body of ['null', '[]', '42']) {
      const response = await call(fileFn, 'POST', `/${file.fileId}/permissions`, { body, headers: { 'content-type': 'application/json', 'x-test-user': 'owner' } });
      expect(response.status).toBe(400);
    }
  });
});
