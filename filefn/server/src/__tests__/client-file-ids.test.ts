import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import type { Adapter, AdapterCapabilities } from '@superfunctions/db';
import { createFileFn, type FileFn } from '../index.js';
import { generateFileFnId } from '../ids.js';
import { CLIENT_FILE_ID_PATTERN, isValidClientFileId } from '../upload-sessions/file-id.js';

const CAPS: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: true, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

type Row = Record<string, any>;

/**
 * In-memory adapter that enforces the schema's `files.fileId` uniqueness the
 * way Postgres does, and can hold `files` inserts at a barrier so two
 * completions both pass their pre-insert checks before either inserts.
 */
function createDb() {
  const tables = new Map<string, Row[]>();
  let filesBarrier: { expected: number; arrived: Array<() => void> } | null = null;
  let filesReadPause: { reached: () => void; release: Promise<void> } | null = null;

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

  async function waitAtFilesBarrier(): Promise<void> {
    const barrier = filesBarrier;
    if (!barrier) return;
    await new Promise<void>((resolve) => {
      barrier.arrived.push(resolve);
      if (barrier.arrived.length === barrier.expected) {
        filesBarrier = null;
        // Release in arrival order, one macrotask apart, so the first arrival
        // inserts first and the later one hits the unique constraint.
        barrier.arrived.forEach((release, index) => setTimeout(release, index));
      }
    });
  }

  const adapter = {
    id: 'client-file-ids-db',
    name: 'client-file-ids-db',
    version: '1.0.0',
    capabilities: CAPS,
    async create(params: any) {
      if (params.model === 'files') {
        await waitAtFilesBarrier();
        if (table('files').some((row) => row.fileId === params.data.fileId)) {
          throw new Error('duplicate key value violates unique constraint "files_fileId_key"');
        }
      }
      const record = { ...params.data };
      table(params.model).push(record);
      return record;
    },
    async findOne(params: any) {
      const found = table(params.model).find((row) => match(row, params.where)) ?? null;
      const pause = params.model === 'files' ? filesReadPause : null;
      if (pause) {
        filesReadPause = null;
        pause.reached();
        await pause.release;
      }
      return found;
    },
    async findMany(params: any) {
      return table(params.model).filter((row) => match(row, params.where));
    },
    async update(params: any) {
      const rows = table(params.model);
      const index = rows.findIndex((row) => match(row, params.where));
      if (index === -1) return null;
      rows[index] = { ...rows[index], ...params.data };
      return rows[index];
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
    holdFilesInserts(expected: number) {
      filesBarrier = { expected, arrived: [] };
    },
    /**
     * Holds the next `files` read after it has seen the table, until `release`
     * is called. `reached` resolves once that read is held.
     */
    pauseNextFilesRead() {
      let release!: () => void;
      let reached!: () => void;
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      filesReadPause = { reached, release: new Promise<void>((resolve) => { release = resolve; }) };
      return { reached: reachedPromise, release };
    },
  };
}

describe('client-chosen file IDs on upload/init (FILE-5)', () => {
  let db: ReturnType<typeof createDb>;
  /** Multipart upload IDs in the order they were completed, per storage key. */
  let published: Map<string, string[]>;
  let failNextPublish: boolean;
  let fileFn: FileFn;

  function build(storagePath?: (ctx: { fileId: string }) => string) {
    db = createDb();
    published = new Map();
    failNextPublish = false;
    let uploads = 0;
    fileFn = createFileFn({
      database: db.adapter,
      storage: createFakeStorageAdapter({
        capabilities: {
          signedUploadUrls: true,
          signedDownloadUrls: true,
          multipart: true,
          proxyStreamingUpload: false,
          proxyStreamingDownload: false,
        },
        async createMultipartUpload() {
          uploads += 1;
          return { uploadId: `mpu_${uploads}` };
        },
        async completeMultipartUpload(input) {
          if (failNextPublish) {
            failNextPublish = false;
            throw new Error('storage unavailable');
          }
          published.set(input.key, [...(published.get(input.key) ?? []), input.uploadId]);
        },
        async statObject(input) {
          return { key: input.key, size: 3 };
        },
      }),
      policies: [{ name: 'capture', contentTypes: ['image/png'], maxSizeBytes: 1024, storagePath }],
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
    const response = await fileFn.router.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-user-id': user, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
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

  async function initAndUpload(user: string, fileId: string): Promise<string> {
    const res = await init(user, { fileId });
    expect(res.status).toBe(200);
    const uploadSessionId = res.body.data.uploadSessionId as string;
    const part = await call('POST', `/upload/${uploadSessionId}/parts/1/complete`, user, { etag: `etag-${user}`, size: 3 });
    expect(part.status).toBe(200);
    return uploadSessionId;
  }

  function complete(user: string, uploadSessionId: string) {
    return call('POST', `/upload/${uploadSessionId}/complete`, user);
  }

  function sessionRow(uploadSessionId: string): Row {
    return db.rows('uploadSessions').find((row) => row.uploadSessionId === uploadSessionId)!;
  }

  /** The upload whose bytes a storage key currently holds (the last one completed there). */
  function contentAt(key: string): string | undefined {
    return published.get(key)?.at(-1);
  }

  function publishedUploads(): string[] {
    return [...published.values()].flat();
  }

  /** Asserts `fileId` has one row owned by the winner, one version, and the winner's bytes. */
  function expectSingleOwner(fileId: string, winner: string, winnerSession: string, winnerVersionId: string) {
    expect(db.rows('files').filter((row) => row.fileId === fileId)).toEqual([
      expect.objectContaining({ ownerId: winner, currentVersionId: winnerVersionId }),
    ]);
    const versions = db.rows('fileVersions').filter((row) => row.fileId === fileId);
    expect(versions).toEqual([expect.objectContaining({ versionId: winnerVersionId })]);
    expect(contentAt(versions[0].storageKey)).toBe(sessionRow(winnerSession).storageUploadId);
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
    const file = db.rows('files').find((row) => row.fileId === fileId)!;
    expect(file).toMatchObject({ ownerId: 'user_a', tenantId: 'org_1', currentVersionId: done.body.data.versionId });
  });

  describe('two principals racing on one new ID resolve to a single owner', () => {
    const layouts = [
      ['the default per-version key', undefined],
      ['a custom storagePath shared by both sessions', (ctx: { fileId: string }) => `captures/${ctx.fileId}`],
    ] as const;

    describe.each(layouts)('with %s', (_layout, storagePath) => {
      beforeEach(() => build(storagePath));

      async function initBoth(fileId: string): Promise<[string, string]> {
        // Neither file exists yet, so both inits are accepted.
        const sessionA = await initAndUpload('user_a', fileId);
        const sessionB = await initAndUpload('user_b', fileId);
        if (storagePath) expect(sessionRow(sessionB).storageKey).toBe(sessionRow(sessionA).storageKey);
        return [sessionA, sessionB];
      }

      it('when both completions find the ID free and insert at once', async () => {
        const fileId = 'file_raced_insert_01';
        const [sessionA, sessionB] = await initBoth(fileId);

        db.holdFilesInserts(2);
        const [doneA, doneB] = await Promise.all([complete('user_a', sessionA), complete('user_b', sessionB)]);

        expect(doneA.status).toBe(200);
        expect(doneA.body.data.fileId).toBe(fileId);
        expect(doneB.status).toBe(403);
        expect(doneB.body.error.code).toBe('FILEFN_FORBIDDEN');
        expectSingleOwner(fileId, 'user_a', sessionA, doneA.body.data.versionId);
        // The loser never publishes, so a shared key keeps the winner's bytes.
        expect(publishedUploads()).not.toContain(sessionRow(sessionB).storageUploadId);

        // Retrying the losing completion stays forbidden and changes nothing.
        const retryB = await complete('user_b', sessionB);
        expect(retryB.status).toBe(403);
        expectSingleOwner(fileId, 'user_a', sessionA, doneA.body.data.versionId);
      });

      it('when the winner creates the file after the loser found the ID free', async () => {
        const fileId = 'file_raced_lookup_01';
        const [sessionA, sessionB] = await initBoth(fileId);

        // user_b's completion sees no file, then waits while user_a completes.
        const paused = db.pauseNextFilesRead();
        const pendingB = complete('user_b', sessionB);
        await paused.reached;
        const doneA = await complete('user_a', sessionA);
        expect(doneA.status).toBe(200);
        paused.release();
        const doneB = await pendingB;

        expect(doneB.status).toBe(403);
        expect(doneB.body.error.code).toBe('FILEFN_FORBIDDEN');
        expectSingleOwner(fileId, 'user_a', sessionA, doneA.body.data.versionId);
        expect(publishedUploads()).not.toContain(sessionRow(sessionB).storageUploadId);
      });

      it('when the loser completes after the winner', async () => {
        const fileId = 'file_raced_after_01';
        const [sessionA, sessionB] = await initBoth(fileId);

        const doneA = await complete('user_a', sessionA);
        const doneB = await complete('user_b', sessionB);
        expect(doneA.status).toBe(200);
        expect(doneB.status).toBe(403);
        expectSingleOwner(fileId, 'user_a', sessionA, doneA.body.data.versionId);
        expect(publishedUploads()).not.toContain(sessionRow(sessionB).storageUploadId);
      });
    });
  });

  it('releases a new ID when completion fails before the version exists', async () => {
    const fileId = 'file_claim_released_01';
    const uploadSessionId = await initAndUpload('user_a', fileId);

    failNextPublish = true;
    await expect(complete('user_a', uploadSessionId)).rejects.toThrow('storage unavailable');
    expect(db.rows('files').filter((row) => row.fileId === fileId)).toEqual([]);

    // The ID is still free: the same session can complete, or another caller could claim it.
    const done = await complete('user_a', uploadSessionId);
    expect(done.status).toBe(200);
    expectSingleOwner(fileId, 'user_a', uploadSessionId, done.body.data.versionId);
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

      db.holdFilesInserts(2);
      const [doneOriginal, doneRetry] = await Promise.all([complete('user_a', original), complete('user_a', retry)]);

      expect(doneOriginal.status).toBe(200);
      expect(doneRetry.status).toBe(200);
      expect(doneOriginal.body.data.fileId).toBe(fileId);
      expect(doneRetry.body.data.fileId).toBe(fileId);

      const files = db.rows('files').filter((row) => row.fileId === fileId);
      expect(files).toHaveLength(1);
      expect(files[0].ownerId).toBe('user_a');
      expect(files[0].currentVersionId).toBe(doneRetry.body.data.versionId);
      const versions = db.rows('fileVersions').filter((row) => row.fileId === fileId);
      expect(versions.map((row) => row.versionId).sort()).toEqual(
        [doneOriginal.body.data.versionId, doneRetry.body.data.versionId].sort(),
      );
      // Both uploads were published under their own keys and kept.
      for (const [session, done] of [[original, doneOriginal], [retry, doneRetry]] as const) {
        const version = versions.find((row) => row.versionId === done.body.data.versionId)!;
        expect(contentAt(version.storageKey)).toBe(sessionRow(session).storageUploadId);
      }
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
