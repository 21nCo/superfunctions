import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUploadSessionRoutes } from '../upload-sessions/routes.js';
import { createUploadSessionService } from '../upload-sessions/service.js';
import type { Adapter, AdapterCapabilities } from '@superfunctions/db';

const CAPS: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: false, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

type Row = Record<string, any>;

type MemoryDb = {
  db: Adapter;
  all(model: string): Row[];
};

function createMemoryDb(): MemoryDb {
  const tables = new Map<string, Map<string, Row>>();
  let idCounter = 1;

  function table(model: string): Map<string, Row> {
    if (!tables.has(model)) tables.set(model, new Map());
    return tables.get(model)!;
  }

  function match(record: Row, where: any[] = []): boolean {
    for (const clause of where) {
      const value = record?.[clause.field];
      if (clause.operator === 'eq' && value !== clause.value) return false;
      if (clause.operator === 'ne' && value === clause.value) return false;
      if (clause.operator === 'lt' && !(value < clause.value)) return false;
      if (clause.operator === 'gt' && !(value > clause.value)) return false;
    }
    return true;
  }

  const db: Adapter = {
    id: 'mem-db',
    name: 'mem-db',
    version: '1.0.0',
    capabilities: CAPS,
    async create(params) {
      const t = table(params.model);
      const id =
        (params.model === 'uploadParts' ? `${params.data.uploadSessionId}:${params.data.partNumber}` : undefined) ||
        (params.model === 'uploadSessions' ? params.data.uploadSessionId : undefined) ||
        (params.model === 'files' ? params.data.fileId : undefined) ||
        (params.model === 'fileVersions' ? params.data.versionId : undefined) ||
        params.data.permissionId ||
        params.data.artifactId ||
        `id_${idCounter++}`;
      const row = { ...params.data, _id: id };
      t.set(id, row);
      return row;
    },
    async findOne(params) {
      for (const row of table(params.model).values()) {
        if (match(row, params.where)) return row;
      }
      return null;
    },
    async findMany(params) {
      const rows = Array.from(table(params.model).values()).filter((row) => match(row, params.where));
      if (params.select && params.select.length > 0) {
        return rows.map((row) => {
          const projected: Row = {};
          for (const key of params.select!) projected[key] = row[key];
          return projected;
        });
      }
      return rows;
    },
    async update(params) {
      const t = table(params.model);
      for (const [id, row] of t.entries()) {
        if (match(row, params.where)) {
          const next = { ...row, ...params.data };
          t.set(id, next);
          return next;
        }
      }
      return null;
    },
    async delete(params) {
      const t = table(params.model);
      for (const [id, row] of t.entries()) {
        if (match(row, params.where)) {
          t.delete(id);
          return;
        }
      }
    },
    async createMany() { return []; },
    async updateMany() { return 0; },
    async deleteMany(params) {
      const t = table(params.model);
      let deleted = 0;
      for (const [id, row] of t.entries()) {
        if (match(row, params.where)) {
          t.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    },
    async upsert(params) {
      const existing = await this.findOne({ model: params.model, where: params.where, namespace: params.namespace });
      if (existing) {
        return this.update({ model: params.model, where: params.where, data: params.update, namespace: params.namespace });
      }
      return this.create({ model: params.model, data: params.create, namespace: params.namespace });
    },
    async count() { return 0; },
    async transaction(cb) { return cb(this as any); },
    async initialize() {},
    async isHealthy() { return { healthy: true, uptime: 0 }; },
    async close() {},
    async getSchemaVersion() { return 0; },
    async setSchemaVersion() {},
    async validateSchema() { return { valid: true }; },
    internal: {
      async ensureTable() {},
      async create() { return {}; },
      async findOne() { return null; },
      async findMany() { return []; },
      async update() { return 0; },
      async delete() { return 0; },
    },
  } as Adapter;

  return {
    db,
    all(model: string) {
      return Array.from(table(model).values());
    },
  };
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function createMemoryStorage(capabilities: {
  signedUploadUrls: boolean;
  multipart: boolean;
  proxyStreamingUpload: boolean;
}) {
  const objects = new Map<string, Uint8Array>();

  return {
    objects,
    adapter: {
      capabilities: {
        ...capabilities,
        signedDownloadUrls: true,
        proxyStreamingDownload: true,
      },
      createMultipartUpload: vi.fn(async () => ({ uploadId: 'up_1' })),
      signMultipartUploadPartUrl: vi.fn(async () => ({ url: 'https://signed.example/upload', headers: { 'x-test': '1' } })),
      completeMultipartUpload: vi.fn(async () => {}),
      openUploadStream: vi.fn(async ({ key }: { key: string }) => {
        const chunks: Uint8Array[] = [];
        return new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(new Uint8Array(chunk));
          },
          close() {
            objects.set(key, concatChunks(chunks));
          },
        });
      }),
      openDownloadStream: vi.fn(async ({ key }: { key: string }) => {
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`Object not found: ${key}`);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }),
      deleteObject: vi.fn(async ({ key }: { key: string }) => {
        objects.delete(key);
      }),
      statObject: vi.fn(async ({ key }: { key: string }) => {
        const bytes = objects.get(key) || new Uint8Array();
        return { key, size: bytes.byteLength };
      }),
    },
  };
}

