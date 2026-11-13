import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import type { Adapter, AdapterCapabilities } from '@superfunctions/db';
import { createFileFn, type FileFn } from '../index.js';
import { generateFileFnId } from '../ids.js';
import { CLIENT_FILE_ID_PATTERN, isValidClientFileId } from '../upload-sessions/file-id.js';
import { fileClaimId } from '../upload-sessions/file-claims.js';

const CAPS: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: true, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

type Row = Record<string, any>;
type Op = 'create' | 'findOne' | 'update' | 'delete';

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
 * next matching operation before it runs (never releasing it models a request
 * interrupted at that point). `zeroRowUpdates` picks how an update that matches
 * no row behaves, since adapters differ: return null, or throw.
 */
function createDb() {
  const tables = new Map<string, Row[]>();
  const holds: Array<{ op: Op; model: string; when: (params: any) => boolean; h: ReturnType<typeof hold> }> = [];
  let zeroRowUpdates: 'null' | 'throw' = 'null';
  let failNextFilesUpdate = false;

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
      if (key && table(params.model).some((row) => row[key] === params.data[key])) {
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
      await gate('update', params);
      if (params.model === 'files' && failNextFilesUpdate) {
        failNextFilesUpdate = false;
        throw new Error('connection reset');
      }
      const rows = table(params.model);
      const index = rows.findIndex((row) => match(row, params.where));
      if (index === -1) {
        if (zeroRowUpdates === 'throw') throw new Error('No record found for update');
        return null;
      }
      rows[index] = { ...rows[index], ...params.data };
      return { ...rows[index] };
    },
    async delete(params: any) {
      await gate('delete', params);
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
    setZeroRowUpdates(mode: 'null' | 'throw') {
      zeroRowUpdates = mode;
    },
    failNextFilesUpdate() {
      failNextFilesUpdate = true;
    },
  };
}

type Layout = 'default' | 'shared';
const SHARED_PATH = (ctx: { fileId: string }) => `captures/${ctx.fileId}`;

