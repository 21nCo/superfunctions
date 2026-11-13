/**
 * Fixture Worker for the storage-r2 workerd test. It is bundled the way
 * `wrangler deploy` bundles a Worker, without the nodejs_compat flag, so the
 * adapter has to run on plain Workers APIs (fetch, Web Crypto, streams).
 *
 * GET  /vector     signs the AWS S3 presigned-URL example inside workerd.
 * POST /roundtrip  drives the adapter against the S3-compatible server named by
 *                  the S3_* bindings and reports what it observed.
 */
import { runConformanceTests } from '@superfunctions/storage';
import { createR2StorageAdapter } from '@superfunctions/storage-r2';
import { presignUrl } from '../../src/sigv4.js';

interface Env {
  S3_ENDPOINT?: string;
  S3_BUCKET?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
}

async function vector(): Promise<Response> {
  const url = await presignUrl(
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    { region: 'us-east-1', service: 's3' },
    { method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', expiresInSeconds: 86400 },
    new Date('2013-05-24T00:00:00Z')
  );
  return new Response(url);
}

async function roundtrip(env: Env): Promise<Response> {
  if (!env.S3_ENDPOINT) {
    return new Response('S3_ENDPOINT binding is not set', { status: 400 });
  }
  const adapter = createR2StorageAdapter({
    accountId: 'unused-with-endpoint',
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET ?? '',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
  });
  const key = `r2-workerd-${crypto.randomUUID()}/hello world.txt`;
  const body = 'hello from workerd';

  const conformance = await runConformanceTests(adapter);

  const upload = await adapter.signUploadUrl!({
    key,
    expiresInSeconds: 120,
    constraints: { contentType: 'text/plain', contentLength: body.length },
  });
  const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
  const stat = await adapter.statObject({ key });
  const downloaded = await new Response(
    await adapter.openDownloadStream!({ key, range: { start: 6, endInclusive: 9 } })
  ).text();
  const signedGet = await fetch((await adapter.signDownloadUrl!({ key, expiresInSeconds: 120 })).url);
  const signedGetBody = await signedGet.text();

  const multipartKey = `${key}.multipart`;
  const { uploadId } = await adapter.createMultipartUpload!({ key: multipartKey, contentType: 'text/plain' });
  const part = await adapter.signMultipartUploadPartUrl!({ key: multipartKey, uploadId, partNumber: 1, expiresInSeconds: 120 });
  const partResponse = await fetch(part.url, { method: 'PUT', body });
  await partResponse.arrayBuffer();
  await adapter.completeMultipartUpload!({
    key: multipartKey,
    uploadId,
    parts: [{ partNumber: 1, etag: partResponse.headers.get('etag') ?? '' }],
  });
  const multipartStat = await adapter.statObject({ key: multipartKey });

  await adapter.deleteObject({ key });
  await adapter.deleteObject({ key: multipartKey });
  const afterDelete = await adapter.statObject({ key }).then(
    () => 'present',
    (error: { code?: string }) => error.code ?? 'unknown'
  );

  return Response.json({
    conformance: conformance.ok,
    putStatus: put.status,
    size: stat.size,
    contentType: stat.contentType,
    downloaded,
    signedGetStatus: signedGet.status,
    signedGetBody,
    multipartSize: multipartStat.size,
    afterDelete,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (request.method === 'GET' && pathname === '/vector') return await vector();
      if (request.method === 'POST' && pathname === '/roundtrip') return await roundtrip(env);
      return new Response('not found', { status: 404 });
    } catch (error) {
      return new Response(error instanceof Error ? `${error.name}: ${error.message}` : String(error), { status: 500 });
    }
  },
};
