import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { StorageAdapter } from '@superfunctions/storage';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileFn, type QuotaProvider } from '../src/index.js';

const alice = { principalId: 'alice', tenantId: 't1' };

/**
 * A multipart store where the test decides how many bytes each "client" part
 * really carried, the way a presigned URL that does not sign Content-Length
 * lets a client upload more than it declared.
 */
function createMultipartStore() {
  const objects = new Map<string, number>();
  const pendingParts = new Map<string, Map<number, number>>();
  let nextPartBytes = 0;
  let failStats = 0;
  const storage: StorageAdapter = {
    name: 'test-multipart',
    capabilities: {
      signedUploadUrls: true,
      signedDownloadUrls: true,
      multipart: true,
      proxyStreamingUpload: false,
      proxyStreamingDownload: true,
    },
    async createMultipartUpload({ key }) {
      pendingParts.set(key, new Map());
      return { uploadId: `upload:${key}` };
    },
    async signMultipartUploadPartUrl({ key, partNumber }) {
      // The client uploads through the signed URL; record what it really sent.
      pendingParts.get(key)!.set(partNumber, nextPartBytes);
      return { url: `https://storage.example/${encodeURIComponent(key)}/${partNumber}` };
    },
    async completeMultipartUpload({ key, parts }) {
      const sizes = pendingParts.get(key);
      if (!sizes) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
      objects.set(key, parts.reduce((sum, part) => sum + (sizes.get(part.partNumber) ?? 0), 0));
      pendingParts.delete(key);
    },
    async abortMultipartUpload({ key }) {
      pendingParts.delete(key);
    },
    async statObject({ key }) {
      if (failStats > 0) {
        failStats -= 1;
        throw new Error('transient stat failure');
      }
      if (!objects.has(key)) throw Object.assign(new Error('not found'), { code: 'STORAGE_NOT_FOUND' });
      return { key, size: objects.get(key)!, lastModifiedAt: new Date().toISOString() };
    },
    async deleteObject({ key }) {
      objects.delete(key);
    },
    async signDownloadUrl({ key }) {
      return { url: `https://storage.example/${encodeURIComponent(key)}` };
    },
  } as StorageAdapter;
  return {
    storage,
    objects,
    setNextPartBytes(bytes: number) {
      nextPartBytes = bytes;
    },
    failNextStats(count: number) {
      failStats = count;
    },
  };
}