describe('client-chosen file IDs on upload/init (FILE-5)', () => {
  let db: ReturnType<typeof createDb>;
  /** Stored objects. A multipart object's content is the upload ID that produced it. */
  let objects: Map<string, string>;
  let publishedUploads: string[];
  let publishGate: { h: ReturnType<typeof hold>; fail: boolean } | null;
  let fileFn: FileFn;

  /** Holds the next multipart completion (publish) until released; `fail` makes it throw then. */
  function holdNextPublish(): Hold & { fail: () => void } {
    const h = hold();
    const entry = { h, fail: false };
    publishGate = entry;
    return {
      reached: h.reached,
      release: h.release,
      fail: () => {
        entry.fail = true;
        h.release();
      },
    };
  }

  function build(options: { layout?: Layout; mode?: 'multipart' | 'proxy' } = {}) {
    const { layout = 'default', mode = 'multipart' } = options;
    db = createDb();
    objects = new Map();
    publishedUploads = [];
    publishGate = null;
    let uploads = 0;
    const proxy = mode === 'proxy';
    fileFn = createFileFn({
      database: db.adapter,
      storage: createFakeStorageAdapter({
        capabilities: {
          signedUploadUrls: !proxy,
          signedDownloadUrls: true,
          multipart: !proxy,
          proxyStreamingUpload: proxy,
          proxyStreamingDownload: proxy,
        },
        async createMultipartUpload() {
          uploads += 1;
          return { uploadId: `mpu_${uploads}` };
        },
        async completeMultipartUpload(input) {
          const gate = publishGate;
          if (gate) {
            publishGate = null;
            gate.h.arrive();
            await gate.h.wait;
            if (gate.fail) throw new Error('storage unavailable');
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
        required: true,
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
          'x-user-id': user,
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

  function claimRow(fileId: string): Row | undefined {
    return db.rows('uploadSessions').find((row) => row.uploadSessionId === fileClaimId(fileId));
  }

  function expireClaim(fileId: string) {
    claimRow(fileId)!.expiresAt = new Date(Date.now() - 1000).toISOString();
  }

  /** Lets queued work (a waiting completion's next poll) run. */
  function tick(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Asserts `fileId` has one row owned by `owner` pointing at `versionId`, that
   * this is its only version, and that the version's object holds `content`.
   * No claim is left behind.
   */
  function expectFile(fileId: string, owner: string, versionId: string, content: string) {
    expect(fileRows(fileId)).toEqual([expect.objectContaining({ ownerId: owner, currentVersionId: versionId })]);
    const versions = versionRows(fileId);
    expect(versions).toEqual([expect.objectContaining({ versionId })]);
    expect(objects.get(versions[0].storageKey)).toBe(content);
    expect(claimRow(fileId)).toBeUndefined();
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
    const status = await call('GET', `/upload/${uploadSessionId}/status`, 'user_a');
    expect(status.body.data.fileId).toBe(fileId);

    const done = await complete('user_a', uploadSessionId);
    expect(done.status).toBe(200);
    expect(done.body.data.fileId).toBe(fileId);
    expect(fileRows(fileId)[0]).toMatchObject({ ownerId: 'user_a', tenantId: 'org_1', currentVersionId: done.body.data.versionId });
    expectFile(fileId, 'user_a', done.body.data.versionId, sessionRow(uploadSessionId).storageUploadId);
  });

  describe('two principals racing on one new ID resolve to a single owner', () => {
    describe.each(['default', 'shared'] as const)('with the %s key layout', (layout) => {
      beforeEach(() => build({ layout }));

      async function initBoth(fileId: string): Promise<[string, string]> {
        // Neither file exists yet, so both inits are accepted.
        const sessionA = await initAndUpload('user_a', fileId);
        const sessionB = await initAndUpload('user_b', fileId);
        if (layout === 'shared') expect(sessionRow(sessionB).storageKey).toBe(sessionRow(sessionA).storageKey);
        return [sessionA, sessionB];
      }

      it('when both complete at once', async () => {
        const fileId = 'file_raced_at_once_01';
        const sessions = await initBoth(fileId);
        const results = await Promise.all([complete('user_a', sessions[0]), complete('user_b', sessions[1])]);

        const winner = results.findIndex((res) => res.status === 200);
        expect(winner).not.toBe(-1);
        const loser = 1 - winner;
        expect(results[loser].status).toBe(403);
        expect(results[loser].body.error.code).toBe('FILEFN_FORBIDDEN');
        const winnerSession = sessionRow(sessions[winner]);
        expectFile(fileId, winnerSession.ownerId, results[winner].body.data.versionId, winnerSession.storageUploadId);
        // The loser never stores bytes, so a shared key keeps the winner's.
        expect(publishedUploads).toEqual([winnerSession.storageUploadId]);
      });

      it('when the loser completes while the winner is publishing', async () => {
        const fileId = 'file_raced_publish_01';
        const [sessionA, sessionB] = await initBoth(fileId);

        const publishing = holdNextPublish();
        const pendingA = complete('user_a', sessionA);
        await publishing.reached;
        const pendingB = complete('user_b', sessionB);
        await tick(30);
        // While user_a holds the ID, user_b has stored nothing and no file is visible.
        expect(fileRows(fileId)).toEqual([]);
        publishing.release();
        const [doneA, doneB] = await Promise.all([pendingA, pendingB]);

        expect(doneA.status).toBe(200);
        expect(doneB.status).toBe(403);
        expectFile(fileId, 'user_a', doneA.body.data.versionId, sessionRow(sessionA).storageUploadId);
        expect(publishedUploads).toEqual([sessionRow(sessionA).storageUploadId]);

        // Retrying the losing completion stays forbidden and changes nothing.
        expect((await complete('user_b', sessionB)).status).toBe(403);
        expectFile(fileId, 'user_a', doneA.body.data.versionId, sessionRow(sessionA).storageUploadId);
      });

      it('when the loser completes after the winner', async () => {
        const fileId = 'file_raced_after_01';
        const [sessionA, sessionB] = await initBoth(fileId);

        const doneA = await complete('user_a', sessionA);
        const doneB = await complete('user_b', sessionB);
        expect(doneA.status).toBe(200);
        expect(doneB.status).toBe(403);
        expectFile(fileId, 'user_a', doneA.body.data.versionId, sessionRow(sessionA).storageUploadId);
        expect(publishedUploads).toEqual([sessionRow(sessionA).storageUploadId]);
      });
    });

    it('in proxy mode with a shared key, each session uploads its own parts and the winner keeps its bytes', async () => {
      build({ layout: 'shared', mode: 'proxy' });
      const fileId = 'file_raced_proxy_01';
      const sessionA = await initAndUpload('user_a', fileId, 'AAA');
      const sessionB = await initAndUpload('user_b', fileId, 'BBB');
      const key = SHARED_PATH({ fileId });
      expect(sessionRow(sessionB).storageKey).toBe(key);
      // Both parts are stored, under keys of their own sessions.
      expect([...objects.values()].sort()).toEqual(['AAA', 'BBB']);

      const doneA = await complete('user_a', sessionA);
      const doneB = await complete('user_b', sessionB);
      expect(doneA.status).toBe(200);
      expect(doneB.status).toBe(403);
      expectFile(fileId, 'user_a', doneA.body.data.versionId, 'AAA');

      // Aborting the losing session removes only its own part.
      expect((await call('POST', `/upload/${sessionB}/abort`, 'user_b')).status).toBe(200);
      expect([...objects.entries()]).toEqual([[key, 'AAA']]);
    });
  });

  describe('a completion that fails or stops part-way', () => {
    it('frees a new ID when publishing fails, for the same caller to complete it', async () => {
      const fileId = 'file_claim_released_01';
      const uploadSessionId = await initAndUpload('user_a', fileId);

      const publishing = holdNextPublish();
      const pending = complete('user_a', uploadSessionId);
      await publishing.reached;
      publishing.fail();
      expect((await pending).status).toBe(500);
      expect(fileRows(fileId)).toEqual([]);
      expect(versionRows(fileId)).toEqual([]);
      expect(claimRow(fileId)).toBeUndefined();

      const done = await complete('user_a', uploadSessionId);
      expect(done.status).toBe(200);
      expectFile(fileId, 'user_a', done.body.data.versionId, sessionRow(uploadSessionId).storageUploadId);
    });

    it("lets the same owner's waiting retry create the file after the first attempt fails", async () => {
      const fileId = 'file_retry_after_fail_1';
      const first = await initAndUpload('user_a', fileId);
      const retry = await initAndUpload('user_a', fileId);

      const publishing = holdNextPublish();
      const pendingFirst = complete('user_a', first);
      await publishing.reached;
      const pendingRetry = complete('user_a', retry);
      await tick(30);
      publishing.fail();

      expect((await pendingFirst).status).toBe(500);
      const doneRetry = await pendingRetry;
      expect(doneRetry.status).toBe(200);
      expectFile(fileId, 'user_a', doneRetry.body.data.versionId, sessionRow(retry).storageUploadId);
      expect(sessionRow(retry)).toMatchObject({ status: 'completed', completionVersionId: doneRetry.body.data.versionId });
      expect(sessionRow(first).status).not.toBe('completed');
    });

    it('gives the ID to whoever completes after a failed attempt, and later foreign completions get 403', async () => {
      const fileId = 'file_foreign_after_fail';
      const sessionA = await initAndUpload('user_a', fileId);
      const sessionB = await initAndUpload('user_b', fileId);
      const sessionC = await initAndUpload('user_c', fileId);

      const publishing = holdNextPublish();
      const pendingA = complete('user_a', sessionA);
      await publishing.reached;
      const pendingC = complete('user_c', sessionC);
      await tick(30);
      publishing.fail();
      expect((await pendingA).status).toBe(500);
      const doneC = await pendingC;
      expect(doneC.status).toBe(200);

      const doneB = await complete('user_b', sessionB);
      expect(doneB.status).toBe(403);
      expect((await complete('user_a', sessionA)).status).toBe(403);
      expectFile(fileId, 'user_c', doneC.body.data.versionId, sessionRow(sessionC).storageUploadId);
    });

    it('shows no file while the creating completion is publishing', async () => {
      const fileId = 'file_hidden_while_pub';
      const uploadSessionId = await initAndUpload('user_a', fileId);

      const publishing = holdNextPublish();
      const pending = complete('user_a', uploadSessionId);
      await publishing.reached;
      expect((await call('GET', `/${fileId}`, 'user_a')).status).toBe(404);
      expect((await call('GET', `/${fileId}/versions`, 'user_a')).status).toBe(404);
      const list = await call('GET', '/', 'user_a');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(fileId);
      // The claim is not an upload session either.
      expect((await call('GET', `/upload/${encodeURIComponent(fileClaimId(fileId))}/status`, 'user_a')).status).toBe(404);

      publishing.release();
      expect((await pending).status).toBe(200);
      expect((await call('GET', `/${fileId}`, 'user_a')).status).toBe(200);
    });

    it('fails a second completion with a retryable 409 while the first holds the ID too long', async () => {
      const fileId = 'file_busy_while_pub_1';
      const sessionA = await initAndUpload('user_a', fileId);
      const sessionB = await initAndUpload('user_b', fileId);

      const publishing = holdNextPublish();
      const pendingA = complete('user_a', sessionA);
      await publishing.reached;
      const busy = await complete('user_b', sessionB);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toMatchObject({ code: 'FILEFN_FILE_BUSY', details: { fileId, retryable: true } });
      expect(sessionRow(sessionB).status).not.toBe('completed');

      publishing.release();
      const doneA = await pendingA;
      expect(doneA.status).toBe(200);
      expect((await complete('user_b', sessionB)).status).toBe(403);
      expectFile(fileId, 'user_a', doneA.body.data.versionId, sessionRow(sessionA).storageUploadId);
    }, 10_000);

    describe.each(['expired-session cleanup', 'the next completion'] as const)(
      'recovers an interrupted creation through %s',
      (recovery) => {
        async function recover(fileId: string) {
          expireClaim(fileId);
          if (recovery === 'expired-session cleanup') {
            await fileFn.cleanupExpiredSessions();
            expect(claimRow(fileId)).toBeUndefined();
          }
        }

        it('after its version was recorded: the version is dropped and the ID is free', async () => {
          const fileId = 'file_interrupted_ver_1';
          const sessionA = await initAndUpload('user_a', fileId);
          const sessionB = await initAndUpload('user_b', fileId);

          // user_a's request stops just before inserting the file row.
          const stopped = db.holdNext('create', 'files');
          void complete('user_a', sessionA);
          await stopped.reached;
          expect(versionRows(fileId)).toHaveLength(1);
          expect(fileRows(fileId)).toEqual([]);

          await recover(fileId);
          const doneB = await complete('user_b', sessionB);
          expect(doneB.status).toBe(200);
          // A shared key would hold user_a's bytes until user_b republished; the default layout keeps both.
          expectFile(fileId, 'user_b', doneB.body.data.versionId, sessionRow(sessionB).storageUploadId);
        });

        it('after its file row was written: a retry of that session returns the recorded version', async () => {
          const fileId = 'file_interrupted_row_1';
          const sessionA = await initAndUpload('user_a', fileId);

          // The request stops after the file row, before the session is recorded.
          const stopped = db.holdNext('update', 'uploadSessions', (params) => params.data.status === 'completed');
          void complete('user_a', sessionA);
          await stopped.reached;
          const versionId = fileRows(fileId)[0].currentVersionId;

          await recover(fileId);
          const retry = await complete('user_a', sessionA);
          expect(retry.status).toBe(200);
          expect(retry.body.data).toEqual({ fileId, versionId });
          expect(sessionRow(sessionA)).toMatchObject({ status: 'completed', completionVersionId: versionId });
          expectFile(fileId, 'user_a', versionId, sessionRow(sessionA).storageUploadId);
        });
      },
    );

    it('a completion whose claim expired and was taken over records nothing', async () => {
      const fileId = 'file_lease_lost_0001';
      const sessionA = await initAndUpload('user_a', fileId);
      const sessionB = await initAndUpload('user_b', fileId);

      const publishing = holdNextPublish();
      const pendingA = complete('user_a', sessionA);
      await publishing.reached;
      expireClaim(fileId);
      const doneB = await complete('user_b', sessionB);
      expect(doneB.status).toBe(200);

      publishing.release();
      const lateA = await pendingA;
      expect(lateA.status).toBe(409);
      expect(lateA.body.error.code).toBe('FILEFN_FILE_BUSY');
      expectFile(fileId, 'user_b', doneB.body.data.versionId, sessionRow(sessionB).storageUploadId);
      expect(sessionRow(sessionA).status).not.toBe('completed');
    });
  });

  describe.each(['null', 'throw'] as const)('replacing an existing file when a zero-row update returns %s', (mode) => {
    let fileId: string;
    let firstVersionId: string;

    beforeEach(async () => {
      db.setZeroRowUpdates(mode);
      fileId = 'file_replace_cas_0001';
      const first = await initAndUpload('user_a', fileId);
      firstVersionId = (await complete('user_a', first)).body.data.versionId;
    });

    /** Completes a replacement by user_a, running `meanwhile` just before its files update. */
    async function replaceWhile(meanwhile: (row: Row) => void) {
      const session = await initAndUpload('user_a', fileId);
      const before = db.holdNext('update', 'files');
      const pending = complete('user_a', session);
      await before.reached;
      meanwhile(fileRows(fileId)[0]);
      before.release();
      return { session, done: await pending };
    }

    it('applies the new version after the row moved to another version of the same owner', async () => {
      const { session, done } = await replaceWhile((row) => {
        row.currentVersionId = 'ver_rolled_back';
      });
      expect(done.status).toBe(200);
      expect(fileRows(fileId)).toEqual([expect.objectContaining({ ownerId: 'user_a', currentVersionId: done.body.data.versionId })]);
      const version = versionRows(fileId).find((row) => row.versionId === done.body.data.versionId)!;
      expect(objects.get(version.storageKey)).toBe(sessionRow(session).storageUploadId);
    });

    it('rejects with 403 and leaves the file alone after it changed owner', async () => {
      const { session, done } = await replaceWhile((row) => {
        row.ownerId = 'user_c';
      });
      expect(done.status).toBe(403);
      expect(fileRows(fileId)).toEqual([expect.objectContaining({ ownerId: 'user_c', currentVersionId: firstVersionId })]);
      expect(versionRows(fileId).map((row) => row.versionId)).toEqual([firstVersionId]);
      expect(sessionRow(session).status).not.toBe('completed');
      expect(claimRow(fileId)).toBeUndefined();
    });

    it('reports a failed update instead of treating it as a lost race', async () => {
      const session = await initAndUpload('user_a', fileId);
      db.failNextFilesUpdate();
      const done = await complete('user_a', session);
      expect(done.status).toBe(500);
      expect(fileRows(fileId)).toEqual([expect.objectContaining({ currentVersionId: firstVersionId })]);
      expect(versionRows(fileId).map((row) => row.versionId)).toEqual([firstVersionId]);
      expect(claimRow(fileId)).toBeUndefined();
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
      expect(db.rows('uploadSessions')).toHaveLength(1);
    });

    it('keeps one file owned by the caller when the original and the retry both complete at once', async () => {
      const fileId = 'file_retry_lost_0001';
      // The first init's response was lost, so the client inits again without a key.
      const original = await initAndUpload('user_a', fileId);
      const retry = await initAndUpload('user_a', fileId);
      expect(retry).not.toBe(original);

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
      // Both uploads were published under their own keys and kept.
      for (const [session, done] of [[original, doneOriginal], [retry, doneRetry]] as const) {
        const version = versions.find((row) => row.versionId === done.body.data.versionId)!;
        expect(objects.get(version.storageKey)).toBe(sessionRow(session).storageUploadId);
      }
    });

    it('returns the recorded result when the same session completes twice at once', async () => {
      const fileId = 'file_double_complete_1';
      const uploadSessionId = await initAndUpload('user_a', fileId);
      const [first, second] = await Promise.all([complete('user_a', uploadSessionId), complete('user_a', uploadSessionId)]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data).toEqual(first.body.data);
      expectFile(fileId, 'user_a', first.body.data.versionId, sessionRow(uploadSessionId).storageUploadId);
    });
  });

  it("rejects another principal's existing ID with 403 at init", async () => {
    const fileId = 'file_owned_by_user_a';
    const uploadSessionId = await initAndUpload('user_a', fileId);
    expect((await complete('user_a', uploadSessionId)).status).toBe(200);

    const foreign = await init('user_b', { fileId });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('FILEFN_FORBIDDEN');
    expect(db.rows('uploadSessions').filter((row) => row.ownerId === 'user_b')).toHaveLength(0);

    // The owner may still replace its own file under the same ID.
    const replace = await init('user_a', { fileId });
    expect(replace.status).toBe(200);
  });
});
