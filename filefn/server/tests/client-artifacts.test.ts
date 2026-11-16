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

type Gate = { op: 'upload' | 'delete'; match: (key: string) => boolean; run: () => Promise<void> };

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
      await held.run();
    }
  };
  const control = {
    proxyUploads: true,
    /** Holds the next server-side upload (or delete) whose key matches until `release` is called. */
    hold(match: (key: string) => boolean, op: Gate['op'] = 'upload') {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      gate = { op, match, run: async () => { reached(); await released; } };
      return { reached: reachedPromise, release };
    },
    /**
     * Runs `during` when the next upload (or delete) of a matching key starts,
     * then lets it go on; `fired` tells whether it ever started.
     */
    intercept(match: (key: string) => boolean, op: Gate['op'], during: () => Promise<void>) {
      const state = { fired: false };
      gate = { op, match, run: async () => { state.fired = true; await during(); } };
      return state;
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
  /**
   * Fails a matching request: `lost` stores a PUT and then loses its
   * response; `down` fails it before anything happens.
   */
  const control: { fault: ((method: string, key: string) => 'lost' | 'down' | undefined) | null } = { fault: null };
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
    const fault = control.fault?.(method, key);
    if (fault === 'down') throw new TypeError('fetch failed: storage unavailable');
    if (method === 'PUT') {
      const data = new Uint8Array(await new Response(init.body).arrayBuffer());
      objects.set(key, { data, contentType: headers.get('content-type') ?? undefined });
      if (fault === 'lost') throw new TypeError('fetch failed: response lost');
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
  return { objects, fetch, control };
}

type AuthorizerFactory = (database: ReturnType<typeof memoryAdapter>) => Parameters<typeof createFileFn>[0]['authorizer'];

/**
 * The memory adapter enforces only its own `id`; FileFn's schema makes
 * `artifactId` unique, which Postgres enforces, so a concurrent create of the
 * same artifact row fails here too.
 */
function withUniqueArtifactIds(database: ReturnType<typeof memoryAdapter>): ReturnType<typeof memoryAdapter> {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== 'create') return Reflect.get(target, property, receiver);
      return async (params: Parameters<typeof target.create>[0]) => {
        if (params.model === 'fileArtifacts') {
          const existing = await target.findOne({
            model: 'fileArtifacts',
            where: [{ field: 'artifactId', operator: 'eq', value: params.data.artifactId }],
            namespace: params.namespace,
          });
          if (existing) throw new Error('UNIQUE constraint failed: fileArtifacts.artifactId');
        }
        return target.create(params);
      };
    },
  });
}

type DatabaseFault = 'throw' | 'commit-then-throw';

/**
 * Lets a test fail the next create of an artifact row, before or after it
 * commits, or make every artifact row operation fail while `down` is set.
 * `zeroUpdateCounts` makes `updateMany` commit and report 0 rows, as the
 * Kysely adapter of `@superfunctions/db` 0.2.0 that FileFn pins does (it
 * reads the count off the result array); `beforeUpdate` runs once just
 * before the next artifact `updateMany`.
 */
function controlledDatabase(database: ReturnType<typeof memoryAdapter>) {
  const control: {
    down: boolean;
    zeroUpdateCounts: boolean;
    beforeUpdate: (() => Promise<void>) | null;
    onCreate: ((data: Record<string, unknown>) => DatabaseFault | undefined) | null;
  } = {
    down: false,
    zeroUpdateCounts: false,
    beforeUpdate: null,
    onCreate: null,
  };
  const proxy = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (params: { model: string; data?: Record<string, unknown> }) => {
        if (params.model === 'fileArtifacts') {
          if (control.down) throw new Error('database unavailable');
          const fault = property === 'create' ? control.onCreate?.(params.data!) : undefined;
          if (fault === 'throw') throw new Error('artifact row write failed');
          if (fault === 'commit-then-throw') {
            await value.call(target, params);
            throw new Error('connection reset after commit');
          }
          if (property === 'updateMany') {
            const before = control.beforeUpdate;
            control.beforeUpdate = null;
            await before?.();
            if (control.zeroUpdateCounts) {
              await value.call(target, params);
              return 0;
            }
          }
        }
        return value.call(target, params);
      };
    },
  });
  return { database: proxy, control };
}

