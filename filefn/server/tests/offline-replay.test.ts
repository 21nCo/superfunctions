import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAuthorizer, createFileFn } from '../src/index.js';
import { BODY_IDEMPOTENCY_KEY_DEPRECATED } from '../src/upload-sessions/routes.js';
// The real client sources and its queue test doubles, so the test covers what an app runs.
import { createFileFnClient } from '../../client/src/index.js';
import { MemoryDirectory, MemoryFile, SharedLockManager, createStorage } from '../../client/src/__tests__/helpers/offline-fixtures.js';

const BASE = 'https://filefn.test';
const roots: string[] = [];

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createApp() {
  const root = await mkdtemp(join(tmpdir(), 'filefn-offline-replay-'));
  roots.push(root);
  const database = memoryAdapter();
  const fileFn = createFileFn({
    database,
    storage: createLocalStorageAdapter({ rootDir: root }),
    authorizer: createDefaultAuthorizer({ db: database }),
    policies: [{ name: 'doc', contentTypes: ['text/plain'], maxSizeBytes: 1024, visibility: 'private' } as any],
    auth: {
      required: true,
      resolveSession: async (request) => {
        const user = request.headers.get('x-test-user');
        return user ? { principalId: user } : null;
      },
    },
  });
  const requests: Array<{ method: string; path: string; key: string | null }> = [];
  /** Called after the server handled a request; throw to lose its response. */
  let afterResponse: ((path: string) => void | Promise<void>) | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), BASE), init);
    request.headers.set('x-test-user', 'user-owner');
    const body = init?.body;
    if (body instanceof Blob && !request.headers.has('content-length')) request.headers.set('content-length', String(body.size));
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path, key: request.headers.get('x-idempotency-key') });
    const response = (await fileFn.router.handle(request)) ?? new Response('no route', { status: 404 });
    await afterResponse?.(path);
    return response;
  }) as typeof globalThis.fetch;
  const storage = createStorage();
  const locks = new SharedLockManager();
  const client = createFileFnClient({
    baseUrl: BASE,
    fetch,
    retryOptions: { maxRetries: 0 },
    offline: {
      enabled: true,
      partition: { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-owner' } },
      currentPrincipal: () => ({ kind: 'user', principalId: 'user-owner' }),
      getAuthHeaders: () => ({}),
      implicitReplay: false,
      queue: { coordinator: locks.forTab('tab-1'), getRoot: async () => storage.root },
    },
  });
  const queue = client.getOfflineQueue();
  const stage = async (fileId: string, idempotencyKey?: string) => {
    const result = await queue.stage({ policy: 'doc', file: new Blob(['hello'], { type: 'text/plain' }), fileName: 'a.txt', fileId, idempotencyKey });
    if (result.status !== 'staged') throw new Error('not staged');
  };
  const rows = async (model: string) => database.findMany<Record<string, any>>({ model });
  /** The journaled replay identity, read synchronously from the in-memory OPFS. */
  const journalKey = () => {
    const find = (dir: MemoryDirectory): MemoryFile | undefined => {
      for (const [name, entry] of dir.entries) {
        if (entry instanceof MemoryFile && name === 'journal.json') return entry;
        if (entry instanceof MemoryDirectory) {
          const found = find(entry);
          if (found) return found;
        }
      }
      return undefined;
    };
    const record = JSON.parse(new TextDecoder().decode(find(storage.root)!.content));
    return record.current.replay as { idempotencyKey: string; retiredKeys: string[] };
  };
  return {
    fileFn, database, client, queue, stage, rows, requests, journalKey, fetch,
    loseResponse(match: (path: string) => boolean) {
      afterResponse = (path) => {
        if (!match(path)) return;
        afterResponse = undefined;
        throw new TypeError('fetch failed');
      };
    },
    /** Runs `fn` once, after the first response whose path matches. */
    afterFirst(match: (path: string) => boolean, fn: () => Promise<void>) {
      afterResponse = async (path) => {
        if (!match(path)) return;
        afterResponse = undefined;
        await fn();
      };
    },
  };
}

