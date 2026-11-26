import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFnClient } from '../index.js';
import type { FileFnClientConfig } from '../types.js';
import type { OfflineQueuePartition, OfflineQueuePrincipal } from '../offline/queue.js';
import { SharedLockManager, createStorage } from './helpers/offline-fixtures.js';

const BASE = 'https://files.example.com/api/files';
const ALICE: OfflineQueuePartition = { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-alice' } };

let storage: ReturnType<typeof createStorage>;
let locks: SharedLockManager;
let onlineListeners: Array<() => void>;
let server: ReturnType<typeof createServer>;

function setOnline(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, writable: true, value });
}

async function goOnline() {
  setOnline(true);
  for (const listener of [...onlineListeners]) listener();
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function failure(status: number, code: string, details?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message: code, details } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Accepts every upload; records each upload/init's file ID and idempotency
 * header, and each request path. `override` may answer a request instead.
 */
function createServer() {
  const inits: Array<{ fileId: string; key: string | null; bodyKey: unknown }> = [];
  const paths: string[] = [];
  // `ended`: keys whose session a replayed upload/init reports with that status.
  const state: { override?: (path: string) => Response | undefined; ended?: Map<string, 'expired' | 'aborted'> } = {};
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).slice(BASE.length);
    paths.push(path);
    const overridden = state.override?.(path);
    if (overridden) return overridden;
    if (path === '/upload/init') {
      const body = JSON.parse(String(init.body));
      const key = new Headers(init.headers).get('x-idempotency-key');
      inits.push({ fileId: body.fileId, key, bodyKey: body.idempotencyKey });
      const ended = key ? state.ended?.get(key) : undefined;
      return envelope({
        uploadSessionId: `sess_${inits.length}`,
        uploadMode: 'proxy',
        chunkSizeBytes: 1024,
        totalParts: 1,
        expiresAt: 'x',
        ...(ended ? { status: ended } : {}),
      });
    }
    const sign = /^\/upload\/(sess_\d+)\/parts\/1\/sign$/.exec(path);
    if (sign) return envelope({ url: `/upload/${sign[1]}/parts/1`, headers: {}, expiresAt: 'x' });
    if (/^\/upload\/sess_\d+\/parts\/1$/.test(path)) return envelope({ etag: 'etag', recorded: true });
    const complete = /^\/upload\/sess_(\d+)\/complete$/.exec(path);
    if (complete) return envelope({ fileId: inits[Number(complete[1]) - 1].fileId, versionId: `ver_${complete[1]}` });
    if (path.startsWith('/') && init.method === 'GET') {
      const [fileId, , versionId] = path.slice(1).split('/');
      return envelope({ fileId, versionId: versionId ?? 'ver_remote_1', state: 'ready', source: { mode: 'original', url: '/remote' } });
    }
    return new Response('not found', { status: 404 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls: fetch, inits, paths, state };
}

/** Credentials issued for exactly `principal`, as offline.getAuthHeaders must return. */
function boundHeaders(principal: OfflineQueuePrincipal): Record<string, string> | null {
  return principal.kind === 'user' ? { authorization: `Bearer test-token-${principal.principalId}` } : null;
}

/** Clients a test made: disposed after it, so none of them drives a later test's queue. */
const clients: Array<{ dispose(): void }> = [];

function offlineClient(offline: Partial<NonNullable<FileFnClientConfig['offline']>> = {}, tab = 'tab-1') {
  return track(createFileFnClient({
    baseUrl: BASE,
    fetch: server.fetch,
    offline: {
      enabled: true,
      partition: ALICE,
      currentPrincipal: () => (offline.partition ?? ALICE).principal,
      getAuthHeaders: boundHeaders,
      ...offline,
      queue: { coordinator: locks.forTab(tab), ...offline.queue },
    },
  }));
}

function dataFiles(): string[] {
  return storage.root.files().filter((path) => path.endsWith('.bin'));
}

beforeEach(() => {
  storage = createStorage();
  locks = new SharedLockManager();
  server = createServer();
  onlineListeners = [];
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => storage.root } });
  vi.stubGlobal('window', {
    addEventListener: (event: string, cb: () => void) => event === 'online' && onlineListeners.push(cb),
    removeEventListener: (event: string, cb: () => void) => {
      if (event === 'online') onlineListeners = onlineListeners.filter((l) => l !== cb);
    },
  });
  // Still a URL constructor, so the client can classify part URLs.
  vi.stubGlobal('URL', Object.assign(class extends URL {}, {
    createObjectURL: vi.fn((blob: Blob) => `blob:local-${blob.size}`),
    revokeObjectURL: vi.fn(),
  }));
  setOnline(false);
});

