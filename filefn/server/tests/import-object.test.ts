import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { StorageAdapter } from '@superfunctions/storage';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { describe, expect, it, vi } from 'vitest';
import { createFileFn, type QuotaProvider } from '../src/index.js';

const NAMESPACE = 'filefn';
const owner = { principalId: 'owner', tenantId: 'tenant' };

/** In-memory storage that records every call, so a test can tell a HEAD from a copy. */
function createStorage(initial: Record<string, number> = {}) {
  const objects = new Map<string, Uint8Array>(
    Object.entries(initial).map(([key, size]) => [key, new Uint8Array(size)]),
  );
  const calls: string[] = [];
  const storage: StorageAdapter = {
    name: 'memory-test',
    capabilities: {
      signedUploadUrls: false,
      signedDownloadUrls: false,
      multipart: false,
      proxyStreamingUpload: true,
      proxyStreamingDownload: true,
    },
    async statObject(input) {
      calls.push(`stat:${input.key}`);
      const bytes = objects.get(input.key);
      if (!bytes) throw Object.assign(new Error('Object not found'), { code: 'STORAGE_NOT_FOUND' });
      return { key: input.key, size: bytes.byteLength };
    },
    async deleteObject(input) {
      calls.push(`delete:${input.key}`);
      objects.delete(input.key);
    },
    async openUploadStream(input) {
      calls.push(`upload:${input.key}`);
      return new WritableStream();
    },
    async openDownloadStream(input) {
      calls.push(`download:${input.key}`);
      const bytes = objects.get(input.key) ?? new Uint8Array();
      return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    },
  };
  return { storage, objects, calls };
}

/**
 * Memory adapter that enforces unique `files.fileId` and
 * `fileVersions.versionId` like Postgres and reports constraints. `beforeCreate`
 * may hold or fail an insert.
 */
function createUniqueDb(base: Adapter = memoryAdapter(), hooks: { beforeCreate?: (model: string) => Promise<void> } = {}): Adapter {
  const uniqueColumns: Record<string, string> = { files: 'fileId', fileVersions: 'versionId' };
  return {
    ...base,
    capabilities: { ...base.capabilities, schema: { ...base.capabilities.schema, constraints: true } },
    async create(params) {
      await hooks.beforeCreate?.(params.model);
      const column = uniqueColumns[params.model];
      if (column) {
        const existing = await base.findOne({
          model: params.model,
          where: [{ field: column, operator: 'eq', value: params.data[column] }],
          namespace: params.namespace,
        });
        if (existing) throw new Error(`duplicate key value violates unique constraint "${params.model}_${column}"`);
      }
      return base.create(params);
    },
  } as Adapter;
}

function createQuota() {
  const recorded: Array<{ principalId?: string; tenantId?: string; bytes: number }> = [];
  const quota: QuotaProvider = {
    async checkQuota() {
      return { allowed: true, current: 0, limit: Number.MAX_SAFE_INTEGER };
    },
    async recordUsage(input) {
      recorded.push(input);
    },
  };
  return { quota, recorded };
}

function build(options: { database?: Adapter; storage: StorageAdapter; quota?: QuotaProvider; factory?: typeof createFileFn }) {
  return (options.factory ?? createFileFn)({
    database: options.database ?? memoryAdapter(),
    storage: options.storage,
    quota: options.quota,
    policies: [{ name: 'doc', contentTypes: ['text/plain'], visibility: 'shared' }],
  });
}

async function rows(database: Adapter, model: 'files' | 'fileVersions') {
  return database.findMany<Record<string, unknown>>({ model, where: [], namespace: NAMESPACE });
}

