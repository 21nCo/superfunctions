import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createNotFoundError } from '@superfunctions/storage/internal/errors';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import type { ObservationMetric } from '@superfunctions/observability';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileFn, type FileFnConfig } from '../src/index.js';

describe('stable upload errors (N-06)', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'filefn-stable-errors-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeFileFn(extra: Partial<FileFnConfig> = {}) {
    return createFileFn({
      database: memoryAdapter(),
      storage: createLocalStorageAdapter({ rootDir }),
      namespace: 'filefn',
      policies: [{ name: 'docs', contentTypes: ['text/plain'], visibility: 'private' }],
      auth: { required: false, resolveSession: async () => null },
      ...extra,
    });
  }

  function assertNoAdapterLeak(text: string, sessionId?: string) {
    expect(text).not.toMatch(/Storage adapter|cannot stat|Proxy part|are missing/);
    if (sessionId) expect(text).not.toContain(sessionId);
  }

  it('returns a stable error when init cannot verify the upload size', async () => {
    const storage = createLocalStorageAdapter({ rootDir });
    delete (storage as { statObject?: unknown }).statObject;
    const fileFn = makeFileFn({ storage });

    const response = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_stat' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));

    expect(response!.status).toBe(500);
    const body = await response!.json() as { ok: boolean; requestId?: string; error: { code: string; message: string; details?: unknown } };
    expect(body.ok).toBe(false);
    expect(body.requestId).toBe('req_test_stat');
    expect(body.error).toEqual({
      code: 'FILEFN_STORAGE_STAT_UNAVAILABLE',
      message: 'Upload size cannot be verified',
    });
    assertNoAdapterLeak(JSON.stringify(body));
  });

  it('returns upload incomplete when a recorded proxy part object is gone', async () => {
    const fileFn = makeFileFn();
    const init = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_test_parts' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(init!.status).toBe(200);
    const created = await init!.json() as { data: { uploadSessionId: string; uploadSessionToken: string } };
    const { uploadSessionId, uploadSessionToken } = created.data;
    const headers = { 'x-upload-session-token': uploadSessionToken, 'x-request-id': 'req_test_parts' };

    const part = await fileFn.router.handle(new Request(`http://localhost/upload/${uploadSessionId}/parts/1`, {
      method: 'PUT',
      headers,
      body: 'x',
    }));
    expect(part!.status).toBe(200);

    const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
    const partFiles = entries.filter((entry) => entry.isFile() && entry.name.includes('.part'));
    expect(partFiles.length).toBeGreaterThan(0);
    for (const entry of partFiles) {
      await rm(join(entry.parentPath, entry.name));
    }

    const complete = await fileFn.router.handle(new Request(`http://localhost/upload/${uploadSessionId}/complete`, {
      method: 'POST',
      headers,
    }));
    expect(complete!.status).toBe(409);
    const body = await complete!.json() as { ok: boolean; requestId?: string; error: { code: string; message: string; details?: unknown } };
    expect(body.ok).toBe(false);
    expect(body.requestId).toBe('req_test_parts');
    expect(body.error).toEqual({
      code: 'FILEFN_UPLOAD_INCOMPLETE',
      message: 'Upload incomplete',
    });
    assertNoAdapterLeak(JSON.stringify(body), uploadSessionId);
  });

  it.each(['open', 'read'])('returns upload incomplete for a missing source part during stitch %s', async (stage) => {
    const storage = createLocalStorageAdapter({ rootDir });
    const open = storage.openDownloadStream!.bind(storage);
    let missing = true;
    storage.openDownloadStream = async (input) => {
      if (missing && input.key.endsWith('.part1')) {
        const error = createNotFoundError('test source part unavailable');
        if (stage === 'open') throw error;
        return new ReadableStream({ start(controller) { controller.error(error); } });
      }
      return open(input);
    };
    const metrics: ObservationMetric[] = [];
    const fileFn = makeFileFn({ storage, observability: { metrics: (metric) => { metrics.push(metric); } } });
    const init = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(init!.status).toBe(200);
    const created = await init!.json() as { data: { uploadSessionId: string; uploadSessionToken: string } };
    const url = `http://localhost/upload/${created.data.uploadSessionId}`;
    const headers = { 'x-upload-session-token': created.data.uploadSessionToken };
    const part = await fileFn.router.handle(new Request(`${url}/parts/1`, { method: 'PUT', headers, body: 'x' }));
    expect(part!.status).toBe(200);

    const complete = () => fileFn.router.handle(new Request(`${url}/complete`, { method: 'POST', headers }));
    const rejected = await complete();
    expect(rejected!.status).toBe(409);
    expect(await rejected!.json()).toMatchObject({
      error: { code: 'FILEFN_UPLOAD_INCOMPLETE', message: 'Upload incomplete' },
    });
    expect(metrics.filter((metric) => metric.kind === 'filefn.upload')).toMatchObject([
      { operation: 'failure', labels: { reason: 'parts_missing' } },
    ]);

    missing = false;
    expect((await complete())!.status).toBe(200);
  });

  it.each(['part', 'output'])('returns a retryable error when stat fails for the %s', async (target) => {
    const storage = createLocalStorageAdapter({ rootDir });
    const stat = storage.statObject!;
    let fail = false;
    storage.statObject = async (input) => {
      if (fail && input.key.endsWith('.part1') === (target === 'part')) {
        throw new Error('test adapter connection timed out');
      }
      return stat.call(storage, input);
    };
    const fileFn = makeFileFn({ storage });
    const init = await fileFn.router.handle(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'docs', fileName: 'a.txt', size: 1, mimeType: 'text/plain' }),
    }));
    expect(init!.status).toBe(200);
    const created = await init!.json() as { data: { uploadSessionId: string; uploadSessionToken: string } };
    const url = `http://localhost/upload/${created.data.uploadSessionId}`;
    const headers = { 'x-upload-session-token': created.data.uploadSessionToken, 'x-request-id': 'req_test_stat_retry' };
    const part = await fileFn.router.handle(new Request(`${url}/parts/1`, { method: 'PUT', headers, body: 'x' }));
    expect(part!.status).toBe(200);

    fail = true;
    const complete = () => fileFn.router.handle(new Request(`${url}/complete`, { method: 'POST', headers }));
    const response = await complete();
    expect(response!.status).toBe(500);
    const body = await response!.json();
    expect(body).toMatchObject({
      ok: false,
      requestId: 'req_test_stat_retry',
      error: { code: 'FILEFN_STORAGE_STAT_UNAVAILABLE', message: 'Upload size cannot be verified' },
    });
    expect(JSON.stringify(body)).not.toContain('test adapter connection timed out');
    assertNoAdapterLeak(JSON.stringify(body), created.data.uploadSessionId);

    fail = false;
    expect((await complete())!.status).toBe(200);
  });
});