function track<T extends { dispose(): void }>(client: T): T {
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.unstubAllGlobals();
});

describe('offline uploads through the client', () => {
  it('TV-CLIENT-OFFLINE-001: stages offline into the partition and publishes once online, sending the key as a header', async () => {
    const client = offlineClient();
    const handle = client.uploadFile({ policy: 'p', file: new File(['content'], 'test.txt', { type: 'text/plain' }), idempotencyKey: 'test-idem-key-0001' });
    const done = handle.done();
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    expect(server.calls).not.toHaveBeenCalled();
    expect((await client.getOfflineQueue().list())[0]).toMatchObject({ entryId: handle.fileId, fileName: 'test.txt', state: 'provisional' });

    await goOnline();
    expect(await done).toEqual({ fileId: handle.fileId, versionId: 'ver_1' });
    // The caller's key prefixes the generation's own key, sent only as the header.
    expect(server.inits).toEqual([{ fileId: handle.fileId, key: expect.stringMatching(/^test-idem-key-0001:op_/), bodyKey: undefined }]);
    expect((await client.getOfflineQueue().list())[0]).toMatchObject({ state: 'published' });
    expect(dataFiles()).toEqual([]);
  });

  it('syncs right after staging when connectivity already returned', async () => {
    const client = offlineClient();
    const handle = client.uploadFile({ policy: 'p', file: new File(['content'], 'test.txt') });
    setOnline(true);
    expect(await handle.done()).toMatchObject({ fileId: handle.fileId });
  });

  it('TV-CLIENT-002: exposes a pending-local descriptor for a staged image', async () => {
    const client = offlineClient();
    const handle = client.uploadFile({ policy: 'p', file: new File(['image-bytes'], 'photo.jpg', { type: 'image/jpeg' }) });
    await vi.waitFor(async () => expect(await client.getPendingLocalDescriptor(handle.fileId)).not.toBeNull());
    const entry = (await client.getOfflineQueue().list())[0];

    expect(await client.getPendingLocalDescriptor(handle.fileId)).toEqual({
      fileId: handle.fileId,
      uploadSessionId: entry.operationId,
      state: 'pending-local',
      source: expect.objectContaining({ mode: 'local-object-url', kind: 'image', mimeType: 'image/jpeg', previewBehavior: 'direct-image', url: 'blob:local-11' }),
    });
  });

  it('TV-VIEW-002/003: prefers a pending-local PDF unless a version is requested', async () => {
    const client = offlineClient();
    const file = new File(['%PDF-1.4'], 'draft.pdf', { type: 'application/pdf' });
    const handle = client.uploadFile({ policy: 'p', file });
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));

    expect(await client.resolveRenderable({ fileId: handle.fileId, intent: 'preview', preferLocal: true })).toMatchObject({
      fileId: handle.fileId,
      state: 'pending-local',
      name: 'draft.pdf',
      size: file.size,
      source: { mode: 'placeholder', placeholderKind: 'pdf-processing' },
    });
    const remote = await client.resolveRenderable({ fileId: handle.fileId, versionId: 'ver_remote_1', intent: 'preview', preferLocal: true });
    expect(remote.versionId).toBe('ver_remote_1');
  });

  it('uses direct-pdf preview behavior when a preprocessor sets it', async () => {
    const client = offlineClient();
    const handle = client.uploadFile({
      policy: 'p',
      file: new File(['%PDF-1.4'], 'draft.pdf', { type: 'application/pdf' }),
      preprocessors: [{ name: 'pdf', matches: () => true, process: async (ctx) => ({ file: ctx.file, localSource: { previewBehavior: 'direct-pdf' } }) }],
    });
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    expect(await client.resolveRenderable({ fileId: handle.fileId, intent: 'preview', preferLocal: true })).toMatchObject({
      state: 'pending-local',
      source: { mode: 'original', url: 'blob:local-8' },
    });
  });

  it('TV-CLIENT-OFFLINE-003: aborting rejects done() and removes the staged entry', async () => {
    const client = offlineClient();
    const handle = client.uploadFile({ policy: 'p', file: new File(['content'], 'test.txt') });
    const done = handle.done();
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    handle.abort();
    await expect(done).rejects.toThrow('Aborted');
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toEqual([]));
    expect(dataFiles()).toEqual([]);
  });

  it('TV-CLIENT-OFFLINE-NEG-001: throws typed errors when offline staging cannot be bound, and refuses it where it cannot be durable', async () => {
    const file = new File(['content'], 'test.txt');
    expect(() => createFileFnClient({ baseUrl: BASE, offline: { enabled: true } }).uploadFile({ policy: 'p', file })).toThrow(
      expect.objectContaining({ code: 'FILEFN_OFFLINE_PARTITION_REQUIRED' }),
    );
    const guest = { serviceId: 'svc-notes', principal: { kind: 'guest', namespace: 'guest-ns-1' } } as const;
    expect(() =>
      createFileFnClient({ baseUrl: BASE, offline: { enabled: true, partition: guest, currentPrincipal: () => guest.principal } }).uploadFile({ policy: 'p', file }),
    ).toThrow(expect.objectContaining({ code: 'FILEFN_OFFLINE_GUEST_TRANSPORT_REQUIRED' }));

    // Without Web Locks the queue is still reachable for its capability result, and staging fails closed.
    // The built-in transport replays only with credentials bound to the partition's principal.
    expect(() =>
      createFileFnClient({ baseUrl: BASE, getAuthHeaders: () => ({}), offline: { enabled: true, partition: ALICE, currentPrincipal: () => ALICE.principal } })
        .uploadFile({ policy: 'p', file }),
    ).toThrow(expect.objectContaining({ code: 'FILEFN_OFFLINE_CREDENTIALS_REQUIRED' }));
    const unlocked = createFileFnClient({
      baseUrl: BASE,
      offline: { enabled: true, partition: ALICE, currentPrincipal: () => ALICE.principal, getAuthHeaders: boundHeaders },
    });
    expect(unlocked.getOfflineQueue().capabilities()).toMatchObject({ durable: false, reason: 'locks-unavailable' });
    await expect(unlocked.uploadFile({ policy: 'p', file }).done()).rejects.toMatchObject({
      code: 'FILEFN_QUEUE_REFUSED',
      details: { reason: 'locks-unavailable' },
    });
    vi.stubGlobal('navigator', { onLine: false });
    const noOpfs = offlineClient();
    expect(noOpfs.getOfflineQueue().capabilities()).toMatchObject({ durable: false, reason: 'storage-unavailable' });
    await expect(noOpfs.uploadFile({ policy: 'p', file }).done()).rejects.toMatchObject({ details: { reason: 'storage-unavailable' } });
    expect(() => noOpfs.uploadFile({ policy: 'p', file, idempotencyKey: ' padded ' })).toThrow(
      expect.objectContaining({ code: 'FILEFN_INVALID_IDEMPOTENCY_KEY' }),
    );
  });
});