function policyRegistry() {
  return {
    get: vi.fn(() => ({
      maxSizeBytes: 10 * 1024 * 1024,
      contentTypes: ['text/plain'],
      visibility: 'private',
    })),
  };
}

function jsonBody(input: unknown): string {
  return JSON.stringify(input);
}

describe('PHASE_02 upload mode and proxy semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TV-UPLOAD-MODE-001: selects only canonical upload modes', async () => {
    const dbA = createMemoryDb();
    const storageA = createMemoryStorage({ signedUploadUrls: true, multipart: true, proxyStreamingUpload: false });
    const serviceA = createUploadSessionService({
      db: dbA.db,
      storage: storageA.adapter as any,
      policies: policyRegistry() as any,
      events: { emit: vi.fn() } as any,
    });

    const a = await serviceA.createSession(
      { policy: 'p1', fileName: 'a.txt', size: 3, mimeType: 'text/plain' },
      { principalId: 'u1', requestId: 'req_a' },
    );
    expect(a.uploadMode).toBe('multipart-signed-url');

    const dbB = createMemoryDb();
    const storageB = createMemoryStorage({ signedUploadUrls: false, multipart: false, proxyStreamingUpload: true });
    const serviceB = createUploadSessionService({
      db: dbB.db,
      storage: storageB.adapter as any,
      policies: policyRegistry() as any,
      events: { emit: vi.fn() } as any,
    });

    const b = await serviceB.createSession(
      { policy: 'p1', fileName: 'b.txt', size: 3, mimeType: 'text/plain' },
      { principalId: 'u1', requestId: 'req_b' },
    );
    expect(b.uploadMode).toBe('proxy');
    expect(b.uploadMode).not.toBe('signed-url');
  });

  it('TV-UPLOAD-MODE-NEG-001: init fails with FILEFN_NO_SUPPORTED_UPLOAD_MODE when no valid mode exists', async () => {
    const db = createMemoryDb();
    const storage = createMemoryStorage({ signedUploadUrls: true, multipart: false, proxyStreamingUpload: false });
    const service = createUploadSessionService({
      db: db.db,
      storage: storage.adapter as any,
      policies: policyRegistry() as any,
      events: { emit: vi.fn() } as any,
    });

    await expect(
      service.createSession(
        { policy: 'p1', fileName: 'c.txt', size: 3, mimeType: 'text/plain' },
        { principalId: 'u1', requestId: 'req_c' },
      ),
    ).rejects.toMatchObject({ code: 'FILEFN_NO_SUPPORTED_UPLOAD_MODE' });
  });

  it('TV-UPLOAD-PROXY-001: proxy PUT records durable part, status shows recordedParts, and complete succeeds', async () => {
    const db = createMemoryDb();
    const storage = createMemoryStorage({ signedUploadUrls: false, multipart: false, proxyStreamingUpload: true });
    const service = createUploadSessionService({
      db: db.db,
      storage: storage.adapter as any,
      policies: policyRegistry() as any,
      events: { emit: vi.fn() } as any,
    });
    const routes = createUploadSessionRoutes({ service, auth: { required: false } });

    const initReq = new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ policy: 'p1', fileName: 'proxy.txt', size: 3, mimeType: 'text/plain' }),
    });
    const initRes = await routes.initSession(initReq);
    const initBody = await initRes.json();
    expect(initRes.status).toBe(200);
    expect(initBody.data.uploadMode).toBe('proxy');

    const uploadSessionId = initBody.data.uploadSessionId as string;
    const uploadSessionToken = initBody.data.uploadSessionToken as string;

    const signReq = new Request(`http://localhost/upload/${uploadSessionId}/parts/1/sign`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-upload-session-token': uploadSessionToken,
      },
      body: jsonBody({ contentLength: 3 }),
    });
    const signRes = await routes.signPart(signReq, uploadSessionId, 1);
    const signBody = await signRes.json();
    expect(signRes.status).toBe(200);
    expect(signBody.data.url).toBe(`/upload/${uploadSessionId}/parts/1`);

    const putReq = new Request(`http://localhost/upload/${uploadSessionId}/parts/1`, {
      method: 'PUT',
      headers: {
        'content-length': '3',
        'content-type': 'text/plain',
        'x-upload-session-token': uploadSessionToken,
      },
      body: 'abc',
      duplex: 'half' as any,
    } as any);
    const putRes = await routes.uploadPartBytes(putReq, uploadSessionId, 1);
    const putBody = await putRes.json();
    expect(putRes.status).toBe(200);
    expect(putBody.data.recorded).toBe(true);
    expect(putBody.data.size).toBe(3);
    expect(putBody.data.etag).toMatch(/^proxy-sha256-/);

    const statusReq = new Request(`http://localhost/upload/${uploadSessionId}/status`, {
      method: 'GET',
      headers: { 'x-upload-session-token': uploadSessionToken },
    });
    const statusRes = await routes.getStatus(statusReq, uploadSessionId);
    const statusBody = await statusRes.json();
    expect(statusRes.status).toBe(200);
    expect(statusBody.data.recordedParts).toEqual([1]);

    const completeReq = new Request(`http://localhost/upload/${uploadSessionId}/complete`, {
      method: 'POST',
      headers: { 'x-upload-session-token': uploadSessionToken },
    });
    const completeRes = await routes.completeSession(completeReq, uploadSessionId);
    const completeBody = await completeRes.json();
    expect(completeRes.status).toBe(200);
    expect(completeBody.data.fileId).toBeDefined();
    expect(completeBody.data.versionId).toBeDefined();

    const uploadSession = db.all('uploadSessions').find((s) => s.uploadSessionId === uploadSessionId)!;
    expect(storage.objects.get(uploadSession.storageKey)).toEqual(new TextEncoder().encode('abc'));
    expect(storage.objects.has(`${uploadSession.storageKey}.part1`)).toBe(false);
  });

  it('TV-UPLOAD-PROXY-NEG-001: conflicting bytes for a recorded proxy part returns FILEFN_PART_CONFLICT', async () => {
    const db = createMemoryDb();
    const storage = createMemoryStorage({ signedUploadUrls: false, multipart: false, proxyStreamingUpload: true });
    const service = createUploadSessionService({
      db: db.db,
      storage: storage.adapter as any,
      policies: policyRegistry() as any,
      events: { emit: vi.fn() } as any,
    });
    const routes = createUploadSessionRoutes({ service, auth: { required: false } });

    const initReq = new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ policy: 'p1', fileName: 'proxy.txt', size: 3, mimeType: 'text/plain' }),
    });
    const initRes = await routes.initSession(initReq);
    const initBody = await initRes.json();
    const uploadSessionId = initBody.data.uploadSessionId as string;
    const uploadSessionToken = initBody.data.uploadSessionToken as string;

    const firstPutReq = new Request(`http://localhost/upload/${uploadSessionId}/parts/1`, {
      method: 'PUT',
      headers: {
        'content-length': '3',
        'content-type': 'text/plain',
        'x-upload-session-token': uploadSessionToken,
      },
      body: 'abc',
      duplex: 'half' as any,
    } as any);
    const firstPutRes = await routes.uploadPartBytes(firstPutReq, uploadSessionId, 1);
    expect(firstPutRes.status).toBe(200);

    const conflictingPutReq = new Request(`http://localhost/upload/${uploadSessionId}/parts/1`, {
      method: 'PUT',
      headers: {
        'content-length': '3',
        'content-type': 'text/plain',
        'x-upload-session-token': uploadSessionToken,
      },
      body: 'abd',
      duplex: 'half' as any,
    } as any);
    const conflictingPutRes = await routes.uploadPartBytes(conflictingPutReq, uploadSessionId, 1);
    const conflictBody = await conflictingPutRes.json();

    expect(conflictingPutRes.status).toBe(409);
    expect(conflictBody.error.code).toBe('FILEFN_PART_CONFLICT');
  });

  it('TV-UPLOAD-PROXY-NEG-002: missing proxy PUT body returns a structured 400 error', async () => {
    const db = createMemoryDb();
    const storage = createMemoryStorage({ signedUploadUrls: false, multipart: false, proxyStreamingUpload: true });
    const service = createUploadSessionService({
      db: db.db,
      storage: storage.adapter as any,
      policies: policyRegistry() as any,
      events: { emit: vi.fn() } as any,
    });
    const routes = createUploadSessionRoutes({ service, auth: { required: false } });

    const initReq = new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ policy: 'p1', fileName: 'proxy.txt', size: 3, mimeType: 'text/plain' }),
    });
    const initRes = await routes.initSession(initReq);
    const initBody = await initRes.json();
    const uploadSessionId = initBody.data.uploadSessionId as string;
    const uploadSessionToken = initBody.data.uploadSessionToken as string;

    const putReq = new Request(`http://localhost/upload/${uploadSessionId}/parts/1`, {
      method: 'PUT',
      headers: {
        'content-length': '3',
        'content-type': 'text/plain',
        'x-upload-session-token': uploadSessionToken,
      },
    });

    const putRes = await routes.uploadPartBytes(putReq, uploadSessionId, 1);
    const putBody = await putRes.json();

    expect(putRes.status).toBe(400);
    expect(putBody.error.code).toBe('FILEFN_INVALID_REQUEST');
  });
});

