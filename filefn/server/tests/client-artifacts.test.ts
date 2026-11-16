import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDefaultAuthorizer,
  createFileFn,
  createProcessingJobHandler,
  type FileFn,
  type Processor,
} from '../src/index.js';
// The real client and viewer sources, so the test covers what an app runs.
import { createFileFnClient, FileFnHttpError } from '../../client/src/index.js';
import { resolveViewerSource } from '../../viewer/src/index.js';

const BASE = 'https://filefn.test';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const bytes = (text: string) => new TextEncoder().encode(text);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every stored object path under the storage root. */
async function storedObjects(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
}

async function createApp(options: { processors?: Processor[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'filefn-client-artifacts-'));
  roots.push(root);
  const database = memoryAdapter();
  const jobs: unknown[] = [];
  const fileFn: FileFn = createFileFn({
    database,
    storage: createLocalStorageAdapter({ rootDir: root }),
    authorizer: createDefaultAuthorizer({ db: database }),
    policies: [{ name: 'photo', contentTypes: ['image/png'], maxSizeBytes: 64, visibility: 'private' }],
    processing: {
      enabled: true,
      processors: options.processors ?? [],
      flowFn: { getQueue: () => ({ name: 'filefn.processing', add: async (job) => { jobs.push(job); return { jobId: `job_${jobs.length}` }; } }) },
    },
    auth: {
      required: true,
      resolveSession: async (request) => {
        const user = request.headers.get('x-test-user');
        return user ? { principalId: user } : null;
      },
    },
  });

  const fetchAs = (user?: string): typeof fetch => async (input, init) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), BASE), init);
    if (user) request.headers.set('x-test-user', user);
    return (await fileFn.router.handle(request)) ?? new Response('no route', { status: 404 });
  };
  const clientFor = (user?: string) =>
    createFileFnClient({ baseUrl: BASE, fetch: fetchAs(user), retryOptions: { maxRetries: 0 } });

  const owner = { principalId: 'owner' };
  const session = await fileFn.createUploadSession({ policy: 'photo', fileName: 'photo.png', size: PNG.length, mimeType: 'image/png' }, owner);
  const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, Buffer.from(PNG), PNG.length, owner);
  await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
  const { fileId, versionId } = await fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
  await fileFn.services.grants.createGrant({ fileId, userId: 'writer', canRead: true, canWrite: true }, owner);
  await fileFn.services.grants.createGrant({ fileId, userId: 'reader', canRead: true }, owner);

  /** Runs every queued processing job, as the queue consumer would. */
  async function drainJobs() {
    const handler = createProcessingJobHandler(fileFn);
    const outcomes = [];
    for (const job of jobs.splice(0)) outcomes.push(await handler.handle(job));
    return outcomes;
  }

  async function put(user: string | undefined, kind: string, body: BodyInit, contentType: string, headers: Record<string, string> = {}) {
    const response = await fetchAs(user)(`${BASE}/${fileId}/versions/${versionId}/artifacts/${kind}`, {
      method: 'PUT',
      headers: { 'content-type': contentType, ...headers },
      body,
      duplex: 'half',
    } as RequestInit);
    return { status: response.status, json: (await response.json()) as any };
  }

  async function artifacts() {
    return fileFn.services.processing.listArtifactsForFile(fileId, owner);
  }

  async function artifactBytes(user: string, url: string) {
    const response = await fetchAs(user)(new URL(url, BASE).toString());
    return new Uint8Array(await response.arrayBuffer());
  }

  return { fileFn, root, fileId, versionId, clientFor, fetchAs, drainJobs, put, artifacts, artifactBytes };
}

function thumbnailProcessor(calls: string[], options: { declareKinds?: boolean } = {}): Processor {
  return {
    name: 'thumbnail',
    supportedMimeTypes: ['image/png'],
    ...(options.declareKinds ? { artifactKinds: ['thumbnail-small', 'thumbnail-medium'] } : {}),
    async process(input) {
      calls.push(input.versionId);
      return {
        success: true,
        artifacts: ['small', 'medium'].map((size) => ({
          kind: `thumbnail-${size}`,
          data: bytes(`server-${size}`),
          mimeType: 'image/jpeg',
          storageKey: `${input.storageKey}-thumb-${size}.jpg`,
        })),
      };
    },
  };
}

