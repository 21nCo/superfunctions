/**
 * Runs the adapter against a real S3-compatible server (MinIO in CI). Set
 * STORAGE_R2_S3_ENDPOINT, STORAGE_R2_S3_ACCESS_KEY_ID,
 * STORAGE_R2_S3_SECRET_ACCESS_KEY and STORAGE_R2_S3_BUCKET (an existing bucket)
 * to enable it. With STORAGE_R2_S3_REQUIRED=1 a missing endpoint fails instead
 * of skipping, so CI cannot pass without exercising the server.
 */
import { runConformanceTests, type StorageAdapter } from '@superfunctions/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import { createR2StorageAdapter, R2RequestError } from './index.js';

const endpoint = process.env.STORAGE_R2_S3_ENDPOINT;
const required = process.env.STORAGE_R2_S3_REQUIRED === '1';

if (required && !endpoint) {
  throw new Error('STORAGE_R2_S3_REQUIRED=1 but STORAGE_R2_S3_ENDPOINT is not set');
}

const config = {
  accountId: 'unused-with-endpoint',
  endpoint,
  bucket: process.env.STORAGE_R2_S3_BUCKET ?? '',
  accessKeyId: process.env.STORAGE_R2_S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.STORAGE_R2_S3_SECRET_ACCESS_KEY ?? '',
};

const MIB = 1024 * 1024;
const prefix = `r2-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function readAll(stream: ReadableStream): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 'STORAGE_NOT_FOUND' });
}

describe.skipIf(!endpoint)('R2 adapter against an S3-compatible server', () => {
  let adapter: StorageAdapter;
  beforeAll(() => {
    adapter = createR2StorageAdapter(config);
  });

  it('passes the shared storage conformance suite', async () => {
    const result = await runConformanceTests(adapter);
    expect(result).toMatchObject({ ok: true, failed: [] });
  });

  it('uploads through a presigned PUT, then stats, downloads, streams and deletes', async () => {
    const key = `${prefix}/dir/with space/ü+&=?#%.txt`;
    const body = 'hello from the r2 adapter';
    const upload = await adapter.signUploadUrl!({
      key,
      expiresInSeconds: 300,
      constraints: { contentType: 'text/plain', contentLength: body.length },
    });
    expect(upload.headers).toEqual({ 'Content-Type': 'text/plain' });
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
    expect(put.status).toBe(200);

    const stat = await adapter.statObject({ key });
    expect(stat).toMatchObject({ key, size: body.length, contentType: 'text/plain' });
    expect(stat.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Number.isNaN(Date.parse(stat.lastModifiedAt ?? ''))).toBe(false);

    const download = await adapter.signDownloadUrl!({
      key,
      expiresInSeconds: 300,
      constraints: { responseContentType: 'application/octet-stream; charset=binary' },
    });
    const get = await fetch(download.url);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('application/octet-stream; charset=binary');
    expect(await get.text()).toBe(body);

    expect(new TextDecoder().decode(await readAll(await adapter.openDownloadStream!({ key })))).toBe(body);
    const ranged = await adapter.openDownloadStream!({ key, range: { start: 6, endInclusive: 9 } });
    expect(new TextDecoder().decode(await readAll(ranged))).toBe('from');

    await adapter.deleteObject({ key });
    await expectNotFound(adapter.statObject({ key }));
    await expectNotFound(adapter.openDownloadStream!({ key }));
    // Deleting a missing object is idempotent, as on R2 and S3.
    await expect(adapter.deleteObject({ key })).resolves.toBeUndefined();
  });

  it('rejects uploads that break the signed constraints or signature', async () => {
    const key = `${prefix}/constrained.txt`;
    const upload = await adapter.signUploadUrl!({
      key,
      expiresInSeconds: 300,
      constraints: { contentType: 'text/plain', contentLength: 5 },
    });
    const wrongType = await fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body: 'hello' });
    expect(wrongType.status).toBe(403);
    const wrongLength = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: 'hello!' });
    expect(wrongLength.status).toBe(403);
    const tampered = upload.url.replace(/X-Amz-Signature=([0-9a-f])/, (_m, c: string) =>
      `X-Amz-Signature=${c === '0' ? '1' : '0'}`
    );
    const badSignature = await fetch(tampered, { method: 'PUT', headers: upload.headers, body: 'hello' });
    expect(badSignature.status).toBe(403);
    await expectNotFound(adapter.statObject({ key }));
  });

  it('completes a multipart upload from presigned part URLs, in any part order', async () => {
    const key = `${prefix}/multipart.bin`;
    const part1 = bytes(5 * MIB, 1);
    const part2 = bytes(1234, 2);
    const { uploadId } = await adapter.createMultipartUpload!({
      key,
      contentType: 'application/x-test',
      metadata: { origin: 'r2-it' },
    });
    expect(uploadId).not.toBe('');

    const parts = [];
    for (const [partNumber, data] of [
      [1, part1],
      [2, part2],
    ] as const) {
      const signed = await adapter.signMultipartUploadPartUrl!({
        key,
        uploadId,
        partNumber,
        expiresInSeconds: 300,
        constraints: { contentLength: data.length },
      });
      const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: data });
      expect(response.status).toBe(200);
      parts.push({ partNumber, etag: response.headers.get('etag')! });
    }

    await adapter.completeMultipartUpload!({ key, uploadId, parts: [...parts].reverse() });

    const stat = await adapter.statObject({ key });
    expect(stat).toMatchObject({ size: part1.length + part2.length, contentType: 'application/x-test' });
    const tail = await readAll(
      await adapter.openDownloadStream!({
        key,
        range: { start: part1.length - 2, endInclusive: part1.length + 1 },
      })
    );
    expect([...tail]).toEqual([...part1.slice(-2), ...part2.slice(0, 2)]);
    await adapter.deleteObject({ key });
  });

  it('surfaces S3 errors from multipart completion and abort', async () => {
    const key = `${prefix}/aborted.bin`;
    const { uploadId } = await adapter.createMultipartUpload!({ key });
    const invalid = adapter.completeMultipartUpload!({
      key,
      uploadId,
      parts: [{ partNumber: 1, etag: '"00000000000000000000000000000000"' }],
    });
    await expect(invalid).rejects.toBeInstanceOf(R2RequestError);
    await expect(invalid).rejects.toMatchObject({ name: 'InvalidPart', statusCode: 400 });

    await adapter.abortMultipartUpload!({ key, uploadId });
    await expect(
      adapter.completeMultipartUpload!({ key, uploadId, parts: [{ partNumber: 1, etag: '"x"' }] })
    ).rejects.toMatchObject({ name: 'NoSuchUpload', statusCode: 404 });
  });

  it('reports bad credentials as an access error, not as a missing object', async () => {
    const denied = createR2StorageAdapter({ ...config, secretAccessKey: `${config.secretAccessKey}-wrong` });
    await expect(denied.statObject({ key: `${prefix}/anything` })).rejects.toMatchObject({ statusCode: 403 });
    await expect(denied.openDownloadStream!({ key: `${prefix}/anything` })).rejects.toMatchObject({
      name: 'SignatureDoesNotMatch',
      statusCode: 403,
    });
  });
});