describe('FILE-16 per-session storage keys', () => {
  const ctx = { principalId: 'u1', tenantId: 't1', requestId: 'req_keys' };

  function proxyService(policy: Record<string, unknown> = {}) {
    const db = createMemoryDb();
    const storage = createMemoryStorage({ signedUploadUrls: false, multipart: false, proxyStreamingUpload: true });
    const service = createUploadSessionService({
      db: db.db,
      storage: storage.adapter as any,
      policies: { get: vi.fn(() => ({ name: 'p1', contentTypes: ['text/plain'], visibility: 'private', ...policy })) } as any,
      events: { emit: vi.fn() } as any,
    });
    return { db, storage, service };
  }

  async function initSession(service: ReturnType<typeof proxyService>['service'], fileId?: string) {
    return service.createSession(
      { policy: 'p1', fileName: 'a.txt', size: 3, mimeType: 'text/plain', ...(fileId ? { fileId } : {}) },
      ctx,
    );
  }

  async function uploadAndComplete(service: ReturnType<typeof proxyService>['service'], uploadSessionId: string, text: string) {
    const bytes = new TextEncoder().encode(text);
    const part = await service.uploadPartBytes(uploadSessionId, 1, Buffer.from(bytes), bytes.byteLength, ctx);
    await service.completePart(uploadSessionId, 1, part.etag, part.size, ctx);
    return service.completeSession(uploadSessionId, ctx);
  }

  function sessionRow(db: MemoryDb, uploadSessionId: string) {
    return db.all('uploadSessions').find((s) => s.uploadSessionId === uploadSessionId)!;
  }

  it('gives two sessions on one fileId different storage keys and part keys, and the loser cannot change published bytes', async () => {
    const { db, storage, service } = proxyService();
    const first = await initSession(service);
    const fileId = sessionRow(db, first.uploadSessionId).fileId as string;
    const second = await initSession(service, fileId);

    const keyA = sessionRow(db, first.uploadSessionId).storageKey as string;
    const keyB = sessionRow(db, second.uploadSessionId).storageKey as string;
    expect(sessionRow(db, second.uploadSessionId).fileId).toBe(fileId);
    expect(keyA).not.toBe(keyB);

    // Both sessions stage part 1 before either completes; the part keys must not collide.
    const partA = await service.uploadPartBytes(first.uploadSessionId, 1, Buffer.from('AAA'), 3, ctx);
    const partB = await service.uploadPartBytes(second.uploadSessionId, 1, Buffer.from('BBB'), 3, ctx);
    expect(storage.objects.get(`${keyA}.part1`)).toEqual(new TextEncoder().encode('AAA'));
    expect(storage.objects.get(`${keyB}.part1`)).toEqual(new TextEncoder().encode('BBB'));

    await service.completePart(first.uploadSessionId, 1, partA.etag, partA.size, ctx);
    const resultA = await service.completeSession(first.uploadSessionId, ctx);
    await service.completePart(second.uploadSessionId, 1, partB.etag, partB.size, ctx);
    const resultB = await service.completeSession(second.uploadSessionId, ctx);

    const versions = db.all('fileVersions');
    const versionA = versions.find((v) => v.versionId === resultA.versionId)!;
    const versionB = versions.find((v) => v.versionId === resultB.versionId)!;
    expect(versionA.storageKey).toBe(keyA);
    expect(versionB.storageKey).toBe(keyB);
    expect(storage.objects.get(keyA)).toEqual(new TextEncoder().encode('AAA'));
    expect(storage.objects.get(keyB)).toEqual(new TextEncoder().encode('BBB'));
  });

  it('publishes the version whose ID is in the session storage key', async () => {
    const { db, service } = proxyService();
    const created = await initSession(service);
    const before = sessionRow(db, created.uploadSessionId);
    expect(before.status).toBe('pending');
    expect(before.completionVersionId).toMatch(/^ver_/);
    expect(before.storageKey).toBe(`t1/u1/${before.fileId}/${before.completionVersionId}-a.txt`);

    const result = await uploadAndComplete(service, created.uploadSessionId, 'abc');

    expect(result.versionId).toBe(before.completionVersionId);
    const version = db.all('fileVersions').find((v) => v.versionId === result.versionId)!;
    expect(version.storageKey).toBe(before.storageKey);
    expect(db.all('files').find((f) => f.fileId === result.fileId)!.currentVersionId).toBe(result.versionId);
    expect(sessionRow(db, created.uploadSessionId).completionVersionId).toBe(result.versionId);
  });

  it('uses the custom storagePath versionId for the published version', async () => {
    const storagePath = vi.fn(({ fileId, versionId }: { fileId: string; versionId: string }) => `custom/${fileId}/${versionId}`);
    const { db, service } = proxyService({ storagePath });
    const created = await initSession(service);
    const row = sessionRow(db, created.uploadSessionId);
    expect(row.storageKey).toBe(`custom/${row.fileId}/${row.completionVersionId}`);

    const result = await uploadAndComplete(service, created.uploadSessionId, 'abc');
    expect(db.all('fileVersions').find((v) => v.versionId === result.versionId)!.storageKey).toBe(
      `custom/${result.fileId}/${result.versionId}`,
    );
  });

  it.each([
    ['proxy', { signedUploadUrls: false, multipart: false, proxyStreamingUpload: true }],
    ['multipart', { signedUploadUrls: true, multipart: true, proxyStreamingUpload: false }],
  ])('refuses a %s init whose storagePath ignores versionId, creating no session or upload', async (_mode, caps) => {
    const db = createMemoryDb();
    const storage = createMemoryStorage(caps);
    const service = createUploadSessionService({
      db: db.db,
      storage: storage.adapter as any,
      policies: {
        get: vi.fn(() => ({
          name: 'fixed',
          contentTypes: ['text/plain'],
          storagePath: ({ fileId, fileName }: { fileId: string; fileName: string }) => `fixed/${fileId}/${fileName}`,
        })),
      } as any,
      events: { emit: vi.fn() } as any,
    });
    const routes = createUploadSessionRoutes({ service, auth: { required: false } });

    const res = await routes.initSession(new Request('http://localhost/upload/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonBody({ policy: 'fixed', fileName: 'a.txt', size: 3, mimeType: 'text/plain', fileId: 'file_shared' }),
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('FILEFN_STORAGE_PATH_NOT_PER_VERSION');
    expect(db.all('uploadSessions')).toHaveLength(0);
    expect(storage.adapter.createMultipartUpload).not.toHaveBeenCalled();
    expect(storage.adapter.openUploadStream).not.toHaveBeenCalled();
  });

  it('completes a session created before version IDs were pre-allocated', async () => {
    const { db, storage, service } = proxyService();
    const created = await initSession(service);
    // A row written by an earlier release has no completionVersionId.
    await db.db.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: created.uploadSessionId }],
      data: { completionVersionId: null },
    });
    const legacyKey = sessionRow(db, created.uploadSessionId).storageKey as string;

    const result = await uploadAndComplete(service, created.uploadSessionId, 'abc');

    expect(result.versionId).toMatch(/^ver_/);
    const version = db.all('fileVersions').find((v) => v.versionId === result.versionId)!;
    expect(version.storageKey).toBe(legacyKey);
    expect(storage.objects.get(legacyKey)).toEqual(new TextEncoder().encode('abc'));
    const after = sessionRow(db, created.uploadSessionId);
    expect(after.status).toBe('completed');
    expect(after.completionVersionId).toBe(result.versionId);
    await expect(service.completeSession(created.uploadSessionId, ctx)).resolves.toEqual(result);
  });
});