describe('offline replay against the FileFn server', () => {
  it('reconciles a completed session from the same key to one stored file, without signing a part again', async () => {
    const app = await createApp();
    await app.stage('file_00000000replay01', 'test-replay-key-0001');
    app.loseResponse((path) => path.endsWith('/complete'));

    expect(await app.queue.process('file_00000000replay01')).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect(await app.queue.process('file_00000000replay01')).toMatchObject({
      status: 'published',
      entry: { upload: { fileId: 'file_00000000replay01' } },
    });

    const inits = app.requests.filter((r) => r.path === '/upload/init');
    // The caller's key prefixes the generation's own key, replayed unchanged.
    expect(inits[0].key).toMatch(/^test-replay-key-0001:op_/);
    expect(inits.map((r) => r.key)).toEqual([inits[0].key, inits[0].key]);
    expect(app.requests.filter((r) => r.path.endsWith('/sign'))).toHaveLength(1);
    // The reconciliation reads the recorded version back.
    const [version] = await app.rows('fileVersions');
    expect(app.requests.at(-1)).toMatchObject({ method: 'GET', path: `/file_00000000replay01/versions/${version.versionId}` });
    expect(await app.rows('files')).toHaveLength(1);
    expect(await app.rows('fileVersions')).toHaveLength(1);
    expect(await app.rows('uploadSessions')).toHaveLength(1);
  });

  it('never confirms a completed session whose file was deleted and recreated under the same ID since', async () => {
    const app = await createApp();
    await app.stage('file_00000000replay02', 'test-replay-key-0005');
    app.loseResponse((path) => path.endsWith('/complete'));
    expect(await app.queue.process('file_00000000replay02')).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect((await app.fetch(`${BASE}/file_00000000replay02`, { method: 'DELETE' })).status).toBe(200);
    await app.client
      .uploadFile({ policy: 'doc', file: new File(['other'], 'b.txt', { type: 'text/plain' }), fileId: 'file_00000000replay02' })
      .done();

    expect(await app.queue.process('file_00000000replay02')).toMatchObject({
      status: 'provisional',
      reason: 'ambiguous',
      entry: { state: 'provisional', pending: { stage: 'upload' } },
    });
    // One part signed for the lost upload, one for the recreated file; none for the replay.
    expect(app.requests.filter((r) => r.path.endsWith('/sign'))).toHaveLength(2);
  });

  it('accepts the key from the header and, for one more minor version, from the body', async () => {
    const app = await createApp();
    const init = (headers: Record<string, string>, body: Record<string, unknown>) =>
      app.fetch(`${BASE}/upload/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ policy: 'doc', fileName: 'a.txt', size: 5, mimeType: 'text/plain', fileId: 'file_00000000legacy01', ...body }),
      }).then(async (response) => ({ status: response.status, json: await response.json() }));

    const legacy = await init({}, { idempotencyKey: 'test-replay-key-0002' });
    expect(legacy.status).toBe(200);
    expect(legacy.json.warnings).toContain(BODY_IDEMPOTENCY_KEY_DEPRECATED);
    const header = await init({ 'x-idempotency-key': 'test-replay-key-0002' }, {});
    expect(header.json.data.uploadSessionId).toBe(legacy.json.data.uploadSessionId);
    expect(header.json.data).toMatchObject({ status: 'pending' });
    expect(header.json.warnings).not.toContain(BODY_IDEMPOTENCY_KEY_DEPRECATED);
    expect((await init({ 'x-idempotency-key': 'test-replay-key-0002' }, { idempotencyKey: 'test-replay-key-0003' })).status).toBe(400);
    expect(await app.rows('uploadSessions')).toHaveLength(1);
  });

  it.each(['expired', 'aborted'] as const)('starts a %s session again under a fresh key journaled before the request', async (ending) => {
    const app = await createApp();
    await app.stage('file_00000000ending01', 'test-replay-key-0004');
    const firstKey = app.journalKey().idempotencyKey;
    // A first attempt created the session under the key, then the page went away.
    const session = await app.fileFn.createUploadSession(
      { policy: 'doc', fileName: 'a.txt', size: 5, mimeType: 'text/plain', fileId: 'file_00000000ending01', idempotencyKey: firstKey },
      { principalId: 'user-owner' },
    );
    if (ending === 'aborted') {
      await app.fileFn.services.uploads.abortSession(session.uploadSessionId, { principalId: 'user-owner' });
    } else {
      await app.database.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
        data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      });
    }
    const journaledAtInit: string[] = [];
    const original = app.requests.push.bind(app.requests);
    app.requests.push = (...items) => {
      for (const item of items) if (item.path === '/upload/init') journaledAtInit.push(app.journalKey().idempotencyKey);
      return original(...items);
    };

    expect(await app.queue.process('file_00000000ending01')).toMatchObject({ status: 'published' });
    const keys = app.requests.filter((r) => r.path === '/upload/init').map((r) => r.key);
    expect(keys[0]).toBe(firstKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    // Each request sent the key the journal held when it went out.
    expect(journaledAtInit).toEqual(keys);
    expect(app.journalKey()).toMatchObject({ retiredKeys: [firstKey] });
    expect(await app.rows('files')).toHaveLength(1);
  });

  it.each([
    ['expires', '/sign', 'expire'],
    ['is aborted', '/sign', 'abort'],
    ['expires', '/parts/1', 'expire'],
  ] as const)('starts again under a fresh key when the session %s after the response to %s', async (_label, after, ending) => {
    const app = await createApp();
    await app.stage('file_00000000ending02', 'test-replay-key-0006');
    app.afterFirst((path) => path.endsWith(after), async () => {
      const [session] = await app.rows('uploadSessions');
      if (ending === 'abort') {
        await app.fileFn.services.uploads.abortSession(session.uploadSessionId, { principalId: 'user-owner' });
        return;
      }
      await app.database.update({
        model: 'uploadSessions',
        where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
        data: { expiresAt: new Date(Date.now() - 1000).toISOString() },
      });
    });

    // The refusal of a request after upload/init leaves the outcome unknown: same key.
    expect(await app.queue.process('file_00000000ending02')).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    // The replay's upload/init confirms the session ended: a fresh key, journaled first.
    expect(await app.queue.process('file_00000000ending02')).toMatchObject({ status: 'published' });
    const keys = app.requests.filter((r) => r.path === '/upload/init').map((r) => r.key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(app.journalKey()).toMatchObject({ retiredKeys: [keys[0]] });
    expect(await app.rows('files')).toHaveLength(1);
  });

  it('keeps a replay provisional when the completed session never recorded its own version', async () => {
    const app = await createApp();
    await app.stage('file_00000000legacy02', 'test-replay-key-0007');
    app.loseResponse((path) => path.endsWith('/complete'));
    expect(await app.queue.process('file_00000000legacy02')).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    // A session completed before completion versions were recorded; the file has a newer version since.
    const [session] = await app.rows('uploadSessions');
    await app.database.update({
      model: 'uploadSessions',
      where: [{ field: 'uploadSessionId', operator: 'eq', value: session.uploadSessionId }],
      data: { completionVersionId: null },
    });
    await app.client
      .uploadFile({ policy: 'doc', file: new File(['newer'], 'a.txt', { type: 'text/plain' }), fileId: 'file_00000000legacy02' })
      .done();

    expect(await app.queue.process('file_00000000legacy02')).toMatchObject({
      status: 'provisional',
      reason: 'ambiguous',
      entry: { state: 'provisional', pending: { stage: 'upload' } },
    });
    expect(app.requests.filter((r) => r.path.endsWith('/sign'))).toHaveLength(2);
    expect(app.requests.some((r) => r.method === 'GET')).toBe(false);
  });
});

describe('session outcomes a replay settles under the same key', () => {
  const owner = { principalId: 'user-owner' };

  /** A FileFn whose proxy part writes run `beforeClose` right before they commit. */
  async function createServer(beforeClose?: () => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'filefn-offline-outcome-'));
    roots.push(root);
    const database = memoryAdapter();
    const local = createLocalStorageAdapter({ rootDir: root });
    const storage = Object.assign(Object.create(local), {
      async openUploadStream(params: Parameters<NonNullable<typeof local.openUploadStream>>[0]) {
        const inner = (await local.openUploadStream!(params)).getWriter();
        return new WritableStream<Uint8Array>({
          write: (chunk) => inner.write(chunk),
          close: async () => {
            await beforeClose?.();
            await inner.close();
          },
        });
      },
    });
    // `gate`, when set, runs before each read of a session's recorded parts.
    const control: { gate?: () => Promise<void> } = {};
    const gated = Object.assign(Object.create(database), {
      async findMany(query: { model: string }) {
        if (query.model === 'uploadParts') await control.gate?.();
        return database.findMany(query as Parameters<typeof database.findMany>[0]);
      },
    }) as typeof database;
    const fileFn = createFileFn({ database: gated, storage, policies: [{ name: 'doc', maxSizeBytes: 1024 }] });
    return {
      fileFn,
      database,
      control,
      session: async (id: string) =>
        (await database.findMany<Record<string, any>>({ model: 'uploadSessions' })).find((row) => row.uploadSessionId === id)!,
      updateSession: (id: string, data: Record<string, unknown>) =>
        database.update({ model: 'uploadSessions', where: [{ field: 'uploadSessionId', operator: 'eq', value: id }], data }),
    };
  }

  function body(bytes: number): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
  }

  it('reports a session another request completed during a proxy part write as completed, not aborted', async () => {
    let completeNow: (() => Promise<void>) | undefined;
    const server = await createServer(async () => completeNow?.());
    const session = await server.fileFn.createUploadSession({ policy: 'doc', fileName: 'a.bin', size: 4, mimeType: 'application/octet-stream' }, owner);
    completeNow = async () => {
      await server.updateSession(session.uploadSessionId, { status: 'completed' });
    };
    await expect(server.fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body(4), 4, owner)).rejects.toMatchObject({
      code: 'FILEFN_UPLOAD_ALREADY_COMPLETED',
    });
  });

  it('waits for a live completion past the session expiry instead of reporting it expired', async () => {
    const server = await createServer();
    const session = await server.fileFn.createUploadSession({ policy: 'doc', fileName: 'a.bin', size: 4, mimeType: 'application/octet-stream' }, owner);
    await server.fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body(4), 4, owner);
    // Another request holds a fresh completion claim; the session expires meanwhile.
    await server.updateSession(session.uploadSessionId, {
      status: 'completing',
      completionClaim: `${new Date().toISOString()} test-claim-nonce`,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const completing = server.fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
    // The holder finishes and records its version.
    setTimeout(() => {
      void server.updateSession(session.uploadSessionId, {
        status: 'completed',
        fileId: 'file_00000000outcome1',
        completionVersionId: 'ver_test_0001',
      });
    }, 50);
    await expect(completing).resolves.toMatchObject({ fileId: 'file_00000000outcome1', versionId: 'ver_test_0001' });
  });

  const init = { policy: 'doc', fileName: 'a.bin', size: 4, mimeType: 'application/octet-stream', fileId: 'file_00000000outcome2' };

  it('reports a replayed session expired only after ending it, so a completion that passed its expiry check cannot publish', async () => {
    const server = await createServer();
    const key = 'test-replay-key-0101';
    const session = await server.fileFn.createUploadSession({ ...init, idempotencyKey: key }, owner);
    await server.fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body(4), 4, owner);
    // A completion passed its expiry check and is admitting the session when it expires.
    let admitting!: () => void;
    const reached = new Promise<void>((resolve) => (admitting = resolve));
    let resume!: () => void;
    server.control.gate = () => {
      server.control.gate = undefined;
      admitting();
      return new Promise<void>((resolve) => (resume = resolve));
    };
    const completing = server.fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
    completing.catch(() => {});
    await reached;
    await server.updateSession(session.uploadSessionId, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    const replay = await server.fileFn.createUploadSession({ ...init, idempotencyKey: key }, owner);
    expect(replay).toMatchObject({ uploadSessionId: session.uploadSessionId, status: 'expired' });
    expect((await server.session(session.uploadSessionId)).status).toBe('expired');

    resume();
    await expect(completing).rejects.toMatchObject({ code: 'FILEFN_UPLOAD_EXPIRED' });
    expect(await server.database.findMany({ model: 'fileVersions' })).toHaveLength(0);
  });

  it('finishes an expired session an earlier FileFn left partly published instead of reporting it ended', async () => {
    const server = await createServer();
    const key = 'test-replay-key-0102';
    const session = await server.fileFn.createUploadSession({ ...init, idempotencyKey: key }, owner);
    await server.fileFn.services.uploads.uploadPartBytes(session.uploadSessionId, 1, body(4), 4, owner);
    const stored = await server.fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner);
    // As an earlier FileFn left it: the file points at the version, the session never completed.
    await server.updateSession(session.uploadSessionId, {
      status: 'in_progress',
      completionPublication: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const replay = await server.fileFn.createUploadSession({ ...init, idempotencyKey: key }, owner);
    expect(replay.status).not.toBe('expired');
    expect((await server.session(session.uploadSessionId)).status).not.toBe('expired');
    await expect(server.fileFn.completeUploadSession({ uploadSessionId: session.uploadSessionId }, owner)).resolves.toMatchObject(stored);
    expect(await server.database.findMany({ model: 'fileVersions' })).toHaveLength(1);
  });
});
