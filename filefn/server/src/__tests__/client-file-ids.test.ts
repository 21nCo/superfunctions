import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { StorageAdapter } from '@superfunctions/storage';
import type { Authorizer } from '@superfunctions/files';
import { createDefaultAuthorizer, createFileFn, type QuotaProvider } from '../index.js';
import { generateFileFnId } from '../ids.js';
import {
  createKeyedSerializer,
  isValidClientFileId,
  parseRequestedFileId,
  SERIALIZED_HOLD_TIMEOUT_MS,
} from '../upload-sessions/file-id.js';
import { generateFileId } from '../../../client/src/upload-manager.js';

type Mode = 'multipart' | 'proxy';

/**
 * Byte-keeping storage fixture. In multipart mode the test plays the client's
 * PUT to a signed part URL with `putSignedPart`; completion concatenates the
 * parts into the object. In proxy mode FileFn streams the bytes itself.
 */
function createStorage(mode: Mode, options: { lenientRecompletion?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const completedUploads = new Map<string, string>();
  /** Keys whose next deleteObject calls fail (count per key). */
  const deleteFailures = new Map<string, number>();
  /** Storage completion of these final keys waits for the promise. */
  const gates = new Map<string, Promise<void>>();
  /** statObject of these keys waits for the promise (after storage completion). */
  const statHolds = new Map<string, Promise<void>>();
  /** Storage-completion attempts per final key. */
  const finalizeAttempts = new Map<string, number>();
  let onFinalize: ((key: string, attempt: number) => void) | undefined;
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
        // S3 and R2 answer NoSuchUpload; the lenient mode models a store that
        // treats re-completing a finished upload as a no-op.
        if (options.lenientRecompletion && completedUploads.get(input.uploadId) === input.key) return;
        throw new Error(`NoSuchUpload: ${input.uploadId}`);
      }
      await gates.get(upload.key);
      const chunks = input.parts.map((part) => upload.parts.get(part.partNumber)!);
      objects.set(upload.key, Buffer.concat(chunks));
      uploads.delete(input.uploadId);
      completedUploads.set(input.uploadId, upload.key);
    },
    async abortMultipartUpload(input) {
      uploads.delete(input.uploadId);
    },
    async statObject(input) {
      await statHolds.get(input.key);
      const bytes = objects.get(input.key);
      if (!bytes) throw new Error(`object not found: ${input.key}`);
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
  /** Use the grant-aware authorizer instead of the owner-only default. */
  grants?: boolean;
  authorizer?: Authorizer;
  /** `createFileFn` of a separately loaded module graph, to model another process. */
  createFileFn?: typeof createFileFn;
  dedup?: boolean;
}) {
  const fixture = options.storageFixture ?? createStorage(options.mode);
  const database = options.database ?? memoryAdapter();
  const fileFn = (options.createFileFn ?? createFileFn)({
    database,
    authorizer: options.authorizer ?? (options.grants ? createDefaultAuthorizer({ db: database }) : undefined),
    storage: fixture.storage,
    policies: [{ name: 'doc', contentTypes: ['text/plain'], visibility: 'private' }],
    quota: options.quota,
    dedup: options.dedup ? { enabled: true } : undefined,
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
        expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('aborted');
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
        expect((await rawSession(database, b.uploadSessionId))!.status).toBe('aborted');
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
  async function createTwoProcesses(mode: Mode, storageOptions: { lenientRecompletion?: boolean } = {}) {
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
    const storageFixture = createStorage(mode, storageOptions);
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
      expect((await rawSession(database, (aWon ? b : a).uploadSessionId))!.status).toBe('aborted');
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
    it(`a second completion of the same ${user ? 'named' : 'anonymous'} session while the first is between its files and version inserts returns the same result and deletes nothing`, async () => {
      // Process one inserts the files row, then is held before its version insert
      // while process two completes the same session.
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
      // Cross-process duplicates both finalize storage; see the lenient fixture.
      const storageFixture = createStorage('multipart', { lenientRecompletion: true });
      const one = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
      const two = createApp({ mode: 'multipart', database, storageFixture, createFileFn: await loadProcess() });
      const staged = await one.stage(user, CLIENT_ID, 'same session bytes');
      const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;
      const completeIn = (app: typeof one) => app.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user, token: staged.token });

      const first = completeIn(one);
      await firstHeld;
      expect(await fileRows(database, CLIENT_ID)).toHaveLength(1);
      const second = await completeIn(two);
      releaseFirst();
      const firstResult = await first;

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

  it('a concurrent second completion call of the same session returns the recorded result and deletes nothing', async () => {
    const { database, storageFixture, one, two, firstArrival, filesInserts } = await createTwoProcesses('multipart', { lenientRecompletion: true });
    const staged = await one.stage('user_a', CLIENT_ID, 'same session');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;

    const first = staged.complete();
    await firstArrival;
    const [firstResult, second] = await Promise.all([
      first,
      two.call('POST', `/upload/${staged.uploadSessionId}/complete`, { user: 'user_a' }),
    ]);
    expect(filesInserts()).toBe(2);
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
    expect((await rawSession(database, a.uploadSessionId))!.status).toBe('aborted');
    expect(await app.readBytes(CLIENT_ID, 'user_b')).toBe('created by b');
  });

  it('a stalled duplicate completion resuming after a later writer moved the file on returns the recorded result', async () => {
    // The anonymous session's second call reads "not published", stalls, and
    // resumes after the first call published and an editor added a later version.
    let holdNextVersionMiss = false;
    let stalled!: () => void;
    const duplicateStalled = new Promise<void>((resolve) => { stalled = resolve; });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => { resume = resolve; });
    const database = createUniqueEnforcingDb({
      async afterFindOne(model, result) {
        if (model === 'fileVersions' && result === null && holdNextVersionMiss) {
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
    const app = createApp({ mode: 'multipart', database, storageFixture, authorizer: editorAuthorizer, createFileFn: await loadProcess() });
    const other = createApp({ mode: 'multipart', database, storageFixture, authorizer: editorAuthorizer, createFileFn: await loadProcess() });
    const staged = await app.stage(undefined, CLIENT_ID, 'anonymous capture');
    const key = (await rawSession(database, staged.uploadSessionId))!.storageKey;

    holdNextVersionMiss = true;
    const duplicate = other.call('POST', `/upload/${staged.uploadSessionId}/complete`, { token: staged.token });
    await duplicateStalled;
    const first = await staged.complete();
    expect(first.status).toBe(200);
    const edit = await app.stage('editor', CLIENT_ID, 'edited later');
    const edited = await edit.complete();
    expect(edited.status).toBe(200);
    resume();
    const second = await duplicate;

    expect(second.status).toBe(200);
    expect(second.json.data).toEqual(first.json.data);
    expect(app.fixture.objects.has(key)).toBe(true);
    expect((await rawSession(database, staged.uploadSessionId))!.status).toBe('completed');
    expect((await fileRows(database, CLIENT_ID))[0].currentVersionId).toBe(edited.json.data.versionId);
  });

});

describe('refused completion cleanup', () => {
  for (const stage of ['early', 'commit'] as const) {
    it(`a refused completion whose object delete fails (${stage} refusal) stays open until a retry or the expiry sweep deletes it`, async () => {
      const database = memoryAdapter();
      const storageFixture = createStorage('multipart');
      const app = createApp({ mode: 'multipart', database, storageFixture });
      const loser = await app.stage('user_b', CLIENT_ID, 'loser bytes');
      const winner = await app.stage('user_a', CLIENT_ID, 'winner bytes');
      const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
      if (stage === 'early') {
        // The loser's earlier attempt finalized its object, then failed.
        await storageFixture.storage.completeMultipartUpload!({
          key: loserKey,
          uploadId: [...storageFixture.uploads.entries()].find(([, upload]) => upload.key === loserKey)![0],
          parts: [{ partNumber: 1, etag: 'x' }],
        });
        expect((await winner.complete()).status).toBe(200);
      }
      storageFixture.deleteFailures.set(loserKey, 1);
      let refused;
      if (stage === 'early') {
        refused = await loser.complete();
      } else {
        // The loser passes the early check, then the winner commits first.
        const release = storageFixture.gate(loserKey);
        const losing = loser.complete();
        expect((await winner.complete()).status).toBe(200);
        release();
        refused = await losing;
      }
      expect(refused.status).toBe(403);
      expect(storageFixture.objects.has(loserKey)).toBe(true);
      expect((await rawSession(database, loser.uploadSessionId))!.status).not.toBe('aborted');

      // The expiry sweep retries the delete before dropping the session.
      await database.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: loser.uploadSessionId }],
        data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
        namespace: 'filefn',
      });
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

  it('a retried completion after a failed delete deletes the object and ends the session aborted', async () => {
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const app = createApp({ mode: 'proxy', database, storageFixture });
    const loser = await app.stage('user_b', CLIENT_ID, 'loser');
    const winner = await app.stage('user_a', CLIENT_ID, 'winner');
    const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
    storageFixture.deleteFailures.set(loserKey, 1);
    const release = storageFixture.gate(loserKey);
    const losing = loser.complete();
    expect((await winner.complete()).status).toBe(200);
    release();
    const first = await losing;
    expect(first.status).toBe(403);
    expect(storageFixture.objects.has(loserKey)).toBe(true);

    const retried = await loser.complete();
    expect(retried.status).toBe(403);
    expect(storageFixture.objects.has(loserKey)).toBe(false);
    expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('aborted');
  });

  it('a dedup-reused refusal whose own-object delete fails stays open until a retry deletes it, keeping the shared object', async () => {
    const database = memoryAdapter();
    const storageFixture = createStorage('multipart');
    const app = createApp({ mode: 'multipart', database, storageFixture, dedup: true });
    const loser = await app.stage('user_b', CLIENT_ID, 'same bytes');
    const winner = await app.stage('user_a', CLIENT_ID, 'same bytes');
    const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
    const winnerKey = (await rawSession(database, winner.uploadSessionId))!.storageKey;
    // Dedup's delete of the loser's object and the refusal's delete both fail.
    storageFixture.deleteFailures.set(loserKey, 2);
    const release = storageFixture.gate(loserKey);
    const losing = loser.complete();
    expect((await winner.complete()).status).toBe(200);
    release();
    const refused = await losing;

    expect(refused.status).toBe(403);
    expect(storageFixture.objects.has(loserKey)).toBe(true);
    expect((await rawSession(database, loser.uploadSessionId))!.status).not.toBe('aborted');

    const retried = await loser.complete();
    expect(retried.status).toBe(403);
    expect(storageFixture.objects.has(loserKey)).toBe(false);
    expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('aborted');
    expect(storageFixture.objects.has(winnerKey)).toBe(true);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('same bytes');
  });

  it('a refusal whose proxy part delete fails keeps the session and its parts until a retry deletes them', async () => {
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
    expect((await rawSession(database, loser.uploadSessionId))!.status).not.toBe('aborted');
    expect(await database.findMany({
      model: 'uploadParts',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: loser.uploadSessionId }],
      namespace: 'filefn',
    })).toHaveLength(1);

    const retried = await loser.complete();
    expect(retried.status).toBe(403);
    expect(storageFixture.objects.has(partKey)).toBe(false);
    expect((await rawSession(database, loser.uploadSessionId))!.status).toBe('aborted');
  });

  it('a commit-time refusal whose proxy part delete failed during stitching keeps the session until a retry deletes the part', async () => {
    const database = memoryAdapter();
    const storageFixture = createStorage('proxy');
    const app = createApp({ mode: 'proxy', database, storageFixture });
    const loser = await app.stage('user_b', CLIENT_ID, 'loser part');
    const winner = await app.stage('user_a', CLIENT_ID, 'winner');
    const loserKey = (await rawSession(database, loser.uploadSessionId))!.storageKey;
    const partKey = `${loserKey}.part1`;
    // Stitching's part delete and the refusal's retry both fail once each.
    storageFixture.deleteFailures.set(partKey, 2);
    const release = storageFixture.gate(loserKey);
    const losing = loser.complete();
    expect((await winner.complete()).status).toBe(200);
    release();
    const refused = await losing;

    expect(refused.status).toBe(403);
    expect(storageFixture.objects.has(partKey)).toBe(true);
    expect(storageFixture.objects.has(loserKey)).toBe(false);
    expect((await rawSession(database, loser.uploadSessionId))!.status).not.toBe('aborted');

    await database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: loser.uploadSessionId }],
      data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      namespace: 'filefn',
    });
    await app.fileFn.services.uploads.cleanupExpiredSessions();
    expect(storageFixture.objects.has(partKey)).toBe(false);
    expect(await rawSession(database, loser.uploadSessionId)).toBeNull();
  });
});


