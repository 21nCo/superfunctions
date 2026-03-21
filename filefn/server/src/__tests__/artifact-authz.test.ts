import { beforeEach, describe, expect, it } from 'vitest';
import { createFileFn, type FileFn } from '../index.js';
import { createSharesService } from '../shares/service.js';
import { createFakeStorageAdapter } from '@superfunctions/storage';
import type { Adapter, AdapterCapabilities } from '@superfunctions/db';

const CAPS: AdapterCapabilities = {
  types: { json: true, dates: true, booleans: true, bigint: false, uuid: false, enum: false },
  operations: { batch: false, upsert: true, streaming: false, fulltext: false, returning: false },
  transactions: { supported: false, nested: false },
  performance: { supportsJoins: false, supportsPreparedStatements: false },
  schema: { migrations: false, constraints: false, indexes: false },
  advanced: { customIdGeneration: false, numericIds: false, schemaNamespaces: false, customTypes: false },
};

function createDb(seed: Record<string, any[]> = {}): Adapter {
  const tables = new Map<string, Map<string, any>>();
  let seq = 1;

  function idFor(record: any): string {
    return (
      record.uploadSessionId ||
      record.fileId ||
      record.versionId ||
      record.permissionId ||
      record.artifactId ||
      record.tokenHash ||
      `id_${seq++}`
    );
  }

  for (const [model, rows] of Object.entries(seed)) {
    const table = new Map<string, any>();
    for (const row of rows) table.set(idFor(row), { ...row });
    tables.set(model, table);
  }

  function getTable(model: string): Map<string, any> {
    if (!tables.has(model)) tables.set(model, new Map());
    return tables.get(model)!;
  }

  function matches(record: any, where: any[] = []): boolean {
    for (const clause of where) {
      const value = record?.[clause.field];
      if (clause.operator === 'eq' && value !== clause.value) return false;
      if (clause.operator === 'ne' && value === clause.value) return false;
      if (clause.operator === 'lt' && !(value < clause.value)) return false;
      if (clause.operator === 'in' && !clause.value.includes(value)) return false;
    }
    return true;
  }

  return {
    id: 'phase0-artifacts-db',
    name: 'phase0-artifacts-db',
    version: '1.0.0',
    capabilities: CAPS,
    async create(params) {
      const table = getTable(params.model);
      const row = { ...params.data };
      table.set(idFor(row), row);
      return row;
    },
    async findOne(params) {
      const table = getTable(params.model);
      for (const row of table.values()) {
        if (matches(row, params.where)) return row;
      }
      return null;
    },
    async findMany(params) {
      const table = getTable(params.model);
      const rows = Array.from(table.values()).filter((row) => matches(row, params.where));
      return rows;
    },
    async update(params) {
      const table = getTable(params.model);
      for (const [id, row] of table.entries()) {
        if (matches(row, params.where)) {
          const next = { ...row, ...params.data };
          table.set(id, next);
          return next;
        }
      }
      return null;
    },
    async delete(params) {
      const table = getTable(params.model);
      for (const [id, row] of table.entries()) {
        if (matches(row, params.where)) {
          table.delete(id);
          return;
        }
      }
    },
    async createMany() { return []; },
    async updateMany() { return 0; },
    async deleteMany(params) {
      const table = getTable(params.model);
      let deleted = 0;
      for (const [id, row] of table.entries()) {
        if (matches(row, params.where)) {
          table.delete(id);
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
}

describe('PHASE_04 AUTH-002/FILE-003 share and artifact authz + proxy descriptors', () => {
  let fileFn: FileFn;
  let db: Adapter;

  beforeEach(() => {
    db = createDb({
      files: [
        {
          fileId: 'file_0001',
          currentVersionId: 'ver_0001',
          ownerId: 'user_123',
          tenantId: 'org_123',
          visibility: 'private',
          policy: 'user-avatar',
          mimeType: 'image/png',
          size: 10,
          name: 'one.png',
          metadata: {},
          createdAt: '2026-03-20T12:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
        {
          fileId: 'file_0002',
          currentVersionId: 'ver_0002',
          ownerId: 'user_123',
          tenantId: 'org_123',
          visibility: 'private',
          policy: 'user-avatar',
          mimeType: 'image/png',
          size: 10,
          name: 'two.png',
          metadata: {},
          createdAt: '2026-03-20T12:00:00.000Z',
          updatedAt: '2026-03-20T12:00:00.000Z',
        },
      ],
      fileVersions: [
        {
          versionId: 'ver_0001',
          fileId: 'file_0001',
          storageKey: 'files/file_0001/ver_0001',
          mimeType: 'image/png',
          size: 10,
          checksumSha256Base64: null,
          createdAt: '2026-03-20T12:00:00.000Z',
        },
        {
          versionId: 'ver_0002',
          fileId: 'file_0002',
          storageKey: 'files/file_0002/ver_0002',
          mimeType: 'image/png',
          size: 10,
          checksumSha256Base64: null,
          createdAt: '2026-03-20T12:00:00.000Z',
        },
      ],
      fileArtifacts: [
        {
          artifactId: 'art_0001',
          fileId: 'file_0002',
          versionId: 'ver_0002',
          kind: 'thumbnail',
          storageKey: 'artifacts/file_0002/thumb',
          mimeType: 'image/webp',
          size: 123,
          metadata: {},
          createdAt: '2026-03-20T12:00:00.000Z',
        },
      ],
    });

    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: false,
        multipart: true,
        proxyStreamingUpload: true,
        proxyStreamingDownload: true,
      },
    });

    fileFn = createFileFn({
      db,
      storage,
      policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 1024 * 1024 }],
      auth: {
        required: false,
        resolveSession: async () => ({ principalId: 'user_123', tenantId: 'org_123' }),
      },
    });
  });

  it('TV-ACCESS-NEG-001: artifact download should 404 for cross-file binding mismatch', async () => {
    const res = await fileFn.router.handle(
      new Request('http://localhost/file_0001/artifacts/art_0001/download', { method: 'GET' })
    );
    const body = await res!.json();

    expect(res!.status).toBe(404);
    expect(body.error.code).toBe('FILEFN_NOT_FOUND');
  });

  it('TV-DOWNLOAD-FALLBACK-001: artifact descriptor should be an HTTP proxy route, never proxy://', async () => {
    const res = await fileFn.router.handle(
      new Request('http://localhost/file_0002/artifacts/art_0001/download', { method: 'GET' })
    );
    const body = await res!.json();

    expect(body.ok).toBe(true);
    expect(body.data.url).toMatch(/^\/proxy\/files\/file_0002\/artifacts\/art_0001\/download$/);
    expect(body.data.url).not.toMatch(/^proxy:\/\//);
  });

  it('TV-DOWNLOAD-FALLBACK-001: artifact proxy data-plane route should stream authorized bytes', async () => {
    const descriptorRes = await fileFn.router.handle(
      new Request('http://localhost/file_0002/artifacts/art_0001/download', { method: 'GET' }),
    );
    const descriptorBody = await descriptorRes!.json();

    const proxyRes = await fileFn.router.handle(
      new Request(`http://localhost${descriptorBody.data.url}`, { method: 'GET' }),
    );

    expect(proxyRes!.status).toBe(200);
    expect(proxyRes!.headers.get('content-type')).toBe('image/webp');
  });

  it('TV-PROCESS-NEG-001: unauthorized artifact download should return 403 FILEFN_FORBIDDEN', async () => {
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: false,
        multipart: true,
        proxyStreamingUpload: true,
        proxyStreamingDownload: true,
      },
    });
    const fileFnUnauthorized = createFileFn({
      db,
      storage,
      policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 1024 * 1024 }],
      auth: {
        required: false,
        resolveSession: async () => ({ principalId: 'user_999', tenantId: 'org_999' }),
      },
    });

    const res = await fileFnUnauthorized.router.handle(
      new Request('http://localhost/file_0002/artifacts/art_0001/download', { method: 'GET' }),
    );
    const body = await res!.json();

    expect(res!.status).toBe(403);
    expect(body.error.code).toBe('FILEFN_FORBIDDEN');
  });

  it('TV-DOWNLOAD-FALLBACK-001: share download descriptor should be an HTTP proxy route, never proxy://', async () => {
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: false,
        multipart: true,
        proxyStreamingUpload: true,
        proxyStreamingDownload: true,
      },
    });

    const sharesService = createSharesService({ db, storage, namespace: 'filefn' });

    const { token } = await sharesService.createShareLink(
      { fileId: 'file_0001' },
      { principalId: 'user_123', tenantId: 'org_123' }
    );

    const descriptor = await sharesService.downloadViaShareLink(token, {
      principalId: 'anonymous',
      tenantId: 'org_123',
      isAuthenticated: false,
    });

    expect(descriptor.url).toMatch(/^\/proxy\/share-links\//);
    expect(descriptor.url).not.toMatch(/^proxy:\/\//);
  });

  it('TV-DOWNLOAD-FALLBACK-001: share proxy data-plane route should stream bytes', async () => {
    const sharesService = createSharesService({
      db,
      storage: createFakeStorageAdapter({
        capabilities: {
          signedUploadUrls: true,
          signedDownloadUrls: false,
          multipart: true,
          proxyStreamingUpload: true,
          proxyStreamingDownload: true,
        },
      }),
      namespace: 'filefn',
    });

    const { token } = await sharesService.createShareLink(
      { fileId: 'file_0001' },
      { principalId: 'user_123', tenantId: 'org_123' },
    );

    const descriptorRes = await fileFn.router.handle(
      new Request(`http://localhost/share-links/${token}/download`, { method: 'GET' }),
    );
    const descriptorBody = await descriptorRes!.json();

    const proxyRes = await fileFn.router.handle(
      new Request(`http://localhost${descriptorBody.data.url}`, { method: 'GET' }),
    );

    expect(proxyRes!.status).toBe(200);
    expect(proxyRes!.headers.get('content-type')).toBe('image/png');
  });

  it('TV-RATE-001: shareDownload category rate limit should return FILEFN_RATE_LIMITED with ISO resetAt', async () => {
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: false,
        multipart: true,
        proxyStreamingUpload: true,
        proxyStreamingDownload: true,
      },
    });

    const fileFnWithShareRate = createFileFn({
      db,
      storage,
      policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 1024 * 1024 }],
      rateLimit: {
        limits: {
          shareDownload: { windowSeconds: 60, maxRequests: 1 },
        },
      },
      auth: {
        required: false,
        resolveSession: async () => ({ principalId: 'user_123', tenantId: 'org_123' }),
      },
    });

    const sharesService = createSharesService({ db, storage, namespace: 'filefn' });
    const { token } = await sharesService.createShareLink(
      { fileId: 'file_0001' },
      { principalId: 'user_123', tenantId: 'org_123' }
    );

    const first = await fileFnWithShareRate.router.handle(
      new Request(`http://localhost/share-links/${token}/download`, { method: 'GET' })
    );
    expect(first!.status).toBe(200);

    const second = await fileFnWithShareRate.router.handle(
      new Request(`http://localhost/share-links/${token}/download`, { method: 'GET' })
    );
    expect(second!.status).toBe(429);
    const body = await second!.json();
    expect(body.error.code).toBe('FILEFN_RATE_LIMITED');
    expect(typeof body.error.details?.resetAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.error.details.resetAt))).toBe(false);
  });

  it('TV-RATE-001: artifactDownload category rate limit should apply to artifact control-plane downloads', async () => {
    const storage = createFakeStorageAdapter({
      capabilities: {
        signedUploadUrls: true,
        signedDownloadUrls: false,
        multipart: true,
        proxyStreamingUpload: true,
        proxyStreamingDownload: true,
      },
    });

    const fileFnWithArtifactRate = createFileFn({
      db,
      storage,
      policies: [{ name: 'user-avatar', contentTypes: ['image/png'], maxSizeBytes: 1024 * 1024 }],
      rateLimit: {
        limits: {
          artifactDownload: { windowSeconds: 60, maxRequests: 1 },
        },
      },
      auth: {
        required: false,
        resolveSession: async () => ({ principalId: 'user_123', tenantId: 'org_123' }),
      },
    });

    const first = await fileFnWithArtifactRate.router.handle(
      new Request('http://localhost/file_0002/artifacts/art_0001/download', { method: 'GET' })
    );
    expect(first!.status).toBe(200);

    const second = await fileFnWithArtifactRate.router.handle(
      new Request('http://localhost/file_0002/artifacts/art_0001/download', { method: 'GET' })
    );
    expect(second!.status).toBe(429);
    const body = await second!.json();
    expect(body.error.code).toBe('FILEFN_RATE_LIMITED');
    expect(typeof body.error.details?.resetAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.error.details.resetAt))).toBe(false);
  });
});
