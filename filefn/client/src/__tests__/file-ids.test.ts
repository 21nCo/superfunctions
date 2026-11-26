import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFnClient } from '../index.js';
import { createHttpClient } from '../client.js';
import { OPFSStore, type PendingUpload } from '../offline/opfs-store.js';
import { OfflineSync } from '../offline/sync.js';
import { UploadManager, isValidFileId } from '../upload-manager.js';
import { SharedLockManager } from './helpers/offline-fixtures.js';

// In-memory OPFS. One root per test, shared by every OPFSStore (and so by every
// client created in the test), which models OPFS surviving a page reload.
class MemoryDir {
  readonly entries = new Map<string, MemoryDir | MemoryFile>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDir> {
    let entry = this.entries.get(name);
    if (!entry && options?.create) {
      entry = new MemoryDir();
      this.entries.set(name, entry);
    }
    if (!(entry instanceof MemoryDir)) throw new DOMException(`${name} not found`, 'NotFoundError');
    return entry;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFile> {
    let entry = this.entries.get(name);
    if (!entry && options?.create) {
      entry = new MemoryFile();
      this.entries.set(name, entry);
    }
    if (!(entry instanceof MemoryFile)) throw new DOMException(`${name} not found`, 'NotFoundError');
    return entry;
  }

  async removeEntry(name: string): Promise<void> {
    this.entries.delete(name);
  }

  async *values() {
    for (const [name, entry] of this.entries) {
      yield { name, kind: entry instanceof MemoryDir ? 'directory' : 'file' };
    }
  }
}

class MemoryFile {
  content: ArrayBuffer | string = '';

  async createWritable() {
    return {
      write: async (data: ArrayBuffer | string) => {
        this.content = data;
      },
      close: async () => {},
    };
  }

  async getFile() {
    const content = this.content;
    return {
      arrayBuffer: async () => (typeof content === 'string' ? new TextEncoder().encode(content).buffer : content),
      text: async () => (typeof content === 'string' ? content : new TextDecoder().decode(content)),
    };
  }
}

const BASE = 'https://files.example.com/api/files';
const ROOT_DIR = 'filefn-pending-uploads';
const MALFORMED_IDS: unknown[] = [
  '',
  'f1',
  'file_short',
  'FILE_abcdefgh',
  'file_has space',
  'file_abc/defgh',
  `file_${'a'.repeat(65)}`,
  123,
];

let opfsRoot: MemoryDir;

function setOnline(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, writable: true, value });
}

function pendingDirs(): string[] {
  const dir = opfsRoot.entries.get(ROOT_DIR);
  return dir instanceof MemoryDir ? [...dir.entries.keys()] : [];
}

async function rawMetadata(uploadSessionId: string): Promise<Record<string, unknown>> {
  const dir = await (await opfsRoot.getDirectoryHandle(ROOT_DIR)).getDirectoryHandle(uploadSessionId);
  return JSON.parse(await (await (await dir.getFileHandle('metadata.json')).getFile()).text());
}

// Writes a record the way @filefn/client 0.2.0 did. `fileId: null` omits the key.
async function writeLegacyRecord(uploadSessionId: string, fileId: string | null, createdAt: string, retryCount = 0) {
  const root = await opfsRoot.getDirectoryHandle(ROOT_DIR, { create: true });
  const dir = await root.getDirectoryHandle(uploadSessionId, { create: true });
  const data = await dir.getFileHandle('data.bin', { create: true });
  await (await data.createWritable()).write(new TextEncoder().encode(`bytes of ${uploadSessionId}`).buffer);
  const metadata: Record<string, unknown> = {
    uploadSessionId,
    ...(fileId === null ? {} : { fileId }),
    policy: 'p',
    fileName: 'legacy.txt',
    size: 10,
    mimeType: 'text/plain',
    createdAt,
    retryCount,
  };
  const meta = await dir.getFileHandle('metadata.json', { create: true });
  await (await meta.createWritable()).write(JSON.stringify(metadata, null, 2));
}

function pendingUpload(overrides: Partial<PendingUpload>): PendingUpload {
  return {
    uploadSessionId: 'offline_1731000000000_abc123def',
    policy: 'p',
    fileName: 'a.txt',
    size: 5,
    mimeType: 'text/plain',
    fileData: new TextEncoder().encode('hello').buffer,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  };
}

