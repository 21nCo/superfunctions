import { describe, it, expect, beforeEach } from 'vitest';
import { createFileFn, type FileFn } from '../index.js';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import type { Adapter, AdapterCapabilities } from '@superfunctions/db';

const FAKE_CAPABILITIES: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: false, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

function createFakeDbAdapter(): Adapter {
  const tables = new Map<string, Map<string, any>>();
  let idCounter = 1;

  function getTable(model: string): Map<string, any> {
    if (!tables.has(model)) tables.set(model, new Map());
    return tables.get(model)!;
  }

  function matchesWhere(record: any, where: any[]): boolean {
    for (const clause of where) {
      const value = record[clause.field];
      switch (clause.operator) {
        case 'eq': if (value !== clause.value) return false; break;
        case 'ne': if (value === clause.value) return false; break;
        default: break;
      }
    }
    return true;
  }

  return {
    id: 'fake',
    name: 'fake',
    version: '1.0.0',
    capabilities: FAKE_CAPABILITIES,
    async create(params) {
      const table = getTable(params.model);
      const id = params.data.uploadSessionId || params.data.versionId || params.data.fileId || params.data.permissionId || `id_${idCounter++}`;
      const record = { ...params.data, _id: id };
      table.set(id, record);
      return record;
    },
    async findOne(params) {
      const table = getTable(params.model);
      for (const record of table.values()) {
        if (matchesWhere(record, params.where)) return record;
      }
      return null;
    },
    async findMany(params) {
      const table = getTable(params.model);
      const results: any[] = [];
      for (const record of table.values()) {
        if (!params.where || params.where.length === 0 || matchesWhere(record, params.where)) {
          results.push(record);
        }
      }
      // Sort by createdAt desc if orderBy specified
      if (params.orderBy?.some((o: any) => o.field === 'createdAt' && o.direction === 'desc')) {
        results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      }
      return results.slice(0, params.limit || results.length);
    },
    async update(params) {
      const table = getTable(params.model);
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          const updated = { ...record, ...params.data };
          table.set(id, updated);
          return updated;
        }
      }
      return null;
    },
    async delete(params) {
      const table = getTable(params.model);
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          table.delete(id);
          return;
        }
      }
    },
    async createMany(params) { return []; },
    async updateMany(params) { return 0; },
    async deleteMany(params) {
      const table = getTable(params.model);
      let count = 0;
      for (const [id, record] of table.entries()) {
        if (matchesWhere(record, params.where)) {
          table.delete(id);
          count++;
        }
      }
      return count;
    },
    async upsert(params) {
      const existing = await this.findOne({ model: params.model, where: params.where, namespace: params.namespace });
      if (existing) {
        return await this.update({ model: params.model, where: params.where, data: params.update, namespace: params.namespace });
      }
      return await this.create({ model: params.model, data: params.create, namespace: params.namespace });
    },
    async count(params) { return 0; },
    async transaction(callback) { return callback(this as any); },
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
}

async function createFileViaUpload(fileFn: FileFn, db: Adapter, storageSizes: Map<string, number>, principalId: string, tenantId?: string): Promise<{ fileId: string; versionId: string }> {
  const { uploadSessionId } = await fileFn.createUploadSession(
    { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png' },
    { principalId, tenantId }
  );

  // Helper to get storageKey
  const session = await db.findOne<any>({ model: 'uploadSessions', where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }] });
  if (session) {
    storageSizes.set(session.storageKey, 2097152);
  }
  
  await fileFn.completeUploadPart(
    { uploadSessionId, partNumber: 1, etag: 'etag1', size: 2097152 },
    { principalId, tenantId }
  );
  
  return fileFn.completeUploadSession({ uploadSessionId }, { principalId, tenantId });
}