describe('in-process completion serialization bound', () => {
  it('a call that never settles holds its key only until the hold timeout, and the key is released', async () => {
    const run = createKeyedSerializer({ holdTimeoutMs: 20 });
    const order: string[] = [];
    void run('k', () => new Promise<never>(() => {}));
    const started = Date.now();
    const waited = await run('k', async () => {
      order.push('second');
      return Date.now() - started;
    });
    expect(order).toEqual(['second']);
    expect(waited).toBeGreaterThanOrEqual(15);
    expect(waited).toBeLessThan(1000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(run.activeKeys()).toBe(0);
  });

  it('calls that settle in time still run one at a time and leave no key behind', async () => {
    const run = createKeyedSerializer({ holdTimeoutMs: 1000 });
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    };
    await Promise.all([run('k', task), run('k', task), run('k', task)]);
    await Promise.resolve();
    expect(maxRunning).toBe(1);
    expect(run.activeKeys()).toBe(0);
  });

  it('a retried completion behind a call that never settles returns the result within the hold timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const database = memoryAdapter();
    const app = createApp({ mode: 'multipart', database });
    const staged = await app.stage('user_a', CLIENT_ID, 'stalled then retried');
    const complete = app.fixture.storage.completeMultipartUpload!.bind(app.fixture.storage);
    let stalls = 1;
    // The first call's storage completion never resolves (a cancelled request).
    app.fixture.storage.completeMultipartUpload = async (input) => {
      if (stalls-- > 0) return new Promise<never>(() => {});
      return complete(input);
    };
    void staged.complete();
    let settled = false;
    const retried = staged.complete().finally(() => {
      settled = true;
    });
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(SERIALIZED_HOLD_TIMEOUT_MS);
    const result = await retried;
    expect(result.status).toBe(200);
    expect(result.json.data.fileId).toBe(CLIENT_ID);
    expect(await app.readBytes(CLIENT_ID, 'user_a')).toBe('stalled then retried');
  });
});
