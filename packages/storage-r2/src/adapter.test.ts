import { describe, it, expect } from 'vitest';
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

    it('treats an error document in a 200 completion response as a failure', async () => {
      const failing = createR2StorageAdapter({
        ...BASE,
        fetch: recordingFetch(() => new Response(xmlError('InternalError', 'try again'), { status: 200 })).fetch,
      });
      await expect(
        failing.completeMultipartUpload!({ key: 'k', uploadId: 'u', parts: [{ partNumber: 1, etag: '"a"' }] })
      ).rejects.toMatchObject({ name: 'InternalError', statusCode: 200 });
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
  });
});