describe('declared upload size is enforced (FILE-30 F-05)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-upload-size-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('refuses an oversized multipart object and deletes it; no file, no quota charge (P11)', async () => {
    const store = createMultipartStore();
    const usage: unknown[] = [];
    const quota: QuotaProvider = {
      async checkQuota() {
        return { allowed: true, current: 0, limit: 1024 };
      },
      async recordUsage(input) {
        usage.push(input);
      },
    } as QuotaProvider;
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: store.storage,
      policies: [{ name: 'small', contentTypes: ['image/png'], maxSizeBytes: 1024 }],
      quota,
    });

    const session = await fileFn.createUploadSession({ policy: 'small', fileName: 'a.png', size: 10, mimeType: 'image/png' }, alice);
    store.setNextPartBytes(50 * 1024 * 1024);
    await fileFn.services.uploads.signPart(session.uploadSessionId, 1, 10, alice);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: 'etag-1', size: 10 }, alice);

    await expect(fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, alice)).rejects.toMatchObject({
      code: 'FILEFN_UPLOAD_SIZE_MISMATCH',
      details: { expected: 10, actual: 50 * 1024 * 1024 },
    });

    expect([...store.objects.keys()]).toEqual([]);
    expect((await fileFn.listFiles({}, alice)).files).toHaveLength(0);
    expect(usage).toEqual([]);
    // The session is refused: a retry cannot publish it.
    await expect(fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, alice)).rejects.toMatchObject({
      code: 'FILEFN_UPLOAD_ABORTED',
    });
  });

  it('refuses to sign a part longer than the session allows for it', async () => {
    const store = createMultipartStore();
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: store.storage,
      policies: [{ name: 'small', maxSizeBytes: 1024 }],
    });
    const session = await fileFn.createUploadSession({ policy: 'small', fileName: 'a.bin', size: 10, mimeType: 'application/octet-stream' }, alice);

    await expect(fileFn.services.uploads.signPart(session.uploadSessionId, 1, 11, alice)).rejects.toMatchObject({
      code: 'FILEFN_PART_TOO_LARGE',
      statusCode: 413,
      details: { partNumber: 1, maxBytes: 10 },
    });
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(fileFn.services.uploads.signPart(session.uploadSessionId, 1, bad, alice)).rejects.toMatchObject({
        code: 'FILEFN_INVALID_REQUEST',
      });
    }
    await expect(fileFn.services.uploads.signPart(session.uploadSessionId, 1, 10, alice)).resolves.toMatchObject({ url: expect.any(String) });
  });

  it('stops a proxy part at its limit while streaming and keeps nothing of it', async () => {
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      policies: [{ name: 'small', maxSizeBytes: 1024 }],
    });
    const session = await fileFn.createUploadSession({ policy: 'small', fileName: 'a.bin', size: 10, mimeType: 'application/octet-stream' }, alice);

    // The declared length lies (says 10); the stream carries 4 MiB.
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 64; i++) controller.enqueue(new Uint8Array(64 * 1024));
        controller.close();
      },
    });
    await expect(
      fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, big, 10, alice),
    ).rejects.toMatchObject({ code: 'FILEFN_PART_TOO_LARGE', statusCode: 413 });

    // Nothing past the part's bound was written (the aborted part, if the
    // adapter leaves one, is empty here; the expiry sweep removes it).
    const files = await readdir(rootDir, { recursive: true, withFileTypes: true });
    for (const entry of files.filter((e) => e.isFile())) {
      const { size } = await stat(join(entry.parentPath ?? (entry as unknown as { path: string }).path, entry.name));
      expect(size).toBeLessThanOrEqual(10);
    }

    // The right bytes still go through afterwards.
    const body = Buffer.from('0123456789');
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body, body.length, alice);
    expect(part.size).toBe(10);
  });

  it('refuses and deletes an oversized multipart object even when the first completion could not stat it', async () => {
    const store = createMultipartStore();
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: store.storage,
      policies: [{ name: 'small', maxSizeBytes: 1024 }],
    });
    const session = await fileFn.createUploadSession({ policy: 'small', fileName: 'a.bin', size: 10, mimeType: 'application/octet-stream' }, alice);
    store.setNextPartBytes(50 * 1024 * 1024);
    await fileFn.services.uploads.signPart(session.uploadSessionId, 1, 10, alice);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: 'etag-1', size: 10 }, alice);

    store.failNextStats(1);
    await expect(fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, alice)).rejects.toThrow();
    // The retry finds the upload consumed, the object present at the wrong size: refused and deleted.
    await expect(fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, alice)).rejects.toMatchObject({
      code: 'FILEFN_UPLOAD_SIZE_MISMATCH',
    });
    expect([...store.objects.keys()]).toEqual([]);
  });

  it('removes an aborted proxy part write when the session is aborted, even without a part row', async () => {
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      policies: [{ name: 'small', maxSizeBytes: 1024 }],
    });
    const session = await fileFn.createUploadSession({ policy: 'small', fileName: 'a.bin', size: 10, mimeType: 'application/octet-stream' }, alice);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    await expect(fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, stream, 0, alice)).rejects.toMatchObject({
      code: 'FILEFN_PART_TOO_LARGE',
    });
    // Let the aborted local write stream settle (it opens its file
    // asynchronously), as it has long before a real abort or expiry.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fileFn.abortUploadSession({ uploadSessionId: session.uploadSessionId }, alice);
    const files = await readdir(rootDir, { recursive: true, withFileTypes: true });
    expect(files.filter((entry) => entry.isFile())).toEqual([]);
  });

  it('refuses an upload that would need more than 10,000 parts', async () => {
    const fileFn = createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      policies: [{ name: 'any' }],
    });
    const tooBig = 10_001 * 8 * 1024 * 1024;
    await expect(
      fileFn.createUploadSession({ policy: 'any', fileName: 'a.bin', size: tooBig, mimeType: 'application/octet-stream' }, alice),
    ).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST', details: { field: 'size' } });
  });
});
