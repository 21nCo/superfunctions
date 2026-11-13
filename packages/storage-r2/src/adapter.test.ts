import { afterEach, describe, it, expect, vi } from 'vitest';
import { runConformanceTests, validateCapabilities } from '@superfunctions/storage';
import { createR2StorageAdapter, R2RequestError, type R2Fetch, type R2StorageConfig } from './index.js';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function recordingFetch(respond: (request: RecordedRequest) => Response = () => new Response(null, { status: 200 })) {
  const requests: RecordedRequest[] = [];
  const fetch: R2Fetch = async (url, init) => {
    const request: RecordedRequest = {
      url,
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body as string | undefined,
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch, requests };
}

const BASE: R2StorageConfig = {
  accountId: 'test-account-id',
  bucket: 'test-bucket',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};

function xmlError(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

type Reply = Response | Error;

/** A fetch that answers with `replies` in order (a thrown Error models a network failure). */
function scriptedFetch(...replies: Array<() => Reply>) {
  const { fetch: record, requests } = recordingFetch();
  let index = 0;
  const fetch: R2Fetch = async (url, init) => {
    await record(url, init);
    const reply = replies[Math.min(index, replies.length - 1)]();
    index += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetch, requests };
}

const NO_DELAY = { retry: { baseDelayMs: 0 } };
const COMPLETE_RESULT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ETag>"x-2"</ETag></CompleteMultipartUploadResult>';
const PARTS = [{ partNumber: 1, etag: '"a"' }];

describe('@superfunctions/storage-r2', () => {
  const adapter = createR2StorageAdapter(BASE);

  describe('contract', () => {
    it('declares the R2 capabilities and passes the conformance suite', async () => {
      expect(adapter.name).toBe('r2');
      expect(adapter.capabilities).toEqual({
        signedUploadUrls: true,
        signedDownloadUrls: true,
        multipart: true,
        proxyStreamingUpload: false,
        proxyStreamingDownload: true,
      });
      expect(adapter.openUploadStream).toBeUndefined();
      expect(validateCapabilities(adapter.capabilities).ok).toBe(true);
      expect(await runConformanceTests(adapter)).toMatchObject({ ok: true, failed: [] });
    });

    it('rejects incomplete configuration', () => {
      expect(() => createR2StorageAdapter({ ...BASE, secretAccessKey: '' })).toThrow(
        expect.objectContaining({ code: 'STORAGE_CONFIG_INVALID' })
      );
      expect(() => createR2StorageAdapter({ ...BASE, accountId: 'evil.example/x' })).toThrow(
        expect.objectContaining({ code: 'STORAGE_CONFIG_INVALID' })
      );
      expect(() => createR2StorageAdapter({ ...BASE, endpoint: 'ftp://localhost' })).toThrow(
        expect.objectContaining({ code: 'STORAGE_CONFIG_INVALID' })
      );
    });
  });

  describe('addressing and signing', () => {
    it('signs path-style requests to the account endpoint with the auto region', async () => {
      const { fetch, requests } = recordingFetch(
        () => new Response(null, { status: 200, headers: { 'content-length': '12', etag: '"abc"' } })
      );
      await createR2StorageAdapter({ ...BASE, fetch }).statObject({ key: 'a b/c.txt' });
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('HEAD');
      expect(requests[0].url).toBe('https://test-account-id.r2.cloudflarestorage.com/test-bucket/a%20b/c.txt');
      expect(requests[0].headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
      );
    });

    it('uses the jurisdiction host or an explicit endpoint', async () => {
      const eu = recordingFetch();
      await createR2StorageAdapter({ ...BASE, jurisdiction: 'eu', fetch: eu.fetch }).deleteObject({ key: 'k' });
      expect(eu.requests[0].url).toBe('https://test-account-id.eu.r2.cloudflarestorage.com/test-bucket/k');

      const local = recordingFetch();
      await createR2StorageAdapter({ ...BASE, endpoint: 'http://127.0.0.1:9000/', fetch: local.fetch }).deleteObject({
        key: 'k',
      });
      expect(local.requests[0].url).toBe('http://127.0.0.1:9000/test-bucket/k');
    });

    it('presigns uploads with the constraint headers signed and no SDK checksum parameters', async () => {
      const signed = await adapter.signUploadUrl!({
        key: 'uploads/photo.png',
        expiresInSeconds: 900,
        constraints: { contentType: 'image/png', contentLength: 2048 },
      });
      const url = new URL(signed.url);
      expect(`${url.origin}${url.pathname}`).toBe(
        'https://test-account-id.r2.cloudflarestorage.com/test-bucket/uploads/photo.png'
      );
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^test-access-key\/\d{8}\/auto\/s3\/aws4_request$/);
      expect([...url.searchParams.keys()].filter((name) => /checksum|x-id/i.test(name))).toEqual([]);
      expect(signed.headers).toEqual({ 'Content-Type': 'image/png' });
    });

    it('presigns downloads and multipart parts with their query parameters', async () => {
      const download = new URL(
        (await adapter.signDownloadUrl!({
          key: 'k',
          expiresInSeconds: 60,
          constraints: { responseContentType: 'text/plain; charset=utf-8' },
        })).url
      );
      expect(download.searchParams.get('response-content-type')).toBe('text/plain; charset=utf-8');
      expect(download.searchParams.get('X-Amz-SignedHeaders')).toBe('host');

      const part = new URL(
        (await adapter.signMultipartUploadPartUrl!({
          key: 'k',
          uploadId: 'up/load+id',
          partNumber: 3,
          expiresInSeconds: 60,
          constraints: { contentLength: 10 },
        })).url
      );
      expect(part.searchParams.get('partNumber')).toBe('3');
      expect(part.searchParams.get('uploadId')).toBe('up/load+id');
      expect(part.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
    });

    it('rejects invalid expiries and keys before signing or sending', async () => {
      const { fetch, requests } = recordingFetch();
      const guarded = createR2StorageAdapter({ ...BASE, fetch });
      for (const expiresInSeconds of [0, -1, 1.5, 7 * 24 * 3600 + 1]) {
        await expect(guarded.signDownloadUrl!({ key: 'k', expiresInSeconds })).rejects.toMatchObject({
          code: 'STORAGE_SIGNED_URL_EXPIRY_INVALID',
        });
      }
      for (const key of ['', 'a/../b', './a', 'a/.', '\ud800']) {
        await expect(guarded.statObject({ key })).rejects.toMatchObject({ code: 'STORAGE_KEY_INVALID' });
      }
      expect(requests).toEqual([]);
    });
  });

  describe('responses', () => {
    it('maps a missing object to STORAGE_NOT_FOUND and other failures to R2RequestError', async () => {
      const missing = createR2StorageAdapter({
        ...BASE,
        fetch: recordingFetch(() => new Response(xmlError('NoSuchKey', 'gone'), { status: 404 })).fetch,
      });
      await expect(missing.statObject({ key: 'k' })).rejects.toMatchObject({ code: 'STORAGE_NOT_FOUND' });
      await expect(missing.openDownloadStream!({ key: 'k' })).rejects.toMatchObject({ code: 'STORAGE_NOT_FOUND' });

      const denied = createR2StorageAdapter({
        ...BASE,
        fetch: recordingFetch(
          () => new Response(xmlError('AccessDenied', 'Access &amp; denied'), {
            status: 403,
            headers: { 'x-amz-request-id': 'req-1' },
          })
        ).fetch,
      });
      const error = await denied.openDownloadStream!({ key: 'k' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(R2RequestError);
      expect(error).toMatchObject({
        name: 'AccessDenied',
        statusCode: 403,
        $metadata: { httpStatusCode: 403, requestId: 'req-1' },
        message: 'R2 GetObject failed with HTTP 403 AccessDenied: Access & denied',
      });
      await expect(denied.deleteObject({ key: 'k' })).rejects.toMatchObject({ name: 'AccessDenied' });
    });

    it('reads object metadata from HEAD headers', async () => {
      const stat = await createR2StorageAdapter({
        ...BASE,
        fetch: recordingFetch(
          () =>
            new Response(null, {
              status: 200,
              headers: {
                'content-length': '42',
                'content-type': 'text/plain',
                etag: '"etag"',
                'last-modified': 'Wed, 12 Nov 2025 10:00:00 GMT',
              },
            })
        ).fetch,
      }).statObject({ key: 'k' });
      expect(stat).toEqual({
        key: 'k',
        size: 42,
        contentType: 'text/plain',
        etag: '"etag"',
        lastModifiedAt: '2025-11-12T10:00:00.000Z',
      });
    });

    it('creates multipart uploads with content type and metadata headers', async () => {
      const { fetch, requests } = recordingFetch(
        () =>
          new Response(
            '<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>k</Key><UploadId>id&amp;1</UploadId></InitiateMultipartUploadResult>'
          )
      );
      const result = await createR2StorageAdapter({ ...BASE, fetch }).createMultipartUpload!({
        key: 'k',
        contentType: 'video/mp4',
        metadata: { Owner: 'u1' },
      });
      expect(result).toEqual({ uploadId: 'id&1' });
      expect(requests[0]).toMatchObject({
        method: 'POST',
        url: 'https://test-account-id.r2.cloudflarestorage.com/test-bucket/k?uploads',
      });
      expect(requests[0].headers).toMatchObject({ 'content-type': 'video/mp4', 'x-amz-meta-owner': 'u1' });
      expect(requests[0].headers.authorization).toContain(
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-owner'
      );
    });

    it('completes multipart uploads with sorted, escaped parts and a signed payload', async () => {
      const { fetch, requests } = recordingFetch(() => new Response('<CompleteMultipartUploadResult/>'));
      await createR2StorageAdapter({ ...BASE, fetch }).completeMultipartUpload!({
        key: 'k',
        uploadId: 'u',
        parts: [
          { partNumber: 2, etag: '"b"' },
          { partNumber: 1, etag: '"a"' },
        ],
      });
      expect(requests[0].url).toBe('https://test-account-id.r2.cloudflarestorage.com/test-bucket/k?uploadId=u');
      expect(requests[0].body).toBe(
        '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
          '<Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>' +
          '<Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part>' +
          '</CompleteMultipartUpload>'
      );
      expect(requests[0].headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(requests[0].headers['x-amz-content-sha256']).not.toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      );
    });

    it('treats an error document in a 200 completion response as a failure, whatever its namespace', async () => {
      const ns = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
      for (const document of [
        xmlError('InvalidPart', 'missing part'),
        `<Error ${ns}><Code>InvalidPart</Code><Message>missing part</Message></Error>`,
        `<?xml version="1.0"?>\n  <s3:Error xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:Code>InvalidPart</s3:Code><s3:Message>missing part</s3:Message></s3:Error>`,
      ]) {
        const { fetch, requests } = recordingFetch(() => new Response(document, { status: 200 }));
        await expect(
          createR2StorageAdapter({ ...BASE, ...NO_DELAY, fetch }).completeMultipartUpload!({
            key: 'k',
            uploadId: 'u',
            parts: PARTS,
          })
        ).rejects.toMatchObject({ name: 'InvalidPart', statusCode: 200, message: expect.stringContaining('missing part') });
        expect(requests).toHaveLength(1);
      }
    });

    it('accepts only a CompleteMultipartUploadResult document as a successful completion', async () => {
      for (const document of [
        COMPLETE_RESULT,
        '<?xml version="1.0"?>\n\n      <s3:CompleteMultipartUploadResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:ETag>"x"</s3:ETag></s3:CompleteMultipartUploadResult>',
      ]) {
        const { fetch } = recordingFetch(() => new Response(document));
        await expect(
          createR2StorageAdapter({ ...BASE, fetch }).completeMultipartUpload!({ key: 'k', uploadId: 'u', parts: PARTS })
        ).resolves.toBeUndefined();
      }
      for (const document of ['', '<Unexpected/>', 'not xml']) {
        const { fetch } = recordingFetch(() => new Response(document));
        await expect(
          createR2StorageAdapter({ ...BASE, fetch }).completeMultipartUpload!({ key: 'k', uploadId: 'u', parts: PARTS })
        ).rejects.toMatchObject({
          name: 'R2RequestError',
          message: expect.stringContaining('not a CompleteMultipartUploadResult'),
        });
      }
    });

    it('reads the UploadId from plain, namespaced and prefixed results, and rejects an embedded error', async () => {
      for (const document of [
        '<InitiateMultipartUploadResult><UploadId>id-1</UploadId></InitiateMultipartUploadResult>',
        '<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>b</Bucket><UploadId>id-1</UploadId></InitiateMultipartUploadResult>',
        '<s3:InitiateMultipartUploadResult xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:UploadIdMarker>no</s3:UploadIdMarker><s3:UploadId>id-1</s3:UploadId></s3:InitiateMultipartUploadResult>',
      ]) {
        const { fetch } = recordingFetch(() => new Response(document));
        await expect(createR2StorageAdapter({ ...BASE, fetch }).createMultipartUpload!({ key: 'k' })).resolves.toEqual({
          uploadId: 'id-1',
        });
      }
      const { fetch } = recordingFetch(
        () => new Response('<Error xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Code>AccessDenied</Code></Error>')
      );
      await expect(createR2StorageAdapter({ ...BASE, fetch }).createMultipartUpload!({ key: 'k' })).rejects.toMatchObject({
        name: 'AccessDenied',
      });
    });

    it('parses namespaced error documents on failed responses', async () => {
      const { fetch } = recordingFetch(
        () =>
          new Response(
            '<s3:Error xmlns:s3="http://s3.amazonaws.com/doc/2006-03-01/"><s3:Code>AccessDenied</s3:Code><s3:RequestId>r-9</s3:RequestId></s3:Error>',
            { status: 403 }
          )
      );
      await expect(createR2StorageAdapter({ ...BASE, fetch }).deleteObject({ key: 'k' })).rejects.toMatchObject({
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403, requestId: 'r-9' },
      });
    });

    it('rejects an empty part list without sending a request', async () => {
      const { fetch, requests } = recordingFetch();
      await expect(
        createR2StorageAdapter({ ...BASE, fetch }).completeMultipartUpload!({ key: 'k', uploadId: 'u', parts: [] })
      ).rejects.toMatchObject({ code: 'STORAGE_MULTIPART_INVALID' });
      expect(requests).toEqual([]);
    });

    it('streams ranged downloads', async () => {
      const { fetch, requests } = recordingFetch(() => new Response('ello', { status: 206 }));
      const stream = await createR2StorageAdapter({ ...BASE, fetch }).openDownloadStream!({
        key: 'k',
        range: { start: 1, endInclusive: 4 },
      });
      expect(await new Response(stream).text()).toBe('ello');
      expect(requests[0].headers.range).toBe('bytes=1-4');
      expect(requests[0].headers.authorization).toContain('SignedHeaders=host;range;');
    });

    it('asks for stored bytes so fetch does not decode a Content-Encoding', async () => {
      const { fetch, requests } = recordingFetch(() => new Response('raw'));
      await createR2StorageAdapter({ ...BASE, fetch }).openDownloadStream!({ key: 'a b' });
      expect(requests[0].url).toBe(
        'https://test-account-id.r2.cloudflarestorage.com/test-bucket/a%20b?response-content-encoding=identity'
      );
    });
  });

  describe('retries', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const transient: Array<[string, () => Reply]> = [
      ['a network error', () => new TypeError('fetch failed')],
      ['HTTP 500', () => new Response(xmlError('InternalError', 'oops'), { status: 500 })],
      ['HTTP 503 SlowDown', () => new Response(xmlError('SlowDown', 'slow'), { status: 503 })],
      ['HTTP 429', () => new Response(null, { status: 429 })],
      ['HTTP 400 RequestTimeout', () => new Response(xmlError('RequestTimeout', 'idle'), { status: 400 })],
    ];

    const operations: Array<[string, () => Response, (adapter: ReturnType<typeof createR2StorageAdapter>) => Promise<unknown>]> = [
      ['statObject', () => new Response(null, { headers: { 'content-length': '3' } }), (a) => a.statObject({ key: 'k' })],
      ['deleteObject', () => new Response(null, { status: 204 }), (a) => a.deleteObject({ key: 'k' })],
      [
        'createMultipartUpload',
        () => new Response('<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>'),
        (a) => a.createMultipartUpload!({ key: 'k' }),
      ],
      [
        'completeMultipartUpload',
        () => new Response(COMPLETE_RESULT),
        (a) => a.completeMultipartUpload!({ key: 'k', uploadId: 'u', parts: PARTS }),
      ],
      ['abortMultipartUpload', () => new Response(null, { status: 204 }), (a) => a.abortMultipartUpload!({ key: 'k', uploadId: 'u' })],
      [
        'openDownloadStream',
        () => new Response('abc'),
        async (a) => new Response(await a.openDownloadStream!({ key: 'k' })).text(),
      ],
    ];

    for (const [operation, success, run] of operations) {
      it(`${operation} succeeds after one transient failure of each kind`, async () => {
        for (const [, failure] of transient) {
          const { fetch, requests } = scriptedFetch(failure, success);
          await expect(run(createR2StorageAdapter({ ...BASE, ...NO_DELAY, fetch }))).resolves.not.toThrow();
          expect(requests).toHaveLength(2);
          expect(requests[1]).toMatchObject({ method: requests[0].method, url: requests[0].url, body: requests[0].body });
        }
      });
    }

    it('re-signs every attempt', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const { fetch, requests } = scriptedFetch(
        () => {
          vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
          return new Response(null, { status: 503 });
        },
        () => new Response(COMPLETE_RESULT)
      );
      await createR2StorageAdapter({ ...BASE, ...NO_DELAY, fetch }).completeMultipartUpload!({
        key: 'k',
        uploadId: 'u',
        parts: PARTS,
      });
      expect(requests.map((request) => request.headers['x-amz-date'])).toEqual(['20260101T000000Z', '20260101T010000Z']);
      expect(requests[0].headers.authorization).not.toBe(requests[1].headers.authorization);
    });

    it('retries a completion whose 200 response carries a retryable error code', async () => {
      const { fetch, requests } = scriptedFetch(
        () => new Response(`<Error xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Code>InternalError</Code></Error>`),
        () => new Response(COMPLETE_RESULT)
      );
      await createR2StorageAdapter({ ...BASE, ...NO_DELAY, fetch }).completeMultipartUpload!({
        key: 'k',
        uploadId: 'u',
        parts: PARTS,
      });
      expect(requests).toHaveLength(2);
    });

    it('does not retry client errors, missing objects or aborts', async () => {
      const cases: Array<[() => Reply, (a: ReturnType<typeof createR2StorageAdapter>) => Promise<unknown>]> = [
        [() => new Response(xmlError('AccessDenied', 'no'), { status: 403 }), (a) => a.deleteObject({ key: 'k' })],
        [() => new Response(xmlError('InvalidPart', 'no'), { status: 400 }), (a) => a.completeMultipartUpload!({ key: 'k', uploadId: 'u', parts: PARTS })],
        [() => new Response(xmlError('NoSuchUpload', 'no'), { status: 404 }), (a) => a.abortMultipartUpload!({ key: 'k', uploadId: 'u' })],
        [() => new Response(null, { status: 404 }), (a) => a.statObject({ key: 'k' })],
        [() => new Response(null, { status: 412 }), (a) => a.openDownloadStream!({ key: 'k' })],
        [() => new DOMException('aborted', 'AbortError'), (a) => a.statObject({ key: 'k' })],
      ];
      for (const [reply, run] of cases) {
        const { fetch, requests } = scriptedFetch(reply, () => new Response(null, { status: 200 }));
        await expect(run(createR2StorageAdapter({ ...BASE, ...NO_DELAY, fetch }))).rejects.toBeDefined();
        expect(requests).toHaveLength(1);
      }
    });

    it('gives up after maxAttempts and surfaces the last failure', async () => {
      const { fetch, requests } = scriptedFetch(() => new Response(xmlError('SlowDown', 'slow'), { status: 503 }));
      await expect(createR2StorageAdapter({ ...BASE, ...NO_DELAY, fetch }).deleteObject({ key: 'k' })).rejects.toMatchObject({
        name: 'SlowDown',
        statusCode: 503,
      });
      expect(requests).toHaveLength(3);

      const network = scriptedFetch(() => new TypeError('fetch failed'));
      await expect(
        createR2StorageAdapter({ ...BASE, retry: { maxAttempts: 2, baseDelayMs: 0 }, fetch: network.fetch }).statObject({ key: 'k' })
      ).rejects.toThrow('fetch failed');
      expect(network.requests).toHaveLength(2);

      const single = scriptedFetch(() => new Response(null, { status: 500 }));
      await expect(
        createR2StorageAdapter({ ...BASE, retry: { maxAttempts: 1 }, fetch: single.fetch }).statObject({ key: 'k' })
      ).rejects.toMatchObject({ statusCode: 500 });
      expect(single.requests).toHaveLength(1);
    });

    it('waits with bounded, jittered backoff between attempts', async () => {
      const delays: number[] = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
        delays.push(delay ?? 0);
        callback();
        return 0;
      }) as typeof setTimeout);
      const random = vi.spyOn(Math, 'random').mockReturnValue(1);
      const run = async (status: number, retry: R2StorageConfig['retry']) => {
        delays.length = 0;
        const { fetch } = scriptedFetch(() => new Response(null, { status }));
        await createR2StorageAdapter({ ...BASE, retry, fetch }).deleteObject({ key: 'k' }).catch(() => undefined);
        return [...delays];
      };
      expect(await run(500, undefined)).toEqual([100, 200]);
      expect(await run(503, undefined)).toEqual([500, 1000]);
      expect(await run(500, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 300 })).toEqual([100, 200, 300, 300]);
      random.mockReturnValue(0.25);
      expect(await run(500, undefined)).toEqual([25, 50]);
      vi.restoreAllMocks();
    });

    it('rejects an invalid retry policy', () => {
      for (const retry of [{ maxAttempts: 0 }, { maxAttempts: 1.5 }, { baseDelayMs: -1 }, { maxDelayMs: Number.NaN }]) {
        expect(() => createR2StorageAdapter({ ...BASE, retry })).toThrow(
          expect.objectContaining({ code: 'STORAGE_CONFIG_INVALID' })
        );
      }
    });
  });
});
