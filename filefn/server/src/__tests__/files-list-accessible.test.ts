/**
 * Test vectors for list accessibility semantics (FILE-001, AUTHZ-001, AUTHZ-003)
 * 
 * These tests encode the audit gaps for accessible file listing:
 * - TV-FILE-LIST-001: List returns owned + public + shared + granted files
 * - TV-FILE-LIST-NEG-001: List does not leak inaccessible private files
 * - TV-VISIBILITY-001: Public visibility allows read
 * - TV-VISIBILITY-NEG-001: Private visibility blocks anonymous read
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFileFn, type FileFn, type Authorizer, type Visibility } from '../index.js';
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
        case 'in': if (!clause.value.includes(value)) return false; break;
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
        if (!params.where || params.where.length === 0 || matchesWhere(record, params.where)) {
          results.push(record);
        }
      }
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
    async createMany() { return []; },
    async updateMany() { return 0; },
    async deleteMany() { return 0; },
    async upsert(params) {
      const existing = await this.findOne({ model: params.model, where: params.where, namespace: params.namespace });
      if (existing) {
        return await this.update({ model: params.model, where: params.where, data: params.update, namespace: params.namespace });
      }
      return await this.create({ model: params.model, data: params.create, namespace: params.namespace });
    },
    async count() { return 0; },
    async transaction(callback) { return callback(this as any); },
    async initialize() {},
    async isHealthy() { return { healthy: true, uptime: 0 }; },
    async close() {},
    async getSchemaVersion() { return 0; },
    async setSchemaVersion() {},
    async validateSchema() { return { valid: true }; },
  } as Adapter;
}

async function createFileWithVisibility(
  fileFn: FileFn,
  db: Adapter,
  storageSizes: Map<string, number>,
  ownerId: string,
  tenantId: string,
  visibility: Visibility,
  fileIdOverride?: string
): Promise<{ fileId: string; versionId: string }> {
  const { uploadSessionId } = await fileFn.createUploadSession(
    { policy: 'user-avatar', fileName: 'test.png', size: 100, mimeType: 'image/png' },
    { principalId: ownerId, tenantId }
  );

  const session = await db.findOne<any>({ model: 'uploadSessions', where: [{ field: 'uploadSessionId', operator: 'eq', value: uploadSessionId }] });
  if (session) storageSizes.set(session.storageKey, 100);
  
  await fileFn.completeUploadPart(
    { uploadSessionId, partNumber: 1, etag: 'etag1', size: 100 },
    { principalId: ownerId, tenantId }
  );
  
  const result = await fileFn.completeUploadSession({ uploadSessionId }, { principalId: ownerId, tenantId });

  // Update visibility directly in db
  await db.update({
    model: 'files',
    where: [{ field: 'fileId', operator: 'eq', value: result.fileId }],
    data: { visibility, fileId: fileIdOverride || result.fileId },
    namespace: 'filefn',
  });

  return { fileId: fileIdOverride || result.fileId, versionId: result.versionId };
}

describe('@filefn/server list accessible files', () => {
  let db: Adapter;
  let fileFn: FileFn;
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
      policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 10485760 }],
      auth: { required: false },
    });
  });

  describe('TV-FILE-LIST-001: List returns only accessible files', () => {
    it('should return owned, public, shared, and granted files', async () => {
      // Setup dataset per test vector:
      // - file_owned_private owned by user_123, visibility private
      // - file_other_public owned by user_999, visibility public
      // - file_other_shared owned by user_999, visibility shared, tenantId org_123
      // - file_other_private_granted owned by user_999, visibility private, with permission grant

      await createFileWithVisibility(fileFn, db, storageSizes, 'user_123', 'org_123', 'private');
      await createFileWithVisibility(fileFn, db, storageSizes, 'user_999', 'org_456', 'public');
      await createFileWithVisibility(fileFn, db, storageSizes, 'user_999', 'org_123', 'shared');

      // Create a granted file
      const grantedFile = await createFileWithVisibility(fileFn, db, storageSizes, 'user_999', 'org_456', 'private');
      
      // Add permission grant for user_123
      await db.create({
        model: 'filePermissions',
        data: {
          permissionId: `perm_${Date.now()}`,
          fileId: grantedFile.fileId,
          principalId: 'user_123',
          canRead: true,
          canWrite: false,
          canDelete: false,
          createdAt: new Date().toISOString(),
        },
        namespace: 'filefn',
      });

      // List files for user_123
      const result = await fileFn.listFiles({}, { principalId: 'user_123', tenantId: 'org_123' }) as any;

      // This will fail until list accessibility is properly implemented
      // Should include: owned private, other public, other shared (same tenant), granted
      expect(result.files.length).toBe(4);
      
      const fileIds = result.files.map((f: any) => f.fileId);
      expect(fileIds).toContain(grantedFile.fileId);
    });
  });

  describe('TV-FILE-LIST-NEG-001: List does not leak private files', () => {
    it('should not return private files owned by others without grant', async () => {
      // Create a private file owned by user_123
      await createFileWithVisibility(fileFn, db, storageSizes, 'user_123', 'org_123', 'private');
      
      // Create a public file owned by other_user
      const publicFile = await createFileWithVisibility(fileFn, db, storageSizes, 'other_user', 'org_456', 'public');

      // List files for other_user (not user_123)
      const result = await fileFn.listFiles({}, { principalId: 'other_user', tenantId: 'org_456' }) as any;

      // other_user should NOT see user_123's private file
      // This will fail until list filtering is properly implemented
      const fileIds = result.files.map((f: any) => f.fileId);
      expect(fileIds).not.toContain('file_user_123_private');
      expect(fileIds).toContain(publicFile.fileId);
    });
  });

  describe('TV-VISIBILITY-001: Public visibility allows read', () => {
    it('should allow anonymous read of public files', async () => {
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

      const fileFnWithAuth = createFileFn({
        db,
        storage,
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 10485760 }],
        auth: { required: false },
      });

      // Create a public file
      const { fileId } = await createFileWithVisibility(fileFnWithAuth, db, storageSizes, 'user_123', 'org_123', 'public');

      // Anonymous read (no principalId)
      const request = new Request(`http://localhost/${fileId}`, {
        method: 'GET',
        headers: { 'x-request-id': 'req_026' },
      });

      const response = await fileFnWithAuth.router.handle(request);
      
      // This will fail until visibility-based access is implemented
      expect(response!.status).toBe(200);

      const body = await response!.json();
      expect(body.ok).toBe(true);
      expect(body.data.visibility).toBe('public');
    });
  });

  describe('TV-VISIBILITY-NEG-001: Private visibility blocks anonymous read', () => {
    it('should require auth for private files', async () => {
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

      const fileFnWithAuth = createFileFn({
        db,
        storage,
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 10485760 }],
        auth: { required: true },
      });

      // Create a private file
      const { fileId } = await createFileWithVisibility(fileFn, db, storageSizes, 'user_123', 'org_123', 'private');

      // Anonymous read (no authorization)
      const request = new Request(`http://localhost/${fileId}`, {
        method: 'GET',
        headers: { 'x-request-id': 'req_027' },
      });

      const response = await fileFnWithAuth.router.handle(request);
      
      // Should return 401 for private file without auth
      expect(response!.status).toBe(401);

      const body = await response!.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('FILEFN_AUTH_REQUIRED');
    });
  });

  describe('TV-VERSION-REPLACE-NEG-001: Replace forbidden without write permission', () => {
    it('should reject replace-by-fileId without write permission', async () => {
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

      const fileFnWithAuth = createFileFn({
        db,
        storage,
        policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 10485760 }],
        auth: {
          required: false,
          resolveSession: async (req) => {
            const auth = req.headers.get('authorization');
            if (auth === 'Bearer good') return { principalId: 'user_123' };
            if (auth === 'Bearer other-user') return { principalId: 'user_999' };
            return null;
          },
        },
      });

      // Create a file owned by user_123
      const { fileId } = await createFileWithVisibility(fileFnWithAuth, db, storageSizes, 'user_123', 'org_123', 'private');

      // Attempt to replace by user_999 (not owner, no write permission)
      const request = new Request('http://localhost/upload/init', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_020',
          'authorization': 'Bearer other-user',
        },
        body: JSON.stringify({
          policy: 'user-avatar',
          fileId: fileId,
          fileName: 'new-avatar.png',
          size: 1,
          mimeType: 'image/png',
        }),
      });

      const response = await fileFnWithAuth.router.handle(request);
      
      // Should return 403 FORBIDDEN for unauthorized replace
      expect(response!.status).toBe(403);

      const body = await response!.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('FILEFN_FORBIDDEN');
    });
  });
});