// A server that accepts every upload and records the fileId each upload/init asked for.
function createServer() {
  const initFileIds: unknown[] = [];
  let sessions = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).slice(BASE.length);
    if (path === '/upload/init') {
      const body = JSON.parse(String(init.body));
      initFileIds.push(body.fileId);
      sessions += 1;
      return envelope({
        uploadSessionId: `sess_${sessions}`,
        uploadSessionToken: `upls_${sessions}`,
        uploadMode: 'proxy',
        chunkSizeBytes: 1024,
        totalParts: 1,
        fileId: body.fileId,
      });
    }
    const sign = /^\/upload\/(sess_\d+)\/parts\/1\/sign$/.exec(path);
    if (sign) return envelope({ url: `/upload/${sign[1]}/parts/1`, headers: {}, expiresAt: 'x' });
    if (/^\/upload\/sess_\d+\/parts\/1$/.test(path)) return envelope({ etag: 'etag', recorded: true });
    const complete = /^\/upload\/(sess_\d+)\/complete$/.exec(path);
    if (complete) {
      const index = Number(complete[1].slice('sess_'.length)) - 1;
      return envelope({ fileId: initFileIds[index], versionId: `ver_${index + 1}` });
    }
    return new Response('not found', { status: 404 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, initFileIds };
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const locks = new SharedLockManager();

/** Clients a test made: disposed after it, so none of them drives a later test's queue. */
const clients: Array<{ dispose(): void }> = [];

function offlineClient(fetch: typeof globalThis.fetch) {
  return track(createFileFnClient({
    baseUrl: BASE,
    fetch,
    offline: {
      enabled: true,
      partition: { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-alice' } },
      currentPrincipal: () => ({ kind: 'user', principalId: 'user-alice' }),
      getAuthHeaders: () => ({}),
      queue: { coordinator: locks.forTab('tab') },
    },
  }));
}

beforeEach(() => {
  opfsRoot = new MemoryDir();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfsRoot } });
  setOnline(true);
});

function track<T extends { dispose(): void }>(client: T): T {
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
});