/** `createFileFn` of a separately loaded module graph, to model another process. */
async function loadIsolatedCreateFileFn(): Promise<typeof createFileFn> {
  vi.resetModules();
  return (await import('../src/index.js')).createFileFn;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const baseInput = {
  storageKey: 'legacy/s3/report.txt',
  principalId: 'owner',
  tenantId: 'tenant',
  fileName: 'report.txt',
  mimeType: 'text/plain',
  size: 12,
  policy: 'doc',
};

describe('services.files.importObject', () => {

  it('registers an existing object as a file and version without copying it, keeping createdAt', async () => {
    const database = memoryAdapter();
    const { storage, calls } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, recorded } = createQuota();
    const fileFn = build({ database, storage, quota });

    const result = await fileFn.services.files.importObject({
      ...baseInput,
      fileId: 'file_imported0001',
      createdAt: '2019-03-04T05:06:07Z',
      metadata: { source: 's3' },
    });

    expect(result.created).toBe(true);
    expect(result.file).toMatchObject({
      fileId: 'file_imported0001',
      currentVersionId: result.version.versionId,
      ownerId: 'owner',
      tenantId: 'tenant',
      policy: 'doc',
      visibility: 'shared',
      name: 'report.txt',
      mimeType: 'text/plain',
      size: 12,
      metadata: { source: 's3' },
      createdAt: '2019-03-04T05:06:07.000Z',
      updatedAt: '2019-03-04T05:06:07.000Z',
    });
    expect(result.version).toMatchObject({
      fileId: 'file_imported0001',
      storageKey: baseInput.storageKey,
      size: 12,
      createdAt: '2019-03-04T05:06:07.000Z',
    });
    // One HEAD; no upload, copy or delete.
    expect(calls).toEqual([`stat:${baseInput.storageKey}`]);
    expect(recorded).toEqual([{ principalId: 'owner', tenantId: 'tenant', bytes: 12 }]);

    // The file reads like an uploaded one, from the original key.
    const read = await fileFn.services.files.getFile('file_imported0001', owner, result.version.versionId);
    expect(read.storageKey).toBe(baseInput.storageKey);
    const download = await fileFn.services.files.getDownloadStream('file_imported0001', undefined, owner);
    expect(download.size).toBe(12);
    expect(calls.at(-1)).toBe(`download:${baseInput.storageKey}`);
  });

  it('reads the object through the real local storage adapter', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'filefn-import-'));
    try {
      await mkdir(join(rootDir, 'legacy'), { recursive: true });
      await writeFile(join(rootDir, 'legacy', 'a.txt'), 'hello world!');
      const fileFn = build({ storage: createLocalStorageAdapter({ rootDir }) });

      const result = await fileFn.services.files.importObject({ ...baseInput, storageKey: 'legacy/a.txt', policy: undefined });
      expect(result.created).toBe(true);
      expect(result.file.policy).toBe('default');
      expect(result.file.visibility).toBe('private');
      const download = await fileFn.services.files.getDownloadStream(result.file.fileId, undefined, owner);
      expect(await new Response(download.stream).text()).toBe('hello world!');

      await expect(fileFn.services.files.importObject({ ...baseInput, storageKey: 'legacy/missing.txt', policy: undefined }))
        .rejects.toMatchObject({ code: 'FILEFN_IMPORT_OBJECT_NOT_FOUND', status: 404 });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('returns the existing file on a rerun, without a second HEAD or quota record', async () => {
    const database = memoryAdapter();
    const { storage, calls } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, recorded } = createQuota();
    const fileFn = build({ database, storage, quota });

    const first = await fileFn.services.files.importObject(baseInput);
    // A rerun of the batch: another FileFn instance, and fields that may differ.
    const again = await build({ database, storage, quota }).services.files.importObject({
      ...baseInput,
      fileName: 'renamed.txt',
      createdAt: '2001-01-01T00:00:00Z',
    });

    expect(again.created).toBe(false);
    expect(again.file).toEqual(first.file);
    expect(again.version).toMatchObject({ versionId: first.version.versionId, storageKey: baseInput.storageKey });
    expect(calls).toEqual([`stat:${baseInput.storageKey}`]);
    expect(recorded).toHaveLength(1);
    expect(await rows(database, 'files')).toHaveLength(1);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
  });

  it('still returns the imported file after a later upload moved it to another version', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const fileFn = build({ database, storage });
    const first = await fileFn.services.files.importObject(baseInput);
    await database.update({
      model: 'files',
      where: [{ field: 'fileId', operator: 'eq', value: first.file.fileId }],
      data: { currentVersionId: 'ver_lateruploadxxxxxxxxx' },
      namespace: NAMESPACE,
    });

    const again = await fileFn.services.files.importObject(baseInput);
    expect(again.created).toBe(false);
    expect(again.file.fileId).toBe(first.file.fileId);
    expect(again.version.versionId).toBe(first.version.versionId);
  });

  it('resumes an import interrupted between the file row and its version', async () => {
    let failVersionInsert = true;
    const database = createUniqueDb(memoryAdapter(), {
      async beforeCreate(model) {
        if (model === 'fileVersions' && failVersionInsert) {
          failVersionInsert = false;
          throw new Error('connection reset');
        }
      },
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, recorded } = createQuota();
    const fileFn = build({ database, storage, quota });

    await expect(fileFn.services.files.importObject(baseInput)).rejects.toThrow('connection reset');
    expect(await rows(database, 'files')).toHaveLength(1);
    expect(await rows(database, 'fileVersions')).toHaveLength(0);

    const resumed = await fileFn.services.files.importObject(baseInput);
    expect(resumed.created).toBe(true);
    expect(await rows(database, 'files')).toEqual([expect.objectContaining({
      fileId: resumed.file.fileId,
      currentVersionId: resumed.version.versionId,
    })]);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('lets one of two racing importers in a process create the file, without unique constraints', async () => {
    const database = memoryAdapter();
    expect(database.capabilities.schema.constraints).toBe(false);
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, recorded } = createQuota();

    const results = await Promise.all([
      build({ database, storage, quota }).services.files.importObject({ ...baseInput, fileId: 'file_importerAAAA' }),
      build({ database, storage, quota }).services.files.importObject({ ...baseInput, fileId: 'file_importerBBBB' }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].file.fileId).toBe(results[1].file.fileId);
    expect(await rows(database, 'files')).toHaveLength(1);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('lets the first version insert win a race between processes and removes the loser\'s file row', async () => {
    const base = memoryAdapter();
    const bothFilesWritten = deferred();
    let filesWritten = 0;
    const database = createUniqueDb(base, {
      async beforeCreate(model) {
        if (model === 'files') {
          filesWritten += 1;
          if (filesWritten === 2) bothFilesWritten.resolve();
        }
        // Each importer inserts its version only once both have written their file row.
        if (model === 'fileVersions') await bothFilesWritten.promise;
      },
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const otherProcess = await loadIsolatedCreateFileFn();

    const results = await Promise.all([
      build({ database, storage }).services.files.importObject({ ...baseInput, fileId: 'file_importerAAAA' }),
      build({ database, storage, factory: otherProcess }).services.files.importObject({ ...baseInput, fileId: 'file_importerBBBB' }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    const winner = results.find((result) => result.created)!;
    expect(results.every((result) => result.file.fileId === winner.file.fileId)).toBe(true);
    expect((await rows(database, 'files')).map((row) => row.fileId)).toEqual([winner.file.fileId]);
    expect(await rows(database, 'fileVersions')).toEqual([expect.objectContaining({ fileId: winner.file.fileId })]);
  });

  it('removes a race loser\'s file row left by an interrupted import when the batch reruns', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const fileFn = build({ database, storage });
    const winner = await fileFn.services.files.importObject({ ...baseInput, fileId: 'file_importerAAAA' });
    // The loser wrote its file row, then stopped before its version insert failed.
    await database.create({
      model: 'files',
      data: {
        fileId: 'file_importerBBBB',
        currentVersionId: winner.version.versionId,
        ownerId: 'owner',
        tenantId: 'tenant',
        visibility: 'shared',
        policy: 'doc',
        mimeType: 'text/plain',
        size: 12,
        name: 'report.txt',
        metadata: {},
        createdAt: winner.file.createdAt,
        updatedAt: winner.file.updatedAt,
      },
      namespace: NAMESPACE,
    });

    const rerun = await fileFn.services.files.importObject({ ...baseInput, fileId: 'file_importerBBBB' });
    expect(rerun).toMatchObject({ created: false, file: { fileId: 'file_importerAAAA' } });
    expect((await rows(database, 'files')).map((row) => row.fileId)).toEqual(['file_importerAAAA']);
  });

  it('refuses a missing object and leaves no rows', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage();
    const fileFn = build({ database, storage });

    await expect(fileFn.services.files.importObject(baseInput))
      .rejects.toMatchObject({ code: 'FILEFN_IMPORT_OBJECT_NOT_FOUND', status: 404, details: { storageKey: baseInput.storageKey } });
    expect(await rows(database, 'files')).toHaveLength(0);
    expect(await rows(database, 'fileVersions')).toHaveLength(0);
  });

  it('passes through a storage error that is not a missing object', async () => {
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    storage.statObject = async () => {
      throw Object.assign(new Error('HeadObject failed: 503'), { statusCode: 503 });
    };
    await expect(build({ storage }).services.files.importObject(baseInput)).rejects.toThrow('HeadObject failed: 503');
  });

  it('refuses a size mismatch and leaves no rows', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage({ [baseInput.storageKey]: 11 });
    const fileFn = build({ database, storage });

    await expect(fileFn.services.files.importObject(baseInput))
      .rejects.toMatchObject({ code: 'FILEFN_IMPORT_SIZE_MISMATCH', status: 409, details: { expected: 12, actual: 11 } });
    expect(await rows(database, 'files')).toHaveLength(0);
    expect(await rows(database, 'fileVersions')).toHaveLength(0);
  });

  it('refuses a file ID that names another file, changing nothing', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage({ [baseInput.storageKey]: 12, 'legacy/other.txt': 3 });
    const fileFn = build({ database, storage });
    const other = await fileFn.services.files.importObject({ ...baseInput, storageKey: 'legacy/other.txt', size: 3, fileId: 'file_takenalready' });

    await expect(fileFn.services.files.importObject({ ...baseInput, fileId: 'file_takenalready' }))
      .rejects.toMatchObject({ code: 'FILEFN_IMPORT_CONFLICT', status: 409, details: { reason: 'fileId' } });
    expect(await rows(database, 'files')).toEqual([expect.objectContaining({ fileId: 'file_takenalready', currentVersionId: other.version.versionId })]);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
  });

  it('does not hand an object imported for one owner to another', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const fileFn = build({ database, storage });
    await fileFn.services.files.importObject(baseInput);

    await expect(fileFn.services.files.importObject({ ...baseInput, principalId: 'someone-else' }))
      .rejects.toMatchObject({ code: 'FILEFN_IMPORT_CONFLICT', details: { reason: 'owner' } });
    await expect(fileFn.services.files.importObject({ ...baseInput, tenantId: null }))
      .rejects.toMatchObject({ code: 'FILEFN_IMPORT_CONFLICT', details: { reason: 'owner' } });
  });

  it('validates the input before touching storage', async () => {
    const { storage, calls } = createStorage({ [baseInput.storageKey]: 12 });
    const files = build({ storage }).services.files;

    await expect(files.importObject({ ...baseInput, fileId: 'not-a-file-id' })).rejects.toMatchObject({ code: 'FILEFN_INVALID_FILE_ID' });
    await expect(files.importObject({ ...baseInput, createdAt: 'yesterday' })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    await expect(files.importObject({ ...baseInput, size: -1 })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    await expect(files.importObject({ ...baseInput, size: 1.5 })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    await expect(files.importObject({ ...baseInput, storageKey: '' })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    await expect(files.importObject({ ...baseInput, principalId: '' })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    await expect(files.importObject({ ...baseInput, metadata: [] as unknown as Record<string, unknown> })).rejects.toMatchObject({ code: 'FILEFN_INVALID_REQUEST' });
    await expect(files.importObject({ ...baseInput, policy: 'unknown' })).rejects.toMatchObject({ code: 'FILEFN_POLICY_NOT_FOUND' });
    expect(calls).toEqual([]);
  });

  it('is not reachable over the router', async () => {
    const fileFn = build({ storage: createStorage({ [baseInput.storageKey]: 12 }).storage });
    for (const path of ['/import', '/files/import', '/objects/import']) {
      const response = await fileFn.router.handle(new Request(`https://filefn.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(baseInput),
      }));
      expect(response === null || response.status === 404 || response.status === 405).toBe(true);
    }
  });
});
