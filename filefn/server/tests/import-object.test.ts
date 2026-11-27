import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import type { StorageAdapter } from '@superfunctions/storage';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { describe, expect, it, vi } from 'vitest';
import { createFileFn, type QuotaProvider } from '../src/index.js';
import { createKeyedSerializer } from '../src/upload-sessions/file-id.js';

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
      const chunks: Uint8Array[] = [];
      return new WritableStream<Uint8Array>({
        write(chunk) { chunks.push(chunk); },
        close() { objects.set(input.key, Buffer.concat(chunks)); },
      });
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
 * `fileVersions.versionId` like Postgres (each check and insert atomic) and
 * reports constraints. `beforeCreate` may hold or fail an insert.
 */
function createUniqueDb(
  base: Adapter = memoryAdapter(),
  hooks: { beforeCreate?: (model: string) => Promise<void>; afterCreate?: (model: string) => Promise<void> } = {},
): Adapter {
  const uniqueColumns: Record<string, string> = { files: 'fileId', fileVersions: 'versionId' };
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ...base,
    capabilities: { ...base.capabilities, schema: { ...base.capabilities.schema, constraints: true } },
    async create(params) {
      await hooks.beforeCreate?.(params.model);
      const insert = tail.then(async () => {
        const column = uniqueColumns[params.model];
        if (column) {
          const existing = await base.findOne({
            model: params.model,
            where: [{ field: column, operator: 'eq', value: params.data[column] }],
            namespace: params.namespace,
          });
          if (existing) {
            throw Object.assign(new Error(`duplicate key value violates unique constraint "${params.model}_${column}"`), { code: '23505' });
          }
        }
        return base.create(params);
      });
      tail = insert.catch(() => undefined);
      const created = await insert;
      await hooks.afterCreate?.(params.model);
      return created;
    },
  } as Adapter;
}

/** Memory adapter (no unique constraints) whose inserts `beforeCreate` may hold. */
function createHookedDb(beforeCreate: (model: string) => Promise<void>): Adapter {
  const base = memoryAdapter();
  return {
    ...base,
    async create(params) {
      await beforeCreate(params.model);
      return base.create(params);
    },
  } as Adapter;
}

/** Resolves once `count` callers have arrived, holding each until then. */
function barrier(count: number) {
  const all = deferred();
  let arrived = 0;
  return () => {
    arrived += 1;
    if (arrived === count) all.resolve();
    return all.promise;
  };
}

