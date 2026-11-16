import { describe, expect, it, vi } from 'vitest';
import { createFileFnClient, FileFnHttpError } from '../index.js';

const artifact = {
  artifactId: 'art_1',
  fileId: 'file_1',
  versionId: 'ver_1',
  kind: 'thumbnail-small',
  mimeType: 'image/webp',
  size: 3,
  source: 'client',
  processingDurationMs: 12,
  createdAt: '2026-11-16T00:00:00.000Z',
};

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('uploadArtifact', () => {
  it('PUTs the raw bytes with their type and duration to the version artifact route', async () => {
    const seen: Array<{ url: string; init: RequestInit; body: string }> = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init, body: await new Response(init.body).text() });
      return ok({ artifact });
    });
    const client = createFileFnClient({
      baseUrl: 'https://api.test/filefn/',
      fetch: fetch as unknown as typeof globalThis.fetch,
      getAuthHeaders: async () => ({ authorization: 'Bearer t' }),
    });

    const result = await client.uploadArtifact({
      fileId: 'file_1',
      versionId: 'ver_1',
      kind: 'thumbnail-small',
      data: new Blob(['abc'], { type: 'image/webp' }),
      durationMs: 12,
    });

    expect(result).toEqual(artifact);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.test/filefn/file_1/versions/ver_1/artifacts/thumbnail-small?durationMs=12');
    expect(seen[0].init.method).toBe('PUT');
    expect(seen[0].init.headers).toEqual({ authorization: 'Bearer t', 'Content-Type': 'image/webp' });
    expect(seen[0].body).toBe('abc');
  });

  it('resends the same bytes when a transient failure is retried', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(await new Response(init.body).text());
      return bodies.length === 1 ? new Response('busy', { status: 503 }) : ok({ artifact });
    });
    const client = createFileFnClient({
      baseUrl: 'https://api.test',
      fetch: fetch as unknown as typeof globalThis.fetch,
      retryOptions: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
    });

    await client.uploadArtifact({
      fileId: 'file_1', versionId: 'ver_1', kind: 'converted', data: new Uint8Array([1, 2, 3]), mimeType: 'image/png',
    });
    expect(bodies).toEqual(['\u0001\u0002\u0003', '\u0001\u0002\u0003']);
  });

  it.each([
    [403, 'FILEFN_FORBIDDEN'],
    // Storage that cannot take a server-side upload: retrying cannot help.
    [501, 'FILEFN_STORAGE_UPLOAD_UNSUPPORTED'],
  ])('does not retry a %i refusal and surfaces its code', async (status, code) => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: { code, message: 'refused' } }),
      { status, headers: { 'content-type': 'application/json' } },
    ));
    const client = createFileFnClient({
      baseUrl: 'https://api.test',
      fetch: fetch as unknown as typeof globalThis.fetch,
      retryOptions: { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0 },
    });
    const error = await client.uploadArtifact({
      fileId: 'file_1', versionId: 'ver_1', kind: 'thumbnail-large', data: new Uint8Array([1]), mimeType: 'image/png',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(FileFnHttpError);
    expect(error).toMatchObject({ status, code });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown kind', { kind: 'poster' }],
    ['data without a type', { data: new Blob(['x']), mimeType: undefined }],
    ['a fractional duration', { durationMs: 1.5 }],
    ['a missing versionId', { versionId: '' }],
  ])('refuses %s before any request', async (_label, override) => {
    const fetch = vi.fn();
    const client = createFileFnClient({ baseUrl: 'https://api.test', fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(client.uploadArtifact({
      fileId: 'file_1',
      versionId: 'ver_1',
      kind: 'thumbnail-small',
      data: new Uint8Array([1]),
      mimeType: 'image/png',
      ...(override as object),
    } as Parameters<typeof client.uploadArtifact>[0])).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