describe('explicit file IDs', () => {
  it.each(MALFORMED_IDS)('uploadFile online throws FILEFN_INVALID_FILE_ID for %j before any request', (fileId) => {
    const server = createServer();
    const client = createFileFnClient({ baseUrl: BASE, fetch: server.fetch });

    expect(() =>
      client.uploadFile({ policy: 'p', file: new Blob(['hello']), fileId: fileId as string }),
    ).toThrow(expect.objectContaining({ code: 'FILEFN_INVALID_FILE_ID' }));
    expect(server.calls).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_IDS)('uploadFile offline throws FILEFN_INVALID_FILE_ID for %j and stages nothing', async (fileId) => {
    setOnline(false);
    const server = createServer();
    const client = offlineClient(server.fetch);

    expect(() =>
      client.uploadFile({ policy: 'p', file: new Blob(['hello']), fileId: fileId as string }),
    ).toThrow(expect.objectContaining({ code: 'FILEFN_INVALID_FILE_ID' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingDirs()).toEqual([]);
    expect(server.calls).not.toHaveBeenCalled();
  });

  it.each(MALFORMED_IDS)('stagePendingUpload rejects %j with FILEFN_INVALID_FILE_ID and leaves no directory', async (fileId) => {
    const store = new OPFSStore();

    await expect(store.stagePendingUpload(pendingUpload({ fileId: fileId as string }))).rejects.toMatchObject({
      code: 'FILEFN_INVALID_FILE_ID',
    });
    expect(pendingDirs()).toEqual([]);
  });

  it('keeps a valid explicit ID through offline staging, reload, local lookup and replay', async () => {
    setOnline(false);
    const fileId = 'file_Explicit-ID_0001';
    const staging = offlineClient(createServer().fetch);
    const handle = staging.uploadFile({ policy: 'p', file: new Blob(['hello'], { type: 'text/plain' }), fileId });
    expect(handle.fileId).toBe(fileId);
    await vi.waitFor(async () => expect(await staging.getOfflineQueue().list()).toMatchObject([{ entryId: fileId, fileId }]));
    staging.dispose();

    // Reload while still offline: a fresh client reads the same entry.
    const reloadedOffline = offlineClient(createServer().fetch);
    const [entry] = await reloadedOffline.getOfflineQueue().list();
    expect(await reloadedOffline.getPendingLocalDescriptor(fileId)).toMatchObject({ fileId, uploadSessionId: entry.operationId });
    reloadedOffline.dispose();

    // Back online, a fresh client replays the entry with the same ID.
    setOnline(true);
    const server = createServer();
    const online = offlineClient(server.fetch);
    await online.getPendingLocalDescriptor(fileId);
    await vi.waitFor(async () => expect((await online.getOfflineQueue().get(fileId))?.state).toBe('published'));
    expect(server.initFileIds).toEqual([fileId]);
  });

  it('keeps a valid explicit ID equal to its session ID, including after a metadata rewrite', async () => {
    const id = 'file_sessionAsFileId01';
    const store = new OPFSStore();
    await store.stagePendingUpload(pendingUpload({ uploadSessionId: id, fileId: id }));
    await store.incrementRetryCount(id);

    const reloaded = new OPFSStore();
    expect((await reloaded.getPendingUpload(id))?.fileId).toBe(id);
    expect((await reloaded.getPendingUploadByFileId(id))?.uploadSessionId).toBe(id);
    expect((await reloaded.getPendingLocalDescriptor(id))?.fileId).toBe(id);
  });

  it('gives a pending upload staged without an ID file_<uploadSessionId>', async () => {
    const store = new OPFSStore();
    await store.stagePendingUpload(pendingUpload({ uploadSessionId: 'offline_1731000000000_noid00001' }));

    expect((await store.getPendingUpload('offline_1731000000000_noid00001'))?.fileId).toBe(
      'file_offline_1731000000000_noid00001',
    );
  });
});

describe('legacy pending uploads from @filefn/client 0.2.0', () => {
  const withoutId = 'offline_1731000000000_k3j4h5g6f';
  const sameAsSession = 'offline_1731000000001_a1b2c3d4e';

  it('map a missing or session-equal fileId to one stable, distinct, grammar-valid ID on every read path and on replay', async () => {
    await writeLegacyRecord(withoutId, null, '2026-11-01T00:00:00.000Z');
    await writeLegacyRecord(sameAsSession, sameAsSession, '2026-11-01T00:00:01.000Z');
    const expected = {
      [withoutId]: `file_${withoutId}`,
      [sameAsSession]: `file_${sameAsSession}`,
    };
    expect(isValidFileId(expected[withoutId])).toBe(true);
    expect(isValidFileId(expected[sameAsSession])).toBe(true);
    expect(expected[withoutId]).not.toBe(expected[sameAsSession]);

    const store = new OPFSStore();
    for (const [uploadSessionId, fileId] of Object.entries(expected)) {
      expect((await store.getPendingUpload(uploadSessionId))?.fileId).toBe(fileId);
      expect((await store.getPendingUploadByFileId(fileId))?.uploadSessionId).toBe(uploadSessionId);
      expect(await store.getPendingLocalDescriptor(fileId)).toMatchObject({ fileId, uploadSessionId });
    }
    // The legacy session-ID form no longer names a pending upload.
    expect(await store.getPendingUploadByFileId(sameAsSession)).toBeNull();

    // A metadata rewrite (a failed replay counts a retry) keeps the mapped ID.
    await store.incrementRetryCount(sameAsSession);
    expect((await new OPFSStore().getPendingUpload(sameAsSession))?.fileId).toBe(expected[sameAsSession]);

    // A partitioned client never lists or replays these unscoped records on its own.
    const server = createServer();
    const client = offlineClient(server.fetch);
    expect(await client.getPendingLocalDescriptor(expected[withoutId])).toBeNull();
    await client.createOfflineSync().syncAll();
    expect(server.initFileIds).toEqual([]);
    expect(pendingDirs().sort()).toEqual([sameAsSession, withoutId].sort());

    // Migrated with ownership evidence, each replays with its mapped ID.
    const queue = client.getOfflineQueue();
    for (const uploadSessionId of Object.keys(expected)) {
      expect(await queue.migrateLegacyUpload(uploadSessionId, { ownershipVerified: true })).toMatchObject({ status: 'staged' });
    }
    expect(pendingDirs()).toEqual([]);
    // The client's implicit sync may drive one of them meanwhile.
    await queue.processAll();
    await vi.waitFor(() => expect([...server.initFileIds].sort()).toEqual(Object.values(expected).sort()));
  });

  it('report any other invalid stored fileId as FILEFN_INVALID_FILE_ID on sync and keep the record unchanged', async () => {
    const uploadSessionId = 'offline_1731000000002_badid0001';
    await writeLegacyRecord(uploadSessionId, 'not a file id', '2026-11-01T00:00:02.000Z');
    const server = createServer();
    const httpClient = createHttpClient({ baseUrl: BASE, fetch: server.fetch });
    const store = new OPFSStore();
    const sync = new OfflineSync({
      store,
      client: { uploadFile: (input) => new UploadManager(httpClient).startUpload(input) },
    });

    await expect(sync.syncOne(uploadSessionId)).rejects.toMatchObject({ code: 'FILEFN_INVALID_FILE_ID' });
    expect(server.calls).not.toHaveBeenCalled();
    expect(pendingDirs()).toEqual([uploadSessionId]);
    expect((await rawMetadata(uploadSessionId)).fileId).toBe('not a file id');
  });
});

describe('retry budget of migrated legacy pending uploads', () => {
  const MAX_RETRIES = 3;

  function failingSync(store: OPFSStore) {
    const uploadFile = vi.fn(async (_input: { fileId?: string }) => {
      throw new Error('server unavailable');
    });
    const sync = new OfflineSync({ store, client: { uploadFile } as never, maxRetries: MAX_RETRIES });
    return { sync, uploadFile };
  }

  it('replays exhausted missing-ID and session-equal records once with file_<uploadSessionId>', async () => {
    const withoutId = 'offline_1731000000003_exhaust01';
    const sameAsSession = 'offline_1731000000004_exhaust02';
    await writeLegacyRecord(withoutId, null, '2026-11-01T00:00:03.000Z', MAX_RETRIES);
    await writeLegacyRecord(sameAsSession, sameAsSession, '2026-11-01T00:00:04.000Z', MAX_RETRIES);
    const server = createServer();
    const httpClient = createHttpClient({ baseUrl: BASE, fetch: server.fetch });
    const store = new OPFSStore();
    expect((await store.getPendingUpload(withoutId))?.retryCount).toBe(0);
    const sync = new OfflineSync({
      store,
      client: { uploadFile: (input) => new UploadManager(httpClient).startUpload(input) },
      maxRetries: MAX_RETRIES,
    });

    await expect(sync.syncOne(withoutId)).resolves.toMatchObject({ fileId: `file_${withoutId}` });
    await expect(sync.syncOne(sameAsSession)).resolves.toMatchObject({ fileId: `file_${sameAsSession}` });
    expect(server.initFileIds).toEqual([`file_${withoutId}`, `file_${sameAsSession}`]);
    expect(pendingDirs()).toEqual([]);
  });

  it('does not replenish the budget after a failed migrated replay and a reload', async () => {
    const uploadSessionId = 'offline_1731000000005_exhaust03';
    await writeLegacyRecord(uploadSessionId, uploadSessionId, '2026-11-01T00:00:05.000Z', MAX_RETRIES);
    const first = failingSync(new OPFSStore());

    await expect(first.sync.syncOne(uploadSessionId)).rejects.toThrow('server unavailable');
    expect(first.uploadFile).toHaveBeenCalledTimes(1);
    expect(first.uploadFile.mock.calls[0][0].fileId).toBe(`file_${uploadSessionId}`);
    expect(await rawMetadata(uploadSessionId)).toMatchObject({
      fileId: `file_${uploadSessionId}`,
      metadataVersion: 2,
      retryCount: 1,
    });

    // A reload reads the persisted count, not a fresh budget.
    const reloaded = failingSync(new OPFSStore());
    expect((await new OPFSStore().getPendingUpload(uploadSessionId))?.retryCount).toBe(1);
    await expect(reloaded.sync.syncOne(uploadSessionId)).rejects.toThrow('server unavailable');
    await expect(reloaded.sync.syncOne(uploadSessionId)).rejects.toThrow('server unavailable');
    await expect(reloaded.sync.syncOne(uploadSessionId)).rejects.toThrow('Max retries exceeded');
    expect(reloaded.uploadFile).toHaveBeenCalledTimes(2);

    const afterReload = failingSync(new OPFSStore());
    await expect(afterReload.sync.syncOne(uploadSessionId)).rejects.toThrow('Max retries exceeded');
    expect(afterReload.uploadFile).not.toHaveBeenCalled();
    expect(pendingDirs()).toEqual([uploadSessionId]);
  });

  it('keeps the retry limit for current records and legacy records with their own file ID', async () => {
    const staged = 'offline_1731000000006_current01';
    const explicitSameAsSession = 'file_session_equal_0001';
    const legacyExplicit = 'offline_1731000000007_legacyid1';
    const store = new OPFSStore();
    await store.stagePendingUpload(pendingUpload({ uploadSessionId: staged, retryCount: MAX_RETRIES }));
    await store.stagePendingUpload(
      pendingUpload({ uploadSessionId: explicitSameAsSession, fileId: explicitSameAsSession, retryCount: MAX_RETRIES }),
    );
    await writeLegacyRecord(legacyExplicit, 'file_legacy_explicit_01', '2026-11-01T00:00:07.000Z', MAX_RETRIES);
    const { sync, uploadFile } = failingSync(new OPFSStore());

    for (const uploadSessionId of [staged, explicitSameAsSession, legacyExplicit]) {
      expect((await new OPFSStore().getPendingUpload(uploadSessionId))?.retryCount).toBe(MAX_RETRIES);
      await expect(sync.syncOne(uploadSessionId)).rejects.toThrow('Max retries exceeded');
    }
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