describe('@filefn/server files', () => {
  let fileFn: FileFn;
  let db: Adapter;
  let storageSizes: Map<string, number>;

  beforeEach(() => {
    db = createFakeDbAdapter();
    storageSizes = new Map();
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: true,
        multipart: true,
        proxyStreamingUpload: false,
        proxyStreamingDownload: true,
      },
      async statObject(input) {
        return { key: input.key, size: storageSizes.get(input.key) ?? 1024 };
      }
    });

    fileFn = createFileFn({
      db,
      storage,
      policies: [{ name: 'user-avatar', contentTypes: ['image/png', 'image/jpeg'], maxSizeBytes: 10485760 }],
      auth: { required: false },
    });
  });

  describe('TV-FILE-GET-001: Get file metadata', () => {
    it('should return file metadata for owner', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123', 'org_123');

      const file = await fileFn.getFile({ fileId }, { principalId: 'user_123', tenantId: 'org_123' }) as any;

      expect(file.fileId).toBe(fileId);
      expect(file.ownerId).toBe('user_123');
      expect(file.mimeType).toBe('image/png');
    });
  });

  describe('TV-FILE-GET-NEG-001: Get file forbidden', () => {
    it('should deny access for non-owner on private file', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123', 'org_123');

      await expect(
        fileFn.getFile({ fileId }, { principalId: 'other_user', tenantId: 'org_123' })
      ).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    });
  });

  describe('TV-FILE-DOWNLOAD-001: Download file', () => {
    it('should return download URL for owner', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      // Create a new instance with resolveSession that returns the file owner
      const fileFnWithAuth = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'] }],
        auth: {
          required: false,
          resolveSession: async () => ({ principalId: 'user_123' }),
        },
      });

      const request = new Request(`http://localhost/${fileId}/download`, {
        method: 'GET',
        headers: { 'x-request-id': 'req_015' },
      });

      // Use router for full integration test
      const response = await fileFnWithAuth.router.handle(request);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(200);

      const body = await response!.json();
      expect(body.ok).toBe(true);
      expect(body.data.url).toBeDefined();
    });
  });

  describe('TV-FILE-DOWNLOAD-NEG-001: Download forbidden', () => {
    it('should deny download for non-owner on private file', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      // Create new instance with auth that resolves to different user
      const fileFnOther = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'] }],
        auth: {
          required: false,
          resolveSession: async () => ({ principalId: 'other_user' }),
        },
      });

      const request = new Request(`http://localhost/${fileId}/download`, {
        method: 'GET',
        headers: { 'x-request-id': 'req_016' },
      });

      const response = await fileFnOther.router.handle(request);
      expect(response!.status).toBe(403);

      const body = await response!.json();
      expect(body.error.code).toBe('FILEFN_FORBIDDEN');
    });
  });

  describe('TV-VERSION-LIST-001: List versions', () => {
    it('should list versions newest-first', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      // Create another version (with a small delay to ensure different timestamps)
      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 1000, mimeType: 'image/png', fileId },
        { principalId: 'user_123' }
      );
      // Mock size for this session too
      const session = await db.findOne<any>({ model: 'uploadSessions', where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }] });
      if (session) storageSizes.set(session.storageKey, 1000);

      await fileFn.completeUploadPart(
        { uploadSessionId, partNumber: 1, etag: 'etag2', size: 1000 },
        { principalId: 'user_123' }
      );
      await fileFn.completeUploadSession({ uploadSessionId }, { principalId: 'user_123' });

      // Create a new instance with resolveSession that returns the file owner
      // Must use the same DB instance to see the versions
      const fileFnWithAuth = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'] }],
        auth: {
          required: false,
          resolveSession: async () => ({ principalId: 'user_123' }),
        },
      });

      const request = new Request(`http://localhost/${fileId}/versions`, {
        method: 'GET',
        headers: { 'x-request-id': 'req_021' },
      });

      const response = await fileFnWithAuth.router.handle(request);
      expect(response!.status).toBe(200);

      const body = await response!.json();
      expect(body.ok).toBe(true);
      expect(body.data.versions.length).toBe(2);
    });
  });

  describe('TV-FILE-DELETE-001: Delete file', () => {
    it('should delete file for owner', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      await fileFn.deleteFile({ fileId }, { principalId: 'user_123' });

      await expect(
        fileFn.getFile({ fileId }, { principalId: 'user_123' })
      ).rejects.toMatchObject({ code: 'FILEFN_NOT_FOUND' });
    });
  });

  describe('TV-FILE-DELETE-NEG-001: Delete forbidden', () => {
    it('should deny delete for non-owner', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      await expect(
        fileFn.deleteFile({ fileId }, { principalId: 'other_user' })
      ).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    });
  });

  describe('TV-VERSION-REPLACE-001: Replace file', () => {
    it('should allow owner to replace file with new version', async () => {
      const { fileId, versionId: v1 } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 500, mimeType: 'image/png', fileId },
        { principalId: 'user_123' }
      );
      
      const session = await db.findOne<any>({ model: 'uploadSessions', where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }] });
      if (session) storageSizes.set(session.storageKey, 500);

      await fileFn.completeUploadPart(
        { uploadSessionId, partNumber: 1, etag: 'etag_new', size: 500 },
        { principalId: 'user_123' }
      );

      const { versionId: v2 } = await fileFn.completeUploadSession({ uploadSessionId }, { principalId: 'user_123' });

      expect(v2).not.toBe(v1);
      
      const file = await fileFn.getFile({ fileId }, { principalId: 'user_123' }) as any;
      expect(file.currentVersionId).toBe(v2);
    });
  });

  describe('List files', () => {
    it('should list files owned by principal', async () => {
      await createFileViaUpload(fileFn, db, storageSizes, 'user_123');
      await createFileViaUpload(fileFn, db, storageSizes, 'user_123');
      await createFileViaUpload(fileFn, db, storageSizes, 'other_user');

      const result = await fileFn.listFiles({}, { principalId: 'user_123' }) as any;
      expect(result.files.length).toBe(2);
    });
  });

  describe('Download rate limiting', () => {
    it('should enforce rate limits on download (TV-RATE-NEG-001 download variant)', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      const rateLimiter = {
        async check(_input: any) {
          return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60000).toISOString(), total: 10 };
        },
        async reset(_key: string) {},
      };

      const fileFnWithRateLimit = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'] }],
        rateLimiter,
        auth: { required: false },
      });

      const request = new Request(`http://localhost/${fileId}/download`, {
        method: 'GET',
        headers: { 'x-request-id': 'req_rate' },
      });

      const response = await fileFnWithRateLimit.router.handle(request);
      expect(response!.status).toBe(429);

      const body = await response!.json();
      expect(body.error.code).toBe('FILEFN_RATE_LIMITED');
    });

    it('TV-RATE-001: should enforce download category rate limits from config', async () => {
      const { fileId } = await createFileViaUpload(fileFn, db, storageSizes, 'user_123');

      const fileFnWithCategoryRateLimit = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'] }],
        rateLimit: {
          limits: {
            download: { windowSeconds: 60, maxRequests: 1 },
          },
        },
        auth: {
          required: false,
          resolveSession: async () => ({ principalId: 'user_123' }),
        },
      });

      const first = await fileFnWithCategoryRateLimit.router.handle(
        new Request(`http://localhost/${fileId}/download`, {
          method: 'GET',
          headers: { 'x-request-id': 'req_rate_cat_1' },
        })
      );
      expect(first!.status).toBe(200);

      const second = await fileFnWithCategoryRateLimit.router.handle(
        new Request(`http://localhost/${fileId}/download`, {
          method: 'GET',
          headers: { 'x-request-id': 'req_rate_cat_2' },
        })
      );
      expect(second!.status).toBe(429);

      const body = await second!.json();
      expect(body.error.code).toBe('FILEFN_RATE_LIMITED');
      expect(typeof body.error.details?.resetAt).toBe('string');
      expect(Number.isNaN(Date.parse(body.error.details.resetAt))).toBe(false);
    });
  });
});
