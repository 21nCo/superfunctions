import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instrumentAdapter, type Adapter } from '@superfunctions/db';
import { normalizeObservability } from '@superfunctions/observability';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { StorageAdapter } from '@superfunctions/storage';
import { createNotFoundError } from '@superfunctions/storage/internal/errors';
import type { Authorizer } from '@superfunctions/files';
import { createDefaultAuthorizer, createFileFn, type FileFnConfig, type QuotaProvider } from '../index.js';
import { generateFileFnId } from '../ids.js';
import {
  createKeyedSerializer,
  isValidClientFileId,
  parseRequestedFileId,
  SERIALIZED_WAIT_TIMEOUT_MS,
} from '../upload-sessions/file-id.js';
import { generateFileId } from '../../../client/src/upload-manager.js';

type Mode = 'multipart' | 'proxy';

/**
 * Byte-keeping storage fixture. In multipart mode the test plays the client's
 * PUT to a signed part URL with `putSignedPart`; completion concatenates the
 * parts into the object. In proxy mode FileFn streams the bytes itself.
 */
function createStorage(mode: Mode) {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  /** Keys whose next deleteObject calls fail (count per key). */
  const deleteFailures = new Map<string, number>();
  /** Storage completion of these final keys waits for the promise. */
  const gates = new Map<string, Promise<void>>();
  /** statObject of these keys waits for the promise (after storage completion). */
  const statHolds = new Map<string, Promise<void>>();
  /** Storage-completion attempts per final key. */
  const finalizeAttempts = new Map<string, number>();
  let onFinalize: ((key: string, attempt: number) => void) | undefined;
  /** Like the local adapter, opening an upload stream empties the object at once. */
  let truncateOnOpen = false;
  const noteFinalize = (key: string) => {
    const attempt = (finalizeAttempts.get(key) ?? 0) + 1;
    finalizeAttempts.set(key, attempt);
    onFinalize?.(key, attempt);
  };
  let uploadCounter = 0;

  const storage: StorageAdapter = {
    name: `test-${mode}`,
    capabilities: {
      signedUploadUrls: mode === 'multipart',
      signedDownloadUrls: false,
      multipart: mode === 'multipart',
      proxyStreamingUpload: mode === 'proxy',
      proxyStreamingDownload: true,
    },
    async createMultipartUpload(input) {
      const uploadId = `mpu_${++uploadCounter}`;
      uploads.set(uploadId, { key: input.key, parts: new Map() });
      return { uploadId };
    },
    async signMultipartUploadPartUrl(input) {
      return { url: `https://storage.test/${input.uploadId}/${input.partNumber}`, headers: {} };
    },
    async completeMultipartUpload(input) {
      noteFinalize(input.key);
      const upload = uploads.get(input.uploadId);
      if (!upload) {
        // S3 and R2 answer NoSuchUpload.
        throw new Error(`NoSuchUpload: ${input.uploadId}`);
      }
      await gates.get(upload.key);
      const chunks = input.parts.map((part) => upload.parts.get(part.partNumber)!);
      objects.set(upload.key, Buffer.concat(chunks));
      uploads.delete(input.uploadId);
    },
    async abortMultipartUpload(input) {
      uploads.delete(input.uploadId);
    },
    async statObject(input) {
      await statHolds.get(input.key);
      const bytes = objects.get(input.key);
      if (!bytes) throw createNotFoundError(`object not found: ${input.key}`);
      return { key: input.key, size: bytes.byteLength };
    },
    async deleteObject(input) {
      const failures = deleteFailures.get(input.key) ?? 0;
      if (failures > 0) {
        deleteFailures.set(input.key, failures - 1);
        throw new Error(`transient delete failure: ${input.key}`);
      }
      objects.delete(input.key);
    },
    async openUploadStream(input) {
      if (!input.key.includes('.part')) noteFinalize(input.key);
      await gates.get(input.key);
      if (truncateOnOpen) objects.set(input.key, new Uint8Array(0));
      const chunks: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
        close() {
          objects.set(input.key, Buffer.concat(chunks));
        },
      });
    },
    async openDownloadStream(input) {
      const bytes = objects.get(input.key);
      if (!bytes) throw new Error(`object not found: ${input.key}`);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };

  return {
    storage,
    objects,
    uploads,
    deleteFailures,
    /**
     * Holds the first completion of `key` after it finalized storage until a
     * second finalization of the same key starts, or `maxMs` passes.
     */
    holdAfterFirstFinalize(key: string, maxMs = 50) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      statHolds.set(key, Promise.race([released, new Promise<void>((resolve) => setTimeout(resolve, maxMs))]));
      onFinalize = (finalized, attempt) => {
        if (finalized === key && attempt >= 2) release();
      };
      return () => finalizeAttempts.get(key) ?? 0;
    },
    /** Holds statObject of `key` (after storage completion) until the returned release is called. */
    holdStat(key: string): () => void {
      let release!: () => void;
      statHolds.set(key, new Promise<void>((resolve) => { release = resolve; }));
      return () => {
        statHolds.delete(key);
        release();
      };
    },
    finalizeCount(key: string): number {
      return finalizeAttempts.get(key) ?? 0;
    },
    /** Opening an upload stream truncates the object, as on the local adapter. */
    truncateObjectsOnOpen() {
      truncateOnOpen = true;
    },
    /** Holds storage completion of `key` until the returned release is called. */
    gate(key: string): () => void {
      let release!: () => void;
      gates.set(key, new Promise<void>((resolve) => { release = resolve; }));
      return () => {
        gates.delete(key);
        release();
      };
    },
    putSignedPart(url: string, bytes: Uint8Array): string {
      const [uploadId, partNumber] = new URL(url).pathname.slice(1).split('/');
      const upload = uploads.get(uploadId);
      if (!upload) throw new Error(`no such upload: ${uploadId}`);
      upload.parts.set(Number(partNumber), bytes);
      return `"${createHash('md5').update(bytes).digest('hex')}"`;
    },
  };
}

/**
 * Memory adapter that enforces the unique `files.fileId` and
 * `fileVersions.versionId` columns, like Postgres. `hooks` let a test hold an
 * insert to line up two processes' commit sections.
 */
function createUniqueEnforcingDb(hooks: {
  before?: (model: string) => Promise<void>;
  after?: (model: string) => void;
  afterFindOne?: (model: string, result: unknown) => Promise<void>;
}): Adapter {
  const base = memoryAdapter();
  const uniqueColumns: Record<string, string> = { files: 'fileId', fileVersions: 'versionId' };
  return {
    ...base,
    async findOne(params) {
      const result = await base.findOne(params);
      await hooks.afterFindOne?.(params.model, result);
      return result as any;
    },
    async create(params) {
      await hooks.before?.(params.model);
      const column = uniqueColumns[params.model];
      if (column) {
        const existing = await base.findOne({
          model: params.model,
          where: [{ field: column, operator: 'eq', value: params.data[column] }],
          namespace: params.namespace,
        });
        if (existing) {
          throw new Error(`duplicate key value violates unique constraint "${params.model}_${column}"`);
        }
      }
      const created = await base.create(params);
      hooks.after?.(params.model);
      return created;
    },
  } as Adapter;
}

function createApp(options: {
  mode: Mode;
  database?: Adapter;
  storageFixture?: ReturnType<typeof createStorage>;
  quota?: QuotaProvider;
  observability?: FileFnConfig['observability'];
  /** Use the grant-aware authorizer instead of the owner-only default. */
  grants?: boolean;
  authorizer?: Authorizer;
  /** `createFileFn` of a separately loaded module graph, to model another process. */
  createFileFn?: typeof createFileFn;
  dedup?: boolean;
  completionTimeoutSeconds?: number;
}) {
  const fixture = options.storageFixture ?? createStorage(options.mode);
  const database = options.database ?? memoryAdapter();
  const fileFn = (options.createFileFn ?? createFileFn)({
    database,
    authorizer: options.authorizer ?? (options.grants ? createDefaultAuthorizer({ db: database }) : undefined),
    storage: fixture.storage,
    policies: [{ name: 'doc', contentTypes: ['text/plain'], visibility: 'private' }],
    quota: options.quota,
    observability: options.observability,
    dedup: options.dedup ? { enabled: true } : undefined,
    completionTimeoutSeconds: options.completionTimeoutSeconds,
    auth: {
      required: false,
      resolveSession: async (request) => {
        const user = request.headers.get('x-test-user');
        return user ? { principalId: user } : null;
      },
    },
  });

  async function call(method: string, path: string, init: { user?: string; token?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.user) headers['x-test-user'] = init.user;
    if (init.token) headers['x-upload-session-token'] = init.token;
    let body: BodyInit | undefined = init.raw;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const response = await fileFn.router.handle(new Request(`https://filefn.test${path}`, { method, headers, body }));
    if (!response) throw new Error(`no route for ${method} ${path}`);
    return { status: response.status, json: (await response.json()) as any };
  }

  async function init(user: string | undefined, fileId: unknown, bytes: Uint8Array, headers?: Record<string, string>) {
    return call('POST', '/upload/init', {
      user,
      headers,
      body: { policy: 'doc', fileName: 'note.txt', size: bytes.byteLength, mimeType: 'text/plain', ...(fileId === undefined ? {} : { fileId }) },
    });
  }

  /** Inits and uploads every part; returns what is needed to complete. */
  async function stage(user: string | undefined, fileId: unknown, text: string) {
    const bytes = Buffer.from(text);
    const started = await init(user, fileId, bytes);
    expect(started.status).toBe(200);
    const { uploadSessionId, uploadSessionToken } = started.json.data;
    const auth = { user, token: uploadSessionToken };
    if (options.mode === 'proxy') {
      const put = await call('PUT', `/upload/${uploadSessionId}/parts/1`, { ...auth, raw: bytes, headers: { 'content-type': 'text/plain' } });
      expect(put.status).toBe(200);
    } else {
      const signed = await call('POST', `/upload/${uploadSessionId}/parts/1/sign`, { ...auth, body: { contentLength: bytes.byteLength } });
      expect(signed.status).toBe(200);
      const etag = fixture.putSignedPart(signed.json.data.url, bytes);
      const recorded = await call('POST', `/upload/${uploadSessionId}/parts/1/complete`, { ...auth, body: { etag, size: bytes.byteLength } });
      expect(recorded.status).toBe(200);
    }
    const session = await fileFn.services.uploads.getSessionStatus(uploadSessionId, { principalId: user }, uploadSessionToken);
    return {
      uploadSessionId,
      fileId: session.fileId!,
      token: uploadSessionToken as string | undefined,
      complete: () => call('POST', `/upload/${uploadSessionId}/complete`, auth),
    };
  }

  async function readBytes(fileId: string, principalId: string | undefined) {
    if (!principalId || principalId === 'anonymous') {
      // Nobody owns an anonymous upload (FILE-30 F-02), so an unauthenticated
      // caller cannot read a private one back; read the stored object instead.
      await expect(fileFn.services.files.getDownloadStream(fileId, undefined, { principalId }))
        .rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
      const file = await database.findOne<{ currentVersionId: string }>({
        model: 'files', where: [{ field: 'fileId', operator: 'eq', value: fileId }], namespace: 'filefn',
      });
      const version = await database.findOne<{ storageKey: string }>({
        model: 'fileVersions', where: [{ field: 'versionId', operator: 'eq', value: file!.currentVersionId }], namespace: 'filefn',
      });
      return Buffer.from(fixture.objects.get(version!.storageKey)!).toString();
    }
    const download = await fileFn.services.files.getDownloadStream(fileId, undefined, { principalId });
    return new Response(download.stream).text();
  }

  return { fileFn, fixture, call, init, stage, readBytes };
}

async function rawSession(db: Adapter, uploadSessionId: string) {
  return db.findOne<{ status: string; storageKey: string; fileId: string }>({
    model: 'uploadSessions',
    where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
    namespace: 'filefn',
  });
}

async function fileRows(db: Adapter, fileId: string) {
  return db.findMany<{ ownerId: string; currentVersionId: string }>({
    model: 'files',
    where: [{ field: 'fileId', operator: 'eq', value: fileId }],
    namespace: 'filefn',
  });
}

async function versionRows(db: Adapter, fileId: string) {
  return db.findMany<{ versionId: string }>({
    model: 'fileVersions',
    where: [{ field: 'fileId', operator: 'eq', value: fileId }],
    namespace: 'filefn',
  });
}

const CLIENT_ID = 'file_offlineCapture01';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('client-chosen file ID grammar', () => {
  it('accepts file_ plus 8 to 64 characters, server IDs and generateFileId() output', () => {
    const accepted = [
      `file_${'a'.repeat(8)}`,
      `file_${'Z9_-'.repeat(16)}`,
      generateFileFnId('file'),
      'file_l1x2y3z4_abc12345',
      generateFileId(),
    ];
    vi.stubGlobal('crypto', undefined);
    accepted.push(generateFileId());
    for (const id of accepted) {
      expect(isValidClientFileId(id), id).toBe(true);
      expect(parseRequestedFileId(id)).toBe(id);
    }
    expect(`file_${'Z9_-'.repeat(16)}`).toHaveLength(69);
  });

  it('rejects other IDs with FILEFN_INVALID_FILE_ID and generates one for null or omitted', () => {
    const rejected: unknown[] = [
      `file_${'a'.repeat(7)}`,
      `file_${'a'.repeat(65)}`,
      'file-xxxxxxxx',
      'offline_abcdefgh12',
      '',
      'file_abc.defgh',
      ' file_abcdefgh',
      42,
      { id: 'file_abcdefgh' },
      ['file_abcdefgh'],
    ];
    for (const value of rejected) {
      expect(isValidClientFileId(value)).toBe(false);
      expect(() => parseRequestedFileId(value)).toThrow(expect.objectContaining({ code: 'FILEFN_INVALID_FILE_ID', status: 400 }));
    }
    expect(parseRequestedFileId(null)).toBeUndefined();
    expect(parseRequestedFileId(undefined)).toBeUndefined();
  });

  it('refuses an invalid ID at upload/init with 400 before any session or storage upload', async () => {
    const app = createApp({ mode: 'multipart' });
    for (const fileId of ['file-xxxxxxxx', '', 12345678, `file_${'a'.repeat(65)}`]) {
      const res = await app.init('user_a', fileId, Buffer.from('x'));
      expect(res.status).toBe(400);
      expect(res.json.error.code).toBe('FILEFN_INVALID_FILE_ID');
    }
    expect(app.fixture.uploads.size).toBe(0);
  });

  it('generates a server ID when fileId is null or omitted', async () => {
    const app = createApp({ mode: 'proxy' });
    for (const fileId of [null, undefined]) {
      const staged = await app.stage('user_a', fileId, 'generated');
      expect(isValidClientFileId(staged.fileId)).toBe(true);
      const done = await staged.complete();
      expect(done.status).toBe(200);
      expect(done.json.data.fileId).toBe(staged.fileId);
    }
  });
});