describe('offline replay lifecycle', () => {
  it('with implicit replay off, only a started OfflineSync advances work, and a disposed one stops', async () => {
    const client = offlineClient({ implicitReplay: false });
    const first = client.uploadFile({ policy: 'p', file: new File(['one'], 'one.txt') });
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    await client.getPendingLocalDescriptor(first.fileId);
    await client.resolveRenderable({ fileId: first.fileId, intent: 'preview', preferLocal: true });
    await goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.inits).toEqual([]);

    const sync = client.createOfflineSync();
    sync.start();
    expect(await first.done()).toMatchObject({ fileId: first.fileId });
    expect(server.inits).toHaveLength(1);

    sync.dispose();
    setOnline(false);
    const second = client.uploadFile({ policy: 'p', file: new File(['two'], 'two.txt') });
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(2));
    await goOnline();
    expect(await sync.syncAll()).toEqual({ succeeded: [], failed: [], totalProcessed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.inits).toHaveLength(1);
    expect(() => sync.start()).toThrow('disposed');
    expect((await client.getOfflineQueue().get(second.fileId))?.state).toBe('provisional');
  });

  it('dispose on logout rejects pending done() and leaves the work to the next client of the same principal', async () => {
    const client = offlineClient();
    const handle = client.uploadFile({ policy: 'p', file: new File(['content'], 'test.txt') });
    const done = handle.done();
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    client.dispose();
    await expect(done).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    expect(() => client.getOfflineQueue()).toThrow(expect.objectContaining({ code: 'FILEFN_CLIENT_DISPOSED' }));
    expect(await client.getPendingLocalDescriptor(handle.fileId)).toBeNull();

    const bob = offlineClient({ partition: { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-bob' } } }, 'tab-1');
    expect(await bob.getPendingLocalDescriptor(handle.fileId)).toBeNull();
    expect(await bob.getOfflineQueue().list()).toEqual([]);

    setOnline(true);
    const returning = offlineClient({}, 'tab-1');
    expect(await returning.getOfflineQueue().list()).toMatchObject([{ entryId: handle.fileId }]);
    await returning.createOfflineSync().syncAll();
    expect((await returning.getOfflineQueue().get(handle.fileId))?.state).toBe('published');
    expect(server.inits).toHaveLength(1);
  });
  it('disposes every sync createOfflineSync made when the client is disposed', async () => {
    const onSyncError = vi.fn();
    const client = offlineClient({ implicitReplay: false });
    const sync = client.createOfflineSync({ onSyncError, retryDelayMs: 1 });
    sync.start();
    client.dispose();
    expect(sync.isDisposed).toBe(true);
    await goOnline();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSyncError).not.toHaveBeenCalled();
  });

  it('replays under the partition and transport captured when the queue was made, whatever the config says later', async () => {
    const asked: OfflineQueuePrincipal[] = [];
    const config = {
      baseUrl: BASE,
      fetch: server.fetch,
      offline: {
        enabled: true,
        partition: ALICE,
        implicitReplay: false,
        currentPrincipal: () => ALICE.principal,
        getAuthHeaders: (principal: OfflineQueuePrincipal) => {
          asked.push(principal);
          return boundHeaders(principal);
        },
        queue: { coordinator: locks.forTab('tab-1') },
      },
    } satisfies FileFnClientConfig;
    const client = track(createFileFnClient(config));
    const handle = client.uploadFile({ policy: 'p', file: new File(['content'], 'test.txt') });
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    // The app reuses its config object for another account and another server.
    (config.offline as { partition: OfflineQueuePartition }).partition = { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-bob' } };
    (config as { baseUrl: string }).baseUrl = 'https://other.example.com';
    setOnline(true);
    expect(await client.getOfflineQueue().process(handle.fileId)).toMatchObject({ status: 'published' });
    expect(new Set(asked.map((principal) => (principal.kind === 'user' ? principal.principalId : '')))).toEqual(new Set(['user-alice']));
    expect(server.inits).toHaveLength(1);
  });
});

describe('replay transport', () => {
  const BOB_PRINCIPAL: OfflineQueuePrincipal = { kind: 'user', principalId: 'user-bob' };

  async function stagedOffline(client: ReturnType<typeof offlineClient>) {
    const handle = client.uploadFile({ policy: 'p', file: new File(['content'], 'test.txt') });
    await vi.waitFor(async () => expect(await client.getOfflineQueue().list()).toHaveLength(1));
    setOnline(true);
    return handle;
  }

  it('sends no further request once the shared session switches accounts mid-upload, and resumes under the same key', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const client = offlineClient({ implicitReplay: false, currentPrincipal: () => signedIn });
    const handle = await stagedOffline(client);
    // Another tab sharing the cookies signs in as Bob while init is in flight.
    server.state.override = (path) => {
      if (path === '/upload/init') signedIn = BOB_PRINCIPAL;
      return undefined;
    };
    expect(await client.getOfflineQueue().process(handle.fileId)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    expect(server.paths).toEqual(['/upload/init']);
    // Local reads and writes are refused while Bob is signed in.
    await expect(client.getOfflineQueue().list()).rejects.toMatchObject({ code: 'FILEFN_QUEUE_PRINCIPAL_MISMATCH' });
    expect(await client.getPendingLocalDescriptor(handle.fileId)).toBeNull();

    server.state.override = undefined;
    signedIn = ALICE.principal;
    expect(await client.getOfflineQueue().process(handle.fileId)).toMatchObject({ status: 'published' });
    expect(server.inits.map((i) => i.key)).toEqual([server.inits[0].key, server.inits[0].key]);
  });

  it('sends only credentials bound to the partition, even when the account switches away and back while headers resolve', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const client = createFileFnClient({
      baseUrl: BASE,
      fetch: server.fetch,
      // The shared session flips to Bob and back while its token is read.
      getAuthHeaders: () => {
        signedIn = BOB_PRINCIPAL;
        const headers = { authorization: 'Bearer test-token-bob' };
        signedIn = ALICE.principal;
        return headers;
      },
      offline: {
        enabled: true,
        partition: ALICE,
        implicitReplay: false,
        currentPrincipal: () => signedIn,
        getAuthHeaders: (principal) => (principal.kind === 'user' ? { authorization: `Bearer test-token-${principal.principalId}` } : null),
        queue: { coordinator: locks.forTab('tab-1') },
      },
    });
    const handle = await stagedOffline(client as ReturnType<typeof offlineClient>);
    expect(await client.getOfflineQueue().process(handle.fileId)).toMatchObject({ status: 'published' });
    const sent = server.calls.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent)).toEqual(new Set(['Bearer test-token-user-alice']));
  });

  it('checks the principal before an automatic retry of a request', async () => {
    let signedIn: OfflineQueuePrincipal = ALICE.principal;
    const client = createFileFnClient({
      baseUrl: BASE,
      fetch: server.fetch,
      retryOptions: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      offline: {
        enabled: true,
        partition: ALICE,
        implicitReplay: false,
        currentPrincipal: () => signedIn,
        getAuthHeaders: boundHeaders,
        queue: { coordinator: locks.forTab('tab-1') },
      },
    });
    const handle = await stagedOffline(client as ReturnType<typeof offlineClient>);
    server.state.override = (path) => {
      if (path !== '/upload/init') return undefined;
      signedIn = BOB_PRINCIPAL;
      return failure(503, 'FILEFN_UNAVAILABLE');
    };
    expect(await client.getOfflineQueue().process(handle.fileId)).toEqual({ status: 'stopped', reason: 'principal-mismatch' });
    expect(server.paths).toEqual(['/upload/init']);
  });

  it.each([
    ['a retryable 409 from the proxy part route', '/parts/1', failure(409, 'FILEFN_UPLOAD_COMPLETION_IN_PROGRESS', { retryable: true }), 'same'],
    ['a 410 expiry from part signing', '/parts/1/sign', failure(410, 'FILEFN_UPLOAD_EXPIRED'), 'fresh'],
    ['a 410 abort from the proxy part route', '/parts/1', failure(410, 'FILEFN_UPLOAD_ABORTED'), 'fresh'],
    ['a 410 expiry from completion', '/complete', failure(410, 'FILEFN_UPLOAD_EXPIRED'), 'fresh'],
    ['a 403 from completion', '/complete', failure(403, 'FILEFN_FORBIDDEN'), 'same'],
    ['a status-only 423', '/complete', new Response('locked', { status: 423 }), 'same'],
    ['a completion that names no file', '/complete', envelope({ versionId: 'ver_x' }), 'same'],
  ] as const)('keeps the generation recoverable after %s', async (_label, suffix, response, key) => {
    const client = offlineClient({ implicitReplay: false });
    const handle = await stagedOffline(client);
    let failed = false;
    server.state.override = (path) => {
      if (failed || !path.endsWith(suffix) || (suffix === '/parts/1' && path.endsWith('/sign'))) return undefined;
      failed = true;
      return response.clone();
    };
    const queue = client.getOfflineQueue();
    // A request other than upload/init cannot tell an ended session from one a
    // live completion still finishes: the outcome stays unknown, same key.
    expect(await queue.process(handle.fileId)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    if (key === 'same') {
      expect(await queue.process(handle.fileId)).toMatchObject({ status: 'published' });
      expect(server.inits).toHaveLength(2);
      expect(server.inits[1].key).toBe(server.inits[0].key);
    } else {
      // The replay's upload/init confirms the session ended: a fresh key is journaled and used at once.
      server.state.ended = new Map([[server.inits[0].key!, (response.status === 410 && suffix === '/parts/1' ? 'aborted' : 'expired')]]);
      expect(await queue.process(handle.fileId)).toMatchObject({ status: 'published' });
      expect(server.inits).toHaveLength(3);
      expect(server.inits[1].key).toBe(server.inits[0].key);
      expect(server.inits[2].key).not.toBe(server.inits[0].key);
    }
  });

  it('rejects an outstanding done() at once when aborted during publication, and keeps the publication journaled', async () => {
    const publication = new Promise<never>(() => {});
    const client = offlineClient({ queue: { hooks: { publish: { run: () => publication } } } });
    const handle = await stagedOffline(client);
    const done = handle.done();
    // Never settles: the publication hangs until the client is disposed after the test.
    client.getOfflineQueue().processAll().catch(() => {});
    await vi.waitFor(async () => expect((await client.getOfflineQueue().list())[0]).toMatchObject({ phase: 'publishing' }));
    handle.abort();
    await expect(done).rejects.toThrow('Aborted');
    expect((await client.getOfflineQueue().list())[0]).toMatchObject({ phase: 'publishing', state: 'provisional' });
  });
});

describe('local previews of a file staged by several entries', () => {
  it('previews the highest generation through the client and resolveRenderable, not the entry touched last', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-26T10:00:00.000Z'));
      const client = offlineClient({ implicitReplay: false });
      const queue = client.getOfflineQueue();
      const fileId = 'file_00000000preview1';
      const older = await queue.stage({ policy: 'p', file: new File(['old'], 'old.png', { type: 'image/png' }), fileId, entryId: 'older' });
      await queue.stage({ policy: 'p', file: new File(['newer!'], 'new.png', { type: 'image/png' }), fileId, entryId: 'newer' });
      if (older.status !== 'staged') throw new Error('not staged');
      vi.setSystemTime(new Date('2026-11-26T10:05:00.000Z'));
      // Touches only the older entry's journal.
      expect(await queue.hold('older', older.entry.generation)).toMatchObject({ status: 'held' });

      expect(await client.getPendingLocalDescriptor(fileId)).toMatchObject({ source: { url: 'blob:local-6' } });
      expect(await client.resolveRenderable({ fileId, intent: 'preview', preferLocal: true })).toMatchObject({
        state: 'pending-local',
        name: 'new.png',
        size: 6,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