async function createApp(options: { processors?: Processor[]; artifactsOnR2?: boolean; authorizer?: AuthorizerFactory } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'filefn-client-artifacts-'));
  roots.push(root);
  const { database, control: databaseControl } = controlledDatabase(withUniqueArtifactIds(memoryAdapter()));
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
    // An HTTP server sees the length of a sized body, as a Worker does.
    const body = init?.body;
    const size = body instanceof Blob ? body.size : body instanceof Uint8Array ? body.byteLength : undefined;
    if (size !== undefined && !request.headers.has('content-length')) request.headers.set('content-length', String(size));
    return (await fileFn.router.handle(request)) ?? new Response('no route', { status: 404 });
  };
  const clientFor = (user?: string) =>
    createFileFnClient({ baseUrl: BASE, fetch: fetchAs(user), retryOptions: { maxRetries: 0 } });

  const owner = { principalId: 'owner' };
  /** Uploads a photo as the owner; its processing job is queued. */
  async function uploadPhoto() {
    const session = await fileFn.createUploadSession({ policy: 'photo', fileName: 'photo.png', size: PNG.length, mimeType: 'image/png' }, owner);
    const part = await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, Buffer.from(PNG), PNG.length, owner);
    await fileFn.completeUploadPart({ uploadSessionId: session.uploadSessionId, partNumber: 1, etag: part.etag, size: part.size }, owner);
    return fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
  }
  const { fileId, versionId } = await uploadPhoto();
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

  /** Records of objects no artifact row names, displaced or an upload's own (see the processing service). */
  async function displacedRecords() {
    return database.findMany<{ storageKey: string; kind: string }>({
      model: 'fileArtifacts',
      where: [{ field: 'kind', operator: 'in', value: ['filefn.displaced-object', 'filefn.upload-intent'] }],
    });
  }

  return {
    fileFn, root, fileId, versionId, owner, uploadPhoto, clientFor, fetchAs, jobs, drainJobs, put, artifacts, artifactBytes,
    storageControl, bucket, database, databaseControl, displacedRecords,
  };
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

    const streamOf = (...parts: string[]) => new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(bytes(part));
        controller.close();
      },
    });

    it('streams a client upload into its signed PUT instead of buffering it', async () => {
      const app = await createApp({ artifactsOnR2: true });
      let putStarted!: () => void;
      const started = new Promise<void>((resolve) => { putStarted = resolve; });
      const putLengths: (string | null)[] = [];
      vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) => {
        if (init.method === 'PUT') {
          putLengths.push(new Headers(init.headers).get('content-length'));
          putStarted();
        }
        return app.bucket.fetch(input, init);
      });
      // The body's second half comes only once the PUT to R2 has begun, so an
      // upload that collected the body first would never finish.
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes('first-')); },
        async pull(controller) {
          await started;
          controller.enqueue(bytes('second'));
          controller.close();
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the upload waited for the whole body before its PUT')), 2_000);
      });
      const response = await Promise.race([
        app.put('owner', 'thumbnail-small', body, 'image/png', { 'content-length': '12' }),
        stalled,
      ]).finally(() => clearTimeout(timer));

      expect(response.status).toBe(200);
      expect(response.json.data.artifact).toMatchObject({ size: 12, source: 'client' });
      expect(putLengths).toEqual(['12']);
      expect(new TextDecoder().decode(app.bucket.objects.get(r2Keys(app)[0])!.data)).toBe('first-second');
    });

    it('refuses a streamed upload whose length is missing or not what it declared, writing nothing to R2', async () => {
      const app = await createApp({ artifactsOnR2: true });
      const missing = await app.put('owner', 'thumbnail-small', streamOf('abc'), 'image/png');
      expect(missing.status).toBe(400);
      expect(missing.json.error.code).toBe('FILEFN_INVALID_REQUEST');
      const longer = await app.put('owner', 'thumbnail-small', streamOf('ab', 'cd'), 'image/png', { 'content-length': '3' });
      expect(longer.status).toBe(400);
      expect(longer.json.error.message).toContain('longer');
      const shorter = await app.put('owner', 'thumbnail-small', streamOf('ab'), 'image/png', { 'content-length': '3' });
      expect(shorter.status).toBe(400);
      expect(shorter.json.error.message).toContain('shorter');
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
    // Only the recorded client object is left of the client's uploads.
    const objects = await storedObjects(app.root);
    expect(objects.filter((path) => path.includes('.client-artifacts/'))).toHaveLength(1);
  });

  it('a forced run that a second client upload overtakes replaces the newer row and discards its object', async () => {
    const app = await createApp({ processors: [thumbnailProcessor([])] });
    const client = app.clientFor('owner');
    const input = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small' as const, mimeType: 'image/png' };
    await client.uploadArtifact({ ...input, data: bytes('client-a') });
    await app.drainJobs();

    await app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'owner' }, app.versionId, { force: true });
    // The forced run's upload of its small thumbnail is held.
    const held = app.storageControl.hold((key) => key.endsWith('-thumb-small.jpg'));
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
    // Neither client object is left behind.
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

  /**
   * Forces a run and drains it the moment a delete of `key` starts, if one
   * ever does; the delete then goes on.
   */
  function forceOnDelete(app: Awaited<ReturnType<typeof createApp>>, key: string) {
    return app.storageControl.intercept((candidate) => candidate === key, 'delete', () => forceNow(app));
  }

  async function forceNow(app: Awaited<ReturnType<typeof createApp>>) {
    await app.fileFn.services.processing.triggerProcessingForFile(app.fileId, { principalId: 'owner' }, app.versionId, { force: true });
    expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed' })]);
  }

  async function expectServerSmallReadable(app: Awaited<ReturnType<typeof createApp>>, fileId = app.fileId) {
    const client = app.clientFor('owner');
    const small = (await client.listArtifacts(fileId)).find((a) => a.kind === 'thumbnail-small')!;
    expect(small.source).toBe('server');
    const url = await client.downloadArtifact(fileId, small.artifactId);
    expect(new TextDecoder().decode(await app.artifactBytes('owner', url))).toBe('server-small');
  }

  it('keeps the object of a forced run that commits while an upload replaces the server row', async () => {
    const app = await createApp({ processors: [thumbnailProcessor([])] });
    await app.drainJobs();
    const serverKey = (await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!.storageKey;

    // A forced run writing the processor's key again commits the moment the
    // upload deletes the server object it replaced, should it ever do so.
    const during = forceOnDelete(app, serverKey);
    await app.clientFor('owner').uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
    });
    expect(during.fired).toBe(false);
    await forceNow(app);

    await expectServerSmallReadable(app);
  });

  it('keeps the object of a forced run that commits while an unforced run loses its row to a client upload', async () => {
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
    // The redelivery keeps the client row; a forced run commits should it
    // delete the object it stored.
    const during = forceOnDelete(app, serverKey);
    heldUpload.release();
    expect(await rerun).toMatchObject({ status: 'completed' });
    expect(during.fired).toBe(false);
    await forceNow(app);

    await expectServerSmallReadable(app);
  });

  it("never deletes a server object another file's first run commits under the same key", async () => {
    // Deduplicated files share a version's storage key, and so the keys a
    // processor derives from it; here every file's thumbnail has one key.
    const sharedKey = 'shared/thumb-small.jpg';
    const shared: Processor = {
      name: 'shared-thumbnail',
      supportedMimeTypes: ['image/png'],
      async process() {
        return {
          success: true,
          artifacts: [{ kind: 'thumbnail-small', data: bytes('server-small'), mimeType: 'image/jpeg', storageKey: sharedKey }],
        };
      },
    };
    const app = await createApp({ processors: [shared] });
    await app.drainJobs();
    const other = await app.uploadPhoto();

    // A client upload replaces the first file's server row. The other file's
    // first run uploads the shared key and commits its row the moment the
    // upload deletes that key, after any reference scan it made.
    const during = app.storageControl.intercept((key) => key === sharedKey, 'delete', async () => {
      expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed' })]);
    });
    await app.clientFor('owner').uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
    });
    if (!during.fired) {
      expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'completed' })]);
    }

    await expectServerSmallReadable(app, other.fileId);
    expect(during.fired).toBe(false);

    // Deleting the first file keeps the key the other file's row still names,
    // and deleting that file then removes it.
    app.storageControl.intercept(() => false, 'delete', async () => undefined);
    await app.clientFor('owner').deleteFile(app.fileId);
    await expectServerSmallReadable(app, other.fileId);
    await app.clientFor('owner').deleteFile(other.fileId);
    expect((await storedObjects(app.root)).filter((path) => path.includes('thumb-small'))).toEqual([]);
  });

  describe('objects an artifact row stops naming', () => {
    /** Stored artifact objects of the photo's versions: server thumbnails and client uploads. */
    const artifactObjects = async (root: string) =>
      (await storedObjects(root)).filter((path) => path.includes('-thumb-') || path.includes('.client-artifacts/'));

    it('are deleted with the file once a client upload replaced the server thumbnail', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      await app.drainJobs();
      const client = app.clientFor('owner');
      await client.uploadArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
      });
      // The replaced server object stays until the file goes, and is not listed.
      expect((await artifactObjects(app.root)).filter((path) => path.endsWith('-thumb-small.jpg'))).toHaveLength(1);
      expect((await client.listArtifacts(app.fileId)).map((a) => a.kind).sort()).toEqual(['thumbnail-medium', 'thumbnail-small']);

      await client.deleteFile(app.fileId);
      expect(await artifactObjects(app.root)).toEqual([]);
    });

    it('are deleted with the file when deleting a replaced client object failed', async () => {
      const app = await createApp();
      const client = app.clientFor('owner');
      const input = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small' as const, mimeType: 'image/png' };
      await client.uploadArtifact({ ...input, data: bytes('client-a') });
      const failed = app.storageControl.intercept((key) => key.includes('.client-artifacts/'), 'delete', async () => {
        throw new Error('storage unavailable');
      });
      await client.uploadArtifact({ ...input, data: bytes('client-b') });
      expect(failed.fired).toBe(true);
      expect(await artifactObjects(app.root)).toHaveLength(2);

      await client.deleteFile(app.fileId);
      expect(await artifactObjects(app.root)).toEqual([]);
    });

    it('are deleted with the file when an unforced run stored its object and lost the row to a client upload', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      // The first run's small thumbnail upload is held; a client upload
      // creates the row it was about to create.
      const held = app.storageControl.hold((key) => key.endsWith('-thumb-small.jpg'));
      const run = app.drainJobs();
      await held.reached;
      const client = app.clientFor('owner');
      const clientSmall = await client.uploadArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
      });
      held.release();
      expect(await run).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect((await client.listArtifacts(app.fileId)).find((a) => a.kind === 'thumbnail-small')).toEqual(clientSmall);
      expect((await artifactObjects(app.root)).filter((path) => path.endsWith('-thumb-small.jpg'))).toHaveLength(1);

      await client.deleteFile(app.fileId);
      expect(await artifactObjects(app.root)).toEqual([]);
    });

    it('are deleted with the file when an upload stored its object, failed, and could not delete it', async () => {
      const app = await createApp({ artifactsOnR2: true });
      const r2Keys = () => [...app.bucket.objects.keys()];
      // The signed PUT stores the object and loses its response; the delete
      // that follows fails too.
      app.bucket.control.fault = (method, key) =>
        !key.includes('.client-artifacts/') ? undefined : method === 'PUT' ? 'lost' : method === 'DELETE' ? 'down' : undefined;
      const upload = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', mimeType: 'image/png' };
      await expect(app.fileFn.services.processing.attachClientArtifact({ ...upload, body: bytes('lost') }, app.owner))
        .rejects.toThrow('response lost');
      expect(r2Keys()).toHaveLength(1);
      expect(await app.artifacts()).toEqual([]);

      // A retry succeeds and leaves only its own upload record behind.
      app.bucket.control.fault = null;
      const retried = await app.fileFn.services.processing.attachClientArtifact({ ...upload, body: bytes('retried') }, app.owner);
      expect(r2Keys()).toHaveLength(2);
      expect((await app.displacedRecords()).map((record) => record.storageKey)).not.toContain(retried.storageKey);

      await app.clientFor('owner').deleteFile(app.fileId);
      expect(r2Keys()).toEqual([]);
    });

    it('keep an upload findable and report the row write error when the database fails', async () => {
      const app = await createApp();
      // The row write fails and the database stays down for the cleanup that follows.
      app.databaseControl.onCreate = (data) => {
        if (data.kind !== 'thumbnail-small') return undefined;
        app.databaseControl.down = true;
        return 'throw';
      };
      await expect(app.fileFn.services.processing.attachClientArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', mimeType: 'image/png', body: bytes('client'),
      }, app.owner)).rejects.toThrow('artifact row write failed');
      app.databaseControl.down = false;
      app.databaseControl.onCreate = null;
      expect(await artifactObjects(app.root)).toHaveLength(1);

      await app.clientFor('owner').deleteFile(app.fileId);
      expect(await artifactObjects(app.root)).toEqual([]);
    });
  });

  it('returns an artifact whose row write committed and then failed, keeping its object', async () => {
    const app = await createApp();
    app.databaseControl.onCreate = (data) => {
      if (data.kind !== 'thumbnail-small') return undefined;
      app.databaseControl.onCreate = null;
      return 'commit-then-throw';
    };
    const client = app.clientFor('owner');
    const attached = await client.uploadArtifact({
      fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('committed'), mimeType: 'image/png',
    });
    expect(attached).toMatchObject({ kind: 'thumbnail-small', size: 9, source: 'client' });
    expect(new TextDecoder().decode(await app.artifactBytes('owner', await client.downloadArtifact(app.fileId, attached.artifactId)))).toBe('committed');
    expect(await app.displacedRecords()).toEqual([]);
    expect(await app.artifacts()).toHaveLength(1);
  });

  it('refuses a version of another file and reports client errors as FileFnHttpError', async () => {
    const app = await createApp();
    const error = await app.clientFor('owner').uploadArtifact({
      fileId: app.fileId, versionId: 'ver_missing', kind: 'thumbnail-small', data: bytes('x'), mimeType: 'image/png',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(FileFnHttpError);
    expect(error).toMatchObject({ status: 404, code: 'FILEFN_NOT_FOUND' });
  });

  describe('on a database adapter that reports no updated rows', () => {
    // The Kysely adapter of @superfunctions/db 0.2.0, which FileFn pins,
    // commits an update and reports 0 rows (see `controlledDatabase`).
    async function smallText(app: Awaited<ReturnType<typeof createApp>>) {
      const client = app.clientFor('owner');
      const small = (await client.listArtifacts(app.fileId)).find((a) => a.kind === 'thumbnail-small')!;
      return new TextDecoder().decode(await app.artifactBytes('owner', await client.downloadArtifact(app.fileId, small.artifactId)));
    }

    it('a forced run rewrites its existing server artifacts', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      await app.drainJobs();
      app.databaseControl.zeroUpdateCounts = true;
      await forceNow(app);
      await expectServerSmallReadable(app);
      expect(await app.artifacts()).toHaveLength(2);
    });

    it('a client upload replaces a server thumbnail and a forced run replaces it back', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      await app.drainJobs();
      app.databaseControl.zeroUpdateCounts = true;
      const attached = await app.clientFor('owner').uploadArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
      });
      expect(attached.source).toBe('client');
      expect(await smallText(app)).toBe('client-small');

      await forceNow(app);
      await expectServerSmallReadable(app);
      expect((await storedObjects(app.root)).some((path) => path.includes('.client-artifacts/'))).toBe(false);
    });

    it('a forced run whose row a client upload replaced meanwhile still replaces the newer row', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      await app.drainJobs();
      app.databaseControl.zeroUpdateCounts = true;
      await app.fileFn.services.processing.triggerProcessingForFile(app.fileId, app.owner, app.versionId, { force: true });
      // The forced run read the server row; its upload is held while a client upload replaces that row.
      const held = app.storageControl.hold((key) => key.endsWith('-thumb-small.jpg'));
      const forced = app.drainJobs();
      await held.reached;
      await app.clientFor('owner').uploadArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
      });
      held.release();
      expect(await forced).toEqual([expect.objectContaining({ status: 'completed' })]);

      await expectServerSmallReadable(app);
      expect((await storedObjects(app.root)).some((path) => path.includes('.client-artifacts/'))).toBe(false);
    });

    it('an upload whose replace another upload overtakes reports a retryable conflict and leaves no object behind', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      await app.drainJobs();
      const serverKey = (await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!.storageKey;
      app.databaseControl.zeroUpdateCounts = true;
      const upload = { fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', mimeType: 'image/png' };
      // A second upload replaces the server row between this upload's read and its replace.
      let overtaking: { storageKey: string } | undefined;
      app.databaseControl.beforeUpdate = async () => {
        overtaking = await app.fileFn.services.processing.attachClientArtifact({ ...upload, body: bytes('client-b') }, app.owner);
      };
      await expect(app.fileFn.services.processing.attachClientArtifact({ ...upload, body: bytes('client-a') }, app.owner))
        .rejects.toMatchObject({ code: 'FILEFN_ARTIFACT_WRITE_CONFLICT', details: { retryable: true } });

      expect((await app.artifacts()).find((a) => a.kind === 'thumbnail-small')!.storageKey).toBe(overtaking!.storageKey);
      expect(await smallText(app)).toBe('client-b');
      const clientObjects = (await storedObjects(app.root)).filter((path) => path.includes('.client-artifacts/'));
      expect(clientObjects).toEqual([expect.stringContaining(overtaking!.storageKey)]);
      // Only the replaced server object stays recorded, for file cleanup.
      expect((await app.displacedRecords()).map((record) => record.storageKey)).toEqual([serverKey]);
    });
  });

  describe('cleanupOrphanedArtifacts', () => {
    /** Moves the clock hours ahead: however long an upload takes, its record must hold. */
    const muchLater = () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    };
    afterEach(() => {
      vi.useRealTimers();
    });

    it('deletes the object of an upload interrupted once stored, after its file was deleted meanwhile', async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      const clientObjects = async () => (await storedObjects(app.root)).filter((path) => path.includes('.client-artifacts/'));
      const held = app.storageControl.hold((key) => key.includes('.client-artifacts/'));
      const attach = app.fileFn.services.processing.attachClientArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', mimeType: 'image/png', body: bytes('client'),
      }, app.owner);
      await held.reached;
      // The file is deleted, and its queued job then cleans up the deleted version.
      await app.clientFor('owner').deleteFile(app.fileId);
      expect(await app.drainJobs()).toEqual([expect.objectContaining({ status: 'dropped' })]);
      // The upload stores its object, and nothing it writes after that lands,
      // as when its worker is evicted.
      app.databaseControl.down = true;
      held.release();
      await expect(attach).rejects.toThrow('database unavailable');
      app.databaseControl.down = false;
      expect(await clientObjects()).toHaveLength(1);
      expect((await app.displacedRecords()).map((record) => record.kind)).toEqual(['filefn.upload-intent']);

      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 1, keptRecords: 0 });
      expect(await clientObjects()).toEqual([]);
      // Only the upload may remove its own record.
      expect((await app.displacedRecords()).map((record) => record.kind)).toEqual(['filefn.upload-intent']);
    });

    it('deletes the object of an upload that a sweep overtook and that was then interrupted once stored', async () => {
      const app = await createApp();
      const clientObjects = async () => (await storedObjects(app.root)).filter((path) => path.includes('.client-artifacts/'));
      const held = app.storageControl.hold((key) => key.includes('.client-artifacts/'));
      const attach = app.fileFn.services.processing.attachClientArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', mimeType: 'image/png', body: bytes('client'),
      }, app.owner);
      await held.reached;
      await app.clientFor('owner').deleteFile(app.fileId);
      // Hours later, with the upload still writing, a sweep runs.
      muchLater();
      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 1, keptRecords: 0 });
      // The upload then stores its object and nothing it writes after that lands.
      app.databaseControl.down = true;
      held.release();
      await expect(attach).rejects.toThrow('database unavailable');
      app.databaseControl.down = false;
      expect(await clientObjects()).toHaveLength(1);

      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 1, keptRecords: 0 });
      expect(await clientObjects()).toEqual([]);
    });

    it('deletes an upload that finished after its file was deleted and could not delete its own object', async () => {
      const app = await createApp();
      const clientObjects = async () => (await storedObjects(app.root)).filter((path) => path.includes('.client-artifacts/'));
      const failDeletes = () => app.storageControl.intercept((key) => key.includes('.client-artifacts/'), 'delete', async () => {
        throw new Error('storage unavailable');
      });
      // The upload is held once its intent is recorded, before its body is stored.
      const held = app.storageControl.hold((key) => key.includes('.client-artifacts/'));
      const attach = app.fileFn.services.processing.attachClientArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', mimeType: 'image/png', body: bytes('client'),
      }, app.owner);
      await held.reached;
      await app.clientFor('owner').deleteFile(app.fileId);
      const failed = failDeletes();
      held.release();
      await expect(attach).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });
      expect(failed.fired).toBe(true);

      // The object is left, and recorded for cleanup now the upload is done with it.
      const [leftover] = await clientObjects();
      expect(await clientObjects()).toHaveLength(1);
      const records = await app.displacedRecords();
      expect(records).toEqual([expect.objectContaining({ kind: 'filefn.displaced-object' })]);
      expect(leftover.endsWith(records[0].storageKey)).toBe(true);

      // A sweep whose delete fails keeps the record; the next one deletes the object.
      failDeletes();
      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 0, keptRecords: 1 });
      expect(await clientObjects()).toHaveLength(1);
      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 1, keptRecords: 0 });
      expect(await clientObjects()).toEqual([]);
      expect(await app.displacedRecords()).toEqual([]);
      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 0, keptRecords: 0 });
    });

    it("leaves a live version's records and an object another row still names", async () => {
      const app = await createApp({ processors: [thumbnailProcessor([])] });
      await app.drainJobs();
      // A client upload replaces the server thumbnail, whose object stays recorded while the version lives.
      await app.clientFor('owner').uploadArtifact({
        fileId: app.fileId, versionId: app.versionId, kind: 'thumbnail-small', data: bytes('client-small'), mimeType: 'image/png',
      });
      expect(await app.displacedRecords()).toHaveLength(1);
      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 0, keptRecords: 0 });
      expect(await app.displacedRecords()).toHaveLength(1);

      // A record of a version gone since, naming the object of a live row.
      const medium = (await app.database.findOne<{ storageKey: string; metadata: Record<string, any> }>({
        model: 'fileArtifacts',
        where: [{ field: 'fileId', operator: 'eq', value: app.fileId }, { field: 'kind', operator: 'eq', value: 'thumbnail-medium' }],
      }))!;
      await app.database.create({
        model: 'fileArtifacts',
        data: {
          artifactId: 'dsp_gone', fileId: 'file_gone', versionId: 'ver_gone', kind: 'filefn.displaced-object',
          storageKey: medium.storageKey, mimeType: 'application/octet-stream', size: 0,
          metadata: { processing: { source: 'server', storageTarget: medium.metadata.processing.storageTarget } },
          createdAt: new Date().toISOString(),
        },
      });
      expect(await app.fileFn.cleanupOrphanedArtifacts()).toEqual({ deletedObjects: 0, keptRecords: 0 });
      expect((await app.displacedRecords()).map((record) => record.storageKey)).not.toContain(medium.storageKey);
      expect((await storedObjects(app.root)).some((path) => path.endsWith(medium.storageKey))).toBe(true);
    });
  });
});