function createQuota() {
  const recorded: Array<{ principalId?: string; tenantId?: string; bytes: number }> = [];
  const control = { failNext: false, failNextTakeBack: false };
  const quota: QuotaProvider = {
    async checkQuota() {
      return { allowed: true, current: 0, limit: Number.MAX_SAFE_INTEGER };
    },
    async recordUsage(input) {
      if (control.failNext) {
        control.failNext = false;
        throw new Error('quota store unavailable');
      }
      if (control.failNextTakeBack && input.bytes < 0) {
        control.failNextTakeBack = false;
        throw new Error('quota take-back unavailable');
      }
      recorded.push(input);
    },
  };
  const net = () => recorded.reduce((sum, entry) => sum + entry.bytes, 0);
  return { quota, recorded, control, net };
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

async function flushPromises() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
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

  it('charges an import for the reserved owner anonymous to the unset principal, as its delete refunds', async () => {
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, recorded } = createQuota();
    const fileFn = build({ storage, quota });

    await fileFn.services.files.importObject({ ...baseInput, principalId: 'anonymous', fileId: 'file_anonimport01' });

    expect(recorded).toEqual([{ principalId: undefined, tenantId: 'tenant', bytes: 12 }]);
  });

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
    // The failed attempt took back the usage it had recorded.
    expect(recorded.map((entry) => entry.bytes)).toEqual([12, -12, 12]);
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
    const { quota, net } = createQuota();
    const otherProcess = await loadIsolatedCreateFileFn();

    const results = await Promise.all([
      build({ database, storage, quota }).services.files.importObject({ ...baseInput, fileId: 'file_importerAAAA' }),
      build({ database, storage, quota, factory: otherProcess }).services.files.importObject({ ...baseInput, fileId: 'file_importerBBBB' }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    const winner = results.find((result) => result.created)!;
    expect(results.every((result) => result.file.fileId === winner.file.fileId)).toBe(true);
    expect((await rows(database, 'files')).map((row) => row.fileId)).toEqual([winner.file.fileId]);
    expect(await rows(database, 'fileVersions')).toEqual([expect.objectContaining({ fileId: winner.file.fileId })]);
    // The loser took back the usage it recorded before its version insert failed.
    expect(net()).toBe(12);
  });

  it.each([
    ['both omit fileId', undefined],
    ['both pass one fileId', 'file_sharedIMPORT'],
  ])('creates one file when importers in two processes race on one object (%s)', async (_label, fileId) => {
    // Both reach their version insert before either inserts it.
    const versionInserts = barrier(2);
    const database = createUniqueDb(memoryAdapter(), {
      async beforeCreate(model) {
        if (model === 'fileVersions') await versionInserts();
      },
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, net } = createQuota();
    const otherProcess = await loadIsolatedCreateFileFn();

    const results = await Promise.all([
      build({ database, storage, quota }).services.files.importObject({ ...baseInput, fileId }),
      build({ database, storage, quota, factory: otherProcess }).services.files.importObject({ ...baseInput, fileId }),
    ]);

    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(results[0].file.fileId).toBe(results[1].file.fileId);
    expect(results[0].version.versionId).toBe(results[1].version.versionId);
    expect(await rows(database, 'files')).toHaveLength(1);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
    expect(net()).toBe(12);
  });

  it('lets only one of two imports of different objects claim one fileId, without unique constraints', async () => {
    const releaseFirstFileRow = deferred();
    let fileRows = 0;
    const database = createHookedDb(async (model) => {
      if (model === 'files' && ++fileRows === 1) await releaseFirstFileRow.promise;
    });
    expect(database.capabilities.schema.constraints).toBe(false);
    const { storage } = createStorage({ 'legacy/one.txt': 12, 'legacy/two.txt': 12 });
    const { quota, net } = createQuota();

    const first = build({ database, storage, quota }).services.files.importObject({
      ...baseInput, storageKey: 'legacy/one.txt', fileId: 'file_claimedONCE',
    });
    const second = build({ database, storage, quota }).services.files.importObject({
      ...baseInput, storageKey: 'legacy/two.txt', fileId: 'file_claimedONCE', principalId: 'intruder',
    });
    // The second import runs as far as it can while the first holds its file row.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirstFileRow.resolve();

    await expect(first).resolves.toMatchObject({ created: true, file: { fileId: 'file_claimedONCE', ownerId: 'owner' } });
    await expect(second).rejects.toMatchObject({
      code: 'FILEFN_IMPORT_CONFLICT',
      details: expect.objectContaining({ reason: 'fileId' }),
    });
    expect(await rows(database, 'files')).toEqual([expect.objectContaining({ fileId: 'file_claimedONCE', ownerId: 'owner' })]);
    expect(await rows(database, 'fileVersions')).toEqual([expect.objectContaining({ storageKey: 'legacy/one.txt' })]);
    expect(net()).toBe(12);
  });

  it('lets only one of two imports of different objects claim one fileId across processes', async () => {
    const fileRowInserts = barrier(2);
    const database = createUniqueDb(memoryAdapter(), {
      async beforeCreate(model) {
        if (model === 'files') await fileRowInserts();
      },
    });
    const { storage } = createStorage({ 'legacy/one.txt': 12, 'legacy/two.txt': 12 });
    const { quota, net } = createQuota();
    const otherProcess = await loadIsolatedCreateFileFn();

    const settled = await Promise.allSettled([
      build({ database, storage, quota }).services.files.importObject({
        ...baseInput, storageKey: 'legacy/one.txt', fileId: 'file_claimedONCE',
      }),
      build({ database, storage, quota, factory: otherProcess }).services.files.importObject({
        ...baseInput, storageKey: 'legacy/two.txt', fileId: 'file_claimedONCE', principalId: 'intruder',
      }),
    ]);

    const created = settled.filter((result) => result.status === 'fulfilled');
    const refused = settled.filter((result) => result.status === 'rejected');
    expect(created).toHaveLength(1);
    expect(refused).toEqual([expect.objectContaining({
      reason: expect.objectContaining({ code: 'FILEFN_IMPORT_CONFLICT', details: expect.objectContaining({ reason: 'fileId' }) }),
    })]);
    const winner = (created[0] as PromiseFulfilledResult<{ file: { ownerId: string }; version: { storageKey: string } }>).value;
    expect(await rows(database, 'files')).toEqual([expect.objectContaining({ fileId: 'file_claimedONCE', ownerId: winner.file.ownerId })]);
    expect(await rows(database, 'fileVersions')).toEqual([expect.objectContaining({ storageKey: winner.version.storageKey })]);
    expect(net()).toBe(12);
  });

  it('does not import under a fileId an upload completion is creating', async () => {
    const releaseUploadFileRow = deferred();
    const uploadAtFileRow = deferred();
    let fileRows = 0;
    const database = createHookedDb(async (model) => {
      if (model === 'files' && ++fileRows === 1) {
        uploadAtFileRow.resolve();
        await releaseUploadFileRow.promise;
      }
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const uploader = { principalId: 'uploader', tenantId: 'tenant' };
    const uploads = build({ database, storage }).services.uploads;
    const session = await uploads.createSession(
      { policy: 'doc', fileName: 'new.txt', size: 5, mimeType: 'text/plain', fileId: 'file_claimedONCE' },
      uploader,
    );
    await uploads.uploadPartBytes(session.uploadSessionId, 1, Buffer.from('hello'), 5, uploader, session.uploadSessionToken);
    const upload = uploads.completeSession(session.uploadSessionId, uploader, session.uploadSessionToken);
    await uploadAtFileRow.promise;

    const imported = build({ database, storage }).services.files.importObject({ ...baseInput, fileId: 'file_claimedONCE' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseUploadFileRow.resolve();

    const published = await upload;
    await expect(imported).rejects.toMatchObject({
      code: 'FILEFN_IMPORT_CONFLICT',
      details: expect.objectContaining({ reason: 'fileId' }),
    });
    expect(await rows(database, 'files')).toEqual([expect.objectContaining({ fileId: 'file_claimedONCE', ownerId: 'uploader' })]);
    expect(await rows(database, 'fileVersions')).toEqual([expect.objectContaining({ versionId: published.versionId })]);
  });

  it('lets only one of two imports through separate wrappers of one memory store claim one fileId', async () => {
    const releaseFirstFileRow = deferred();
    const firstAtFileRow = deferred();
    let fileRows = 0;
    const store = createHookedDb(async (model) => {
      if (model === 'files' && ++fileRows === 1) {
        firstAtFileRow.resolve();
        await releaseFirstFileRow.promise;
      }
    });
    const { storage } = createStorage({ 'legacy/one.txt': 12, 'legacy/two.txt': 12 });
    const { quota, net } = createQuota();
    // Each wrapper is a separate adapter object that forwards to one store.
    const viaA = build({ database: { ...store } as Adapter, storage, quota });
    const viaB = build({ database: { ...store } as Adapter, storage, quota });

    const first = viaA.services.files.importObject({ ...baseInput, storageKey: 'legacy/one.txt', fileId: 'file_claimedONCE' });
    await firstAtFileRow.promise;
    const second = viaB.services.files.importObject({
      ...baseInput, storageKey: 'legacy/two.txt', fileId: 'file_claimedONCE', principalId: 'intruder',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirstFileRow.resolve();

    await expect(first).resolves.toMatchObject({ created: true, file: { fileId: 'file_claimedONCE', ownerId: 'owner' } });
    await expect(second).rejects.toMatchObject({
      code: 'FILEFN_IMPORT_CONFLICT',
      details: expect.objectContaining({ reason: 'fileId' }),
    });
    expect(await rows(store, 'files')).toEqual([expect.objectContaining({ fileId: 'file_claimedONCE', ownerId: 'owner' })]);
    expect(await rows(store, 'fileVersions')).toEqual([expect.objectContaining({ storageKey: 'legacy/one.txt' })]);
    expect(net()).toBe(12);
  });

  it('makes an upload completion through another wrapper of one memory store wait for an import of its fileId', async () => {
    const releaseImportFileRow = deferred();
    const importAtFileRow = deferred();
    let fileRows = 0;
    const store = createHookedDb(async (model) => {
      if (model === 'files' && ++fileRows === 1) {
        importAtFileRow.resolve();
        await releaseImportFileRow.promise;
      }
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const viaA = build({ database: { ...store } as Adapter, storage });
    const viaB = build({ database: { ...store } as Adapter, storage });
    const uploader = { principalId: 'uploader', tenantId: 'tenant' };
    const session = await viaB.services.uploads.createSession(
      { policy: 'doc', fileName: 'new.txt', size: 5, mimeType: 'text/plain', fileId: 'file_claimedONCE' },
      uploader,
    );
    await viaB.services.uploads.uploadPartBytes(session.uploadSessionId, 1, Buffer.from('hello'), 5, uploader, session.uploadSessionToken);

    const imported = viaA.services.files.importObject({ ...baseInput, fileId: 'file_claimedONCE' });
    await importAtFileRow.promise;
    const upload = viaB.services.uploads.completeSession(session.uploadSessionId, uploader, session.uploadSessionToken);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseImportFileRow.resolve();

    await expect(imported).resolves.toMatchObject({ created: true, file: { fileId: 'file_claimedONCE', ownerId: 'owner' } });
    await expect(upload).rejects.toMatchObject({ code: 'FILEFN_FORBIDDEN' });
    expect(await rows(store, 'files')).toEqual([expect.objectContaining({ fileId: 'file_claimedONCE', ownerId: 'owner' })]);
    expect(await rows(store, 'fileVersions')).toEqual([expect.objectContaining({ storageKey: baseInput.storageKey })]);
  });

  it('keeps imports of one fileId into separate memory stores of one namespace behind each store\'s upload completion', async () => {
    const uploader = { principalId: 'uploader', tenantId: 'tenant' };
    async function storeWithHeldUpload(name: string) {
      const release = deferred();
      const held = deferred();
      let fileRows = 0;
      const database = createHookedDb(async (model) => {
        if (model === 'files' && ++fileRows === 1) {
          held.resolve();
          await release.promise;
        }
      });
      const { storage } = createStorage({ [`legacy/${name}.txt`]: 12 });
      const fileFn = build({ database, storage });
      const session = await fileFn.services.uploads.createSession(
        { policy: 'doc', fileName: `${name}.txt`, size: 5, mimeType: 'text/plain', fileId: 'file_claimedONCE' },
        uploader,
      );
      await fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, Buffer.from('hello'), 5, uploader, session.uploadSessionToken);
      const upload = fileFn.services.uploads.completeSession(session.uploadSessionId, uploader, session.uploadSessionToken);
      await held.promise;
      return { database, fileFn, upload, release: release.resolve };
    }
    // Each store's upload completion is held before its files insert: two groups of the key.
    const a = await storeWithHeldUpload('a');
    const b = await storeWithHeldUpload('b');
    const importA = a.fileFn.services.files.importObject({ ...baseInput, storageKey: 'legacy/a.txt', fileId: 'file_claimedONCE' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const importB = b.fileFn.services.files.importObject({ ...baseInput, storageKey: 'legacy/b.txt', fileId: 'file_claimedONCE' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    a.release();
    await a.upload;
    // Store B's upload completion is still before its files insert.
    await new Promise((resolve) => setTimeout(resolve, 20));
    b.release();
    await b.upload;

    for (const imported of [importA, importB]) {
      await expect(imported).rejects.toMatchObject({
        code: 'FILEFN_IMPORT_CONFLICT',
        details: expect.objectContaining({ reason: 'fileId' }),
      });
    }
    for (const { database } of [a, b]) {
      expect(await rows(database, 'files')).toEqual([expect.objectContaining({ fileId: 'file_claimedONCE', ownerId: 'uploader' })]);
      expect(await rows(database, 'fileVersions')).toEqual([expect.not.objectContaining({ storageKey: expect.stringMatching(/^legacy\//) })]);
    }
  });

  it('runs a spanning turn only after every group of its key, and queues later calls of any group behind it', async () => {
    const run = createKeyedSerializer({ waitTimeoutMs: 60_000 });
    const sameGroup = (group: string) => async (members: readonly string[]) => members.some((member) => member.startsWith(group));
    const order: string[] = [];
    const hold = (name: string, member: string) => {
      const release = deferred();
      const done = run('k', async () => {
        order.push(name);
        await release.promise;
      }, { member, sharesKeyWith: sameGroup(member[0]) });
      return { release: release.resolve, done };
    };
    const x1 = hold('x1', 'x1');
    const y1 = hold('y1', 'y1');
    await flushPromises();
    const spanning = (name: string) => run('k', async () => { order.push(name); }, { member: `import ${name}`, spansGroups: true, keepWaiting: true });
    const s1 = spanning('s1');
    const s2 = spanning('s2');
    // Probes group y only; must still queue behind both spanning turns.
    const y2 = run('k', async () => { order.push('y2'); }, { member: 'y2', sharesKeyWith: sameGroup('y') });
    await flushPromises();
    expect(order).toEqual(['x1', 'y1']);
    x1.release();
    await x1.done;
    await flushPromises();
    expect(order).toEqual(['x1', 'y1']);
    y1.release();
    await Promise.all([y1.done, s1, s2, y2]);
    expect(order).toEqual(['x1', 'y1', 's1', 's2', 'y2']);
    expect(run.activeKeys()).toBe(0);
  });

  it('keeps the usage of a version insert that wrote its row but lost its response', async () => {
    let loseResponse = true;
    const database = createUniqueDb(memoryAdapter(), {
      async afterCreate(model) {
        if (model === 'fileVersions' && loseResponse) {
          loseResponse = false;
          throw new Error('connection reset after commit');
        }
      },
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, net } = createQuota();
    const fileFn = build({ database, storage, quota });

    const imported = await fileFn.services.files.importObject(baseInput);
    expect(imported.created).toBe(true);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
    expect(net()).toBe(12);

    expect((await fileFn.services.files.importObject(baseInput)).created).toBe(false);
    expect(net()).toBe(12);
    await fileFn.services.files.deleteFile(imported.file.fileId, owner);
    expect(net()).toBe(0);
  });

  it('reports the insert error when taking back a race loser\'s usage fails, and its rerun records nothing', async () => {
    const bothFilesWritten = deferred();
    let filesWritten = 0;
    const database = createUniqueDb(memoryAdapter(), {
      async beforeCreate(model) {
        if (model === 'files' && ++filesWritten === 2) bothFilesWritten.resolve();
        if (model === 'fileVersions') await bothFilesWritten.promise;
      },
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, control, net } = createQuota();
    control.failNextTakeBack = true;
    const otherProcess = await loadIsolatedCreateFileFn();
    const inputA = { ...baseInput, fileId: 'file_importerAAAA' };
    const inputB = { ...baseInput, fileId: 'file_importerBBBB' };
    const processA = build({ database, storage, quota });
    const processB = build({ database, storage, quota, factory: otherProcess });

    const settled = await Promise.allSettled([
      processA.services.files.importObject(inputA),
      processB.services.files.importObject(inputB),
    ]);
    const loserIndex = settled.findIndex((result) => result.status === 'rejected');
    expect(loserIndex).toBeGreaterThanOrEqual(0);
    expect((settled[loserIndex] as PromiseRejectedResult).reason).toMatchObject({ code: '23505' });
    const winner = (settled[1 - loserIndex] as PromiseFulfilledResult<{ created: boolean; file: { fileId: string } }>).value;
    expect(winner.created).toBe(true);
    // The loser's record stands (documented over-count); nothing else changes it.
    const afterRace = net();
    expect(afterRace).toBe(24);

    const rerun = await [processA, processB][loserIndex].services.files.importObject([inputA, inputB][loserIndex]);
    expect(rerun).toMatchObject({ created: false, file: { fileId: winner.file.fileId } });
    expect(net()).toBe(afterRace);
    expect((await rows(database, 'files')).map((row) => row.fileId)).toEqual([winner.file.fileId]);
  });

  it('returns created for both same-fileId importers across processes when the loser\'s insert fails with a non-duplicate error (documented double count)', async () => {
    const bothAtVersion = barrier(2);
    const firstVersionWritten = deferred();
    let versionInserts = 0;
    const database = createUniqueDb(memoryAdapter(), {
      async beforeCreate(model) {
        if (model !== 'fileVersions') return;
        await bothAtVersion();
        if (++versionInserts === 2) {
          await firstVersionWritten.promise;
          throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        }
      },
      async afterCreate(model) {
        if (model === 'fileVersions') firstVersionWritten.resolve();
      },
    });
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, net } = createQuota();
    const otherProcess = await loadIsolatedCreateFileFn();
    const input = { ...baseInput, fileId: 'file_sharedIDXXXX' };

    const results = await Promise.all([
      build({ database, storage, quota }).services.files.importObject(input),
      build({ database, storage, quota, factory: otherProcess }).services.files.importObject(input),
    ]);
    expect(results.map((result) => [result.created, result.file.fileId])).toEqual([
      [true, 'file_sharedIDXXXX'],
      [true, 'file_sharedIDXXXX'],
    ]);
    expect(net()).toBe(24);
    expect(await rows(database, 'files')).toHaveLength(1);
    expect(await rows(database, 'fileVersions')).toHaveLength(1);
  });

  it('reports the insert error, not the quota error, when taking back a failed insert\'s usage fails', async () => {
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
    const { quota, control, net } = createQuota();
    control.failNextTakeBack = true;
    const fileFn = build({ database, storage, quota });

    await expect(fileFn.services.files.importObject(baseInput)).rejects.toThrow('connection reset');
    expect(net()).toBe(12);
    expect((await fileFn.services.files.importObject(baseInput)).created).toBe(true);
    // Nothing durable records the stranded 12 bytes, so the rerun counts them
    // again: the documented over-count, as after a stop before the insert.
    expect(net()).toBe(24);
  });

  it('records usage once when a rerun follows a failed usage record, and a delete balances it', async () => {
    const database = memoryAdapter();
    const { storage } = createStorage({ [baseInput.storageKey]: 12 });
    const { quota, control, net } = createQuota();
    const fileFn = build({ database, storage, quota });

    control.failNext = true;
    await expect(fileFn.services.files.importObject(baseInput)).rejects.toThrow('quota store unavailable');
    expect(await rows(database, 'fileVersions')).toHaveLength(0);
    expect(net()).toBe(0);

    const resumed = await fileFn.services.files.importObject(baseInput);
    expect(resumed.created).toBe(true);
    expect(net()).toBe(12);
    await fileFn.services.files.importObject(baseInput);
    expect(net()).toBe(12);

    await fileFn.services.files.deleteFile(resumed.file.fileId, owner);
    expect(net()).toBe(0);
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
