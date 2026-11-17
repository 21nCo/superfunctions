/**
 * Runs the container entry against an S3-compatible server (MinIO in CI) and
 * the in-memory database: a FileFn producer enqueues processing jobs, each
 * job is POSTed to the container's `/jobs`, and the artifacts must land in the
 * bucket and the database. Set STORAGE_R2_S3_ENDPOINT, STORAGE_R2_S3_BUCKET
 * (an existing bucket), STORAGE_R2_S3_ACCESS_KEY_ID and
 * STORAGE_R2_S3_SECRET_ACCESS_KEY to enable it; with
 * FILEFN_CONTAINER_IT_REQUIRED=1 a missing endpoint fails instead of
 * skipping. FILEFN_CONTAINER_IT_OCR=1 also runs OCR through the native
 * `tesseract` command (the CI image has it).
 */
import { fileURLToPath } from 'node:url';
import { createOCRProcessor, createPdfPreviewProcessor, createThumbnailProcessor } from '@filefn/processing';
import { createFileFn } from '@filefn/server';
import type { StorageAdapter } from '@superfunctions/storage';
import { createR2StorageAdapter } from '@superfunctions/storage-r2';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startContainer, type RunningContainer } from '../src/main.js';
import { sharedDatabase } from './fixtures/shared-database.js';

const endpoint = process.env.STORAGE_R2_S3_ENDPOINT;
const withOcr = process.env.FILEFN_CONTAINER_IT_OCR === '1';
if (process.env.FILEFN_CONTAINER_IT_REQUIRED === '1' && !endpoint) {
  throw new Error('FILEFN_CONTAINER_IT_REQUIRED=1 but STORAGE_R2_S3_ENDPOINT is not set');
}