describe('client-supplied processing artifacts', () => {
  it('lets the owner upload a thumbnail through the client and records its source and duration', async () => {
    const app = await createApp();
    const artifact = await app.clientFor('owner').uploadArtifact({
      fileId: app.fileId,
      versionId: app.versionId,
      kind: 'thumbnail-small',
      data: new Blob([bytes('client-small')], { type: 'image/webp' }),
      durationMs: 42,
    });

    expect(artifact).toMatchObject({
      fileId: app.fileId,
      versionId: app.versionId,
      kind: 'thumbnail-small',
      mimeType: 'image/webp',
      size: 12,
      source: 'client',
      processingDurationMs: 42,
    });
    expect(await app.clientFor('owner').listArtifacts(app.fileId)).toEqual([artifact]);
  });

  it('lets a writer attach an artifact', async () => {
    const app = await createApp();
    const artifact = await app.clientFor('writer').uploadArtifact({
      fileId: app.fileId,
      versionId: app.versionId,
      kind: 'converted',
      data: bytes('converted-png'),
      mimeType: 'image/png',
    });
    expect(artifact).toMatchObject({ kind: 'converted', source: 'client', mimeType: 'image/png' });
    expect(artifact.processingDurationMs).toBeUndefined();
  });

  it.each([
    ['a reader who cannot write', 'reader', 403, 'FILEFN_FORBIDDEN'],
    ['a stranger', 'stranger', 403, 'FILEFN_FORBIDDEN'],
    ['an anonymous caller', undefined, 401, 'FILEFN_AUTH_REQUIRED'],
  ])('refuses %s and stores nothing', async (_label, user, status, code) => {
    const app = await createApp();
    const before = await storedObjects(app.root);
    const response = await app.put(user, 'thumbnail-small', bytes('sneaky'), 'image/png');
    expect(response.status).toBe(status);
    expect(response.json.error.code).toBe(code);
    expect(await app.artifacts()).toEqual([]);
    expect(await storedObjects(app.root)).toEqual(before);
  });

  it('refuses a kind or content type outside the closed set', async () => {
    const app = await createApp();
    const unknownKind = await app.put('owner', 'thumbnail-huge', bytes('x'), 'image/png');
    expect(unknownKind.status).toBe(400);
    expect(unknownKind.json.error.code).toBe('FILEFN_ARTIFACT_KIND_NOT_ALLOWED');

    const gifThumbnail = await app.put('owner', 'thumbnail-small', bytes('x'), 'image/gif');
    expect(gifThumbnail.status).toBe(415);
    expect(gifThumbnail.json.error.code).toBe('FILEFN_ARTIFACT_TYPE_NOT_ALLOWED');

    const jpegConverted = await app.put('owner', 'converted', bytes('x'), 'image/jpeg');
    expect(jpegConverted.status).toBe(415);

    const empty = await app.put('owner', 'thumbnail-small', new Uint8Array(), 'image/png');
    expect(empty.status).toBe(400);
    expect(await app.artifacts()).toEqual([]);
  });

  it('refuses an oversized artifact, declared or streamed, and leaves no object behind', async () => {
    const app = await createApp();
    const before = await storedObjects(app.root);

    const declared = await app.put('owner', 'thumbnail-small', bytes('x'), 'image/png', {
      'content-length': String(2 * 1024 * 1024 + 1),
    });
    expect(declared.status).toBe(413);
    expect(declared.json.error.code).toBe('FILEFN_ARTIFACT_TOO_LARGE');

    // No Content-Length: the limit is enforced while the body streams in.
    const chunk = new Uint8Array(512 * 1024);
    let sent = 0;
    const streamed = await app.put('owner', 'thumbnail-small', new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 5) return controller.close();
        sent += 1;
        controller.enqueue(chunk);
      },
    }), 'image/png');
    expect(streamed.status).toBe(413);

    // The converted cap is the policy's file cap (64 bytes here).
    const converted = await app.put('owner', 'converted', new Uint8Array(65), 'image/png');
    expect(converted.status).toBe(413);

    expect(await app.artifacts()).toEqual([]);
    expect(await storedObjects(app.root)).toEqual(before);
  });

  it('treats a retried upload as the same artifact and keeps only the latest object', async () => {
    const app = await createApp();
    const before = await storedObjects(app.root);
    const client = app.clientFor('owner');
    const input = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small' as const, mimeType: 'image/png' };

    // An attempt that failed part way records nothing.
    const failed = await app.put('owner', 'thumbnail-small', new Uint8Array(2 * 1024 * 1024 + 1), 'image/png');
    expect(failed.status).toBe(413);

    const first = await client.uploadArtifact({ ...input, data: bytes('first') });
    const second = await client.uploadArtifact({ ...input, data: bytes('second!') });

    expect(second.artifactId).toBe(first.artifactId);
    expect(second.createdAt).toBe(first.createdAt);
    const rows = await app.artifacts();
    expect(rows).toHaveLength(1);
    expect(rows[0].size).toBe(7);
    const url = await client.downloadArtifact(app.fileId, first.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url))).toBe('second!');
    // Only the second attempt's object remains next to the original.
    expect((await storedObjects(app.root)).filter((path) => !before.includes(path))).toHaveLength(1);
  });

  it('server processing skips a kind the client supplied and replaces it when forced', async () => {
    const calls: string[] = [];
    const app = await createApp({ processors: [thumbnailProcessor(calls)] });
    const client = app.clientFor('owner');
    // The device uploads its thumbnail while the upload's own job is still queued.
    const clientSmall = await client.uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
    });
    const afterClient = await storedObjects(app.root);

    // The unforced run keeps the client's thumbnail-small and adds only thumbnail-medium.
    expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed', artifactsCreated: 1 })]);
    expect(calls).toEqual([app.versionId]);
    let byKind = new Map((await client.listArtifacts(app.fileId)).map((a) => [a.kind, a]));
    expect(byKind.get('thumbnail-small')).toEqual(clientSmall);
    expect(byKind.get('thumbnail-medium')?.source).toBe('server');
    const url0 = await client.downloadArtifact(app.fileId, clientSmall.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url0))).toBe('client-small');
    // Only thumbnail-medium's object was added.
    expect((await storedObjects(app.root)).filter((path) => !afterClient.includes(path))).toEqual([
      expect.stringContaining('thumb-medium'),
    ]);

    // A reader may not force a run that would replace the writer's artifact.
    const readerForce = await app.fetchAs('reader')(`${BASE}/${app.fileId}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: app.versionId, force: true }),
    });
    expect(readerForce.status).toBe(403);

    const forced = await app.fetchAs('owner')(`${BASE}/${app.fileId}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: app.versionId, force: true }),
    });
    expect(forced.status).toBe(200);
    const runsBefore = calls.length;
    expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(calls.length).toBe(runsBefore + 1);

    byKind = new Map((await client.listArtifacts(app.fileId)).map((a) => [a.kind, a]));
    expect(byKind.get('thumbnail-small')).toMatchObject({ artifactId: clientSmall.artifactId, source: 'server', mimeType: 'image/jpeg' });
    const url = await client.downloadArtifact(app.fileId, clientSmall.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url))).toBe('server-small');
    // The client's object is gone with its record.
    expect((await storedObjects(app.root)).some((path) => path.includes('.client-artifacts/'))).toBe(false);
  });

  it('does not run a processor whose declared kinds the client supplied, unless forced', async () => {
    const calls: string[] = [];
    const app = await createApp({ processors: [thumbnailProcessor(calls, { declareKinds: true })] });
    const client = app.clientFor('owner');
    // The upload's own job is still queued; the client supplies both kinds first.
    for (const kind of ['thumbnail-small', 'thumbnail-medium'] as const) {
      await client.uploadArtifact({ fileId: app.fileId, versionId: app.versionId, kind, data: bytes(kind), mimeType: 'image/png' });
    }
    expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed', artifactsCreated: 0 })]);
    expect(calls).toEqual([]);
    expect((await app.artifacts()).every((a) => a.metadata?.processing && (a.metadata.processing as any).source === 'client')).toBe(true);

    await app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'writer' }, app.versionId, { force: true });
    await app.drainJobs();
    expect(calls).toEqual([app.versionId]);
    await expect(
      app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'reader' }, app.versionId, { force: true }),
    ).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
  });

  it('the viewer resolves a client-supplied thumbnail like a server one', async () => {
    const app = await createApp();
    const client = app.clientFor('owner');
    const uploaded = await client.uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-thumb'), mimeType: 'image/jpeg',
    });

    const descriptor = await client.resolveRenderable({ fileId: app.fileId, intent: 'thumbnail' });
    expect(descriptor.source).toMatchObject({ mode: 'artifact', artifactId: uploaded.artifactId, artifactKind: 'thumbnail-small' });

    const source = await resolveViewerSource({ client, fileId: app.fileId, intent: 'thumbnail' });
    expect(source).toMatchObject({ state: 'ready', mimeType: 'image/jpeg', size: 12 });
    expect(new TextDecoder().decode(await app.artifactBytes('owner', source.url!))).toBe('client-thumb');
  });

  it('refuses a version of another file and reports client errors as FileFnHttpError', async () => {
    const app = await createApp();
    const error = await app.clientFor('owner').uploadArtifact({
      fileId: app.fileId, versionId: 'ver_missing', kind: 'thumbnail-small', data: bytes('x'), mimeType: 'image/png',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(FileFnHttpError);
    expect(error).toMatchObject({ status: 404, code: 'FILEFN_NOT_FOUND' });
  });
});
