import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFileFn, type FileFn, type QuotaProvider } from '../index.js';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import type { Adapter, TableSchema, AdapterCapabilities } from '@superfunctions/db';

const FAKE_CAPABILITIES: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: false, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

// Fake in-memory DB adapter
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
      const id = params.data.uploadSessionId || params.data.fileId || params.data.versionId || params.data.permissionId || `id_${idCounter++}`;
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
        if (matchesWhere(record, params.where)) results.push(record);
      }
      return results;
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
    async deleteMany(params) { return 0; },
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
  } as Adapter;
}

describe('@filefn/server upload sessions', () => {
  let fileFn: FileFn;
  let db: Adapter;

  beforeEach(() => {
    db = createFakeDbAdapter();
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: true,
        multipart: true,
        proxyStreamingUpload: false,
        proxyStreamingDownload: true,
      },
    });

    fileFn = createFileFn({
      db,
      storage,
      policies: [
        {
          name: 'user-avatar',
          contentTypes: ['image/png', 'image/jpeg'],
          maxSizeBytes: 10485760, // 10 MiB
          visibility: 'private',
        },
      ],
      auth: { required: false },
    });
  });

  describe('TV-UPLOAD-INIT-001: Create upload session', () => {
    it('should create upload session successfully', async () => {
      const result = await fileFn.createUploadSession(
        {
          policy: 'user-avatar',
          fileName: 'avatar.png',
          size: 2097152,
          mimeType: 'image/png',
          metadata: { userId: 'user_123' },
        },
        { principalId: 'user_123', tenantId: 'org_123', requestId: 'req_001' }
      );

      expect(result.uploadSessionId).toBeDefined();
      expect(result.uploadSessionId).toMatch(/^upl_/);
    });
  });

  describe('TV-UPLOAD-INIT-NEG-001: Disallowed content type', () => {
    it('should reject disallowed content type', async () => {
      await expect(
        fileFn.createUploadSession(
          { policy: 'user-avatar', fileName: 'avatar.gif', size: 100, mimeType: 'image/gif' },
          { principalId: 'user_123', requestId: 'req_002' }
        )
      ).rejects.toMatchObject({
        code: 'FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED',
        details: { policy: 'user-avatar', mimeType: 'image/gif' },
      });
    });
  });

  describe('TV-UPLOAD-INIT-NEG-002: Size exceeds policy max', () => {
    it('should reject file exceeding max size', async () => {
      await expect(
        fileFn.createUploadSession(
          { policy: 'user-avatar', fileName: 'big.png', size: 10485761, mimeType: 'image/png' },
          { principalId: 'user_123', requestId: 'req_003' }
        )
      ).rejects.toMatchObject({
        code: 'FILEFN_POLICY_MAX_SIZE_EXCEEDED',
        details: { policy: 'user-avatar', maxSizeBytes: 10485760, size: 10485761 },
      });
    });
  });

  describe('TV-QUOTA-NEG-001: Quota exceeded', () => {
    it('should reject when quota is exceeded', async () => {
      const quotaProvider: QuotaProvider = {
        async checkQuota() {
          return { allowed: false, current: 100, limit: 100 };
        },
        async recordUsage() {},
      };

      const fileFnWithQuota = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 10485760 }],
        quota: quotaProvider,
        auth: { required: false },
      });

      await expect(
        fileFnWithQuota.createUploadSession(
          { policy: 'user-avatar', fileName: 'avatar.png', size: 1, mimeType: 'image/png' },
          { principalId: 'user_123', requestId: 'req_004' }
        )
      ).rejects.toMatchObject({
        code: 'FILEFN_QUOTA_EXCEEDED',
        details: { current: 100, limit: 100, requested: 1 },
      });
    });
  });

  describe('TV-IDEMPOTENCY-001: Idempotent upload init', () => {
    it('should return same session for same idempotency key', async () => {
      const input = {
        policy: 'user-avatar',
        fileName: 'avatar.png',
        size: 2097152,
        mimeType: 'image/png',
        idempotencyKey: 'idem_001',
      };
      const ctx = { principalId: 'user_123', requestId: 'req_001' };

      const result1 = await fileFn.createUploadSession(input, ctx);
      const result2 = await fileFn.createUploadSession(input, ctx);

      expect(result1.uploadSessionId).toBe(result2.uploadSessionId);
    });
  });

  describe('TV-IDEMPOTENCY-NEG-001: Idempotency conflict', () => {
    it('should reject idempotency key reuse with different payload', async () => {
      const ctx = { principalId: 'user_123', requestId: 'req_001' };

      await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png', idempotencyKey: 'idem_001' },
        ctx
      );

      await expect(
        fileFn.createUploadSession(
          { policy: 'user-avatar', fileName: 'different.png', size: 2, mimeType: 'image/png', idempotencyKey: 'idem_001' },
          ctx
        )
      ).rejects.toMatchObject({ code: 'FILEFN_IDEMPOTENCY_CONFLICT' });
    });
  });

  describe('TV-UPLOAD-PART-SIGN-NEG-001: Invalid part number', () => {
    it('should reject invalid part number', async () => {
      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png' },
        { principalId: 'user_123' }
      );

      await expect(
        fileFn.signUploadPart(
          { uploadSessionId, partNumber: 0, contentLength: 1 },
          { principalId: 'user_123' }
        )
      ).rejects.toMatchObject({ code: 'FILEFN_INVALID_PART_NUMBER' });
    });
  });

  describe('TV-UPLOAD-PART-COMPLETE-NEG-001: Invalid etag', () => {
    it('should reject empty etag', async () => {
      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png' },
        { principalId: 'user_123' }
      );

      await expect(
        fileFn.completeUploadPart(
          { uploadSessionId, partNumber: 1, etag: '', size: 2097152 },
          { principalId: 'user_123' }
        )
      ).rejects.toMatchObject({ code: 'FILEFN_INVALID_ETAG' });
    });
  });

  describe('TV-UPLOAD-COMPLETE-NEG-001: Upload incomplete', () => {
    it('should reject completion with missing parts', async () => {
      // Create a fileFn with a larger size limit for this test
      const fileFnLarge = createFileFn({
        db,
        storage: createFakeStorageAdapter({
          capabilities: { signedUploadUrls: true, signedDownloadUrls: true, multipart: true, proxyStreamingUpload: false, proxyStreamingDownload: true },
        }),
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 50000000 }],
        auth: { required: false },
      });

      const { uploadSessionId } = await fileFnLarge.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 20000000, mimeType: 'image/png' }, // ~20MB = 3 parts
        { principalId: 'user_123' }
      );

      // Only complete 1 part
      await fileFnLarge.completeUploadPart(
        { uploadSessionId, partNumber: 1, etag: 'etag1', size: 8388608 },
        { principalId: 'user_123' }
      );

      await expect(
        fileFnLarge.completeUploadSession({ uploadSessionId }, { principalId: 'user_123' })
      ).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_INCOMPLETE' });
    });
  });

  describe('TV-UPLOAD-COMPLETE-001: Complete upload session', () => {
    it('should complete upload session after all parts recorded', async () => {
      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png' },
        { principalId: 'user_123' }
      );

      await fileFn.completeUploadPart(
        { uploadSessionId, partNumber: 1, etag: 'etag_part_1', size: 2097152 },
        { principalId: 'user_123' }
      );

      const result = await fileFn.completeUploadSession({ uploadSessionId }, { principalId: 'user_123' });

      expect(result.fileId).toBeDefined();
      expect(result.versionId).toBeDefined();
      expect(result.fileId).toMatch(/^file_/);
      expect(result.versionId).toMatch(/^ver_/);
    });
  });

  describe('TV-UPLOAD-EXPIRE-001: Expired session', () => {
    it('should reject completion of expired session', async () => {
      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png' },
        { principalId: 'user_123' }
      );

      // Manually expire the session
      await db.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }],
        data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
        namespace: 'filefn',
      });

      await expect(
        fileFn.completeUploadSession({ uploadSessionId }, { principalId: 'user_123' })
      ).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_EXPIRED' });
    });
  });

  describe('Abort then complete', () => {
    it('should reject completion after abort', async () => {
      const { uploadSessionId } = await fileFn.createUploadSession(
        { policy: 'user-avatar', fileName: 'avatar.png', size: 2097152, mimeType: 'image/png' },
        { principalId: 'user_123' }
      );

      await fileFn.abortUploadSession({ uploadSessionId }, { principalId: 'user_123' });

      await expect(
        fileFn.completeUploadSession({ uploadSessionId }, { principalId: 'user_123' })
      ).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_ABORTED' });
    });
  });

  describe('getSchema', () => {
    it('should return all required schemas (TV-DB-SCHEMA-001)', () => {
      const { version, schemas } = fileFn.getSchema();

      expect(version).toBe(1);

      const modelNames = schemas.map(s => s.modelName);
      expect(modelNames).toContain('files');
      expect(modelNames).toContain('fileVersions');
      expect(modelNames).toContain('uploadSessions');
      expect(modelNames).toContain('uploadParts');
      expect(modelNames).toContain('filePermissions');
      expect(modelNames).toContain('fileShares');
      expect(modelNames).toContain('fileArtifacts');
    });
  });

  describe('Rate limiting (TV-RATE-NEG-001)', () => {
    it('should enforce rate limits on upload init', async () => {
      const rateLimiter = {
        async check(_key: string) {
          return { allowed: false, remaining: 0, resetAt: Date.now() + 60000, total: 10 };
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

      const request = new Request('http://localhost/upload/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_rate' },
        body: JSON.stringify({ policy: 'user-avatar', fileName: 'test.png', size: 100, mimeType: 'image/png' }),
      });

      const response = await fileFnWithRateLimit.router.handle(request);
      expect(response).not.toBeNull();
      expect(response!.status).toBe(429);

      const body = await response!.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('FILEFN_RATE_LIMITED');
    });
  });
});
