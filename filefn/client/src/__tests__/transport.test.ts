import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../client.js';
import { createFileFnClient } from '../index.js';
import type { FileFnClientConfig } from '../types.js';

const BASE = 'https://files.example.com/api/files';
const PRESIGNED = 'https://bucket.r2.example.net/obj?X-Amz-Signature=abc';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  credentials: RequestCredentials | undefined;
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fake FileFn server behind an injectable fetch. `partUrl` decides where
 * signed part uploads go: a relative proxy path or a presigned storage URL.
 */
function createFakeServer(partUrl: (partNumber: number) => string) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init.headers), credentials: init.credentials });

    if (!url.startsWith(`${BASE}/`)) {
      return new Response(null, { status: 200, headers: { ETag: '"storage-etag"' } });
    }
    const path = url.slice(BASE.length);
    const part = /^\/upload\/sess_1\/parts\/(\d+)(\/sign|\/complete)?$/.exec(path);
    if (part && part[2] === '/sign') {
      return envelope({ url: partUrl(Number(part[1])), headers: { 'content-type': 'text/plain' }, expiresAt: 'x' });
    }
    if (part && part[2] === '/complete') return envelope({ recorded: true });
    if (part) return envelope({ etag: 'proxy-etag', recorded: true });

    switch (`${method} ${path.split('?')[0]}`) {
      case 'POST /upload/init':
        return envelope({ uploadSessionId: 'sess_1', uploadSessionToken: 'upls_1', uploadMode: 'proxy', chunkSizeBytes: 5, totalParts: 2 });
      case 'GET /upload/sess_1/status':
        return envelope({ status: 'in_progress', recordedParts: [1], totalParts: 2, chunkSizeBytes: 5, fileSize: 10 });
      case 'POST /upload/sess_1/complete':
        return envelope({ fileId: 'file_1', versionId: 'ver_1' });
      case 'GET /file_1':
        return envelope({ fileId: 'file_1' });
      case 'GET /file_1/artifacts':
        return envelope({ artifacts: [] });
      case 'GET /file_1/download':
      case 'GET /file_1/artifacts/art_1/download':
        return envelope({ url: 'https://cdn.example.net/signed' });
      case 'GET /file_1/render':
        return envelope({ fileId: 'file_1', state: 'ready' });
      case 'DELETE /file_1':
        return new Response(null, { status: 204 });
      default:
        return new Response('not found', { status: 404 });
    }
  };
  return { calls, fetch: vi.fn(fetchImpl) as unknown as typeof fetch };
}

const tenBytes = () => new Blob(['0123456789'], { type: 'text/plain' });