const storageEnv = {
  FILEFN_R2_ENDPOINT: endpoint,
  FILEFN_R2_BUCKET: process.env.STORAGE_R2_S3_BUCKET,
  FILEFN_R2_ACCESS_KEY_ID: process.env.STORAGE_R2_S3_ACCESS_KEY_ID,
  FILEFN_R2_SECRET_ACCESS_KEY: process.env.STORAGE_R2_S3_SECRET_ACCESS_KEY,
};
const prefix = `filefn-container-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const owner = { principalId: 'owner', tenantId: 'tenant', requestId: 'req_it' };
const TOKEN = 'it-token';

/** A one-page PDF with a filled rectangle, small enough to write by hand. */
function onePagePdf(): Uint8Array {
  const content = '0.2 0.4 0.8 rg 20 20 160 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 140] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function put(storage: StorageAdapter, key: string, data: Uint8Array, contentType: string): Promise<void> {
  const upload = await storage.signUploadUrl!({ key, expiresInSeconds: 300, constraints: { contentType, contentLength: data.length } });
  const response = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(data) });
  await response.arrayBuffer();
  expect(response.status).toBe(200);
}

async function readObject(storage: StorageAdapter, key: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await storage.openDownloadStream!({ key })).arrayBuffer());
}

describe.skipIf(!endpoint)('processing container against MinIO and an in-memory database', () => {
  let container: RunningContainer;
  let storage: StorageAdapter;
  const jobs: Record<string, unknown>[] = [];
  const written: string[] = [];

  /** The producer side: a FileFn on the same database and bucket that enqueues jobs instead of running them. */
  const producer = () => createFileFn({
    database: sharedDatabase,
    storage,
    policies: [{ name: 'media', contentTypes: ['image/png', 'application/pdf'], visibility: 'shared' }],
    processing: {
      enabled: true,
      processors: [
        createThumbnailProcessor(),
        createPdfPreviewProcessor(),
        ...(withOcr ? [createOCRProcessor()] : []),
      ],
      flowFn: {
        getQueue: () => ({
          name: 'filefn.processing',
          async add(job: unknown) {
            jobs.push(JSON.parse(JSON.stringify(job)));
            return { jobId: `job_${jobs.length}` };
          },
        }),
      },
    },
  });

  async function postJob(job: unknown, attempts = 1) {
    const response = await fetch(`http://127.0.0.1:${container.port}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ job, attempts }),
    });
    return { status: response.status, body: (await response.json()) as { outcome: { status: string; artifactsCreated?: number } } };
  }

  beforeAll(async () => {
    storage = createR2StorageAdapter({
      accountId: 'endpoint',
      endpoint: endpoint!,
      bucket: storageEnv.FILEFN_R2_BUCKET!,
      accessKeyId: storageEnv.FILEFN_R2_ACCESS_KEY_ID!,
      secretAccessKey: storageEnv.FILEFN_R2_SECRET_ACCESS_KEY!,
    });
    container = await startContainer({
      ...storageEnv,
      PORT: '0',
      FILEFN_DATABASE: fileURLToPath(new URL('./fixtures/shared-database.ts', import.meta.url)),
      FILEFN_CONTAINER_TOKEN: TOKEN,
      FILEFN_PROCESSORS: withOcr ? 'thumbnail,pdf-preview,ocr' : 'thumbnail,pdf-preview',
    });
  });

  afterAll(async () => {
    await container?.close();
    await Promise.all(written.map((key) => storage.deleteObject({ key }).catch(() => {})));
  });

  it('produces a thumbnail and a first-page PDF preview in the bucket and the database', async () => {
    const fileFn = producer();
    const png = new Uint8Array(await sharp({ create: { width: 640, height: 480, channels: 3, background: '#3366cc' } }).png().toBuffer());
    const pdf = onePagePdf();
    const sources = [
      { key: `${prefix}/photo.png`, data: png, mimeType: 'image/png', fileName: 'photo.png' },
      { key: `${prefix}/report.pdf`, data: pdf, mimeType: 'application/pdf', fileName: 'report.pdf' },
    ];
    const fileIds: string[] = [];
    for (const source of sources) {
      await put(storage, source.key, source.data, source.mimeType);
      written.push(source.key);
      const { file } = await fileFn.services.files.importObject({
        storageKey: source.key,
        principalId: owner.principalId,
        tenantId: owner.tenantId,
        fileName: source.fileName,
        mimeType: source.mimeType,
        size: source.data.length,
        policy: 'media',
      });
      fileIds.push(file.fileId);
      await expect(fileFn.services.processing.triggerProcessingForFile(file.fileId, owner)).resolves.toMatchObject({ enqueued: true });
    }
    expect(jobs).toHaveLength(2);

    for (const job of jobs) {
      const { status, body } = await postJob(job);
      expect(status).toBe(200);
      expect(body.outcome).toMatchObject({ status: 'completed' });
      expect(body.outcome.artifactsCreated).toBeGreaterThan(0);
    }

    const [imageArtifacts, pdfArtifacts] = await Promise.all(
      fileIds.map((fileId) => fileFn.services.processing.listArtifactsForFile(fileId, owner)),
    );
    for (const artifact of [...imageArtifacts, ...pdfArtifacts]) written.push(artifact.storageKey);

    const thumbnail = imageArtifacts.find((artifact) => artifact.kind === 'thumbnail-small');
    expect(thumbnail).toBeDefined();
    const thumbnailImage = await sharp(await readObject(storage, thumbnail!.storageKey)).metadata();
    expect(thumbnailImage).toMatchObject({ width: 150, height: 113 });

    const preview = pdfArtifacts.find((artifact) => artifact.kind === 'pdf-preview-page-1-small');
    expect(preview).toBeDefined();
    expect(preview!.metadata).toMatchObject({ pageNumber: 1 });
    const previewImage = await sharp(await readObject(storage, preview!.storageKey)).metadata();
    expect(previewImage.format).toBe('png');

    if (withOcr) {
      expect(imageArtifacts.map((artifact) => artifact.kind)).toContain('ocr-text');
    }

    // A redelivery of a finished job runs nothing again.
    expect((await postJob(jobs[0], 2)).body.outcome).toEqual({ status: 'duplicate' });
  });
});