describe('client-chosen file IDs: first completion wins', () => {
  it('creates the file under the client-chosen ID', async () => {
    const app = createApp({ mode: 'proxy' });
    const staged = await app.stage('user_a', CLIENT_ID, 'captured offline');
    const done = await staged.complete();
    expect(done.status).toBe(200);
    expect(done.json.data.fileId).toBe(CLIENT_ID);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('captured offline');
  });

  for (const mode of ['multipart', 'proxy'] as const) {
    for (const [first, second] of [
      ['user_a', 'user_b'],
      ['user_a', undefined],
      [undefined, undefined],
    ] as const) {
      it(`${mode}: two ${first ?? 'anonymous'}/${second ?? 'anonymous'} completions racing on one new ID give one 200 and one 403`, async () => {
        const database = memoryAdapter();
        const app = createApp({ mode, database });
        const a = await app.stage(first, CLIENT_ID, 'bytes from A');
        const b = await app.stage(second, CLIENT_ID, 'bytes from B!');
        const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
        const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;
        expect(keyA).not.toBe(keyB);

        const [resA, resB] = await Promise.all([a.complete(), b.complete()]);
        expect([resA.status, resB.status].sort()).toEqual([200, 403]);
        const aWon = resA.status === 200;
        const [winner, loser] = aWon ? [a, b] : [b, a];
        const [winnerUser, winnerText, winnerKey, loserKey] = aWon
          ? [first, 'bytes from A', keyA, keyB]
          : [second, 'bytes from B!', keyB, keyA];
        expect((aWon ? resB : resA).json.error.code).toBe('FILEFN_FORBIDDEN');

        const rows = await fileRows(database, CLIENT_ID);
        expect(rows).toHaveLength(1);
        expect(rows[0].ownerId).toBe(winnerUser ?? 'anonymous');
        expect(await app.readBytes(CLIENT_ID, winnerUser ?? 'anonymous')).toBe(winnerText);
        expect(app.fixture.objects.has(winnerKey)).toBe(true);
        expect(app.fixture.objects.has(loserKey)).toBe(false);
        expect([...app.fixture.objects.keys()].filter((key) => key.startsWith(`${loserKey}.part`))).toEqual([]);
        expect(app.fixture.uploads.size).toBe(0);
        expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('refused');
        expect((await rawSession(database, winner.uploadSessionId))!.status).toBe('completed');
      });
    }
  }

  it('late completer: init before the file exists, completion after another principal created it', async () => {
    for (const granted of [false, true]) {
      const database = memoryAdapter();
      const app = createApp({ mode: 'multipart', database, grants: true });
      const b = await app.stage('user_b', CLIENT_ID, 'late bytes');
      const a = await app.stage('user_a', CLIENT_ID, 'first bytes');
      const created = await a.complete();
      expect(created.status).toBe(200);
      if (granted) {
        await app.fileFn.services.grants.createGrant({ fileId: CLIENT_ID, userId: 'user_b', canWrite: true }, { principalId: 'user_a' });
      }

      const late = await b.complete();
      const rows = await fileRows(database, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe('user_a');
      if (granted) {
        expect(late.status).toBe(200);
        expect(late.json.data.fileId).toBe(CLIENT_ID);
        expect(rows[0].currentVersionId).toBe(late.json.data.versionId);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('late bytes');
      } else {
        expect(late.status).toBe(403);
        expect(late.json.error.code).toBe('FILEFN_FORBIDDEN');
        expect(rows[0].currentVersionId).toBe(created.json.data.versionId);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('first bytes');
        expect((await rawSession(database, b.uploadSessionId))!.status).toBe('refused');
        expect(app.fixture.uploads.size).toBe(0);
        expect(app.fixture.objects.size).toBe(1);
      }
    }
  });

  it('a retried init with the same idempotency key returns the same session and file ID', async () => {
    const app = createApp({ mode: 'proxy' });
    for (const fileId of [CLIENT_ID, undefined]) {
      const headers = { 'x-idempotency-key': `idem-${fileId ?? 'generated'}` };
      const bytes = Buffer.from('retry');
      const first = await app.init('user_a', fileId, bytes, headers);
      const retried = await app.init('user_a', fileId, bytes, headers);
      expect(first.status).toBe(200);
      expect(retried.status).toBe(200);
      expect(retried.json.data.uploadSessionId).toBe(first.json.data.uploadSessionId);
      const firstStatus = await app.call('GET', `/upload/${first.json.data.uploadSessionId}/status`, { user: 'user_a' });
      expect(firstStatus.json.data.fileId).toBe(fileId ?? firstStatus.json.data.fileId);
      expect(isValidClientFileId(firstStatus.json.data.fileId)).toBe(true);
      const retriedStatus = await app.call('GET', `/upload/${retried.json.data.uploadSessionId}/status`, { user: 'user_a' });
      expect(retriedStatus.json.data.fileId).toBe(firstStatus.json.data.fileId);
    }
  });

  it('refuses init on another principal\'s existing file with 403', async () => {
    const app = createApp({ mode: 'multipart' });
    const owned = await app.stage('user_a', CLIENT_ID, 'owned');
    expect((await owned.complete()).status).toBe(200);
    const uploadsBefore = app.fixture.uploads.size;

    for (const user of ['user_b', undefined]) {
      const res = await app.init(user, CLIENT_ID, Buffer.from('foreign'));
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe('FILEFN_FORBIDDEN');
    }
    expect(app.fixture.uploads.size).toBe(uploadsBefore);
  });

  it('a second completion call of the winning session returns the same result and keeps the bytes', async () => {
    const app = createApp({ mode: 'proxy' });
    const staged = await app.stage('user_a', CLIENT_ID, 'kept bytes');
    const first = await staged.complete();
    const second = await staged.complete();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.data).toEqual(first.json.data);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('kept bytes');
  });

  it('serializes per-request FileFn instances that share one memory adapter in a process', async () => {
    // Hosts such as the Worker fixture build FileFn per request over one adapter.
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const first = createApp({ mode: 'proxy', database, storageFixture });
    const second = createApp({ mode: 'proxy', database, storageFixture });
    const a = await first.stage('user_a', CLIENT_ID, 'instance one');
    const b = await second.stage('user_b', CLIENT_ID, 'instance two');
    const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
    const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;

    const [resA, resB] = await Promise.all([a.complete(), b.complete()]);
    expect([resA.status, resB.status].sort()).toEqual([200, 403]);
    const aWon = resA.status === 200;
    const rows = await fileRows(database, CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe(aWon ? 'user_a' : 'user_b');
    expect(storageFixture.objects.has(aWon ? keyA : keyB)).toBe(true);
    expect(storageFixture.objects.has(aWon ? keyB : keyA)).toBe(false);
  });

  it('serializes FileFn instances built over different wrappers of one memory adapter', async () => {
    // Each wrapper is a separate adapter object that forwards to one store.
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const first = createApp({ mode: 'proxy', database: { ...database } as Adapter, storageFixture });
    const second = createApp({ mode: 'proxy', database: { ...database } as Adapter, storageFixture });
    const a = await first.stage('user_a', CLIENT_ID, 'wrapper one');
    const b = await second.stage('user_b', CLIENT_ID, 'wrapper two');
    const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
    const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;

    const [resA, resB] = await Promise.all([a.complete(), b.complete()]);
    expect([resA.status, resB.status].sort()).toEqual([200, 403]);
    const aWon = resA.status === 200;
    const rows = await fileRows(database, CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe(aWon ? 'user_a' : 'user_b');
    expect(await first.readBytes(CLIENT_ID, aWon ? 'user_a' : 'user_b')).toBe(aWon ? 'wrapper one' : 'wrapper two');
    expect(storageFixture.objects.has(aWon ? keyB : keyA)).toBe(false);
  });

  it('serializes FileFn instances built over one instrumented memory adapter', async () => {
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const store = memoryAdapter();
    const database = instrumentAdapter(store, { observability: normalizeObservability({ logger: silent }) });
    // Every read of `internal` returns a new proxy, so it cannot identify the store.
    expect(database.internal).not.toBe(database.internal);
    const storageFixture = createStorage('proxy');
    const first = createApp({ mode: 'proxy', database, storageFixture });
    const second = createApp({ mode: 'proxy', database, storageFixture });
    const a = await first.stage('user_a', CLIENT_ID, 'instrumented one');
    const b = await second.stage('user_b', CLIENT_ID, 'instrumented two');
    const keyA = (await rawSession(store, a.uploadSessionId))!.storageKey;
    const keyB = (await rawSession(store, b.uploadSessionId))!.storageKey;

    const [resA, resB] = await Promise.all([a.complete(), b.complete()]);
    expect([resA.status, resB.status].sort()).toEqual([200, 403]);
    const aWon = resA.status === 200;
    const rows = await fileRows(store, CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe(aWon ? 'user_a' : 'user_b');
    expect(await first.readBytes(CLIENT_ID, aWon ? 'user_a' : 'user_b')).toBe(aWon ? 'instrumented one' : 'instrumented two');
    expect(storageFixture.objects.has(aWon ? keyB : keyA)).toBe(false);
  });

  for (const mode of ['multipart', 'proxy'] as const) {
    it(`${mode}: two concurrent completion calls of one session return the same result and keep the bytes`, async () => {
      const database = memoryAdapter();
      const app = createApp({ mode, database });
      const staged = await app.stage('user_a', CLIENT_ID, 'one session, two calls');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      // The first call stalls after finalizing storage; the second must not
      // finalize storage again over it.
      const finalizations = app.fixture.holdAfterFirstFinalize(key);
      const [first, second] = await Promise.all([staged.complete(), staged.complete()]);
      expect(finalizations()).toBe(1);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.json.data).toEqual(first.json.data);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('one session, two calls');
    });
  }

  it('a quota-refused init leaves no session row and no storage upload', async () => {
    const database = memoryAdapter();
    const quota: QuotaProvider = {
      async checkQuota() { return { allowed: false, current: 10, limit: 10 }; },
      async recordUsage() {},
    };
    const app = createApp({ mode: 'multipart', database, quota });
    const res = await app.init('user_a', CLIENT_ID, Buffer.from('too big'));
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe('FILEFN_QUOTA_EXCEEDED');
    expect(await database.findMany({ model: 'uploadSessions', namespace: 'filefn' })).toEqual([]);
    expect(app.fixture.uploads.size).toBe(0);
  });

  it('keeps a multipart completion retryable while final-object stat is unavailable', async () => {
    const fixture = createStorage('multipart');
    const stat = fixture.storage.statObject!;
    let statAvailable = false;
    fixture.storage.statObject = async (input) => {
      if (!statAvailable) throw new Error('test storage stat timed out');
      return stat.call(fixture.storage, input);
    };
    const app = createApp({ mode: 'multipart', storageFixture: fixture });
    const staged = await app.stage('user_a', CLIENT_ID, 'test retry');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await staged.complete();
      expect(failed.status).toBe(500);
      expect(failed.json.error).toEqual({
        code: 'FILEFN_STORAGE_STAT_UNAVAILABLE', message: 'Upload size cannot be verified',
      });
    }
    statAvailable = true;
    expect((await staged.complete()).status).toBe(200);
  });

  it.each([true, false])('hides the owner quota outcome (allowed=%s) when upload completion is forbidden', async (allowed) => {
    let withinQuota = true;
    const observed: string[] = [];
    const app = createApp({
      mode: 'proxy',
      quota: {
        async checkQuota() { return { allowed: withinQuota, current: 10, limit: 10 }; },
        async recordUsage() {},
      },
      observability: { metrics: (metric) => { observed.push(metric.kind); } },
    });
    const pending = await app.stage('user_b', CLIENT_ID, 'pending upload');
    const owner = await app.stage('user_a', CLIENT_ID, 'owner upload');
    expect((await owner.complete()).status).toBe(200);

    withinQuota = allowed;
    const response = await app.fileFn.router.handle(new Request(`https://filefn.test/upload/${pending.uploadSessionId}/complete`, {
      method: 'POST',
      headers: { 'x-test-user': 'user_b' },
    }));
    expect(response?.status).toBe(403);
    expect(response?.headers.get('server-timing')).toBeTruthy();
    expect(response?.headers.get('server-timing')).not.toContain('filefn.quota');
    expect(observed).not.toContain('filefn.quota');
  });
});

/** Loads FileFn from a fresh module graph: separate module state, as in another process. */
async function loadProcess(): Promise<typeof createFileFn> {
  vi.resetModules();
  return (await import('../index.js')).createFileFn;
}

describe('client-chosen file IDs across processes (unique-enforcing adapter)', () => {
  /**
   * Two processes (separately loaded FileFn modules, so separate in-process
   * locks) share one database and one storage. The first `files` insert is held
   * until a second one arrives, so both completions have read "no file" and the
   * unique constraint, not the in-process lock, decides the winner. The second
   * insert is released only once the winner's version row exists.
   */
  async function createTwoProcesses(mode: Mode) {
    let filesInserts = 0;
    let firstArrived!: () => void;
    const firstArrival = new Promise<void>((resolve) => { firstArrived = resolve; });
    let secondArrived!: () => void;
    const secondArrival = new Promise<void>((resolve) => { secondArrived = resolve; });
    let winnerVersionWritten!: () => void;
    const winnerVersion = new Promise<void>((resolve) => { winnerVersionWritten = resolve; });

    const database = createUniqueEnforcingDb({
      async before(model) {
        if (model !== 'files') return;
        filesInserts += 1;
        if (filesInserts === 1) {
          firstArrived();
          await secondArrival;
        } else if (filesInserts === 2) {
          secondArrived();
          await winnerVersion;
        }
      },
      after(model) {
        if (model === 'fileVersions') winnerVersionWritten();
      },
    });
    const storageFixture = createStorage(mode);
    const one = createApp({ mode, database, storageFixture, createFileFn: await loadProcess() });
    const two = createApp({ mode, database, storageFixture, createFileFn: await loadProcess() });
    return { database, storageFixture, one, two, firstArrival, filesInserts: () => filesInserts };
  }

  for (const mode of ['multipart', 'proxy'] as const) {
    it(`${mode}: the loser of the insert gets 403 and its object is deleted`, async () => {
      const { database, storageFixture, one, two, filesInserts } = await createTwoProcesses(mode);
      const a = await one.stage('user_a', CLIENT_ID, 'process one bytes');
      const b = await two.stage('user_b', CLIENT_ID, 'process two');
      const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
      const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;

      const [resA, resB] = await Promise.all([a.complete(), b.complete()]);
      expect(filesInserts()).toBe(2);
      expect([resA.status, resB.status].sort()).toEqual([200, 403]);
      const aWon = resA.status === 200;
      const rows = await fileRows(database, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe(aWon ? 'user_a' : 'user_b');
      expect(await one.readBytes(CLIENT_ID, aWon ? 'user_a' : 'user_b')).toBe(aWon ? 'process one bytes' : 'process two');
      expect(storageFixture.objects.has(aWon ? keyA : keyB)).toBe(true);
      expect(storageFixture.objects.has(aWon ? keyB : keyA)).toBe(false);
      expect((await rawSession(database, (aWon ? b : a).uploadSessionId))!.status).toBe('refused');
    });
  }

  it('the loser of the insert with write permission on the winner\'s row adds a version', async () => {
    // The same principal on two devices: it owns the row the other session inserted.
    const { database, storageFixture, one, two, firstArrival, filesInserts } = await createTwoProcesses('proxy');
    const a = await one.stage('user_a', CLIENT_ID, 'from device one');
    const b = await two.stage('user_a', CLIENT_ID, 'from device two');
    const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;

    const completingA = a.complete();
    await firstArrival;
    const [resA, resB] = await Promise.all([completingA, b.complete()]);
    expect(filesInserts()).toBe(2);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resB.json.data.fileId).toBe(CLIENT_ID);
    const rows = await fileRows(database, CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].currentVersionId).toBe(resB.json.data.versionId);
    const versions = await database.findMany<{ versionId: string }>({
      model: 'fileVersions',
      where: [{ field: 'fileId', operator: 'eq', value: CLIENT_ID }],
      namespace: 'filefn',
    });
    expect(versions.map((v) => v.versionId).sort()).toEqual([resA.json.data.versionId, resB.json.data.versionId].sort());
    expect(storageFixture.objects.has(keyB)).toBe(true);
    expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('from device two');
  });

  for (const user of ['user_a', undefined] as const) {
    it(`a second completion of the same ${user ? 'named' : 'anonymous'} session while the first is between its files and version inserts finishes that publication, returns the same result and finalizes storage once`, async () => {
      // Process one moves the session to 'publishing', inserts the files row,
      // then is held before its version insert while process two completes the
      // same session: two finishes the recorded publication (one version row).
      let versionInserts = 0;
      let heldAtVersion!: () => void;
      const firstHeld = new Promise<void>((resolve) => { heldAtVersion = resolve; });
      let releaseFirst!: () => void;
      const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const database = createUniqueEnforcingDb({
        async before(model) {
          if (model !== 'fileVersions') return;
          versionInserts += 1;
          if (versionInserts === 1) {
            heldAtVersion();
            await firstReleased;
          }
        },
      });
      // Strict fixture: a second storage finalization would fail (NoSuchUpload).
      const storageFixture = createStorage('multipart');
      const one = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
      const two = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
      const staged = await one.stage(user, CLIENT_ID, 'same session bytes');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      const completeIn = (app: typeof one) => app.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user, token: staged.token });

      const first = completeIn(one);
      await firstHeld;
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(1);
      const pendingSecond = completeIn(two);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseFirst();
      const [firstResult, second] = await Promise.all([first, pendingSecond]);
      expect(storageFixture.finalizeCount(key)).toBe(1);
      expect(await versionRows(database, CLIENT_ID)).toHaveLength(1);

      expect(second.status).toBe(200);
      expect(firstResult.status).toBe(200);
      expect(firstResult.json.data).toEqual(second.json.data);
      expect(second.json.data.fileId).toBe(CLIENT_ID);
      expect(storageFixture.objects.has(key)).toBe(true);
      expect(await one.readBytes(CLIENT_ID, user ?? 'anonymous')).toBe('same session bytes');
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
      const rows = await fileRows(database, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].currentVersionId).toBe(second.json.data.versionId);
    });
  }

  it('a concurrent second completion call of the same session in another process finishes the same publication and creates the file once', async () => {
    // Process one is held at its files insert (it has finalized storage and
    // recorded its publication); the duplicate in process two finishes that
    // publication, never one of its own: the unique insert admits one files row.
    let filesInserts = 0;
    let firstArrived!: () => void;
    const firstArrival = new Promise<void>((resolve) => { firstArrived = resolve; });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const database = createUniqueEnforcingDb({
      async before(model) {
        if (model !== 'files') return;
        filesInserts += 1;
        if (filesInserts > 1) return;
        firstArrived();
        await firstReleased;
      },
    });
    const storageFixture = createStorage('multipart');
    const one = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
    const two = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
    const staged = await one.stage('user_a', CLIENT_ID, 'same session');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;

    const first = staged.complete();
    await firstArrival;
    const pendingSecond = two.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseFirst();
    const [firstResult, second] = await Promise.all([first, pendingSecond]);
    expect(filesInserts).toBe(2);
    expect(await fileRows(database, CLIENT_ID)).toHaveLength(1);
    expect(await versionRows(database, CLIENT_ID)).toHaveLength(1);
    expect(storageFixture.finalizeCount(key)).toBe(1);
    expect(firstResult.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.data).toEqual(firstResult.json.data);
    expect(firstResult.json.data.fileId).toBe(CLIENT_ID);
    expect(storageFixture.objects.has(key)).toBe(true);
    expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('same session');
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
  });

  it('a refused retry deletes the final object an interrupted attempt left', async () => {
    // A's first completion finalizes its object, then fails on the files insert
    // (not a unique conflict). B then creates the ID. A's retry is refused.
    let failNextFilesInsert = true;
    const database = createUniqueEnforcingDb({
      async before(model) {
        if (model === 'files' && failNextFilesInsert) {
          failNextFilesInsert = false;
          throw new Error('connection reset');
        }
      },
    });
    const storageFixture = createStorage('multipart');
    const app = createApp({ mode: 'multipart', database, storageFixture });
    const a = await app.stage('user_a', CLIENT_ID, 'interrupted');
    const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
    await expect(a.complete()).rejects.toThrow('connection reset');
    expect(storageFixture.objects.has(keyA)).toBe(true);

    const b = await app.stage('user_b', CLIENT_ID, 'created by b');
    expect((await b.complete()).status).toBe(200);

    const retried = await a.complete();
    expect(retried.status).toBe(403);
    expect(retried.json.error.code).toBe('FILEFN_FORBIDDEN');
    expect(storageFixture.objects.has(keyA)).toBe(false);
    expect((await rawSession(database, a.uploadSessionId))!.status).toBe('refused');
    expect(await app.readBytes(CLIENT_ID, 'user_b')).toBe('created by b');
  });

  it('a stalled completion resuming after a takeover and a later writer moved the file on returns the recorded result', async () => {
    // The anonymous session's first call publishes it (it created the file)
    // and stalls before its version insert. A second call finishes the
    // publication, an editor adds a later version, and the first resumes.
    let holdNextVersionMiss = false;
    let stalled!: () => void;
    const duplicateStalled = new Promise<void>((resolve) => { stalled = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    let publishingSessionId: string | undefined;
    const database: Adapter = createUniqueEnforcingDb({
      async afterFindOne(model, result) {
        // The version check of the publication (not the one before the claim).
        if (
          model === 'fileVersions' && result === null && holdNextVersionMiss &&
          (await rawSession(database, publishingSessionId!))?.status === 'publishing'
        ) {
          holdNextVersionMiss = false;
          stalled();
          await resumed;
        }
      },
    });
    const editorAuthorizer: Authorizer = {
      async canRead(file, ctx) { return file.ownerId === (ctx.principalId ?? 'anonymous') || ctx.principalId === 'editor'; },
      async canWrite(file, ctx) { return file.ownerId === ctx.principalId || ctx.principalId === 'editor'; },
      async canDelete(file, ctx) { return file.ownerId === ctx.principalId; },
    };
    const storageFixture = createStorage('multipart');
    const completionTimeoutSeconds = 0.05;
    const app = createApp({ mode: 'multipart', database, storageFixture, authorizer: editorAuthorizer, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const other = createApp({ mode: 'multipart', database, storageFixture, authorizer: editorAuthorizer, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const staged = await app.stage(undefined, CLIENT_ID, 'anonymous capture');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
    publishingSessionId = staged.uploadSessionId;

    holdNextVersionMiss = true;
    const duplicate = other.call('POST', `/upload/${staged.uploadSessionId}/complete`, { token: staged.token });
    await duplicateStalled;
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('publishing');
    await new Promise((resolve) => setTimeout(resolve, 60));
    const first = await staged.complete();
    expect(first.status).toBe(200);
    const edit = await app.stage('editor', CLIENT_ID, 'edited later');
    const edited = await edit.complete();
    expect(edited.status).toBe(200);
    resume();
    const second = await duplicate;

    expect(second.status).toBe(200);
    expect(second.json.data).toEqual(first.json.data);
    expect(storageFixture.finalizeCount(key)).toBe(1);
    expect(app.fixture.objects.has(key)).toBe(true);
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
    expect((await fileRows(database, CLIENT_ID))[0].currentVersionId).toBe(edited.json.data.versionId);
  });

});

describe('refused completion cleanup', () => {
  const expireSession = (database: Adapter, uploadSessionId: string) =>
    database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      namespace: 'filefn',
    });
  const partRows = (database: Adapter, uploadSessionId: string) =>
    database.findMany({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      namespace: 'filefn',
    });

  /**
   * user_b's completion is refused after user_a created CLIENT_ID; the first
   * `failures` deletes of the loser's own key fail. A commit-time refusal puts
   * the loser in another process (one process serializes completions per ID).
   */
  async function refuseLoser(options: { stage: 'early' | 'commit'; mode?: Mode; dedup?: boolean; failures: number }) {
    const mode = options.mode ?? 'multipart';
    const database = memoryAdapter();
    const storageFixture = createStorage(mode);
    const app = createApp({ mode, database, storageFixture, dedup: options.dedup });
    const loserApp = options.stage === 'commit'
      ? createApp({ mode, database, storageFixture, dedup: options.dedup, createFileFn: await loadProcess() })
      : app;
    const text = options.dedup ? 'same bytes' : 'loser bytes';
    const loser = await loserApp.stage('user_b', CLIENT_ID, text);
    const winner = await app.stage('user_a', CLIENT_ID, options.dedup ? 'same bytes' : 'winner bytes');
    const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
    const winnerKey = (await rawSession(database, winner.uploadSessionId))!.storageKey;
    let refused;
    if (options.stage === 'early') {
      // The loser's earlier attempt finalized its object, then failed.
      await storageFixture.storage.completeMultipartUpload!({
        key: loserKey,
        uploadId: [...storageFixture.uploads.entries()].find(([, upload]) => upload.key === loserKey)![0],
        parts: [{ partNumber: 1, etag: 'x' }],
      });
      expect((await winner.complete()).status).toBe(200);
      storageFixture.deleteFailures.set(loserKey, options.failures);
      refused = await loser.complete();
    } else {
      storageFixture.deleteFailures.set(loserKey, options.failures);
      const release = storageFixture.gate(loserKey);
      const losing = loser.complete();
      expect((await winner.complete()).status).toBe(200);
      release();
      refused = await losing;
    }
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('FILEFN_FORBIDDEN');
    return { database, storageFixture, app, loser, loserKey, winnerKey };
  }

  /** The session is fenced: refused (clients see aborted), and a retry is refused without publishing. */
  async function expectFenced(app: ReturnType<typeof createApp>, database: Adapter, loser: { uploadSessionId: string; complete: () => Promise<{ status: number; json: any }> }) {
    expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('refused');
    const retried = await loser.complete();
    expect(retried.status).toBe(410);
    expect(retried.json.error.code).toBe('FILEFN_UPLOAD_ABORTED');
    expect(await fileRows(database, CLIENT_ID)).toHaveLength(1);
  }

  for (const stage of ['early', 'commit'] as const) {
    it(`a refused completion whose object delete fails (${stage} refusal) is fenced as refused, and the expiry sweep deletes its object`, async () => {
      const { database, storageFixture, app, loser, loserKey } = await refuseLoser({ stage, failures: 1 });
      expect(storageFixture.objects.has(loserKey)).toBe(true);
      await expectFenced(app, database, loser);
      expect(storageFixture.objects.has(loserKey)).toBe(true);

      // The sweep retries the delete before dropping the session.
      await expireSession(database, loser.uploadSessionId);
      storageFixture.deleteFailures.set(loserKey, 1);
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await rawSession(database, loser.uploadSessionId)).not.toBeNull();
      expect(storageFixture.objects.has(loserKey)).toBe(true);
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
      expect(storageFixture.objects.has(loserKey)).toBe(false);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('winner bytes');
    });
  }

  it('a dedup-reused refusal whose own-object delete fails is fenced, and the sweep deletes its object but keeps the shared one', async () => {
    // The refusal's delete of the loser's object fails (dedup keeps a session's
    // own object until the session is completed, so it never deletes it here).
    const { database, storageFixture, app, loser, loserKey, winnerKey } = await refuseLoser({ stage: 'commit', dedup: true, failures: 1 });
    expect(storageFixture.objects.has(loserKey)).toBe(true);
    await expectFenced(app, database, loser);

    await expireSession(database, loser.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
    expect(storageFixture.objects.has(loserKey)).toBe(false);
    expect(storageFixture.objects.has(winnerKey)).toBe(true);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('same bytes');
  });

  it('deleting the winner\'s file keeps a refused session with a failed delete until the sweep deletes its object', async () => {
    const { database, storageFixture, app, loser, loserKey } = await refuseLoser({ stage: 'commit', mode: 'proxy', failures: 1 });
    await app.fileFn.services.files.deleteFile(CLIENT_ID, { principalId: 'user_a' });
    expect(await fileRows(database, CLIENT_ID)).toHaveLength(0);
    expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('refused');
    expect(await partRows(database, loser.uploadSessionId)).toHaveLength(1);
    expect(storageFixture.objects.has(loserKey)).toBe(true);

    await expireSession(database, loser.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
    expect(storageFixture.objects.has(loserKey)).toBe(false);
  });

  it('an owner\'s abort of a refused session with a failed delete leaves its record for the sweep', async () => {
    const { database, storageFixture, app, loser, loserKey } = await refuseLoser({ stage: 'commit', mode: 'proxy', failures: 1 });
    const aborted = await app.call('POST', `/upload/${loser.uploadSessionId}/abort`, { user: 'user_b' });
    expect(aborted.status).toBe(200);
    expect(await partRows(database, loser.uploadSessionId)).toHaveLength(1);

    await expireSession(database, loser.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
    expect(storageFixture.objects.has(loserKey)).toBe(false);
  });

  /**
   * A zero-byte proxy upload (no part rows) by user_b, refused at commit in
   * another process after user_a created CLIENT_ID; the first `failures`
   * deletes of the loser's own key fail.
   */
  async function refuseZeroByteLoser(options: { dedup: boolean; failures: number }) {
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const app = createApp({ mode: 'proxy', database, storageFixture, dedup: options.dedup });
    const loserApp = createApp({ mode: 'proxy', database, storageFixture, dedup: options.dedup, createFileFn: await loadProcess() });
    const started = await loserApp.init('user_b', CLIENT_ID, new Uint8Array(0));
    expect(started.status).toBe(200);
    const { uploadSessionId, uploadSessionToken } = started.json.data;
    const loser = {
      uploadSessionId,
      complete: () => loserApp.call('POST', `/upload/${uploadSessionId}/complete`, { user: 'user_b', token: uploadSessionToken }),
    };
    const winnerStarted = await app.init('user_a', CLIENT_ID, new Uint8Array(0));
    expect(winnerStarted.status).toBe(200);
    const winnerSession = winnerStarted.json.data;
    const loserKey = (await rawSession(database, uploadSessionId))!.storageKey;
    const winnerKey = (await rawSession(database, winnerSession.uploadSessionId))!.storageKey;
    storageFixture.deleteFailures.set(loserKey, options.failures);
    const release = storageFixture.gate(loserKey);
    const losing = loser.complete();
    const won = await app.call('POST', `/upload/${winnerSession.uploadSessionId}/complete`, { user: 'user_a', token: winnerSession.uploadSessionToken });
    expect(won.status).toBe(200);
    release();
    const refused = await losing;
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe('FILEFN_FORBIDDEN');
    expect(await partRows(database, uploadSessionId)).toHaveLength(0);
    return { database, storageFixture, app, loser, loserKey, winnerKey, uploadSessionToken };
  }

  for (const dedup of [false, true]) {
    it(`a zero-byte refusal${dedup ? ' with dedup' : ''} whose own-object delete fails keeps its record until a sweep deletes the object`, async () => {
      // With dedup, dedup's own delete of the loser's object fails too.
      const { database, storageFixture, app, loser, loserKey, winnerKey, uploadSessionToken } =
        await refuseZeroByteLoser({ dedup, failures: dedup ? 2 : 1 });
      expect(storageFixture.objects.has(loserKey)).toBe(true);
      await expectFenced(app, database, loser);
      const status = await app.fileFn.services.uploads.getSessionStatus(loser.uploadSessionId, { principalId: 'user_b' }, uploadSessionToken);
      expect(status.status).toBe('aborted');

      await expireSession(database, loser.uploadSessionId);
      storageFixture.deleteFailures.set(loserKey, 1);
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('refused');
      expect(storageFixture.objects.has(loserKey)).toBe(true);
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
      expect(storageFixture.objects.has(loserKey)).toBe(false);
      expect(storageFixture.objects.has(winnerKey)).toBe(true);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('');
    });
  }

  it('a zero-byte refused session survives an owner abort and deleting the winner\'s file until the sweep deletes its object', async () => {
    const { database, storageFixture, app, loser, loserKey, uploadSessionToken } = await refuseZeroByteLoser({ dedup: false, failures: 1 });
    const aborted = await app.call('POST', `/upload/${loser.uploadSessionId}/abort`, { user: 'user_b', token: uploadSessionToken });
    expect(aborted.status).toBe(200);
    await app.fileFn.services.files.deleteFile(CLIENT_ID, { principalId: 'user_a' });
    expect(await fileRows(database, CLIENT_ID)).toHaveLength(0);
    expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('refused');
    expect(storageFixture.objects.has(loserKey)).toBe(true);

    await expireSession(database, loser.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
    expect(storageFixture.objects.has(loserKey)).toBe(false);
  });

  it('a refusal whose proxy part delete fails is fenced with its parts until the sweep deletes them', async () => {
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const app = createApp({ mode: 'proxy', database, storageFixture });
    const loser = await app.stage('user_b', CLIENT_ID, 'loser part');
    const winner = await app.stage('user_a', CLIENT_ID, 'winner');
    expect((await winner.complete()).status).toBe(200);
    const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
    const partKey = `${loserKey}.part1`;
    expect(storageFixture.objects.has(partKey)).toBe(true);
    storageFixture.deleteFailures.set(partKey, 1);

    const refused = await loser.complete();
    expect(refused.status).toBe(403);
    expect(storageFixture.objects.has(partKey)).toBe(true);
    expect(await partRows(database, loser.uploadSessionId)).toHaveLength(1);
    await expectFenced(app, database, loser);

    await expireSession(database, loser.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(storageFixture.objects.has(partKey)).toBe(false);
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
  });

  it('a commit-time refusal whose proxy part delete fails is fenced until the sweep deletes the part', async () => {
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const app = createApp({ mode: 'proxy', database, storageFixture });
    const loserApp = createApp({ mode: 'proxy', database, storageFixture, createFileFn: await loadProcess() });
    const loser = await loserApp.stage('user_b', CLIENT_ID, 'loser part');
    const winner = await app.stage('user_a', CLIENT_ID, 'winner');
    const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
    const partKey = `${loserKey}.part1`;
    // The refusal's part delete fails (stitching keeps the parts).
    storageFixture.deleteFailures.set(partKey, 1);
    const release = storageFixture.gate(loserKey);
    const losing = loser.complete();
    expect((await winner.complete()).status).toBe(200);
    release();
    const refused = await losing;

    expect(refused.status).toBe(403);
    expect(storageFixture.objects.has(partKey)).toBe(true);
    expect(storageFixture.objects.has(loserKey)).toBe(false);
    await expectFenced(app, database, loser);

    await expireSession(database, loser.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(storageFixture.objects.has(partKey)).toBe(false);
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
  });
});


/** Lets pending promise continuations (not timers) run. */
async function flushPromises(rounds = 50) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Rejects if `promise` has not settled within `ms` of real time. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not settled within ${ms}ms`)), ms)),
  ]);
}

describe('in-process completion serialization bound', () => {
  it('a waiter fails fast with the retryable error by its own timer when the holder never settles and armed no timer', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 20 });
    // Timers armed while the holder starts never fire (as in a cancelled
    // Workers request), so only a timer the waiter arms can bound its wait.
    vi.stubGlobal('setTimeout', () => 0);
    void run('k', () => new Promise<never>(() => {}));
    await Promise.resolve();
    await Promise.resolve();
    vi.unstubAllGlobals();

    let ran = false;
    const waited = run('k', async () => {
      ran = true;
    });
    const error = await within(waited.then(() => null, (err: unknown) => err), 2000);
    expect(error).toMatchObject({ code: 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS', status: 409, details: { retryable: true } });
    expect(ran).toBe(false);
    // Timed-out waiters leave nothing behind: only the holder's entry remains.
    await Promise.all([1, 2, 3].map(() => run('k', async () => {}).catch(() => {})));
    expect(run.activeKeys()).toBe(1);
  });

  it('a waiter never runs while a slow holder is still running, and the key is released when it settles', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 250 });
    let finishHolder!: () => void;
    let holderRunning = true;
    const holder = run('k', () => new Promise<void>((resolve) => {
      finishHolder = () => {
        holderRunning = false;
        resolve();
      };
    }));
    const overlapped: boolean[] = [];
    const timedOut = run('k', async () => {
      overlapped.push(holderRunning);
    });
    await expect(timedOut).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS' });
    // A call that arrives before the holder settles waits for it, then runs.
    const queued = run('k', async () => {
      overlapped.push(holderRunning);
    });
    await flushPromises(5);
    finishHolder();
    await holder;
    await queued;
    expect(overlapped).toEqual([false]);
    expect(run.activeKeys()).toBe(0);
  });

  it('calls that settle in time run one at a time and leave no key behind', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 1000 });
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    };
    await Promise.all([run('k', task), run('k', task), run('k', task)]);
    expect(maxRunning).toBe(1);
    expect(run.activeKeys()).toBe(0);
  });

  it('a waiter takes the key from a holder past its evictableAt, and the evicted holder no longer releases it', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 250 });
    let finishEvicted!: () => void;
    const evicted = run('k', () => new Promise<void>((resolve) => { finishEvicted = resolve; }), { evictableAt: Date.now() });
    let finishTaker!: () => void;
    let takerRunning = false;
    const taker = run('k', () => new Promise<void>((resolve) => {
      takerRunning = true;
      finishTaker = () => {
        takerRunning = false;
        resolve();
      };
    }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(takerRunning).toBe(true);

    finishEvicted();
    await evicted;
    const overlapped: boolean[] = [];
    const next = run('k', async () => {
      overlapped.push(takerRunning);
    });
    await flushPromises(5);
    expect(overlapped).toEqual([]);
    finishTaker();
    await taker;
    await next;
    expect(overlapped).toEqual([false]);
    expect(run.activeKeys()).toBe(0);
  });

  it('a holder whose evictableAt has not passed keeps its key', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 20 });
    void run('k', () => new Promise<never>(() => {}), { evictableAt: Date.now() + 60_000 });
    await expect(run('k', async () => {})).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS' });
  });

  it('calls of a group run one at a time even when both probe a busy key at once, and never wait on another group', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 60_000 });
    const sameGroup = (group: string) => async (members: readonly string[]) => members.some((member) => member.startsWith(group));
    let releaseX!: () => void;
    const x = run('k', () => new Promise<void>((resolve) => { releaseX = resolve; }), { member: 'x1', sharesKeyWith: sameGroup('x') });
    const order: string[] = [];
    let releaseY1!: () => void;
    const y1 = run('k', async () => {
      order.push('y1 start');
      await new Promise<void>((resolve) => { releaseY1 = resolve; });
      order.push('y1 end');
    }, { member: 'y1', sharesKeyWith: sameGroup('y') });
    const y2 = run('k', async () => { order.push('y2'); }, { member: 'y2', sharesKeyWith: sameGroup('y') });
    await flushPromises();
    expect(order).toEqual(['y1 start']);
    releaseY1();
    await Promise.all([y1, y2]);
    expect(order).toEqual(['y1 start', 'y1 end', 'y2']);
    expect(run.activeKeys()).toBe(1);
    releaseX();
    await x;
    expect(run.activeKeys()).toBe(0);
  });

  it('a call whose group probe stalls fails with the retryable error by its wait bound, without running', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 20 });
    let releaseX!: () => void;
    const x = run('k', () => new Promise<void>((resolve) => { releaseX = resolve; }), { member: 'x1' });
    let ran = false;
    const stalled = run('k', async () => { ran = true; }, { member: 'y1', sharesKeyWith: () => new Promise<boolean>(() => {}) });
    await expect(stalled).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS' });
    expect(ran).toBe(false);
    releaseX();
    await x;
    expect(run.activeKeys()).toBe(0);
  });

  it('a call whose group probe succeeds late fails at its original wait bound, without running or staying queued', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const run = createKeyedSerializer({ waitTimeoutMs: 30_000 });
    let releaseX!: () => void;
    const x = run('k', () => new Promise<void>((resolve) => { releaseX = resolve; }), { member: 'x1' });
    let ran = false;
    let outcome: string | undefined;
    void run('k', async () => { ran = true; }, {
      member: 'x2',
      sharesKeyWith: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 29_000)),
    }).then(() => { outcome = 'ran'; }, (error: { code?: string }) => { outcome = error.code; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
    releaseX();
    await x;
    await flushPromises();
    expect(ran).toBe(false);
    expect(run.activeKeys()).toBe(0);
  });

  for (const handover of ['release', 'eviction'] as const) {
    it(`a keepWaiting call whose group probe succeeds late keeps waiting past the bound and runs on ${handover}`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const run = createKeyedSerializer({ waitTimeoutMs: 30_000 });
      let releaseX!: () => void;
      const evictableAt = handover === 'eviction' ? Date.now() + 75_000 : undefined;
      const x = run('k', () => new Promise<void>((resolve) => { releaseX = resolve; }), { member: 'x1', evictableAt });
      let ran = false;
      const late = run('k', async () => { ran = true; }, {
        member: 'x2',
        keepWaiting: true,
        sharesKeyWith: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 29_000)),
      });
      await vi.advanceTimersByTimeAsync(70_000);
      expect(ran).toBe(false);
      if (handover === 'release') releaseX();
      else await vi.advanceTimersByTimeAsync(30_000);
      await late;
      expect(ran).toBe(true);
      releaseX();
      await x;
      expect(run.activeKeys()).toBe(0);
    });
  }

  for (const mode of ['multipart', 'proxy'] as const) {
    it(`${mode}: a retried completion while the first call is still running past the wait bound gets 409 and storage is finalized once`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const database = memoryAdapter();
      const app = createApp({ mode, database });
      const staged = await app.stage('user_a', CLIENT_ID, 'slow but alive');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      // The first call stalls after finalizing storage and resumes later.
      const resume = app.fixture.holdStat(key);
      const first = staged.complete();
      await flushPromises();
      expect(app.fixture.finalizeCount(key)).toBe(1);

      const retried = staged.complete();
      await flushPromises();
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS);
      const busy = await retried;
      expect(busy.status).toBe(409);
      expect(busy.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');

      resume();
      const done = await first;
      expect(done.status).toBe(200);
      expect(app.fixture.finalizeCount(key)).toBe(1);
      const again = await staged.complete();
      expect(again.status).toBe(200);
      expect(again.json.data).toEqual(done.json.data);
      expect(app.fixture.finalizeCount(key)).toBe(1);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('slow but alive');
    });
  }

  /** A memory adapter whose first files insert, once armed, waits for release() and then runs afterInsert. */
  function holdFirstFilesInsert() {
    const base = memoryAdapter();
    let hold: Promise<void> | undefined;
    let release!: () => void;
    const control = {
      afterInsert: undefined as (() => Promise<void>) | undefined,
      arm() { hold = new Promise<void>((resolve) => { release = resolve; }); },
      release: () => release(),
    };
    const database = {
      ...base,
      async create(params: Parameters<Adapter['create']>[0]) {
        if (params.model === 'files' && hold) {
          const waitFor = hold;
          hold = undefined;
          await waitFor;
          const created = await base.create(params);
          await control.afterInsert?.();
          return created;
        }
        return base.create(params);
      },
    } as Adapter;
    expect(database.capabilities.schema.constraints).toBe(false);
    return { base, database, control };
  }

  for (const granted of [false, true]) {
    it(`memory adapter: a completion of the same new ID behind a commit held past the wait bound gets 409 before its storage step, then ${granted ? 'adds a version' : '403'}`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { database, control } = holdFirstFilesInsert();
      const app = createApp({ mode: 'multipart', database, grants: true });
      const a = await app.stage('user_a', CLIENT_ID, 'holder bytes');
      const b = await app.stage('user_b', CLIENT_ID, 'waiter bytes');
      const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;
      control.arm();
      const first = a.complete();
      await flushPromises();

      const waiting = b.complete();
      await flushPromises();
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS);
      const busy = await waiting;
      expect(busy.status).toBe(409);
      expect(busy.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
      expect(app.fixture.finalizeCount(keyB)).toBe(0);
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(0);

      control.release();
      expect((await first).status).toBe(200);
      if (granted) {
        await app.fileFn.services.grants.createGrant({ fileId: CLIENT_ID, userId: 'user_b', canWrite: true }, { principalId: 'user_a' });
      }
      const retried = await b.complete();
      const rows = await fileRows(database, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe('user_a');
      if (granted) {
        expect(retried.status).toBe(200);
        expect(rows[0].currentVersionId).toBe(retried.json.data.versionId);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('waiter bytes');
      } else {
        expect(retried.status).toBe(403);
        expect(app.fixture.objects.has(keyB)).toBe(false);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('holder bytes');
      }
    });

    it(`memory adapter: a completion whose storage step finished behind a commit of the same new ID keeps waiting past the bound, never a 409, then ${granted ? 'adds a version' : '403'}`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { database, control } = holdFirstFilesInsert();
      const app = createApp({ mode: 'multipart', database, grants: true });
      const a = await app.stage('user_a', CLIENT_ID, 'holder bytes');
      const b = await app.stage('user_b', CLIENT_ID, 'waiter bytes');
      const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;
      if (granted) {
        // Still inside the holder's commit, so before the waiter's commit runs.
        control.afterInsert = async () => {
          await app.fileFn.services.grants.createGrant({ fileId: CLIENT_ID, userId: 'user_b', canWrite: true }, { principalId: 'user_a' });
        };
      }
      // B passes its pre-storage wait, then A's commit starts while B is in storage.
      const resumeB = app.fixture.holdStat(keyB);
      let settled = false;
      const waiting = b.complete().finally(() => { settled = true; });
      await flushPromises();
      expect(app.fixture.finalizeCount(keyB)).toBe(1);
      control.arm();
      const first = a.complete();
      await flushPromises();
      resumeB();
      await flushPromises();
      await vi.advanceTimersByTimeAsync(3 * SERIALIZED_WAIT_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(0);

      control.release();
      expect((await first).status).toBe(200);
      const done = await waiting;
      const rows = await fileRows(database, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe('user_a');
      if (granted) {
        expect(done.status).toBe(200);
        expect(rows[0].currentVersionId).toBe(done.json.data.versionId);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('waiter bytes');
      } else {
        expect(done.status).toBe(403);
        expect(app.fixture.objects.has(keyB)).toBe(false);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('holder bytes');
      }
    });
  }

  it('memory adapter: a completion held in storage does not block another session of the same new ID, and the first commit wins', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    const a = await app.stage('user_a', CLIENT_ID, 'held in storage');
    const b = await app.stage('user_b', CLIENT_ID, 'prompt bytes');
    const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
    const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;
    const resume = app.fixture.holdStat(keyA);
    const held = a.complete();
    await flushPromises();

    let settled = false;
    const other = b.complete().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS - 1);
    expect(settled).toBe(true);
    expect((await other).status).toBe(200);

    resume();
    const lost = await held;
    expect(lost.status).toBe(403);
    const rows = await fileRows(database, CLIENT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe('user_b');
    expect(app.fixture.objects.has(keyA)).toBe(false);
    expect(app.fixture.objects.has(keyB)).toBe(true);
    expect(await app.readBytes(CLIENT_ID, 'user_b')).toBe('prompt bytes');
  });

  it('memory adapters: a completion held in storage on one store does not make a completion of the same ID on another store wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const databaseOne = memoryAdapter();
    const one = createApp({ mode: 'multipart', database: databaseOne });
    const two = createApp({ mode: 'multipart', database: memoryAdapter() });
    const a = await one.stage('user_a', CLIENT_ID, 'bytes in one');
    const b = await two.stage('user_b', CLIENT_ID, 'bytes in two');
    const keyA = (await rawSession(databaseOne, a.uploadSessionId))!.storageKey;
    const resume = one.fixture.holdStat(keyA);
    const held = a.complete();
    await flushPromises();
    try {
      let settled = false;
      const other = b.complete().finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS - 1);
      expect(settled).toBe(true);
      expect((await other).status).toBe(200);
      expect(await two.readBytes(CLIENT_ID, 'user_b')).toBe('bytes in two');
    } finally {
      resume();
    }
    expect((await held).status).toBe(200);
    expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('bytes in one');
  });

  it('memory adapters: a commit stalled in the database on one store does not make a completion of the same ID on another store wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { database, control } = holdFirstFilesInsert();
    const one = createApp({ mode: 'multipart', database });
    const two = createApp({ mode: 'multipart', database: memoryAdapter() });
    const a = await one.stage('user_a', CLIENT_ID, 'bytes in one');
    const b = await two.stage('user_b', CLIENT_ID, 'bytes in two');
    control.arm();
    const held = a.complete();
    await flushPromises();
    try {
      let settled = false;
      const other = b.complete().finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS - 1);
      expect(settled).toBe(true);
      expect((await other).status).toBe(200);
      expect(await two.readBytes(CLIENT_ID, 'user_b')).toBe('bytes in two');
    } finally {
      control.release();
    }
    expect((await held).status).toBe(200);
    expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('bytes in one');
  });

  it('memory adapters: a completion past its storage step on one store does not wait for a commit of the same ID stalled in another store', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { database, control } = holdFirstFilesInsert();
    const databaseTwo = memoryAdapter();
    const one = createApp({ mode: 'multipart', database });
    const two = createApp({ mode: 'multipart', database: databaseTwo });
    const a = await one.stage('user_a', CLIENT_ID, 'bytes in one');
    const b = await two.stage('user_b', CLIENT_ID, 'bytes in two');
    const keyB = (await rawSession(databaseTwo, b.uploadSessionId))!.storageKey;
    const resumeB = two.fixture.holdStat(keyB);
    let settled = false;
    const other = b.complete().finally(() => { settled = true; });
    await flushPromises();
    expect(two.fixture.finalizeCount(keyB)).toBe(1);
    control.arm();
    const held = a.complete();
    await flushPromises();
    try {
      resumeB();
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS - 1);
      expect(settled).toBe(true);
      expect((await other).status).toBe(200);
      expect(await two.readBytes(CLIENT_ID, 'user_b')).toBe('bytes in two');
    } finally {
      control.release();
    }
    expect((await held).status).toBe(200);
    expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('bytes in one');
  });

  it('memory adapters: two completions of one new ID on a store serialize among themselves, not behind a commit stalled in another store', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { database, control } = holdFirstFilesInsert();
    const databaseTwo = memoryAdapter();
    const one = createApp({ mode: 'multipart', database });
    const two = createApp({ mode: 'multipart', database: databaseTwo });
    const a = await one.stage('user_a', CLIENT_ID, 'bytes in one');
    const b1 = await two.stage('user_b', CLIENT_ID, 'bytes of b1');
    const b2 = await two.stage('user_c', CLIENT_ID, 'bytes of b2');
    const key1 = (await rawSession(databaseTwo, b1.uploadSessionId))!.storageKey;
    const key2 = (await rawSession(databaseTwo, b2.uploadSessionId))!.storageKey;
    control.arm();
    const held = a.complete();
    await flushPromises();
    try {
      let settled = 0;
      const both = Promise.all([b1.complete(), b2.complete()].map((call) => call.finally(() => { settled += 1; })));
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS - 1);
      expect(settled).toBe(2);
      const [res1, res2] = await both;
      expect([res1.status, res2.status].sort()).toEqual([200, 403]);
      const firstWon = res1.status === 200;
      const rows = await fileRows(databaseTwo, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe(firstWon ? 'user_b' : 'user_c');
      expect(two.fixture.objects.has(firstWon ? key2 : key1)).toBe(false);
      expect(await two.readBytes(CLIENT_ID, firstWon ? 'user_b' : 'user_c')).toBe(firstWon ? 'bytes of b1' : 'bytes of b2');
    } finally {
      control.release();
    }
    expect((await held).status).toBe(200);
  });

  for (const wrap of ['spread', 'instrumented'] as const) {
    it(`memory adapter: a completion through another adapter object (${wrap}) over the store waits for a commit of the same ID stalled in it, then 403`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { base, database, control } = holdFirstFilesInsert();
      const silent = { debug() {}, info() {}, warn() {}, error() {} };
      const other = wrap === 'spread'
        ? ({ ...base } as Adapter)
        : instrumentAdapter(base, { observability: normalizeObservability({ logger: silent }) });
      const storageFixture = createStorage('multipart');
      const one = createApp({ mode: 'multipart', database, storageFixture });
      const two = createApp({ mode: 'multipart', database: other, storageFixture });
      const a = await one.stage('user_a', CLIENT_ID, 'stalled winner');
      const b = await two.stage('user_b', CLIENT_ID, 'same store loser');
      const keyB = (await rawSession(base, b.uploadSessionId))!.storageKey;
      control.arm();
      const first = a.complete();
      await flushPromises();
      let settled = false;
      const second = b.complete().finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS / 2);
      expect(settled).toBe(false);
      expect(storageFixture.finalizeCount(keyB)).toBe(0);

      control.release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(403);
      const rows = await fileRows(base, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe('user_a');
      expect(storageFixture.objects.has(keyB)).toBe(false);
      expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('stalled winner');
    });
  }

  for (const phase of ['before its storage step', 'at its commit step'] as const) {
    it(`unique-enforcing adapter: a completion that waited out a commit stalled on the same ID ${phase} takes the key, and the unique insert arbitrates them`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let holdFilesInsert: Promise<void> | undefined;
      const uniqueDb = createUniqueEnforcingDb({
        before: async (model) => {
          // Holds only the first files insert once armed: A's, inside its commit step.
          if (model === 'files' && holdFilesInsert) {
            const hold = holdFilesInsert;
            holdFilesInsert = undefined;
            await hold;
          }
        },
      });
      const database = {
        ...uniqueDb,
        capabilities: { ...uniqueDb.capabilities, schema: { ...uniqueDb.capabilities.schema, constraints: true } },
      } as Adapter;
      const storageFixture = createStorage('multipart');
      const app = createApp({ mode: 'multipart', database, storageFixture });
      const a = await app.stage('user_a', CLIENT_ID, 'stalled bytes');
      const b = await app.stage('user_b', CLIENT_ID, 'prompt bytes');
      const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
      const keyB = (await rawSession(database, b.uploadSessionId))!.storageKey;
      let releaseInsert!: () => void;
      const arm = () => { holdFilesInsert = new Promise<void>((resolve) => { releaseInsert = resolve; }); };

      let prompt: ReturnType<typeof b.complete>;
      if (phase === 'before its storage step') {
        arm();
        const stalled = a.complete();
        await flushPromises();
        prompt = b.complete();
        await flushPromises();
        expect(storageFixture.finalizeCount(keyB)).toBe(0);
        await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS);
        const won = await prompt;
        expect(won.status).toBe(200);
        releaseInsert();
        expect((await stalled).status).toBe(403);
      } else {
        // B passes its pre-storage wait, then A's commit stalls while B is in storage.
        const resumeB = storageFixture.holdStat(keyB);
        prompt = b.complete();
        await flushPromises();
        arm();
        const stalled = a.complete();
        await flushPromises();
        resumeB();
        await flushPromises();
        expect(storageFixture.finalizeCount(keyB)).toBe(1);
        await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS);
        const won = await prompt;
        expect(won.status).toBe(200);
        releaseInsert();
        expect((await stalled).status).toBe(403);
      }
      const rows = await fileRows(database, CLIENT_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0].ownerId).toBe('user_b');
      expect(storageFixture.objects.has(keyA)).toBe(false);
      expect(storageFixture.objects.has(keyB)).toBe(true);
      expect(await app.readBytes(CLIENT_ID, 'user_b')).toBe('prompt bytes');
    });
  }

  it('unique-enforcing adapters: completions of one new ID against two databases in one process do not wait on each other', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const uniqueDatabase = () => {
      const uniqueDb = createUniqueEnforcingDb({});
      return {
        ...uniqueDb,
        capabilities: { ...uniqueDb.capabilities, schema: { ...uniqueDb.capabilities.schema, constraints: true } },
      } as Adapter;
    };
    const databaseOne = uniqueDatabase();
    const one = createApp({ mode: 'multipart', database: databaseOne });
    const two = createApp({ mode: 'multipart', database: uniqueDatabase() });
    const a = await one.stage('user_a', CLIENT_ID, 'bytes in one');
    const b = await two.stage('user_b', CLIENT_ID, 'bytes in two');
    const keyA = (await rawSession(databaseOne, a.uploadSessionId))!.storageKey;
    const resume = one.fixture.holdStat(keyA);
    const held = a.complete();
    await flushPromises();

    try {
      let settled = false;
      const other = b.complete().finally(() => { settled = true; });
      // Short of the wait bound, after which a waiter would take the key.
      await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS - 1);
      expect(settled).toBe(true);
      const done = await other;
      expect(done.status).toBe(200);
      expect(await two.readBytes(CLIENT_ID, 'user_b')).toBe('bytes in two');
    } finally {
      resume();
    }
    expect((await held).status).toBe(200);
    expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('bytes in one');
  });

  it('a completion behind a call that never settles reports the session expired once it has expired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    // Its own ID: the stuck call keeps holding this process's key for it.
    const staged = await app.stage('user_a', 'file_neverSettles01', 'never finishes');
    // The first call's storage completion never resolves (a cancelled request).
    app.fixture.storage.completeMultipartUpload = () => new Promise<never>(() => {});
    void staged.complete();
    await flushPromises();

    const early = staged.complete();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS);
    expect((await early).status).toBe(409);

    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    const late = staged.complete();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(2 * SERIALIZED_WAIT_TIMEOUT_MS);
    const expired = await late;
    expect(expired.status).toBe(410);
    expect(expired.json.error.code).toBe('FILEFN_UPLOAD_EXPIRED');
  });
});

describe('expiry cleanup of a session whose object another file shares', () => {
  /**
   * A publishes a version but its session stays pending; B dedups onto A's
   * object; deleting A's file keeps the shared object and fails before it
   * removes A's session. Returns the app with A's session pending.
   */
  async function setupSharedObject() {
    const base = memoryAdapter();
    const failNext = new Set<string>();
    const findManyModels: string[] = [];
    const database = {
      ...base,
      async update(params: Parameters<Adapter['update']>[0]) {
        if (params.model === 'uploadSessions' && (params.data as { status?: string }).status === 'completed' && failNext.delete('session-completed')) {
          throw new Error('transient update failure');
        }
        return base.update(params);
      },
      async findMany(params: Parameters<Adapter['findMany']>[0]) {
        findManyModels.push(params.model);
        if (params.model === 'fileArtifacts' && params.where?.length && failNext.delete('artifact-list')) {
          throw new Error('transient list failure');
        }
        return base.findMany(params);
      },
    } as Adapter;
    const storageFixture = createStorage('multipart');
    const app = createApp({ mode: 'multipart', database, storageFixture, dedup: true });

    // A publishes its version, but marking its session completed fails.
    const a = await app.stage('user_a', CLIENT_ID, 'shared bytes');
    const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
    failNext.add('session-completed');
    await expect(app.fileFn.services.uploads.completeSession(a.uploadSessionId, { principalId: 'user_a' }, a.token)).rejects.toThrow('transient update failure');
    expect((await rawSession(database, a.uploadSessionId))!.status).toBe('publishing');
    // As a session an earlier FileFn left open after publishing its version.
    await database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: a.uploadSessionId }],
      data: { status: 'pending' },
      namespace: 'filefn',
    });

    // B uploads the same bytes under another ID; dedup points it at A's object.
    const b = await app.stage('user_b', undefined, 'shared bytes');
    expect((await b.complete()).status).toBe(200);
    expect(await app.readBytes(b.fileId, 'user_b')).toBe('shared bytes');

    // Deleting A removes A's version, keeps the shared object, then fails
    // before it removes A's pending session.
    failNext.add('artifact-list');
    await expect(app.fileFn.services.files.deleteFile(CLIENT_ID, { principalId: 'user_a' })).rejects.toThrow();
    expect(await rawSession(database, a.uploadSessionId)).not.toBeNull();
    expect(storageFixture.objects.has(keyA)).toBe(true);

    const expire = (uploadSessionId: string) =>
      database.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
        namespace: 'filefn',
      });
    return { database, storageFixture, app, a, b, keyA, expire, findManyModels };
  }

  it('keeps an object a dedup version of another file references after the session\'s own version was deleted', async () => {
    const { database, storageFixture, app, a, b, keyA, expire } = await setupSharedObject();
    await expire(a.uploadSessionId);
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(await rawSession(database, a.uploadSessionId)).toBeNull();
    expect(storageFixture.objects.has(keyA)).toBe(true);
    expect(await app.readBytes(b.fileId, 'user_b')).toBe('shared bytes');
  });

  it('runs one reference lookup per sweep, deleting fenced refused objects and keeping shared and pending ones', async () => {
    const { database, storageFixture, app, a, b, keyA, expire, findManyModels } = await setupSharedObject();
    await expire(a.uploadSessionId);

    // Three expired sessions a refusal fenced (status refused) whose
    // final object is still there, and one expired pending session whose
    // completion finalized its object (it may still publish it).
    const stageWithObject = async (user: string) => {
      const staged = await app.stage(user, undefined, `own object of ${user}`);
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      storageFixture.objects.set(key, Buffer.from(`own object of ${user}`));
      await expire(staged.uploadSessionId);
      return { uploadSessionId: staged.uploadSessionId, key };
    };
    const fenced = [];
    for (const user of ['user_c', 'user_d', 'user_e']) {
      const staged = await stageWithObject(user);
      await database.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: staged.uploadSessionId }],
        data: { status: 'refused' },
        namespace: 'filefn',
      });
      fenced.push(staged);
    }
    const pending = await stageWithObject('user_f');

    findManyModels.length = 0;
    const result = await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(result.deletedSessions).toBe(5);
    expect(findManyModels.filter((model) => model === 'fileVersions')).toHaveLength(1);
    expect(findManyModels.filter((model) => model === 'fileArtifacts')).toHaveLength(1);
    expect(findManyModels.filter((model) => model === 'files')).toHaveLength(1);

    for (const session of fenced) {
      expect(storageFixture.objects.has(session.key)).toBe(false);
      expect(await rawSession(database, session.uploadSessionId)).toBeNull();
    }
    expect(storageFixture.objects.has(pending.key)).toBe(true);
    expect(await rawSession(database, a.uploadSessionId)).toBeNull();
    expect(storageFixture.objects.has(keyA)).toBe(true);
    expect(await app.readBytes(b.fileId, 'user_b')).toBe('shared bytes');
  });
});

describe('expiry cleanup while a completion of the expired session is running', () => {
  /** A's completion finalized its object and is held before publishing; then A's session expires. */
  async function startHeldCompletion(completionTimeoutSeconds?: number) {
    const database = memoryAdapter();
    const storageFixture = createStorage('multipart');
    const app = createApp({ mode: 'multipart', database, storageFixture, dedup: true, completionTimeoutSeconds });
    const a = await app.stage('user_a', CLIENT_ID, 'shared bytes');
    const keyA = (await rawSession(database, a.uploadSessionId))!.storageKey;
    const resume = storageFixture.holdStat(keyA);
    const completion = a.complete();
    await flushPromises();
    expect(storageFixture.objects.has(keyA)).toBe(true);
    await database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: a.uploadSessionId }],
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      namespace: 'filefn',
    });
    return { database, storageFixture, app, a, keyA, resume, completion };
  }

  it('keeps an object published and shared by dedup after the sweep read the session', async () => {
    // A's claim is stale by the time the sweep reads the session, so the sweep
    // takes it up; A still holds it and publishes.
    const { storageFixture, app, keyA, resume, completion } = await startHeldCompletion(0.05);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Pause the sweep at its first storage call, after everything it reads up front.
    let paused!: () => void;
    const sweepPaused = new Promise<void>((resolve) => { paused = resolve; });
    let resumeSweep!: () => void;
    const sweepResumed = new Promise<void>((resolve) => { resumeSweep = resolve; });
    const abort = storageFixture.storage.abortMultipartUpload!.bind(storageFixture.storage);
    storageFixture.storage.abortMultipartUpload = async (input) => {
      paused();
      await sweepResumed;
      return abort(input);
    };
    const sweep = app.fileFn.services.uploads.cleanupExpiredSessions();
    await sweepPaused;

    // A publishes, then B's identical bytes dedup onto A's object.
    resume();
    expect((await completion).status).toBe(200);
    const b = await app.stage('user_b', undefined, 'shared bytes');
    expect((await b.complete()).status).toBe(200);

    resumeSweep();
    await sweep;
    expect(storageFixture.objects.has(keyA)).toBe(true);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('shared bytes');
    expect(await app.readBytes(b.fileId, 'user_b')).toBe('shared bytes');
  });

  it('leaves an expired session whose completion is still running (live claim) to that completion', async () => {
    const { database, storageFixture, app, a, keyA, resume, completion } = await startHeldCompletion();
    const result = await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(result.deletedSessions).toBe(0);
    expect(result.abortedMultipart).toBe(0);
    expect(storageFixture.objects.has(keyA)).toBe(true);

    resume();
    const ended = await completion;
    expect(ended.status).toBe(200);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('shared bytes');
    expect((await rawSession(database, a.uploadSessionId))!.status).toBe('completed');
  });
});

/**
 * The shipped Prisma adapter's update runs updateMany, then finds the row with
 * the same predicate, and throws ADAPTER_NOT_FOUND when either matches nothing.
 */
function prismaStyleUpdate(base: Adapter): Adapter {
  return {
    ...base,
    async update(params: Parameters<Adapter['update']>[0]) {
      const notFound = () => Object.assign(new Error('ADAPTER_NOT_FOUND'), { code: 'ADAPTER_NOT_FOUND' });
      const count = await base.updateMany(params);
      if (!count) throw notFound();
      const row = await base.findOne({ model: params.model, where: params.where, namespace: params.namespace });
      if (!row) throw notFound();
      return row as any;
    },
  } as Adapter;
}

describe('conditional session status writes on Prisma-style update semantics', () => {
  for (const mode of ['multipart', 'proxy'] as const) {
    it(`${mode}: the first part moves the session to in_progress and the completion succeeds`, async () => {
      const database = prismaStyleUpdate(memoryAdapter());
      const app = createApp({ mode, database });
      const staged = await app.stage('user_a', CLIENT_ID, 'hello prisma');
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('in_progress');
      const done = await staged.complete();
      expect(done.status).toBe(200);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('hello prisma');
    });
  }

  it('an owner abort that read an open session refused before its write succeeds and leaves it refused', async () => {
    const base = memoryAdapter();
    let refuseOnRead: string | undefined;
    const database = prismaStyleUpdate({
      ...base,
      async findOne(params: Parameters<Adapter['findOne']>[0]) {
        const row = await base.findOne<{ uploadSessionId: string }>(params);
        if (params.model === 'uploadSessions' && row && row.uploadSessionId === refuseOnRead) {
          refuseOnRead = undefined;
          // A refusal lands between the abort's read and its write.
          await base.updateMany({ model: 'uploadSessions', where: params.where, data: { status: 'refused' }, namespace: params.namespace });
        }
        return row as any;
      },
    } as Adapter);
    const app = createApp({ mode: 'proxy', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'aborted late');
    refuseOnRead = staged.uploadSessionId;
    await app.fileFn.services.uploads.abortSession(staged.uploadSessionId, { principalId: 'user_a' }, staged.token);
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('refused');
  });
});

describe('upload completion fencing (FILE-19)', () => {
  /** The session's claim, dated past the default completion timeout. */
  async function agedClaim(database: Adapter, uploadSessionId: string) {
    const claim = (await rawSession(database, uploadSessionId))!.completionClaim as string;
    return [new Date(Date.now() - 901_000).toISOString(), ...claim.split(' ').slice(1)].join(' ');
  }
  async function setSession(database: Adapter, uploadSessionId: string, data: Record<string, unknown>) {
    await database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
      data,
      namespace: 'filefn',
    });
  }

  for (const mode of ['multipart', 'proxy'] as const) {
    it(`${mode}: an abort during completion gets 409 and the file is published once`, async () => {
      const database = memoryAdapter();
      const app = createApp({ mode, database });
      const uploaded: string[] = [];
      app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
      const staged = await app.stage('user_a', CLIENT_ID, 'kept bytes');
      const auth = { user: 'user_a', token: staged.token };
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      const release = app.fixture.gate(key);
      const completion = staged.complete();
      await flushPromises();
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completing');

      const abort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, auth);
      expect(abort.status).toBe(409);
      expect(abort.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
      const part = await app.call('POST', `/upload/${staged.uploadSessionId}/parts/1/complete`, { ...auth, body: { etag: '"other"', size: 1 } });
      expect(part.status).toBe(409);
      expect(part.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
      const status = await app.call('GET', `/upload/${staged.uploadSessionId}/status`, auth);
      expect(status.json.data.status).toBe('in_progress');

      release();
      const done = await completion;
      expect(done.status).toBe(200);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('kept bytes');
      expect(app.fixture.finalizeCount(key)).toBe(1);
      expect(uploaded).toEqual([done.json.data.versionId]);
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
      const lateAbort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, auth);
      expect(lateAbort.json.error.code).toBe('FILEFN_UPLOAD_ALREADY_COMPLETED');
    });

    it(`${mode}: two concurrent completion calls in two processes return the same result and publish once`, async () => {
      const database = createUniqueEnforcingDb({});
      const storageFixture = createStorage(mode);
      const one = createApp({ mode, database, storageFixture, createFileFn: await loadProcess() });
      const two = createApp({ mode, database, storageFixture, createFileFn: await loadProcess() });
      const uploaded: string[] = [];
      for (const app of [one, two]) app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
      const staged = await one.stage('user_a', CLIENT_ID, 'published once');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      const release = storageFixture.gate(key);

      const first = staged.complete();
      await flushPromises();
      const second = two.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.status).toBe(200);
      expect(secondResult.status).toBe(200);
      expect(secondResult.json.data).toEqual(firstResult.json.data);
      expect(storageFixture.finalizeCount(key)).toBe(1);
      expect(uploaded).toEqual([firstResult.json.data.versionId]);
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(1);
      expect(await one.readBytes(CLIENT_ID, 'user_a')).toBe('published once');
    });
  }

  it('an abort whose write races a completion claim gets 409 and leaves the session to the completion', async () => {
    const base = memoryAdapter();
    let claimBeforeAbortWrite: string | undefined;
    const database = {
      ...base,
      async update(params: Parameters<Adapter['update']>[0]) {
        const sessionId = claimBeforeAbortWrite;
        if (params.model === 'uploadSessions' && (params.data as { status?: string }).status === 'aborted' && sessionId) {
          // Another process claims the session between the abort's read and write.
          claimBeforeAbortWrite = undefined;
          await setSession(base, sessionId, { status: 'completing', completionClaim: `${new Date().toISOString()} other` });
        }
        return base.update(params);
      },
    } as Adapter;
    const app = createApp({ mode: 'multipart', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'claimed first');
    claimBeforeAbortWrite = staged.uploadSessionId;

    const abort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token });
    expect(abort.status).toBe(409);
    expect(abort.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completing');
    // The storage upload the completion needs was left alone.
    expect(app.fixture.uploads.size).toBe(1);
  });

  it('a stale completing session left by a crashed completer is taken over and completes', async () => {
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'taken over');
    // Claimed past the default 900 s completion timeout by a process that crashed.
    const crashedClaim = `${new Date(Date.now() - 901_000).toISOString()} crashed`;
    await setSession(database, staged.uploadSessionId, { status: 'completing', completionClaim: crashedClaim });

    const abort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token });
    expect(abort.status).toBe(409);
    const done = await staged.complete();
    expect(done.status).toBe(200);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('taken over');
    const row = (await rawSession(database, staged.uploadSessionId)) as { status: string; completionClaim: string };
    expect(row.status).toBe('completed');
    expect(row.completionClaim).not.toBe(crashedClaim);
  });

  it('a completion behind a live claim of another process gets the retryable 409 after the wait bound, changing nothing', async () => {
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'still held');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
    const liveClaim = `${new Date().toISOString()} live`;
    await setSession(database, staged.uploadSessionId, { status: 'completing', completionClaim: liveClaim });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = staged.complete();
    await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS + 1_000);
    const res = await pending;
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
    expect(res.json.error.details).toEqual({ retryable: true });
    expect(app.fixture.finalizeCount(key)).toBe(0);
    const row = (await rawSession(database, staged.uploadSessionId)) as { status: string; completionClaim: string };
    expect(row).toMatchObject({ status: 'completing', completionClaim: liveClaim });
  });

  it('proxy: a completion that stalled past the timeout and was taken over writes nothing when it resumes, so the published bytes stay intact', async () => {
    // Process one claims the session and stalls before its storage step. Process
    // two takes the stale session over, stitches, deletes the parts and
    // publishes. Process one then resumes.
    const shared = createUniqueEnforcingDb({});
    let holdNextVersionMiss = false;
    let stalled!: () => void;
    const holderStalled = new Promise<void>((resolve) => { stalled = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const holderDb = {
      ...shared,
      async findOne(params: Parameters<Adapter['findOne']>[0]) {
        const result = await shared.findOne(params);
        // The holder's claim check right before its stitch.
        if (params.model === 'uploadSessions' && (result as { status?: string } | null)?.status === 'completing' && holdNextVersionMiss) {
          holdNextVersionMiss = false;
          stalled();
          await resumed;
        }
        return result;
      },
    } as Adapter;
    const storageFixture = createStorage('proxy');
    const completionTimeoutSeconds = 0.05;
    const holder = createApp({ mode: 'proxy', database: holderDb, storageFixture, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const taker = createApp({ mode: 'proxy', database: shared, storageFixture, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const staged = await holder.stage('user_a', CLIENT_ID, 'published by the taker');
    const key = (await rawSession(shared, staged.uploadSessionId))!.storageKey;

    holdNextVersionMiss = true;
    const first = staged.complete();
    await holderStalled;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
    expect(second.status).toBe(200);
    expect(storageFixture.objects.has(`${key}.part1`)).toBe(false);
    resume();
    const resumedResult = await first;

    expect(resumedResult.status).toBe(200);
    expect(resumedResult.json.data).toEqual(second.json.data);
    // The taker stitched into its own object. The resumed call, past its claim
    // check, stitched the session's key (its own), found the parts gone and
    // published nothing; its object is deleted.
    expect(storageFixture.objects.has(key)).toBe(false);
    expect(await taker.readBytes(CLIENT_ID, 'user_a')).toBe('published by the taker');
  });

  it('proxy: a holder stalled inside opening its stitch, taken over, cannot truncate the published object when it resumes', async () => {
    const shared = createUniqueEnforcingDb({});
    const storageFixture = createStorage('proxy');
    storageFixture.truncateObjectsOnOpen();
    const completionTimeoutSeconds = 0.05;
    const holder = createApp({ mode: 'proxy', database: shared, storageFixture, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const taker = createApp({ mode: 'proxy', database: shared, storageFixture, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const uploaded: string[] = [];
    for (const app of [holder, taker]) app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
    const staged = await holder.stage('user_a', CLIENT_ID, 'intact bytes');
    const key = (await rawSession(shared, staged.uploadSessionId))!.storageKey;

    // The holder passed its claim check and is inside openUploadStream.
    const release = storageFixture.gate(key);
    const first = staged.complete();
    await flushPromises();
    expect(storageFixture.finalizeCount(key)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
    expect(second.status).toBe(200);
    release();
    const resumedResult = await first;

    expect(resumedResult.status).toBe(200);
    expect(resumedResult.json.data).toEqual(second.json.data);
    expect(uploaded).toEqual([second.json.data.versionId]);
    expect(await taker.readBytes(CLIENT_ID, 'user_a')).toBe('intact bytes');
    // The holder's own (truncated) object is deleted; so are the parts.
    expect(storageFixture.objects.has(key)).toBe(false);
    expect(storageFixture.objects.has(`${key}.part1`)).toBe(false);
  });

  /**
   * An authorizer whose `pauseAt`-th canWrite call (1-based) of a non-owner
   * after `arm()` waits for `resume` and then answers `answer`; every other call
   * allows the editor.
   */
  function pausingAuthorizer(pauseAt: number, answer: boolean) {
    let armed = false;
    let calls = 0;
    let paused!: () => void;
    const pausedAt = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const authorizer: Authorizer = {
      async canRead(file, ctx) { return file.ownerId === ctx.principalId || ctx.principalId === 'editor'; },
      async canWrite(file, ctx) {
        if (file.ownerId === ctx.principalId) return true;
        if (armed) calls += 1;
        if (armed && calls === pauseAt) {
          paused();
          await resumed;
          return answer;
        }
        return ctx.principalId === 'editor';
      },
      async canDelete(file, ctx) { return file.ownerId === ctx.principalId; },
    };
    return { authorizer, pausedAt, resume, arm: () => { armed = true; } };
  }

  const editorAuthorizer: Authorizer = {
    async canRead(file, ctx) { return file.ownerId === ctx.principalId || ctx.principalId === 'editor'; },
    async canWrite(file, ctx) { return file.ownerId === ctx.principalId || ctx.principalId === 'editor'; },
    async canDelete(file, ctx) { return file.ownerId === ctx.principalId; },
  };

  /** user_a owns CLIENT_ID; the editor stages a new version of it in the holder process. */
  async function editorSessionOnOwnedFile(holderAuthorizer: Authorizer, holderDb?: (shared: Adapter) => Adapter) {
    const database = createUniqueEnforcingDb({});
    const storageFixture = createStorage('multipart');
    const completionTimeoutSeconds = 0.05;
    const holder = createApp({ mode: 'multipart', database: holderDb ? holderDb(database) : database, storageFixture, authorizer: holderAuthorizer, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const taker = createApp({ mode: 'multipart', database, storageFixture, authorizer: editorAuthorizer, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const created = await taker.stage('user_a', CLIENT_ID, 'original');
    expect((await created.complete()).status).toBe(200);
    const staged = await holder.stage('editor', CLIENT_ID, 'edited');
    return { database, holder, taker, staged };
  }

  it('a holder paused in its commit\'s write check, taken over, never moves the file back from a later version', async () => {
    const pausing = pausingAuthorizer(2, true);
    const { database, taker, staged } = await editorSessionOnOwnedFile(pausing.authorizer);
    pausing.arm();
    const first = staged.complete();
    await pausing.pausedAt;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'editor' });
    expect(second.status).toBe(200);
    const later = await taker.stage('user_a', CLIENT_ID, 'later');
    const laterDone = await later.complete();
    expect(laterDone.status).toBe(200);
    pausing.resume();
    const resumedResult = await first;

    expect(resumedResult.status).toBe(200);
    expect(resumedResult.json.data).toEqual(second.json.data);
    expect((await fileRows(database, CLIENT_ID))[0].currentVersionId).toBe(laterDone.json.data.versionId);
    expect(await taker.readBytes(CLIENT_ID, 'user_a')).toBe('later');
  });

  it('a holder paused inside its file write, taken over, moves the file only from the version it read', async () => {
    let holdFilesWrite = false;
    let paused!: () => void;
    const pausedAt = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const { database, taker, staged } = await editorSessionOnOwnedFile(editorAuthorizer, (shared) => ({
      ...shared,
      async update(params: Parameters<Adapter['update']>[0]) {
        if (params.model === 'files' && holdFilesWrite) {
          holdFilesWrite = false;
          paused();
          await resumed;
        }
        return shared.update(params);
      },
    }) as Adapter);
    holdFilesWrite = true;
    const first = staged.complete();
    await pausedAt;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'editor' });
    expect(second.status).toBe(200);
    const later = await taker.stage('user_a', CLIENT_ID, 'later');
    const laterDone = await later.complete();
    expect(laterDone.status).toBe(200);
    resume();
    const resumedResult = await first;

    expect(resumedResult.status).toBe(200);
    expect(resumedResult.json.data).toEqual(second.json.data);
    expect((await fileRows(database, CLIENT_ID))[0].currentVersionId).toBe(laterDone.json.data.versionId);
    expect(await taker.readBytes(CLIENT_ID, 'user_a')).toBe('later');
  });

  for (const stage of ['early', 'commit'] as const) {
    it(`a holder that resumes with a stale ${stage} refusal after a takeover completed the session refuses and deletes nothing`, async () => {
      const pausing = pausingAuthorizer(stage === 'early' ? 1 : 2, false);
      const { database, taker, staged } = await editorSessionOnOwnedFile(pausing.authorizer);
      pausing.arm();
      const first = staged.complete();
      await pausing.pausedAt;
      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'editor' });
      expect(second.status).toBe(200);
      pausing.resume();
      const resumedResult = await first;

      expect(resumedResult.status).toBe(200);
      expect(resumedResult.json.data).toEqual(second.json.data);
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
      const retried = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'editor' });
      expect(retried.status).toBe(200);
      expect(retried.json.data).toEqual(second.json.data);
      expect(await taker.readBytes(CLIENT_ID, 'user_a')).toBe('edited');
    });
  }

  it('proxy: a stitch that fails part-way never commits the object, and the released session completes on retry', async () => {
    const database = memoryAdapter();
    const app = createApp({ mode: 'proxy', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'stitched later');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
    const download = app.fixture.storage.openDownloadStream!.bind(app.fixture.storage);
    app.fixture.storage.openDownloadStream = async () => {
      throw new Error('part read failed');
    };
    await expect(staged.complete()).rejects.toThrow('part read failed');
    expect(app.fixture.objects.has(key)).toBe(false);
    expect(await rawSession(database, staged.uploadSessionId)).toMatchObject({ status: 'in_progress' });

    app.fixture.storage.openDownloadStream = download;
    const done = await staged.complete();
    expect(done.status).toBe(200);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('stitched later');
  });

  for (const mode of ['multipart', 'proxy'] as const) {
    it(`${mode}: a session whose crashed completer finalized storage but published nothing is taken over and completes from the stored object`, async () => {
      const base = memoryAdapter();
      let crashAtPublishing = true;
      const database = {
        ...base,
        async update(params: Parameters<Adapter['update']>[0]) {
          if ((params.data as { status?: string }).status === 'publishing' && crashAtPublishing) {
            crashAtPublishing = false;
            throw new Error('process crashed');
          }
          return base.update(params);
        },
      } as Adapter;
      const app = createApp({ mode, database });
      const uploaded: string[] = [];
      app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
      const staged = await app.stage('user_a', CLIENT_ID, 'finalized once');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      // Storage was finalized before the move to 'publishing'; the completer
      // then died holding its claim. Multipart: the upload is consumed. Proxy: the
      // parts stay until the session is completed (the failed call deleted the
      // object it stitched), so the call taking over stitches again.
      await expect(staged.complete()).rejects.toThrow('process crashed');
      if (mode === 'multipart') {
        expect(app.fixture.uploads.size).toBe(0);
      } else {
        expect(app.fixture.objects.has(`${key}.part1`)).toBe(true);
      }
      await setSession(database, staged.uploadSessionId, {
        status: 'completing',
        completionClaim: `${new Date(Date.now() - 901_000).toISOString()} crashed`,
      });

      const done = await staged.complete();
      expect(done.status).toBe(200);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('finalized once');
      expect(uploaded).toEqual([done.json.data.versionId]);
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
      expect(app.fixture.objects.has(`${key}.part1`)).toBe(false);
    });
  }

  it('a stale claim whose takeover the quota refuses is ended, so the owner can abort the session', async () => {
    const database = memoryAdapter();
    let allowed = true;
    const quota: QuotaProvider = {
      async checkQuota() { return { allowed, current: 10, limit: 10 }; },
      async recordUsage() {},
    };
    const app = createApp({ mode: 'multipart', database, quota });
    const staged = await app.stage('user_a', CLIENT_ID, 'over quota');
    await setSession(database, staged.uploadSessionId, {
      status: 'completing',
      completionClaim: `${new Date(Date.now() - 901_000).toISOString()} crashed`,
    });
    allowed = false;

    const refused = await staged.complete();
    expect(refused.status).toBe(402);
    expect(refused.json.error.code).toBe('FILEFN_QUOTA_EXCEEDED');
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('in_progress');
    const abort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token });
    expect(abort.status).toBe(200);
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('aborted');
  });

  it('a takeover of a stale session that fails before publishing releases it, so the owner can abort it', async () => {
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'never published');
    await setSession(database, staged.uploadSessionId, {
      status: 'completing',
      completionClaim: `${new Date(Date.now() - 901_000).toISOString()} crashed`,
    });
    app.fixture.storage.completeMultipartUpload = async () => {
      throw new Error('storage unavailable');
    };
    await expect(staged.complete()).rejects.toThrow('storage unavailable');
    expect(await rawSession(database, staged.uploadSessionId)).toMatchObject({ status: 'in_progress' });

    const abort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token });
    expect(abort.status).toBe(200);
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('aborted');
  });

  it('a completion that sees the published version of a sibling call, which then completes the session, returns the recorded result', async () => {
    // Process one publishes the version and pauses before marking the session
    // completed. Process two sees the published version; process one then
    // completes the session, deleting its parts, before process two goes on.
    const shared = createUniqueEnforcingDb({});
    let holdCompletedWrite = true;
    let paused!: () => void;
    const holderPaused = new Promise<void>((resolve) => { paused = resolve; });
    let proceed!: () => void;
    const holderProceeds = new Promise<void>((resolve) => { proceed = resolve; });
    const holderDb = {
      ...shared,
      async update(params: Parameters<Adapter['update']>[0]) {
        if (params.model === 'uploadSessions' && (params.data as { status?: string }).status === 'completed' && holdCompletedWrite) {
          holdCompletedWrite = false;
          paused();
          await holderProceeds;
        }
        return shared.update(params);
      },
    } as Adapter;
    let holderDone: Promise<unknown> | undefined;
    let releaseOnPublishedVersion = true;
    const siblingDb = {
      ...shared,
      async findOne(params: Parameters<Adapter['findOne']>[0]) {
        const result = await shared.findOne(params);
        if (params.model === 'fileVersions' && result && releaseOnPublishedVersion) {
          releaseOnPublishedVersion = false;
          proceed();
          await holderDone;
        }
        return result;
      },
    } as Adapter;
    const storageFixture = createStorage('multipart');
    const holder = createApp({ mode: 'multipart', database: holderDb, storageFixture, createFileFn: await loadProcess() });
    const sibling = createApp({ mode: 'multipart', database: siblingDb, storageFixture, createFileFn: await loadProcess() });
    const uploaded: string[] = [];
    for (const app of [holder, sibling]) app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
    const staged = await holder.stage('user_a', CLIENT_ID, 'completed by one');
    const key = (await rawSession(shared, staged.uploadSessionId))!.storageKey;

    holderDone = staged.complete();
    await holderPaused;
    const second = await sibling.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
    const first = (await holderDone) as Awaited<ReturnType<typeof staged.complete>>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json.data).toEqual(first.json.data);
    expect(uploaded).toEqual([first.json.data.versionId]);
    expect(storageFixture.finalizeCount(key)).toBe(1);
  });

  it('a completion that fails before publishing releases its claim, so a retry completes at once', async () => {
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'retried');
    const finalize = app.fixture.storage.completeMultipartUpload!.bind(app.fixture.storage);
    app.fixture.storage.completeMultipartUpload = async () => {
      throw new Error('storage unavailable');
    };
    await expect(staged.complete()).rejects.toThrow('storage unavailable');
    expect(await rawSession(database, staged.uploadSessionId)).toMatchObject({ status: 'in_progress' });

    app.fixture.storage.completeMultipartUpload = finalize;
    const done = await within(staged.complete(), 1_000);
    expect(done.status).toBe(200);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('retried');
  });

  /** An app whose next version insert fails once, after the files write landed. */
  function failingVersionInsert(mode: Mode) {
    const base = memoryAdapter();
    let failNext = false;
    const database = {
      ...base,
      async create(params: Parameters<Adapter['create']>[0]) {
        if (params.model === 'fileVersions' && failNext) {
          failNext = false;
          throw new Error('version insert failed');
        }
        return base.create(params);
      },
    } as Adapter;
    const app = createApp({ mode, database });
    const uploaded: string[] = [];
    app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
    return { database, app, uploaded, failNextVersionInsert: () => { failNext = true; } };
  }

  for (const mode of ['multipart', 'proxy'] as const) {
    for (const replace of [false, true]) {
      it(`${mode}: a ${replace ? 'replacement' : 'new file'} whose version insert fails stays publishing, so an abort gets 409 and a retry publishes the same version once`, async () => {
        const { database, app, uploaded, failNextVersionInsert } = failingVersionInsert(mode);
        if (replace) expect((await (await app.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
        const staged = await app.stage('user_a', CLIENT_ID, 'replacement');
        const versionId = ((await rawSession(database, staged.uploadSessionId)) as unknown as { completionVersionId: string }).completionVersionId;
        failNextVersionInsert();
        await expect(staged.complete()).rejects.toThrow('version insert failed');
        // A new file is created first; a replacement moves the file only after
        // its version row exists, so the file keeps its readable version.
        const pointer = (await fileRows(database, CLIENT_ID))[0].currentVersionId;
        if (replace) {
          expect(pointer).not.toBe(versionId);
          expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('original');
        } else {
          expect(pointer).toBe(versionId);
        }
        expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('publishing');

        const abort = await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token });
        expect(abort.status).toBe(409);
        expect(abort.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
        expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('publishing');

        // Any completion call finishes the recorded publication at once.
        const done = await within(staged.complete(), 1_000);
        expect(done.status).toBe(200);
        expect(done.json.data).toEqual({ fileId: CLIENT_ID, versionId });
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('replacement');
        expect(uploaded).toHaveLength(replace ? 2 : 1);
        expect(uploaded.at(-1)).toBe(versionId);
        expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
      });
    }
  }

  const refusingQuota: QuotaProvider = {
    async checkQuota() { return { allowed: false, current: 10, limit: 10 }; },
    async recordUsage() {},
  };

  /**
   * Process one (the holder) stalls at `stallAt` past the completion timeout;
   * process two, refused by its quota, then completes the session and the
   * owner aborts it; then the holder resumes.
   */
  async function stalledHolderThenRefusedTakerAndAbort(kind: 'create' | 'replace', stallAt: 'files-write' | 'publishing-write') {
    const shared = createUniqueEnforcingDb({});
    let armed = false;
    let stalled!: () => void;
    const holderStalled = new Promise<void>((resolve) => { stalled = resolve; });
    let resume!: () => void;
    const holderResumes = new Promise<void>((resolve) => { resume = resolve; });
    const stall = async (hit: boolean) => {
      if (armed && hit) {
        armed = false;
        stalled();
        await holderResumes;
      }
    };
    const filesWrite = (model: string) => stallAt === 'files-write' && model === 'files';
    const holderDb = {
      ...shared,
      async create(params: Parameters<Adapter['create']>[0]) { await stall(filesWrite(params.model)); return shared.create(params); },
      async updateMany(params: Parameters<Adapter['updateMany']>[0]) { await stall(filesWrite(params.model)); return shared.updateMany(params); },
      async update(params: Parameters<Adapter['update']>[0]) {
        await stall(filesWrite(params.model) || (stallAt === 'publishing-write' && (params.data as { status?: string }).status === 'publishing'));
        return shared.update(params);
      },
    } as Adapter;
    const storageFixture = createStorage('multipart');
    const completionTimeoutSeconds = 0.05;
    const holder = createApp({ mode: 'multipart', database: holderDb, storageFixture, completionTimeoutSeconds, createFileFn: await loadProcess() });
    const taker = createApp({ mode: 'multipart', database: shared, storageFixture, completionTimeoutSeconds, quota: refusingQuota, createFileFn: await loadProcess() });
    const uploaded: string[] = [];
    for (const app of [holder, taker]) app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
    if (kind === 'replace') expect((await (await holder.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
    uploaded.length = 0;
    const staged = await holder.stage('user_a', CLIENT_ID, 'replacement');
    armed = true;
    const holderDone = staged.complete();
    await holderStalled;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const takerResult = await taker.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
    const abort = await taker.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a' });
    resume();
    const holderResult = await holderDone;
    const versions = (await versionRows(shared, CLIENT_ID)).map((version) => version.versionId);
    const files = await fileRows(shared, CLIENT_ID);
    for (const file of files) expect(versions).toContain(file.currentVersionId);
    return { shared, holder, staged, takerResult, abort, holderResult, versions, files, uploaded };
  }

  for (const kind of ['create', 'replace'] as const) {
    it(`${kind}: a holder stalled inside its files write is finished by a quota-refused taker, so the abort gets 409 and no file points at a missing version`, async () => {
      const run = await stalledHolderThenRefusedTakerAndAbort(kind, 'files-write');
      expect(run.takerResult.status).toBe(200);
      expect(run.abort.status).toBe(409);
      expect(run.holderResult.status).toBe(200);
      expect(run.holderResult.json.data).toEqual(run.takerResult.json.data);
      expect(run.files[0].currentVersionId).toBe(run.takerResult.json.data.versionId);
      expect(run.versions).toHaveLength(kind === 'replace' ? 2 : 1);
      expect(run.uploaded).toEqual([run.takerResult.json.data.versionId]);
      expect(await run.holder.readBytes(CLIENT_ID, 'user_a')).toBe('replacement');
      expect((await rawSession(run.shared, run.staged.uploadSessionId))!.status).toBe('completed');
    });

    it(`${kind}: a holder stalled before its move to publishing, ended by a quota-refused taker and aborted, writes nothing when it resumes`, async () => {
      const run = await stalledHolderThenRefusedTakerAndAbort(kind, 'publishing-write');
      expect(run.takerResult.status).toBe(402);
      expect(run.abort.status).toBe(200);
      expect(run.holderResult.status).toBe(410);
      expect(run.versions).toHaveLength(kind === 'replace' ? 1 : 0);
      expect(run.files).toHaveLength(kind === 'replace' ? 1 : 0);
      if (kind === 'replace') expect(await run.holder.readBytes(CLIENT_ID, 'user_a')).toBe('original');
      expect(run.uploaded).toEqual([]);
      expect((await rawSession(run.shared, run.staged.uploadSessionId))!.status).toBe('aborted');
    });
  }

  it('a session from before init allocated its version, whose completion failed after publishing, completes the same version on retry', async () => {
    const { database, app, uploaded, failNextVersionInsert } = failingVersionInsert('multipart');
    const staged = await app.stage('user_a', CLIENT_ID, 'legacy bytes');
    await setSession(database, staged.uploadSessionId, { completionVersionId: null });
    failNextVersionInsert();
    await expect(staged.complete()).rejects.toThrow('version insert failed');
    const published = (await fileRows(database, CLIENT_ID))[0].currentVersionId;

    const done = await staged.complete();
    expect(done.status).toBe(200);
    expect(done.json.data).toEqual({ fileId: CLIENT_ID, versionId: published });
    expect((await versionRows(database, CLIENT_ID)).map((version) => version.versionId)).toEqual([published]);
    expect(uploaded).toEqual([published]);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('legacy bytes');
  });

  it('a publishing session past its expiry is finished by a completion call, or by the expiry sweep when no call comes', async () => {
    for (const finisher of ['completion', 'sweep'] as const) {
      const { database, app, uploaded, failNextVersionInsert } = failingVersionInsert('proxy');
      const staged = await app.stage('user_a', CLIENT_ID, 'kept past expiry');
      const versionId = ((await rawSession(database, staged.uploadSessionId)) as unknown as { completionVersionId: string }).completionVersionId;
      failNextVersionInsert();
      await expect(staged.complete()).rejects.toThrow('version insert failed');
      await setSession(database, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });

      if (finisher === 'completion') {
        const done = await staged.complete();
        expect(done.status).toBe(200);
      }
      const swept = await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect(swept.deletedSessions).toBe(0);
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('kept past expiry');
      expect(uploaded).toEqual([versionId]);
      expect((await staged.complete()).json.data).toEqual({ fileId: CLIENT_ID, versionId });
      expect((await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
    }
  });

  it('deleting a file while a session of it is publishing gets 409 and keeps the file; the delete succeeds once it completes', async () => {
    const { database, app, failNextVersionInsert } = failingVersionInsert('proxy');
    expect((await (await app.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
    const staged = await app.stage('user_a', CLIENT_ID, 'replacement');
    failNextVersionInsert();
    await expect(staged.complete()).rejects.toThrow('version insert failed');

    const refused = await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('publishing');
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('original');

    expect((await staged.complete()).status).toBe(200);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('replacement');
    expect((await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
  });

  for (const failure of ['part-rows', 'part-object'] as const) {
    it(`a ${failure} cleanup failure after completion still records usage and emits once, and the sweep finishes the cleanup`, async () => {
      const base = memoryAdapter();
      let failPartRows = failure === 'part-rows';
      const database = {
        ...base,
        async deleteMany(params: Parameters<Adapter['deleteMany']>[0]) {
          if (params.model === 'uploadParts' && failPartRows) {
            failPartRows = false;
            throw new Error('part rows delete failed');
          }
          return base.deleteMany(params);
        },
      } as Adapter;
      const usage: number[] = [];
      const quota: QuotaProvider = {
        async checkQuota() { return { allowed: true, current: 0, limit: 100 }; },
        async recordUsage(input) { usage.push(input.bytes); },
      };
      const app = createApp({ mode: 'proxy', database, quota });
      const uploaded: string[] = [];
      app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
      const staged = await app.stage('user_a', CLIENT_ID, 'cleaned later');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      if (failure === 'part-object') app.fixture.deleteFailures.set(`${key}.part1`, 1);

      const done = await staged.complete();
      expect(done.status).toBe(200);
      expect(uploaded).toEqual([done.json.data.versionId]);
      expect(usage).toEqual(['cleaned later'.length]);
      const parts = () => database.findMany({ model: 'uploadParts', where: [{ field: 'uploadSessionId', operator: 'eq', value: staged.uploadSessionId }], namespace: 'filefn' });
      expect(await parts()).toHaveLength(1);
      expect(app.fixture.objects.has(`${key}.part1`)).toBe(failure === 'part-object');

      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await parts()).toHaveLength(0);
      expect(app.fixture.objects.has(`${key}.part1`)).toBe(false);
      expect(uploaded).toHaveLength(1);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('cleaned later');
    });
  }

  it('proxy: a retry in the holder\'s own process takes over a completion stalled past the timeout', async () => {
    const database = memoryAdapter();
    const app = createApp({ mode: 'proxy', database, completionTimeoutSeconds: 1 });
    const staged = await app.stage('user_a', CLIENT_ID, 'taken over in process');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const release = app.fixture.gate(key);
    const stalled = staged.complete();
    await vi.advanceTimersByTimeAsync(10);
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completing');

    const retry = staged.complete();
    await vi.advanceTimersByTimeAsync(SERIALIZED_WAIT_TIMEOUT_MS + 1_000);
    const done = await retry;
    expect(done.status).toBe(200);
    vi.useRealTimers();
    release();
    const resumed = await stalled;
    expect(resumed.status).toBe(200);
    expect(resumed.json.data).toEqual(done.json.data);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('taken over in process');
  });

  for (const next of ['abort', 'complete'] as const) {
    it(`proxy: the object a crashed retake stitched survives a quota-refused end of its claim, and ${next === 'abort' ? 'an abort' : 'the completion'} deletes it`, async () => {
      const database = memoryAdapter();
      let allowed = true;
      const quota: QuotaProvider = {
        async checkQuota() { return { allowed, current: 10, limit: 10 }; },
        async recordUsage() {},
      };
      const app = createApp({ mode: 'proxy', database, quota });
      const staged = await app.stage('user_a', CLIENT_ID, 'retaken');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      // A retake that stitched its own object and crashed.
      app.fixture.objects.set(`${key}.cabc123`, Buffer.from('retaken'));
      await setSession(database, staged.uploadSessionId, {
        status: 'completing',
        completionClaim: `${new Date(Date.now() - 901_000).toISOString()} abc123 retake`,
      });
      allowed = false;
      expect((await staged.complete()).status).toBe(402);
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('in_progress');

      if (next === 'abort') {
        expect((await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token })).status).toBe(200);
      } else {
        allowed = true;
        expect((await staged.complete()).status).toBe(200);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('retaken');
      }
      expect(app.fixture.objects.has(`${key}.cabc123`)).toBe(false);
    });
  }

  /** A gate a hooked adapter call waits at, once armed. */
  function stallGate() {
    let armed = false;
    let stalled!: () => void;
    const reached = new Promise<void>((resolve) => { stalled = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    return {
      reached,
      resume,
      arm: () => { armed = true; },
      async at(hit: boolean) {
        if (!armed || !hit) return;
        armed = false;
        stalled();
        await resumed;
      },
    };
  }

  for (const kind of ['create', 'replace'] as const) {
    it(`${kind}: a call finishing a publication that resumes after a sibling completed it and the file was deleted leaves the file deleted`, async () => {
      const shared = createUniqueEnforcingDb({});
      const gate = stallGate();
      // create: the holder stalls at its files insert; replace: at its version insert.
      const stalledModel = kind === 'create' ? 'files' : 'fileVersions';
      const holderDb = {
        ...shared,
        async create(params: Parameters<Adapter['create']>[0]) {
          await gate.at(params.model === stalledModel);
          return shared.create(params);
        },
      } as Adapter;
      const storageFixture = createStorage('multipart');
      const holder = createApp({ mode: 'multipart', database: holderDb, storageFixture, createFileFn: await loadProcess() });
      const sibling = createApp({ mode: 'multipart', database: shared, storageFixture, createFileFn: await loadProcess() });
      if (kind === 'replace') expect((await (await sibling.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
      const staged = await holder.stage('user_a', CLIENT_ID, 'replacement');
      gate.arm();
      const holderDone = staged.complete();
      await gate.reached;
      expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('publishing');

      const finished = await sibling.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
      expect(finished.status).toBe(200);
      expect((await sibling.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
      gate.resume();
      const resumed = await holderDone;

      expect(resumed.status).toBe(200);
      expect(resumed.json.data).toEqual(finished.json.data);
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(0);
      expect(await versionRows(shared, CLIENT_ID)).toHaveLength(0);
    });
  }

  it('deleting a file whose open session a completion claims after the delete read it gets 409 and leaves the session and its parts', async () => {
    const base = memoryAdapter();
    let claimAfterRead: string | undefined;
    const database = {
      ...base,
      async findMany(params: Parameters<Adapter['findMany']>[0]) {
        const result = await base.findMany(params);
        const sessionId = claimAfterRead;
        if (params.model === 'uploadSessions' && sessionId) {
          claimAfterRead = undefined;
          await setSession(base, sessionId, { status: 'completing', completionClaim: `${new Date().toISOString()} other` });
        }
        return result;
      },
    } as Adapter;
    const app = createApp({ mode: 'proxy', database });
    expect((await (await app.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
    const staged = await app.stage('user_a', CLIENT_ID, 'claimed meanwhile');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
    claimAfterRead = staged.uploadSessionId;

    const refused = await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('FILEFN_UPLOAD_COMPLETION_IN_PROGRESS');
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completing');
    expect(app.fixture.objects.has(`${key}.part1`)).toBe(true);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('original');
  });

  it('a failed read right after the session is completed never skips usage or file:uploaded', async () => {
    const base = memoryAdapter();
    let completed = false;
    let failNextVersionRead = true;
    const database = {
      ...base,
      async update(params: Parameters<Adapter['update']>[0]) {
        const result = await base.update(params);
        if (params.model === 'uploadSessions' && (params.data as { status?: string }).status === 'completed') completed = true;
        return result;
      },
      async findOne(params: Parameters<Adapter['findOne']>[0]) {
        if (completed && failNextVersionRead && params.model === 'fileVersions') {
          failNextVersionRead = false;
          throw new Error('version read failed');
        }
        return base.findOne(params);
      },
    } as Adapter;
    const usage: number[] = [];
    const quota: QuotaProvider = {
      async checkQuota() { return { allowed: true, current: 0, limit: 100 }; },
      async recordUsage(input) { usage.push(input.bytes); },
    };
    const app = createApp({ mode: 'multipart', database, quota });
    const uploaded: string[] = [];
    app.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));
    const staged = await app.stage('user_a', CLIENT_ID, 'effects once');
    const done = await staged.complete();
    expect(done.status).toBe(200);
    expect(uploaded).toEqual([done.json.data.versionId]);
    expect(usage).toEqual(['effects once'.length]);
  });

  it('proxy: a retake object of a publication refused for another principal\'s new file is kept until the sweep deletes it', async () => {
    const shared = createUniqueEnforcingDb({});
    const gate = stallGate();
    const holderDb = {
      ...shared,
      async create(params: Parameters<Adapter['create']>[0]) {
        await gate.at(params.model === 'files');
        return shared.create(params);
      },
    } as Adapter;
    const storageFixture = createStorage('proxy');
    const holder = createApp({ mode: 'proxy', database: holderDb, storageFixture, createFileFn: await loadProcess() });
    const rival = createApp({ mode: 'proxy', database: shared, storageFixture, createFileFn: await loadProcess() });
    const staged = await holder.stage('user_a', CLIENT_ID, 'refused bytes');
    const key = (await rawSession(shared, staged.uploadSessionId))!.storageKey;
    // Claimed and released before, so this completion is a retake with an object of its own.
    await setSession(shared, staged.uploadSessionId, { completionClaim: `${new Date(Date.now() - 901_000).toISOString()} n0 retake` });
    gate.arm();
    const holderDone = staged.complete();
    await gate.reached;
    const retakeKey = [...storageFixture.objects.keys()].find((k) => k.startsWith(`${key}.c`))!;
    expect(retakeKey).toBeDefined();

    expect((await (await rival.stage('user_b', CLIENT_ID, 'rival bytes')).complete()).status).toBe(200);
    storageFixture.deleteFailures.set(retakeKey, 1);
    gate.resume();
    const refused = await holderDone;
    expect(refused.status).toBe(403);
    expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('refused');
    expect(storageFixture.objects.has(retakeKey)).toBe(true);

    // Expired but refused just now: a write started before the refusal may still land, so its record stays.
    await setSession(shared, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await holder.fileFn.services.uploads.cleanupExpiredSessions();
    expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('refused');
    // Expired, and refused longer than the completion timeout ago.
    await setSession(shared, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString(), completionClaim: await agedClaim(shared, staged.uploadSessionId) });
    await holder.fileFn.services.uploads.cleanupExpiredSessions();
    expect(storageFixture.objects.has(retakeKey)).toBe(false);
    // The refused publication's record stays for good.
    expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('refused');
    expect(await rival.readBytes(CLIENT_ID, 'user_b')).toBe('rival bytes');
  });

  for (const next of ['abort', 'complete'] as const) {
    it(`proxy: the objects of two consecutive crashed retakes stay known, and ${next === 'abort' ? 'an abort' : 'the completion'} deletes both`, async () => {
      const database = memoryAdapter();
      let allowed = true;
      const quota: QuotaProvider = {
        async checkQuota() { return { allowed, current: 10, limit: 10 }; },
        async recordUsage() {},
      };
      const app = createApp({ mode: 'proxy', database, quota });
      const staged = await app.stage('user_a', CLIENT_ID, 'retaken twice');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      // Retake nA stitched and crashed; retake nB took it over, stitched and crashed.
      app.fixture.objects.set(`${key}.cnA`, Buffer.from('retaken twice'));
      app.fixture.objects.set(`${key}.cnB`, Buffer.from('retaken twice'));
      await setSession(database, staged.uploadSessionId, {
        status: 'completing',
        completionClaim: `${new Date(Date.now() - 901_000).toISOString()} nB retake nA`,
      });

      if (next === 'abort') {
        allowed = false;
        expect((await staged.complete()).status).toBe(402);
        expect((await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token })).status).toBe(200);
      } else {
        expect((await staged.complete()).status).toBe(200);
        expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('retaken twice');
      }
      expect(app.fixture.objects.has(`${key}.cnA`)).toBe(false);
      expect(app.fixture.objects.has(`${key}.cnB`)).toBe(false);
    });
  }

  for (const swept of [false, true]) it(`a refused publication's insert that resumes after the rival file was deleted${swept ? ' and the refused session swept' : ''} leaves no file or version`, async () => {
    const shared = createUniqueEnforcingDb({});
    const gate = stallGate();
    const holderDb = {
      ...shared,
      async create(params: Parameters<Adapter['create']>[0]) {
        await gate.at(params.model === 'files');
        return shared.create(params);
      },
    } as Adapter;
    const storageFixture = createStorage('multipart');
    const holder = createApp({ mode: 'multipart', database: holderDb, storageFixture, createFileFn: await loadProcess() });
    const other = createApp({ mode: 'multipart', database: shared, storageFixture, createFileFn: await loadProcess() });
    const staged = await holder.stage('user_a', CLIENT_ID, 'refused bytes');
    gate.arm();
    const holderDone = staged.complete();
    await gate.reached;

    expect((await (await other.stage('user_b', CLIENT_ID, 'rival bytes')).complete()).status).toBe(200);
    const refused = await other.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
    expect(refused.status).toBe(403);
    if (swept) {
      await setSession(shared, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString(), completionClaim: await agedClaim(shared, staged.uploadSessionId) });
      await other.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('refused');
    }
    expect((await other.call('DELETE', `/${CLIENT_ID}`, { user: 'user_b' })).status).toBe(200);
    gate.resume();
    const resumed = await holderDone;

    expect(resumed.status).toBe(410);
    expect(await fileRows(shared, CLIENT_ID)).toHaveLength(0);
    expect(await versionRows(shared, CLIENT_ID)).toHaveLength(0);
  });


  it('a file delete during which a publishing session finishes deletes its version\'s object and releases its bytes too', async () => {
    const base = memoryAdapter();
    let failNextVersionInsert = false;
    let finishDuringDelete: (() => Promise<unknown>) | undefined;
    const database = {
      ...base,
      async create(params: Parameters<Adapter['create']>[0]) {
        if (params.model === 'fileVersions' && failNextVersionInsert) {
          failNextVersionInsert = false;
          throw new Error('version insert failed');
        }
        return base.create(params);
      },
      async findMany(params: Parameters<Adapter['findMany']>[0]) {
        const finish = finishDuringDelete;
        if (params.model === 'uploadSessions' && finish) {
          finishDuringDelete = undefined;
          await finish();
        }
        return base.findMany(params);
      },
    } as Adapter;
    const usage: number[] = [];
    const quota: QuotaProvider = {
      async checkQuota() { return { allowed: true, current: 0, limit: 100 }; },
      async recordUsage(input) { usage.push(input.bytes); },
    };
    const app = createApp({ mode: 'proxy', database, quota });
    expect((await (await app.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
    const staged = await app.stage('user_a', CLIENT_ID, 'replacement');
    failNextVersionInsert = true;
    await expect(staged.complete()).rejects.toThrow('version insert failed');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
    // The publication finishes as the delete reads the file's sessions.
    finishDuringDelete = async () => expect((await staged.complete()).status).toBe(200);

    expect((await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
    expect(app.fixture.objects.has(key)).toBe(false);
    expect(usage.reduce((sum, bytes) => sum + bytes, 0)).toBe(0);
    expect(await versionRows(database, CLIENT_ID)).toHaveLength(0);
  });

  describe('final publication reset (PR #362 round 2)', () => {
    /** A unique-enforcing db whose next files or fileVersions insert can be failed once. */
    function failableDb() {
      const shared = createUniqueEnforcingDb({});
      let failModel: string | undefined;
      const database = {
        ...shared,
        async create(params: Parameters<Adapter['create']>[0]) {
          if (params.model === failModel) { failModel = undefined; throw new Error(`${params.model} insert failed`); }
          return shared.create(params);
        },
      } as Adapter;
      return { shared, database, failNext: (model: string) => { failModel = model; } };
    }
    const currentOf = async (db: Adapter) => (await fileRows(db, CLIENT_ID))[0]?.currentVersionId;
    const sessionVersion = async (db: Adapter, id: string) => ((await rawSession(db, id)) as unknown as { completionVersionId: string }).completionVersionId;
    const versionIds = async (db: Adapter) => (await versionRows(db, CLIENT_ID)).map((row) => row.versionId);

    // publication-rolls-back-later-version
    it('a crashed new-file publication retried after a later replacement keeps the later version current and joins the history', async () => {
      const { database, failNext } = failableDb();
      const app = createApp({ mode: 'multipart', database });
      const first = await app.stage('user_a', CLIENT_ID, 'first');
      const v1 = await sessionVersion(database, first.uploadSessionId);
      failNext('fileVersions');
      await expect(first.complete()).rejects.toThrow('fileVersions insert failed');
      expect(await currentOf(database)).toBe(v1);
      const second = await app.stage('user_a', CLIENT_ID, 'second');
      const done2 = await second.complete();
      expect(done2.status).toBe(200);
      const v2 = done2.json.data.versionId;

      const retry = await first.complete();
      expect(retry.status).toBe(200);
      expect(retry.json.data.versionId).toBe(v1);
      expect(await currentOf(database)).toBe(v2);
      expect((await versionIds(database)).sort()).toEqual([v1, v2].sort());
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('second');
      expect((await rawSession(database, first.uploadSessionId))!.status).toBe('completed');
    });

    // publication-base-rewrite-claim-collision (pullfrog PRRT_kwDOP-e7KM64iNpl)
    it('overlapping base rewrites within one millisecond never move the file off a later writer\'s version', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z'));
        const { shared, database, failNext } = failableDb();
        const storageFixture = createStorage('multipart');
        const p0 = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
        const bFilesRead = stallGate();
        const bAfterRewrite = stallGate();
        const aAfterRewrite = stallGate();
        const isBaseRewrite = (p: Parameters<Adapter['update']>[0]) =>
          p.model === 'uploadSessions' && !!(p.data as { completionPublication?: unknown }).completionPublication && (p.data as { status?: unknown }).status === undefined;
        // Each pauses after its rewrite attempt, whether it applied or not.
        const dbA = { ...shared, async update(p: Parameters<Adapter['update']>[0]) { try { return await shared.update(p); } finally { await aAfterRewrite.at(isBaseRewrite(p)); } } } as Adapter;
        const dbB = {
          ...shared,
          async findOne(p: Parameters<Adapter['findOne']>[0]) { await bFilesRead.at(p.model === 'files'); return shared.findOne(p); },
          async update(p: Parameters<Adapter['update']>[0]) { try { return await shared.update(p); } finally { await bAfterRewrite.at(isBaseRewrite(p)); } },
        } as Adapter;
        const pA = createApp({ mode: 'multipart', database: dbA, storageFixture, createFileFn: await loadProcess() });
        const pB = createApp({ mode: 'multipart', database: dbB, storageFixture, createFileFn: await loadProcess() });

        const original = await p0.stage('user_a', CLIENT_ID, 'original-old');
        const v0 = await sessionVersion(shared, original.uploadSessionId);
        const rival1 = await p0.stage('user_a', CLIENT_ID, 'rival-1');
        const rival2 = await p0.stage('user_a', CLIENT_ID, 'rival-2');
        failNext('files');
        await expect(original.complete()).rejects.toThrow('files insert failed');
        const claimC = (await rawSession(shared, original.uploadSessionId))!.completionClaim;
        expect((await rawSession(shared, original.uploadSessionId))!.status).toBe('publishing');
        expect((await rival1.complete()).status).toBe(200);

        bFilesRead.arm();
        const B = pB.call('POST', `/upload/${original.uploadSessionId}/complete`, { user: 'user_a' });
        await bFilesRead.reached;
        aAfterRewrite.arm();
        const A = pA.call('POST', `/upload/${original.uploadSessionId}/complete`, { user: 'user_a' });
        await aAfterRewrite.reached;
        expect((await rawSession(shared, original.uploadSessionId))!.completionClaim).not.toBe(claimC);
        const r2 = await rival2.complete();
        expect(r2.status).toBe(200);
        const V2 = r2.json.data.versionId;
        bAfterRewrite.arm();
        bFilesRead.resume();
        await bAfterRewrite.reached;
        aAfterRewrite.resume();
        const a = await A;
        bAfterRewrite.resume();
        const b = await B;

        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.json.data.versionId).toBe(v0);
        expect(b.json.data.versionId).toBe(v0);
        expect(await currentOf(shared)).toBe(V2);
        expect(await versionIds(shared)).toContain(v0);
      } finally {
        vi.useRealTimers();
      }
    });

    // expired-completing-session-loses-upload: what base f34442366 left after a
    // crash between its files insert and its version insert.
    async function legacyCrashState(options: { status?: 'in_progress' | 'completing' } = {}) {
      const { shared, database, failNext } = failableDb();
      const storageFixture = createStorage('multipart');
      const app = createApp({ mode: 'multipart', database, storageFixture });
      const staged = await app.stage('user_a', CLIENT_ID, 'legacy');
      const v = await sessionVersion(shared, staged.uploadSessionId);
      failNext('fileVersions');
      await expect(staged.complete()).rejects.toThrow('fileVersions insert failed');
      expect(await currentOf(shared)).toBe(v);
      await setSession(shared, staged.uploadSessionId, {
        status: options.status ?? 'in_progress',
        completionClaim: options.status === 'completing' ? `${new Date(Date.now() - 901_000).toISOString()} n0` : null,
        completionPublication: null,
      });
      return { shared, storageFixture, app, staged, v };
    }

    it('the expiry sweep finishes an old partly published session instead of deleting it', async () => {
      const { shared, app, staged, v } = await legacyCrashState();
      await setSession(shared, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('completed');
      expect(await versionIds(shared)).toContain(v);
      const retry = await staged.complete();
      expect(retry.status).toBe(200);
      expect(retry.json.data.versionId).toBe(v);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('legacy');
    });

    for (const status of ['in_progress', 'completing'] as const) {
      it(`an old partly published ${status} session is finished without quota or parts, and an abort gets 409`, async () => {
        const { shared, storageFixture, staged, v } = await legacyCrashState({ status });
        const usage: number[] = [];
        const refusing: QuotaProvider = {
          async checkQuota() { return { allowed: false, current: 10, limit: 10 }; },
          async recordUsage(input) { usage.push(input.bytes); },
        };
        const other = createApp({ mode: 'multipart', database: shared, storageFixture, quota: refusing, createFileFn: await loadProcess() });
        await shared.deleteMany({ model: 'uploadParts', where: [{ field: 'uploadSessionId', operator: 'eq', value: staged.uploadSessionId }], namespace: 'filefn' });

        const abort = await other.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a' });
        expect(abort.status).toBe(409);
        // An in_progress one is adopted as a publication; a completing one is held.
        expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe(status === 'in_progress' ? 'publishing' : 'completing');
        const retry = await other.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' });
        expect(retry.status).toBe(200);
        expect(retry.json.data.versionId).toBe(v);
        expect(usage).toEqual(['legacy'.length]);
        expect(await versionIds(shared)).toEqual([v]);
        expect(await other.readBytes(CLIENT_ID, 'user_a')).toBe('legacy');
      });
    }

    // stale-completion-writes-after-claim-loss residual
    function lateInsertSetup(sessionReadFailures: number) {
      const { shared, database, failNext } = failableDb();
      const storageFixture = createStorage('multipart');
      const stall = stallGate();
      let failReads = 0;
      const dbH = {
        ...shared,
        async create(p: Parameters<Adapter['create']>[0]) {
          await stall.at(p.model === 'files');
          const r = await shared.create(p);
          if (p.model === 'files') failReads = sessionReadFailures;
          return r;
        },
        async findOne(p: Parameters<Adapter['findOne']>[0]) {
          if (failReads > 0 && p.model === 'uploadSessions') { failReads--; throw new Error('injected session read failure'); }
          return shared.findOne(p);
        },
      } as Adapter;
      return { shared, database, failNext, storageFixture, stall, dbH };
    }

    for (const readFailures of [1, 3]) {
      it(`a write in flight after the session completed and its file was deleted never resurrects the file${readFailures === 3 ? ' (its check failing: the sweep removes it)' : ''}`, async () => {
        const { shared, database, failNext, storageFixture, stall, dbH } = lateInsertSetup(readFailures);
        const p0 = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
        const pH = createApp({ mode: 'multipart', database: dbH, storageFixture, createFileFn: await loadProcess() });
        const pS = createApp({ mode: 'multipart', database: shared, storageFixture, createFileFn: await loadProcess() });
        const staged = await p0.stage('user_a', CLIENT_ID, 'deleted later');
        failNext('files');
        await expect(staged.complete()).rejects.toThrow('files insert failed');
        stall.arm();
        const H = pH.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' }).catch((err: unknown) => ({ status: -1, json: String(err) }));
        await stall.reached;
        expect((await pS.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' })).status).toBe(200);
        expect((await pS.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
        stall.resume();
        const h = await H;

        if (readFailures === 1) {
          expect(h.status).toBe(200);
        } else {
          // The check could not be read: the row stays until the sweep.
          expect(h.status).toBe(-1);
          expect(await fileRows(shared, CLIENT_ID)).toHaveLength(1);
          await pS.fileFn.services.uploads.cleanupExpiredSessions();
        }
        expect(await fileRows(shared, CLIENT_ID)).toHaveLength(0);
        expect(await versionRows(shared, CLIENT_ID)).toHaveLength(0);
      });
    }

    it('an error of the completing call\'s own effects reaches its caller', async () => {
      const database = memoryAdapter();
      const quota: QuotaProvider = {
        async checkQuota() { return { allowed: true, current: 0, limit: 10 }; },
        async recordUsage() { throw new Error('usage store down'); },
      };
      const app = createApp({ mode: 'multipart', database, quota });
      const staged = await app.stage('user_a', CLIENT_ID, 'effects fail');
      await expect(staged.complete()).rejects.toThrow('usage store down');
      expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
    });

    it('a file delete that fails after marking its completed sessions leaves the file to its retry, not to the sweep', async () => {
      const base = memoryAdapter();
      let failVersionsRead = false;
      const database = {
        ...base,
        async findMany(params: Parameters<Adapter['findMany']>[0]) {
          if (failVersionsRead && params.model === 'fileVersions') { failVersionsRead = false; throw new Error('versions read failed'); }
          return base.findMany(params);
        },
      } as Adapter;
      const app = createApp({ mode: 'multipart', database });
      const staged = await app.stage('user_a', CLIENT_ID, 'kept');
      const done = await staged.complete();
      expect(done.status).toBe(200);
      failVersionsRead = true;
      await expect(app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).rejects.toThrow('versions read failed');
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(1);
      expect(await versionIds(database)).toEqual([done.json.data.versionId]);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('kept');
      expect((await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(0);
    });

    it('an old replacement that inserted its version but never moved the file is published normally', async () => {
      const database = memoryAdapter();
      const app = createApp({ mode: 'multipart', database });
      expect((await (await app.stage('user_a', CLIENT_ID, 'original')).complete()).status).toBe(200);
      const replacement = await app.stage('user_a', CLIENT_ID, 'replacement');
      const session = (await rawSession(database, replacement.uploadSessionId))!;
      const v1 = (session as unknown as { completionVersionId: string }).completionVersionId;
      // What base f34442366 left after a crash between a version insert and the file move.
      await database.create({
        model: 'fileVersions',
        data: { versionId: v1, fileId: CLIENT_ID, storageKey: session.storageKey, mimeType: 'text/plain', size: 'replacement'.length, checksumSha256Base64: null, tenantId: null, createdAt: new Date().toISOString() },
        namespace: 'filefn',
      });
      const done = await replacement.complete();
      expect(done.status).toBe(200);
      expect(done.json.data.versionId).toBe(v1);
      expect(await currentOf(database)).toBe(v1);
      expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('replacement');
    });

    it('a late row of a file whose first delete failed after marking is still swept once a retried delete succeeds', async () => {
      const { shared, database, failNext, storageFixture, stall, dbH } = lateInsertSetup(3);
      let failVersionsRead = false;
      const dbS = {
        ...shared,
        async findMany(params: Parameters<Adapter['findMany']>[0]) {
          if (failVersionsRead && params.model === 'fileVersions') { failVersionsRead = false; throw new Error('versions read failed'); }
          return shared.findMany(params);
        },
      } as Adapter;
      const p0 = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
      const pH = createApp({ mode: 'multipart', database: dbH, storageFixture, createFileFn: await loadProcess() });
      const pS = createApp({ mode: 'multipart', database: dbS, storageFixture, createFileFn: await loadProcess() });
      const staged = await p0.stage('user_a', CLIENT_ID, 'deleted twice');
      failNext('files');
      await expect(staged.complete()).rejects.toThrow('files insert failed');
      stall.arm();
      const H = pH.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' }).catch((err: unknown) => ({ status: -1, json: String(err) }));
      await stall.reached;
      expect((await pS.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' })).status).toBe(200);
      failVersionsRead = true;
      await expect(pS.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).rejects.toThrow('versions read failed');
      expect((await pS.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
      stall.resume();
      expect((await H).status).toBe(-1);
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(1);

      await pS.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(0);
      expect(await versionRows(shared, CLIENT_ID)).toHaveLength(0);
    });

    it('the sweep keeps checking a deleted file\'s publication after the completion timeout', async () => {
      const database = memoryAdapter();
      const app = createApp({ mode: 'multipart', database });
      const staged = await app.stage('user_a', CLIENT_ID, 'deleted');
      expect((await staged.complete()).status).toBe(200);
      expect((await app.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
      expect((await rawSession(database, staged.uploadSessionId))!.completionClaim).toBe('file-deleted');
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await rawSession(database, staged.uploadSessionId))!.completionClaim).toBe('file-deleted');
      const session = (await rawSession(database, staged.uploadSessionId))!;
      await setSession(database, staged.uploadSessionId, {
        completionPublication: { ...session.completionPublication, fileDeletedAt: new Date(Date.now() - 901_000).toISOString() },
      });
      await app.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await rawSession(database, staged.uploadSessionId))!.completionClaim).toBe('file-deleted');
      expect((await staged.complete()).status).toBe(200);
    });

    // Owner amendment 2026-11-18 (PR review round 3): permanent tombstones,
    // the legacy retained-bytes check and stitch-before-row expiry cleanup.
    it('a write landing after the completion timeout, past a sweep, is still removed and the deleted file stays deleted', async () => {
      const { shared, database, failNext, storageFixture, stall, dbH } = lateInsertSetup(3);
      const p0 = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
      const pH = createApp({ mode: 'multipart', database: dbH, storageFixture, createFileFn: await loadProcess() });
      const pS = createApp({ mode: 'multipart', database: shared, storageFixture, createFileFn: await loadProcess() });
      const staged = await p0.stage('user_a', CLIENT_ID, 'deleted long ago');
      failNext('files');
      await expect(staged.complete()).rejects.toThrow('files insert failed');
      stall.arm();
      const H = pH.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' }).catch((err: unknown) => ({ status: -1, json: String(err) }));
      await stall.reached;
      expect((await pS.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' })).status).toBe(200);
      expect((await pS.call('DELETE', `/${CLIENT_ID}`, { user: 'user_a' })).status).toBe(200);
      // The helper stays paused past the completion timeout, and a sweep runs then.
      const session = (await rawSession(shared, staged.uploadSessionId))!;
      await setSession(shared, staged.uploadSessionId, {
        completionPublication: { ...session.completionPublication, fileDeletedAt: new Date(Date.now() - 901_000).toISOString() },
      });
      await pS.fileFn.services.uploads.cleanupExpiredSessions();
      stall.resume();
      expect((await H).status).toBe(-1);
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(1);

      await pS.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(0);
      expect(await versionRows(shared, CLIENT_ID)).toHaveLength(0);
      await expect(pS.readBytes(CLIENT_ID, 'user_a')).rejects.toMatchObject({ status: 404 });
    });

    it('a refused publication\'s write landing after its record was swept past the timeout is still removed', async () => {
      const { shared, storageFixture, stall, dbH } = lateInsertSetup(3);
      const pH = createApp({ mode: 'multipart', database: dbH, storageFixture, createFileFn: await loadProcess() });
      const pS = createApp({ mode: 'multipart', database: shared, storageFixture, createFileFn: await loadProcess() });
      const staged = await pS.stage('user_a', CLIENT_ID, 'refused late');
      stall.arm();
      const H = pH.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' }).catch((err: unknown) => ({ status: -1, json: String(err) }));
      await stall.reached;
      expect((await (await pS.stage('user_b', CLIENT_ID, 'rival bytes')).complete()).status).toBe(200);
      expect((await pS.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' })).status).toBe(403);
      await setSession(shared, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString(), completionClaim: await agedClaim(shared, staged.uploadSessionId) });
      await pS.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await pS.call('DELETE', `/${CLIENT_ID}`, { user: 'user_b' })).status).toBe(200);
      stall.resume();
      expect((await H).status).toBe(-1);
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(1);

      await pS.fileFn.services.uploads.cleanupExpiredSessions();
      expect(await fileRows(shared, CLIENT_ID)).toHaveLength(0);
      expect(await versionRows(shared, CLIENT_ID)).toHaveLength(0);
      // The refused publication's record stays for good.
      expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('refused');
    });

    it('an old partly published session whose own object is gone is never completed, aborted or expired, and runs no effects', async () => {
      const { shared, storageFixture, staged, v } = await legacyCrashState();
      // Base dedup deleted the session's own object before creating the file.
      storageFixture.objects.delete((await rawSession(shared, staged.uploadSessionId))!.storageKey);
      const usage: number[] = [];
      const quota: QuotaProvider = {
        async checkQuota() { return { allowed: true, current: 0, limit: 100 }; },
        async recordUsage(input) { usage.push(input.bytes); },
      };
      const other = createApp({ mode: 'multipart', database: shared, storageFixture, quota, createFileFn: await loadProcess() });
      const uploaded: string[] = [];
      other.fileFn.events.on('file:uploaded', (event) => uploaded.push(event.versionId));

      expect((await other.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' })).status).toBe(409);
      expect((await other.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a' })).status).toBe(409);
      await setSession(shared, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
      await other.fileFn.services.uploads.cleanupExpiredSessions();
      expect((await other.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' })).status).toBe(409);

      expect((await rawSession(shared, staged.uploadSessionId))!.status).toBe('in_progress');
      expect(usage).toEqual([]);
      expect(uploaded).toEqual([]);
      expect(await versionIds(shared)).toEqual([]);
      expect(await currentOf(shared)).toBe(v);
    });

    for (const first of ['sweep', 'abort'] as const) {
      it(`proxy: a retake object whose delete fails in ${first === 'abort' ? 'an abort and ' : ''}the expiry sweep keeps the session row until a later sweep deletes it`, async () => {
        const database = memoryAdapter();
        const app = createApp({ mode: 'proxy', database });
        const staged = await app.stage('user_a', CLIENT_ID, 'expired retake');
        const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
        const retakeKey = `${key}.cnA`;
        // A released retake left its stitched object.
        app.fixture.objects.set(retakeKey, Buffer.from('expired retake'));
        await setSession(database, staged.uploadSessionId, { status: 'in_progress', completionClaim: `${new Date(Date.now() - 901_000).toISOString()} nA retake` });
        app.fixture.deleteFailures.set(retakeKey, first === 'abort' ? 2 : 1);
        if (first === 'abort') {
          expect((await app.call('POST', `/upload/${staged.uploadSessionId}/abort`, { user: 'user_a', token: staged.token })).status).toBe(200);
          expect(app.fixture.objects.has(retakeKey)).toBe(true);
        }
        await setSession(database, staged.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });

        await app.fileFn.services.uploads.cleanupExpiredSessions();
        expect(app.fixture.objects.has(retakeKey)).toBe(true);
        expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('aborted');
        await app.fileFn.services.uploads.cleanupExpiredSessions();
        expect(app.fixture.objects.has(retakeKey)).toBe(false);
        expect(await rawSession(database, staged.uploadSessionId)).toBeNull();
      });
    }
  });
});