describe('client transport options', () => {
  const globalFetch = vi.fn(async () => {
    throw new Error('global fetch must not be used when a fetch is injected');
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', globalFetch);
    globalFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends every FileFn request through the injected fetch with merged headers and the chosen credentials', async () => {
    const server = createFakeServer((n) => `/upload/sess_1/parts/${n}`);
    let csrf = 0;
    const client = createFileFnClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: 'include',
      getAuthHeaders: () => ({ 'x-csrf-token': `csrf-${++csrf}` }),
    });

    await expect(
      client.uploadFile({ policy: 'p', file: tenBytes(), fileName: 'a.txt', fileId: 'file_1' }).done(),
    ).resolves.toEqual({ fileId: 'file_1', versionId: 'ver_1' });
    await client.resumeUpload('sess_1', tenBytes(), { uploadSessionToken: 'upls_1', fileId: 'file_1' }).done();
    await client.getFile('file_1');
    await client.listArtifacts('file_1');
    await client.downloadUrl('file_1');
    await client.downloadArtifact('file_1', 'art_1');
    await client.resolveRenderable({ fileId: 'file_1', intent: 'preview' });
    await client.deleteFile('file_1');

    expect(globalFetch).not.toHaveBeenCalled();
    const seen = new Set(server.calls.map((c) => `${c.method} ${c.url.slice(BASE.length).split('?')[0]}`));
    expect([...seen].sort()).toEqual([
      'DELETE /file_1',
      'GET /file_1',
      'GET /file_1/artifacts',
      'GET /file_1/artifacts/art_1/download',
      'GET /file_1/download',
      'GET /file_1/render',
      'GET /upload/sess_1/status',
      'POST /upload/init',
      'POST /upload/sess_1/complete',
      'POST /upload/sess_1/parts/1/sign',
      'POST /upload/sess_1/parts/2/sign',
      'PUT /upload/sess_1/parts/1',
      'PUT /upload/sess_1/parts/2',
    ]);

    const csrfTokens = new Set<string | null>();
    for (const call of server.calls) {
      expect(call.credentials, `${call.method} ${call.url}`).toBe('include');
      expect(call.headers.get('x-csrf-token'), `${call.method} ${call.url}`).toMatch(/^csrf-\d+$/);
      csrfTokens.add(call.headers.get('x-csrf-token'));
      if (call.url.includes('/upload/sess_1/')) {
        expect(call.headers.get('x-upload-session-token'), `${call.method} ${call.url}`).toBe('upls_1');
      }
    }
    // getAuthHeaders is consulted per request, not cached once per client.
    expect(csrfTokens.size).toBe(server.calls.length);

    const proxyPut = server.calls.find((c) => c.method === 'PUT')!;
    expect(proxyPut.headers.get('content-type')).toBe('text/plain');
  });

  it('uploads presigned parts through the injected fetch without FileFn headers or credentials', async () => {
    const server = createFakeServer(() => PRESIGNED);
    const client = createFileFnClient({
      baseUrl: BASE,
      fetch: server.fetch,
      credentials: 'include',
      getAuthHeaders: () => ({ Authorization: 'Bearer secret' }),
    });

    await client.uploadFile({ policy: 'p', file: tenBytes(), fileName: 'a.txt', fileId: 'file_1' }).done();

    expect(globalFetch).not.toHaveBeenCalled();
    const storagePuts = server.calls.filter((c) => c.url === PRESIGNED);
    expect(storagePuts).toHaveLength(2);
    for (const put of storagePuts) {
      expect(put.method).toBe('PUT');
      expect(put.headers.get('authorization')).toBeNull();
      expect(put.headers.get('content-type')).toBe('text/plain');
      expect(put.credentials).toBe('omit');
    }
    const partCompletes = server.calls.filter((c) => /\/parts\/\d+\/complete$/.test(c.url));
    expect(partCompletes).toHaveLength(2);
    for (const call of server.calls.filter((c) => c.url !== PRESIGNED)) {
      expect(call.headers.get('authorization')).toBe('Bearer secret');
      expect(call.credentials).toBe('include');
    }
  });

  it.each([
    [`${BASE}/upload/sess_1/parts/1`, true],
    ['https://files.example.com/api/files', true],
    ['https://files.example.com/other/upload', false],
    ['https://files.example.com/api/filesystem/upload', false],
    ['https://files.example.com.evil.test/api/files/upload', false],
    ['http://files.example.com/api/files/upload', false],
  ])('only sends FileFn headers and credentials to signed URL %s when it is under baseUrl (%s)', async (url, toFileFn) => {
    const server = createFakeServer(() => url);
    const http = createHttpClient({
      baseUrl: `${BASE}/`,
      fetch: server.fetch,
      credentials: 'include',
      getAuthHeaders: () => ({ Authorization: 'Bearer secret' }),
    });

    await http.uploadPartToSignedUrl(url, { 'content-type': 'text/plain' }, tenBytes());

    const [put] = server.calls;
    expect(put.url).toBe(url);
    expect(put.headers.get('authorization')).toBe(toFileFn ? 'Bearer secret' : null);
    expect(put.credentials).toBe(toFileFn ? 'include' : 'omit');
  });

  it('defaults to the global fetch, resolved per request, and same-origin credentials', async () => {
    const client = createFileFnClient({ baseUrl: BASE });
    const lateFetch = vi.fn(async () => envelope({ fileId: 'file_1' }));
    vi.stubGlobal('fetch', lateFetch);

    await client.getFile('file_1');

    expect(lateFetch).toHaveBeenCalledTimes(1);
    expect(lateFetch.mock.calls[0]).toEqual([
      `${BASE}/file_1`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    ]);
  });

  it('re-reads auth headers on each retry attempt', async () => {
    const tokens: string[] = [];
    let attempt = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get('x-csrf-token')!);
      return ++attempt === 1 ? new Response('busy', { status: 503 }) : envelope({ fileId: 'file_1' });
    });
    let csrf = 0;
    const client = createFileFnClient({
      baseUrl: BASE,
      fetch: fetchImpl as unknown as typeof fetch,
      getAuthHeaders: async () => ({ 'x-csrf-token': `csrf-${++csrf}` }),
      retryOptions: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    await expect(client.getFile('file_1')).resolves.toEqual({ fileId: 'file_1' });
    expect(tokens).toEqual(['csrf-1', 'csrf-2']);
  });

  it('calls the injected fetch without binding it to the config object', async () => {
    const receivers: unknown[] = [];
    const config: FileFnClientConfig = {
      baseUrl: BASE,
      fetch: function (this: unknown) {
        receivers.push(this);
        return Promise.resolve(envelope({ fileId: 'file_1' }));
      } as typeof fetch,
    };

    await createFileFnClient(config).getFile('file_1');

    expect(receivers).toEqual([undefined]);
  });

  it('rejects a fetch that is not a function and an unknown credentials mode', () => {
    expect(() =>
      createFileFnClient({ baseUrl: BASE, fetch: 'nope' as unknown as typeof fetch }),
    ).toThrow(TypeError);
    expect(() =>
      createFileFnClient({ baseUrl: BASE, credentials: 'cookies' as RequestCredentials }),
    ).toThrow(TypeError);
  });
});
