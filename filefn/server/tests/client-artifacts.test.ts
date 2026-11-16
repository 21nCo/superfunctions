import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createRoutedStorageAdapter, type StorageAdapter } from '@superfunctions/storage';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The real R2 adapter, so the test covers the owner-decided storage.
import { createR2StorageAdapter } from '../../../packages/storage-r2/src/index.js';
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
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every stored object path under the storage root. */
async function storedObjects(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
}

type Gate = { op: 'upload' | 'delete'; match: (key: string) => boolean; reached: () => void; released: Promise<void> };

/**
 * Storage whose server-side uploads can be switched off, or whose next upload
 * or delete of a matching key can be held at a gate so a test can interleave
 * other writes.
 */
function controlledStorage(local: StorageAdapter) {
  let gate: Gate | null = null;
  const pass = async (op: Gate['op'], key: string) => {
    const held = gate;
    if (held?.op === op && held.match(key)) {
      gate = null;
      held.reached();
      await held.released;
    }
  };
  const control = {
    proxyUploads: true,
    /** Holds the next server-side upload (or delete) whose key matches until `release` is called. */
    hold(match: (key: string) => boolean, op: Gate['op'] = 'upload') {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      gate = { op, match, reached, released: new Promise<void>((resolve) => { release = resolve; }) };
      return { reached: reachedPromise, release };
    },
  };
  const storage = new Proxy(local, {
    get(target, property, receiver) {
      if (property === 'capabilities') {
        return control.proxyUploads ? target.capabilities : { ...target.capabilities, proxyStreamingUpload: false };
      }
      if (property === 'openUploadStream') {
        if (!control.proxyUploads) return undefined;
        return async (input: { key: string; target?: string; contentType?: string }) => {
          await pass('upload', input.key);
          return target.openUploadStream!(input);
        };
      }
      if (property === 'deleteObject') {
        return async (input: { key: string; target?: string }) => {
          await pass('delete', input.key);
          return target.deleteObject(input);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { storage, control };
}

/**
 * An in-memory bucket behind the S3 API the R2 adapter speaks, reached
 * through `fetch`. It accepts only presigned or SigV4-signed requests.
 */
function fakeR2Bucket() {
  const objects = new Map<string, { data: Uint8Array; contentType?: string }>();
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers);
    if (url.host !== 'r2.test' || !url.pathname.startsWith('/files/')) return new Response('unknown host', { status: 400 });
    if (!url.searchParams.has('X-Amz-Signature') && !headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256')) {
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    }
    const key = decodeURIComponent(url.pathname.slice('/files/'.length));
    const method = init.method ?? 'GET';
    const object = objects.get(key);
    if (method === 'PUT') {
      const data = new Uint8Array(await new Response(init.body).arrayBuffer());
      objects.set(key, { data, contentType: headers.get('content-type') ?? undefined });
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (!object) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    const objectHeaders = { 'content-length': String(object.data.length), 'content-type': object.contentType ?? '' };
    return new Response(method === 'HEAD' ? null : (object.data as Uint8Array<ArrayBuffer>), { status: 200, headers: objectHeaders });
  };
  return { objects, fetch };
}

type AuthorizerFactory = (database: ReturnType<typeof memoryAdapter>) => Parameters<typeof createFileFn>[0]['authorizer'];

async function createApp(options: { processors?: Processor[]; artifactsOnR2?: boolean; authorizer?: AuthorizerFactory } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'filefn-client-artifacts-'));
  roots.push(root);
  const database = memoryAdapter();
  const local = createLocalStorageAdapter({ rootDir: root });
  const bucket = fakeR2Bucket();
  let backing: StorageAdapter = local;
  if (options.artifactsOnR2) {
    // Files stay on local storage; the policy sends artifacts to R2, whose
    // adapter has no server-side upload stream and signs URLs instead.
    const r2 = createR2StorageAdapter({
      accountId: 'account', endpoint: 'https://r2.test', bucket: 'files', accessKeyId: 'AKID', secretAccessKey: 'secret',
      fetch: bucket.fetch, retry: { maxAttempts: 1 },
    });
    expect(r2.openUploadStream).toBeUndefined();
    backing = createRoutedStorageAdapter({ adapters: { durable: local, r2 }, defaultTarget: 'durable' });
    // The server's own PUT to a signed URL goes through the global fetch.
    vi.stubGlobal('fetch', bucket.fetch);
  }
  const { storage, control: storageControl } = controlledStorage(backing);
  const jobs: any[] = [];
  const fileFn: FileFn = createFileFn({
    database,
    storage,
    authorizer: options.authorizer?.(database) ?? createDefaultAuthorizer({ db: database }),
    policies: [{
      name: 'photo', contentTypes: ['image/png'], maxSizeBytes: 64, visibility: 'private',
      ...(options.artifactsOnR2 ? { artifactStorageTarget: 'r2' } : {}),
    }],
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

  return { fileFn, root, fileId, versionId, clientFor, fetchAs, jobs, drainJobs, put, artifacts, artifactBytes, storageControl, bucket };
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

  it('refuses with a typed error, storing nothing, when storage can neither stream nor sign an upload', async () => {
    const app = await createApp();
    const before = await storedObjects(app.root);
    // Local storage signs no URLs; without its upload stream it cannot take the body.
    app.storageControl.proxyUploads = false;

    const refused = await app.put('owner', 'thumbnail-small', bytes('client-small'), 'image/png');
    expect(refused.status).toBe(501);
    expect(refused.json.error.code).toBe('FILEFN_STORAGE_UPLOAD_UNSUPPORTED');
    // Authorization still comes first.
    expect((await app.put('reader', 'thumbnail-small', bytes('x'), 'image/png')).status).toBe(403);
    expect(await app.artifacts()).toEqual([]);
    expect(await storedObjects(app.root)).toEqual(before);
  });

  describe('on R2 artifact storage', () => {
    const r2Keys = (app: { bucket: { objects: Map<string, unknown> } }) => [...app.bucket.objects.keys()];

    it('stores an owner or writer upload through a signed PUT under the same row a retry replaces', async () => {
      const app = await createApp({ artifactsOnR2: true });
      const input = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small' as const };

      const first = await app.clientFor('owner').uploadArtifact({ ...input, data: new Blob([bytes('client-small')], { type: 'image/webp' }), durationMs: 7 });
      expect(first).toMatchObject({ kind: 'thumbnail-small', mimeType: 'image/webp', size: 12, source: 'client', processingDurationMs: 7 });
      expect(r2Keys(app)).toEqual([expect.stringContaining('.client-artifacts/thumbnail-small/')]);
      const stored = app.bucket.objects.get(r2Keys(app)[0])!;
      expect(new TextDecoder().decode(stored.data)).toBe('client-small');
      expect(stored.contentType).toBe('image/webp');

      // A writer's retry keeps the artifact ID and leaves only its own object.
      const second = await app.clientFor('writer').uploadArtifact({ ...input, data: bytes('client-small-2'), mimeType: 'image/png' });
      expect(second).toMatchObject({ artifactId: first.artifactId, size: 14, source: 'client' });
      expect(r2Keys(app)).toHaveLength(1);
      expect(new TextDecoder().decode(app.bucket.objects.get(r2Keys(app)[0])!.data)).toBe('client-small-2');
      expect(await app.artifacts()).toHaveLength(1);
    });

    it('refuses an oversized, wrong-type or unauthorized upload and writes nothing to R2', async () => {
      const app = await createApp({ artifactsOnR2: true });
      const oversized = await app.put('owner', 'thumbnail-small', new Uint8Array(2 * 1024 * 1024 + 1), 'image/png');
      expect(oversized.status).toBe(413);
      expect(oversized.json.error.code).toBe('FILEFN_ARTIFACT_TOO_LARGE');
      expect((await app.put('owner', 'converted', new Uint8Array(65), 'image/png')).status).toBe(413);
      expect((await app.put('owner', 'thumbnail-small', bytes('x'), 'image/gif')).status).toBe(415);
      expect((await app.put('reader', 'thumbnail-small', bytes('x'), 'image/png')).status).toBe(403);
      expect(r2Keys(app)).toEqual([]);
      expect(await app.artifacts()).toEqual([]);
    });

    it('server processing writes its artifacts to R2 and keeps a client-supplied kind', async () => {
      const app = await createApp({ artifactsOnR2: true, processors: [thumbnailProcessor([])] });
      await app.clientFor('owner').uploadArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
      });
      expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed', artifactsCreated: 1 })]);
      const byKind = new Map((await app.artifacts()).map((a) => [a.kind, a]));
      expect((byKind.get('thumbnail-small')!.metadata!.processing as any).source).toBe('client');
      const medium = byKind.get('thumbnail-medium')!;
      expect(new TextDecoder().decode(app.bucket.objects.get(medium.storageKey)!.data)).toBe('server-medium');
      expect(r2Keys(app)).toHaveLength(2);
    });
  });

  it('keeps a client artifact that lands while an unforced run stores the same kind over a server row', async () => {
    const app = await createApp({ processors: [thumbnailProcessor([])] });
    const [job] = app.jobs;
    expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed', artifactsCreated: 2 })]);
    const serverSmall = (await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!;

    // A redelivery with another key runs the processor again; its row read
    // (a server row) goes stale while its object upload is held.
    const held = app.storageControl.hold((key) => key.endsWith('-thumb-small.jpg'));
    const rerun = createProcessingJobHandler(app.fileFn).handle({ ...job, idempotencyKey: `${job.idempotencyKey}:again` });
    await held.reached;
    const client = app.clientFor('owner');
    const clientSmall = await client.uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
    });
    held.release();
    expect(await rerun).toMatchObject({ status: 'completed' });

    const small = (await client.listArtifacts(app.fileId)).find((a) => a.kind === 'thumbnail-small');
    expect(small).toEqual(clientSmall);
    expect(small).toMatchObject({ artifactId: serverSmall.artifactId, source: 'client' });
    const url = await client.downloadArtifact(app.fileId, clientSmall.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url))).toBe('client-small');
    // The run's own object was discarded and the replaced server object is gone.
    const objects = await storedObjects(app.root);
    expect(objects.some((path) => path.endsWith('-thumb-small.jpg'))).toBe(false);
    expect(objects.filter((path) => path.includes('.client-artifacts/'))).toHaveLength(1);
  });

  it('a forced run that a second client upload overtakes replaces the newer row and discards its object', async () => {
    const app = await createApp({ processors: [thumbnailProcessor([])] });
    const client = app.clientFor('owner');
    const input = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small' as const, mimeType: 'image/png' };
    await client.uploadArtifact({ ...input, data: bytes('client-a') });
    await app.drainJobs();

    await app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'owner' }, app.versionId, { force: true });
    // A forced write goes to a key derived from the row it replaces.
    const held = app.storageControl.hold((key) => key.includes('-thumb-small.jpg.'));
    const forced = app.drainJobs();
    await held.reached;
    // A second client upload replaces the row the forced run read.
    await client.uploadArtifact({ ...input, data: bytes('client-b') });
    held.release();
    expect(await forced).toEqual([expect.objectContaining({ status: 'completed' })]);

    const small = (await client.listArtifacts(app.fileId)).find((a) => a.kind === 'thumbnail-small')!;
    expect(small.source).toBe('server');
    const url = await client.downloadArtifact(app.fileId, small.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url))).toBe('server-small');
    // Neither client object is left behind, nor the object derived from the row it first read.
    const objects = await storedObjects(app.root);
    expect(objects.some((path) => path.includes('.client-artifacts/'))).toBe(false);
    const row = (await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!;
    expect(objects.filter((path) => path.includes('-thumb-small.jpg'))).toEqual([expect.stringContaining(row.storageKey)]);
  });

  it('honors the configured authorizer alone for attaching and forcing', async () => {
    // A delegate the custom authorizer lets write, with no grant and no
    // visibility on the private file; an outsider it refuses.
    const app = await createApp({
      processors: [thumbnailProcessor([])],
      authorizer: () => ({
        canRead: async (file, ctx) => ctx.principalId === file.ownerId || ctx.principalId === 'delegate',
        canWrite: async (file, ctx) => ctx.principalId === file.ownerId || ctx.principalId === 'delegate',
        canDelete: async (file, ctx) => ctx.principalId === file.ownerId,
      }),
    });
    const input = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small' as const, data: bytes('d'), mimeType: 'image/png' };
    await expect(app.clientFor('delegate').uploadArtifact(input)).resolves.toMatchObject({ source: 'client' });
    await expect(app.clientFor('outsider').uploadArtifact(input)).rejects.toMatchObject({ status: 403 });

    const force = (user: string) => app.fetchAs(user)(`${BASE}/${app.fileId}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versionId: app.versionId, force: true }),
    });
    expect((await force('delegate')).status).toBe(200);
    expect((await force('outsider')).status).toBe(403);
    await expect(app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'delegate' }, app.versionId, { force: true }))
      .resolves.toMatchObject({ enqueued: true });
    await expect(app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'outsider' }, app.versionId, { force: true }))
      .rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    // A missing file is still not found.
    const missing = await app.fetchAs('delegate')(`${BASE}/file_missing/versions/${app.versionId}/artifacts/thumbnail-small`, {
      method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes('x'),
    });
    expect(missing.status).toBe(404);
  });

  /** Forces a run and drains it while `paused` holds a delete of a replaced server object. */
  async function forceDuring(app: Awaited<ReturnType<typeof createApp>>, paused: { reached: Promise<void>; release: () => void }) {
    await paused.reached;
    await app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'owner' }, app.versionId, { force: true });
    expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed' })]);
    paused.release();
  }

  async function expectServerSmallReadable(app: Awaited<ReturnType<typeof createApp>>) {
    const client = app.clientFor('owner');
    const small = (await client.listArtifacts(app.fileId)).find((a) => a.kind === 'thumbnail-small')!;
    expect(small.source).toBe('server');
    const url = await client.downloadArtifact(app.fileId, small.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url))).toBe('server-small');
  }

  it('keeps the object of a forced run that commits while an upload deletes the server object it replaced', async () => {
    const app = await createApp({ processors: [thumbnailProcessor([])] });
    await app.drainJobs();
    const serverKey = (await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!.storageKey;

    // The upload has replaced the server row and scanned its object as unreferenced.
    const paused = app.storageControl.hold((key) => key === serverKey, 'delete');
    const uploading = app.clientFor('owner').uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
    });
    await forceDuring(app, paused);
    await uploading;

    await expectServerSmallReadable(app);
  });

  it('keeps the object of a forced run that commits while an unforced run discards the object it lost', async () => {
    const app = await createApp({ processors: [thumbnailProcessor([])] });
    const [job] = app.jobs;
    await app.drainJobs();
    const serverKey = (await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!.storageKey;

    // A redelivery rewrites the server object in place; a client upload lands meanwhile.
    const heldUpload = app.storageControl.hold((key) => key === serverKey);
    const rerun = createProcessingJobHandler(app.fileFn).handle({ ...job, idempotencyKey: `${job.idempotencyKey}:again` });
    await heldUpload.reached;
    await app.clientFor('owner').uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
    });
    // The redelivery keeps the client row and is about to delete the object it stored.
    const paused = app.storageControl.hold((key) => key === serverKey, 'delete');
    heldUpload.release();
    await forceDuring(app, paused);
    expect(await rerun).toMatchObject({ status: 'completed' });

    await expectServerSmallReadable(app);
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
