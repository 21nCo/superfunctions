import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import type { Adapter, AdapterCapabilities } from '@superfunctions/db';
import { createFileFn, type FileFn } from '../index.js';
import { generateFileFnId } from '../ids.js';
import { createDefaultAuthorizer } from '../authz/authorizer.js';
import { CLIENT_FILE_ID_PATTERN, isValidClientFileId } from '../upload-sessions/file-id.js';
import { createFileIdReservations, fileIdReservationId } from '../upload-sessions/file-id-reservations.js';

const CAPS: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: true, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

type Row = Record<string, any>;
type Op = 'create' | 'findOne';

/** A held operation: `reached` resolves once it is held; `release` lets it run. */
interface Hold {
  reached: Promise<void>;
  release: () => void;
}

function hold(): Hold & { wait: Promise<void>; arrive: () => void } {
  let release!: () => void;
  let arrive!: () => void;
  const reached = new Promise<void>((resolve) => { arrive = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, wait, arrive };
}

/**
 * In-memory adapter that enforces the schema's unique `files.fileId` and
 * `uploadSessions.uploadSessionId` the way Postgres does. `holdNext` parks the
 * next matching operation before it runs.
 */
function createDb(options: { enforceUnique?: boolean } = {}) {
  const { enforceUnique = true } = options;
  const tables = new Map<string, Row[]>();
  const holds: Array<{ op: Op; model: string; when: (params: any) => boolean; h: ReturnType<typeof hold> }> = [];

  function table(model: string): Row[] {
    if (!tables.has(model)) tables.set(model, []);
    return tables.get(model)!;
  }

  function match(row: Row, where: any[] = []): boolean {
    return where.every((clause) => {
      const value = row[clause.field];
      if (clause.operator === 'eq') return value === clause.value;
      if (clause.operator === 'ne') return value !== clause.value;
      if (clause.operator === 'lt') return value < clause.value;
      return true;
    });
  }

  async function gate(op: Op, params: any): Promise<void> {
    const index = holds.findIndex((entry) => entry.op === op && entry.model === params.model && entry.when(params));
    if (index === -1) return;
    const [entry] = holds.splice(index, 1);
    entry.h.arrive();
    await entry.h.wait;
  }

  const unique: Record<string, string> = { files: 'fileId', uploadSessions: 'uploadSessionId' };

  const adapter = {
    id: 'client-file-ids-db',
    name: 'client-file-ids-db',
    version: '1.0.0',
    capabilities: CAPS,
    async create(params: any) {
      await gate('create', params);
      const key = unique[params.model];
      if (enforceUnique && key && table(params.model).some((row) => row[key] === params.data[key])) {
        throw new Error(`duplicate key value violates unique constraint "${params.model}_${key}_key"`);
      }
      const record = { ...params.data };
      table(params.model).push(record);
      return record;
    },
    async findOne(params: any) {
      await gate('findOne', params);
      const found = table(params.model).find((row) => match(row, params.where));
      return found ? { ...found } : null;
    },
    async findMany(params: any) {
      return table(params.model).filter((row) => match(row, params.where)).map((row) => ({ ...row }));
    },
    async update(params: any) {
      const rows = table(params.model);
      const index = rows.findIndex((row) => match(row, params.where));
      if (index === -1) return null;
      rows[index] = { ...rows[index], ...params.data };
      return { ...rows[index] };
    },
    async delete(params: any) {
      const rows = table(params.model);
      const index = rows.findIndex((row) => match(row, params.where));
      if (index !== -1) rows.splice(index, 1);
    },
    async deleteMany(params: any) {
      const rows = table(params.model);
      const kept = rows.filter((row) => !match(row, params.where));
      tables.set(params.model, kept);
      return rows.length - kept.length;
    },
    async createMany() { return []; },
    async updateMany() { return 0; },
    async upsert() { throw new Error('not used'); },
    async count() { return 0; },
    async transaction(cb: any) { return cb(adapter); },
    async initialize() {},
    async isHealthy() { return { healthy: true, uptime: 0 }; },
    async close() {},
    async getSchemaVersion() { return 0; },
    async setSchemaVersion() {},
    async validateSchema() { return { valid: true }; },
  };

  return {
    adapter: adapter as unknown as Adapter,
    rows: (model: string) => table(model),
    holdNext(op: Op, model: string, when: (params: any) => boolean = () => true): Hold {
      const h = hold();
      holds.push({ op, model, when, h });
      return h;
    },
  };
}

type Layout = 'default' | 'shared';
const SHARED_PATH = (ctx: { fileId: string }) => `captures/${ctx.fileId}`;

const isReservationInsert = (params: any) => String(params.data?.uploadSessionId).startsWith('fileid:');

describe('client-chosen file IDs on upload/init (FILE-5)', () => {
  let db: ReturnType<typeof createDb>;
  /** Stored objects. A multipart object's content is the upload ID that produced it. */
  let objects: Map<string, string>;
  let publishedUploads: string[];
  let multipartUploadsStarted: number;
  let publishGate: ReturnType<typeof hold> | null;
  let fileFn: FileFn;

  /** Holds the next multipart completion (publish) until released. */
  function holdNextPublish(): Hold {
    const h = hold();
    publishGate = h;
    return { reached: h.reached, release: h.release };
  }

  function build(options: { layout?: Layout; mode?: 'multipart' | 'proxy'; anonymous?: boolean } = {}) {
    const { layout = 'default', mode = 'multipart', anonymous = false } = options;
    db = createDb();
    objects = new Map();
    publishedUploads = [];
    multipartUploadsStarted = 0;
    publishGate = null;
    const proxy = mode === 'proxy';
    fileFn = createFileFn({
      database: db.adapter,
      // Honors write grants in filePermissions.
      authorizer: createDefaultAuthorizer({ db: db.adapter }),
      storage: createFakeStorageAdapter({
        capabilities: {
          signedUploadUrls: !proxy,
          signedDownloadUrls: true,
          multipart: !proxy,
          proxyStreamingUpload: proxy,
          proxyStreamingDownload: proxy,
        },
        async createMultipartUpload() {
          multipartUploadsStarted += 1;
          return { uploadId: `mpu_${multipartUploadsStarted}` };
        },
        async completeMultipartUpload(input) {
          const gate = publishGate;
          if (gate) {
            publishGate = null;
            gate.arrive();
            await gate.wait;
          }
          objects.set(input.key, input.uploadId);
          publishedUploads.push(input.uploadId);
        },
        async openUploadStream(input) {
          let content = '';
          const decoder = new TextDecoder();
          return new WritableStream<Uint8Array>({
            write(chunk) { content += decoder.decode(chunk, { stream: true }); },
            close() { objects.set(input.key, content); },
          });
        },
        async openDownloadStream(input) {
          const content = objects.get(input.key);
          if (content === undefined) throw new Error(`Object not found: ${input.key}`);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(content));
              controller.close();
            },
          });
        },
        async deleteObject(input) {
          objects.delete(input.key);
        },
        async statObject(input) {
          return { key: input.key, size: proxy ? (objects.get(input.key)?.length ?? 0) : 3 };
        },
      }),
      policies: [{
        name: 'capture',
        contentTypes: ['image/png'],
        maxSizeBytes: 1024,
        storagePath: layout === 'shared' ? SHARED_PATH : undefined,
      }],
      auth: {
        // With `anonymous`, a request without x-user-id is an anonymous caller.
        required: !anonymous,
        resolveSession: async (request) => {
          const principalId = request.headers.get('x-user-id');
          return principalId ? { principalId, tenantId: 'org_1' } : null;
        },
      },
    });
  }

  beforeEach(() => build());

  async function call(
    method: string,
    path: string,
    user: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const isBytes = typeof body === 'string';
    let response: Response | null | undefined;
    try {
      response = await fileFn.router.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          'content-type': isBytes ? 'image/png' : 'application/json',
          ...(user ? { 'x-user-id': user } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : isBytes ? body : JSON.stringify(body),
      }),
      );
    } catch (error) {
      // The router rethrows unexpected errors for the host to turn into a 500.
      return { status: 500, body: { error: { message: (error as Error).message } } };
    }
    return { status: response!.status, body: await response!.json() };
  }

  function init(user: string, body: Record<string, unknown>, headers?: Record<string, string>) {
    return call(
      'POST',
      '/upload/init',
      user,
      { policy: 'capture', fileName: 'capture.png', size: 3, mimeType: 'image/png', ...body },
      headers,
    );
  }

  /** Inits a session and uploads its one part: `bytes` through the proxy, or a recorded multipart part. */
  async function initAndUpload(user: string, fileId: string, bytes = 'abc'): Promise<string> {
    const res = await init(user, { fileId });
    expect(res.status).toBe(200);
    const uploadSessionId = res.body.data.uploadSessionId as string;
    const part = res.body.data.uploadMode === 'proxy'
      ? await call('PUT', `/upload/${uploadSessionId}/parts/1`, user, bytes)
      : await call('POST', `/upload/${uploadSessionId}/parts/1/complete`, user, { etag: `etag-${user}`, size: 3 });
    expect(part.status).toBe(200);
    return uploadSessionId;
  }

  function complete(user: string, uploadSessionId: string) {
    return call('POST', `/upload/${uploadSessionId}/complete`, user);
  }

  function sessionRow(uploadSessionId: string): Row {
    return db.rows('uploadSessions').find((row) => row.uploadSessionId === uploadSessionId)!;
  }

  function fileRows(fileId: string): Row[] {
    return db.rows('files').filter((row) => row.fileId === fileId);
  }

  function versionRows(fileId: string): Row[] {
    return db.rows('fileVersions').filter((row) => row.fileId === fileId);
  }

  function reservationRow(fileId: string): Row | undefined {
    return db.rows('uploadSessions').find((row) => row.uploadSessionId === fileIdReservationId(fileId));
  }

  function sessionsOf(user: string): Row[] {
    return db.rows('uploadSessions').filter((row) => row.ownerId === user && !String(row.uploadSessionId).startsWith('fileid:'));
  }

  /**
   * Asserts `fileId` has one row owned by `owner` pointing at `versionId`, that
   * this is its only version, and that the version's object holds `content`.
   */
  function expectFile(fileId: string, owner: string, versionId: string, content: string) {
    expect(fileRows(fileId)).toEqual([expect.objectContaining({ ownerId: owner, currentVersionId: versionId })]);
    const versions = versionRows(fileId);
    expect(versions).toEqual([expect.objectContaining({ versionId })]);
    expect(objects.get(versions[0].storageKey)).toBe(content);
  }

  function grantWrite(fileId: string, userId: string) {
    db.rows('filePermissions').push({
      permissionId: `perm_${userId}`,
      fileId,
      userId,
      role: null,
      tenantId: null,
      canRead: true,
      canWrite: true,
      canDelete: false,
      canShare: false,
      expiresAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  describe('grammar file_[A-Za-z0-9_-]{8,64}', () => {
    const accepted = [
      'file_abcdefgh',
      `file_${'a'.repeat(64)}`,
      'file_AZaz09-_',
      'file_--------',
      'file_________',
      'file_lq2x3abc_k3j4h5g6', // legacy server ID shape
      'file_0123456789abcdef0123456789abcdef', // @filefn/client generateFileId() shape
      generateFileFnId('file'),
    ];
    const rejected: unknown[] = [
      '',
      'file_',
      'file_abcdefg', // 7 characters
      `file_${'a'.repeat(65)}`,
      'FILE_abcdefgh',
      'file-abcdefgh',
      'upl_abcdefgh',
      'ver_abcdefgh',
      ' file_abcdefgh',
      'file_abcdefgh ',
      'file_abcdefgh\n',
      'file_abc/defgh',
      'file_abc.defgh',
      'file_abc%2Fdefgh',
      'file_abcdéfgh',
      '../file_abcdefgh',
      12345678,
      true,
      { id: 'file_abcdefgh' },
      ['file_abcdefgh'],
    ];

    it.each(accepted)('accepts %j on init and keeps it through completion', async (fileId) => {
      expect(isValidClientFileId(fileId)).toBe(true);
      const uploadSessionId = await initAndUpload('user_a', fileId);
      const done = await complete('user_a', uploadSessionId);
      expect(done.status).toBe(200);
      expect(done.body.data.fileId).toBe(fileId);
      expect(db.rows('files').map((row) => [row.fileId, row.ownerId])).toEqual([[fileId, 'user_a']]);
    });

    it.each(rejected)('rejects %j with 400 before creating a session', async (fileId) => {
      expect(isValidClientFileId(fileId)).toBe(false);
      const res = await init('user_a', { fileId });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILEFN_INVALID_FILE_ID');
      expect(db.rows('uploadSessions')).toHaveLength(0);
    });

    it('rejects an invalid ID even when the request replays an idempotency key', async () => {
      const res = await init('user_a', { fileId: 'file_bad' }, { 'x-idempotency-key': 'idem_bad' });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('FILEFN_INVALID_FILE_ID');
    });

    it('generates a server ID when fileId is absent or null', async () => {
      for (const body of [{}, { fileId: null }]) {
        const res = await init('user_a', body);
        expect(res.status).toBe(200);
      }
      const ids = db.rows('uploadSessions').map((row) => row.fileId);
      expect(ids).toHaveLength(2);
      for (const id of ids) expect(id).toMatch(CLIENT_FILE_ID_PATTERN);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  it('a new ID creates the file owned by the caller under that ID', async () => {
    const fileId = 'file_offline_capture_001';
    const uploadSessionId = await initAndUpload('user_a', fileId);
    expect(reservationRow(fileId)).toMatchObject({ ownerId: 'user_a', tenantId: 'org_1' });
    const status = await call('GET', `/upload/${uploadSessionId}/status`, 'user_a');
    expect(status.body.data.fileId).toBe(fileId);

    const done = await complete('user_a', uploadSessionId);
    expect(done.status).toBe(200);
    expect(done.body.data.fileId).toBe(fileId);
    expect(fileRows(fileId)[0]).toMatchObject({ ownerId: 'user_a', tenantId: 'org_1' });
    expectFile(fileId, 'user_a', done.body.data.versionId, sessionRow(uploadSessionId).storageUploadId);
    expect((await call('GET', `/${fileId}`, 'user_a')).status).toBe(200);
  });

  describe('two principals racing on one new ID resolve to a single owner', () => {
    it('when both init at once, exactly one gets the ID and the other gets 403', async () => {
      const fileId = 'file_raced_at_once_01';
      const results = await Promise.all([init('user_a', { fileId }), init('user_b', { fileId })]);
      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([200, 403]);
      const winner = results[0].status === 200 ? 'user_a' : 'user_b';
      const loser = winner === 'user_a' ? 'user_b' : 'user_a';
      expect(results.find((res) => res.status === 403)!.body.error.code).toBe('FILEFN_FORBIDDEN');
      expect(reservationRow(fileId)).toMatchObject({ ownerId: winner });
      expect(sessionsOf(loser)).toHaveLength(0);
    });

    it('when both pass the lookup before either inserts: the first insert wins', async () => {
      const fileId = 'file_raced_insert_01';
      // user_a has looked the ID up (free) and is about to insert its reservation.
      const held = db.holdNext('create', 'uploadSessions', isReservationInsert);
      const pendingA = init('user_a', { fileId });
      await held.reached;
      // user_b inserts first.
      const doneB = await init('user_b', { fileId });
      held.release();
      const doneA = await pendingA;

      expect(doneB.status).toBe(200);
      expect(doneA.status).toBe(403);
      expect(reservationRow(fileId)).toMatchObject({ ownerId: 'user_b' });
      expect(sessionsOf('user_a')).toHaveLength(0);
      expect(db.rows('uploadSessions').filter((row) => row.uploadSessionId === fileIdReservationId(fileId))).toHaveLength(1);
    });

    describe.each(['multipart', 'proxy'] as const)('with a storage path shared by the ID, in %s mode', (mode) => {
      beforeEach(() => build({ layout: 'shared', mode }));

      it('the loser stores no bytes, so the winner keeps its own', async () => {
        const fileId = 'file_raced_shared_01';
        const sessionA = await initAndUpload('user_a', fileId, 'AAA');
        const foreign = await init('user_b', { fileId });
        expect(foreign.status).toBe(403);
        expect(sessionsOf('user_b')).toHaveLength(0);
        // user_b never started a storage upload under the shared key.
        expect(multipartUploadsStarted).toBe(mode === 'multipart' ? 1 : 0);

        const doneA = await complete('user_a', sessionA);
        expect(doneA.status).toBe(200);
        const expected = mode === 'proxy' ? 'AAA' : sessionRow(sessionA).storageUploadId;
        expectFile(fileId, 'user_a', doneA.body.data.versionId, expected);
        expect(objects.get(SHARED_PATH({ fileId }))).toBe(expected);

        // After the file exists, user_b is refused through the write check.
        expect((await init('user_b', { fileId })).status).toBe(403);
        expect(objects.get(SHARED_PATH({ fileId }))).toBe(expected);
      });
    });
  });

  describe('a retried init after a lost response', () => {
    it('replays the same session when the retry repeats the idempotency key', async () => {
      const fileId = 'file_retry_idem_0001';
      const first = await init('user_a', { fileId }, { 'x-idempotency-key': 'idem_capture_1' });
      const retry = await init('user_a', { fileId }, { 'x-idempotency-key': 'idem_capture_1' });
      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(retry.body.data.uploadSessionId).toBe(first.body.data.uploadSessionId);
      expect(sessionsOf('user_a')).toHaveLength(1);
    });

    it('lets the same caller init again without a key, and keeps one file when both sessions complete at once', async () => {
      const fileId = 'file_retry_lost_0001';
      // The first init's response was lost, so the client inits again without a key.
      const original = await initAndUpload('user_a', fileId);
      const retry = await initAndUpload('user_a', fileId);
      expect(retry).not.toBe(original);
      expect(reservationRow(fileId)).toMatchObject({ ownerId: 'user_a' });

      const [doneOriginal, doneRetry] = await Promise.all([complete('user_a', original), complete('user_a', retry)]);
      expect(doneOriginal.status).toBe(200);
      expect(doneRetry.status).toBe(200);
      expect(doneOriginal.body.data.fileId).toBe(fileId);
      expect(doneRetry.body.data.fileId).toBe(fileId);

      const files = fileRows(fileId);
      expect(files).toHaveLength(1);
      expect(files[0].ownerId).toBe('user_a');
      expect([doneOriginal.body.data.versionId, doneRetry.body.data.versionId]).toContain(files[0].currentVersionId);
      const versions = versionRows(fileId);
      expect(versions.map((row) => row.versionId).sort()).toEqual(
        [doneOriginal.body.data.versionId, doneRetry.body.data.versionId].sort(),
      );
      for (const [session, done] of [[original, doneOriginal], [retry, doneRetry]] as const) {
        const version = versions.find((row) => row.versionId === done.body.data.versionId)!;
        expect(objects.get(version.storageKey)).toBe(sessionRow(session).storageUploadId);
      }
    });

    it('adds a version when the other session created the file while this one was publishing', async () => {
      const fileId = 'file_retry_publish_01';
      const original = await initAndUpload('user_a', fileId);
      const retry = await initAndUpload('user_a', fileId);

      const publishing = holdNextPublish();
      const pendingOriginal = complete('user_a', original);
      await publishing.reached;
      const doneRetry = await complete('user_a', retry);
      expect(doneRetry.status).toBe(200);
      publishing.release();
      const doneOriginal = await pendingOriginal;

      expect(doneOriginal.status).toBe(200);
      expect(fileRows(fileId)).toEqual([
        expect.objectContaining({ ownerId: 'user_a', currentVersionId: doneOriginal.body.data.versionId }),
      ]);
      expect(versionRows(fileId)).toHaveLength(2);
    });
  });

  describe("another principal's ID", () => {
    it('is rejected with 403 at init when the file exists', async () => {
      const fileId = 'file_owned_by_user_a';
      const uploadSessionId = await initAndUpload('user_a', fileId);
      expect((await complete('user_a', uploadSessionId)).status).toBe(200);

      const foreign = await init('user_b', { fileId });
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.code).toBe('FILEFN_FORBIDDEN');
      expect(sessionsOf('user_b')).toHaveLength(0);

      // The owner may still replace its own file under the same ID.
      expect((await init('user_a', { fileId })).status).toBe(200);
    });

    it('is rejected with 403 at init while reserved but not yet uploaded', async () => {
      const fileId = 'file_reserved_user_a';
      expect((await init('user_a', { fileId })).status).toBe(200);
      const foreign = await init('user_b', { fileId });
      expect(foreign.status).toBe(403);
      expect(sessionsOf('user_b')).toHaveLength(0);
      expect(reservationRow(fileId)).toMatchObject({ ownerId: 'user_a' });
    });

    it('stays with its owner after the file is deleted', async () => {
      const fileId = 'file_deleted_user_a01';
      const uploadSessionId = await initAndUpload('user_a', fileId);
      expect((await complete('user_a', uploadSessionId)).status).toBe(200);
      expect((await call('DELETE', `/${fileId}`, 'user_a')).status).toBe(200);
      expect(fileRows(fileId)).toEqual([]);

      expect((await init('user_b', { fileId })).status).toBe(403);
      expect((await init('user_a', { fileId })).status).toBe(200);
    });

    it('cannot be taken by a writer of the file once the file is deleted', async () => {
      const fileId = 'file_granted_deleted01';
      const created = await initAndUpload('user_a', fileId);
      expect((await complete('user_a', created)).status).toBe(200);
      grantWrite(fileId, 'user_b');
      expect((await init('user_b', { fileId })).status).toBe(200);

      expect((await call('DELETE', `/${fileId}`, 'user_a')).status).toBe(200);
      expect((await init('user_b', { fileId })).status).toBe(403);
    });

    it('cannot be recreated by a writer whose completion was publishing when the file was deleted', async () => {
      const fileId = 'file_granted_inflight1';
      const created = await initAndUpload('user_a', fileId);
      expect((await complete('user_a', created)).status).toBe(200);
      grantWrite(fileId, 'user_b');
      const sessionB = await initAndUpload('user_b', fileId);

      const publishing = holdNextPublish();
      const pendingB = complete('user_b', sessionB);
      await publishing.reached;
      expect((await call('DELETE', `/${fileId}`, 'user_a')).status).toBe(200);
      publishing.release();

      expect((await pendingB).status).toBe(403);
      expect(fileRows(fileId)).toEqual([]);
    });
  });

  it('refuses a session without a reservation once another principal created the file mid-publish', async () => {
    // A session left from before IDs were reserved: user_b's session on an ID
    // nobody had reserved. user_a then reserves and creates the file while
    // user_b's completion is publishing.
    const fileId = 'file_presession_race1';
    const sessionB = await initAndUpload('user_b', fileId);
    db.rows('uploadSessions').splice(
      db.rows('uploadSessions').findIndex((row) => row.uploadSessionId === fileIdReservationId(fileId)),
      1,
    );
    const publishing = holdNextPublish();
    const pendingB = complete('user_b', sessionB);
    await publishing.reached;
    const sessionA = await initAndUpload('user_a', fileId);
    const doneA = await complete('user_a', sessionA);
    expect(doneA.status).toBe(200);
    publishing.release();
    const doneB = await pendingB;

    expect(doneB.status).toBe(403);
    expect(fileRows(fileId)).toEqual([
      expect.objectContaining({ ownerId: 'user_a', currentVersionId: doneA.body.data.versionId }),
    ]);
  });

  describe('a reservation', () => {
    it('is not an upload session', async () => {
      const fileId = 'file_not_a_session01';
      expect((await init('user_a', { fileId })).status).toBe(200);
      const reservationId = encodeURIComponent(fileIdReservationId(fileId));
      for (const [method, path] of [
        ['GET', `/upload/${reservationId}/status`],
        ['POST', `/upload/${reservationId}/complete`],
        ['POST', `/upload/${reservationId}/abort`],
      ] as const) {
        const res = await call(method, path, 'user_a');
        expect(res.status).toBe(404);
      }
    });

    it('survives expired-session cleanup', async () => {
      const fileId = 'file_cleanup_keeps_01';
      expect((await init('user_a', { fileId })).status).toBe(200);
      for (const row of sessionsOf('user_a')) row.expiresAt = new Date(Date.now() - 1000).toISOString();
      const result = await fileFn.cleanupExpiredSessions();
      expect(result.deletedSessions).toBe(1);
      expect(reservationRow(fileId)).toMatchObject({ ownerId: 'user_a' });
      expect((await init('user_b', { fileId })).status).toBe(403);
    });

    it('cannot be held by an anonymous caller', async () => {
      const reservations = createFileIdReservations({ db: db.adapter, namespace: 'filefn' });
      expect(await reservations.reserve('file_anonymous_0001', { ownerId: 'anonymous', tenantId: null }, 'capture')).toBe(false);
      expect(reservationRow('file_anonymous_0001')).toBeUndefined();
    });
  });

  describe('an anonymous caller (no principal)', () => {
    beforeEach(() => build({ anonymous: true }));

    /** An anonymous init, part and completion, authorized by the session token. */
    async function anonymousUpload(fileId: string): Promise<{ status: number; body: any }> {
      const res = await init('', { fileId });
      if (res.status !== 200) return res;
      const { uploadSessionId, uploadSessionToken } = res.body.data;
      const token = { 'x-upload-session-token': uploadSessionToken };
      const part = await call('POST', `/upload/${uploadSessionId}/parts/1/complete`, '', { etag: 'etag-anon', size: 3 }, token);
      expect(part.status).toBe(200);
      return call('POST', `/upload/${uploadSessionId}/complete`, '', undefined, token);
    }

    it('uploads under an SDK-generated ID and creates the file under it', async () => {
      // @filefn/client always sends a generated `file_<32 hex>` ID.
      const fileId = `file_${'0123456789abcdef'.repeat(2)}`;
      const done = await anonymousUpload(fileId);

      expect(done.status).toBe(200);
      expect(done.body.data.fileId).toBe(fileId);
      expect(fileRows(fileId)).toEqual([expect.objectContaining({ ownerId: 'anonymous', currentVersionId: done.body.data.versionId })]);
      // It reserves nothing: the ID is unowned until the file exists.
      expect(reservationRow(fileId)).toBeUndefined();
    });

    it('gets 403 at init under an ID a named principal reserved', async () => {
      const fileId = 'file_named_first_01';
      expect((await init('user_a', { fileId })).status).toBe(200);

      const res = await init('', { fileId });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FILEFN_FORBIDDEN');
    });

    it('gets 403 at completion once a named principal reserved the ID after its init', async () => {
      const fileId = 'file_named_later_01';
      const res = await init('', { fileId });
      expect(res.status).toBe(200);
      const { uploadSessionId, uploadSessionToken } = res.body.data;
      const token = { 'x-upload-session-token': uploadSessionToken };
      await call('POST', `/upload/${uploadSessionId}/parts/1/complete`, '', { etag: 'etag-anon', size: 3 }, token);

      expect((await init('user_a', { fileId })).status).toBe(200);
      const done = await call('POST', `/upload/${uploadSessionId}/complete`, '', undefined, token);

      expect(done.status).toBe(403);
      expect(fileRows(fileId)).toEqual([]);
      expect(publishedUploads).toEqual([]);
    });
  });

  it('settles one reservation owner even on an adapter that does not enforce the unique key', async () => {
    const lax = createDb({ enforceUnique: false });
    const reservations = createFileIdReservations({ db: lax.adapter, namespace: 'filefn' });
    const fileId = 'file_lax_adapter_01';
    const results = await Promise.all([
      reservations.reserve(fileId, { ownerId: 'user_a', tenantId: 'org_1' }, 'capture'),
      reservations.reserve(fileId, { ownerId: 'user_b', tenantId: 'org_1' }, 'capture'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
