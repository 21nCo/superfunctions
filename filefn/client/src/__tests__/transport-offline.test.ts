import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFnClient } from '../index.js';
import { MemoryDirectory, SharedLockManager, createStorage, replayScopeOf } from './helpers/offline-fixtures.js';

// OPFS contents persist across page reloads: one in-memory root and one lock
// manager are shared by every client created in a test.
let storage: ReturnType<typeof createStorage>;
let locks: SharedLockManager;
const PARTITION = { serviceId: 'svc-notes', principal: { kind: 'user', principalId: 'user-alice' } } as const;

function persistedText(): string {
  return storage.root.files().join('\n');
}

function journals(): string {
  const out: string[] = [];
  const walk = (dir: MemoryDirectory) => {
    for (const [name, entry] of dir.entries) {
      if (entry instanceof MemoryDirectory) walk(entry);
      else if (name === 'journal.json') out.push(new TextDecoder().decode(entry.content));
    }
  };
  walk(storage.root);
  return out.join('\n');
}

const BASE = 'https://files.example.com/api/files';

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function setOnline(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, writable: true, value });
}

describe('offline replay transport', () => {
  const globalFetch = vi.fn(async () => {
    throw new Error('global fetch must not be used when a fetch is injected');
  });

  beforeEach(() => {
    storage = createStorage();
    locks = new SharedLockManager();
    vi.stubGlobal('fetch', globalFetch);
    // Node 21+ has a global navigator; older supported runtimes do not, and a
    // real navigator's onLine is a getter, so give each test its own object.
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => storage.root } });
    setOnline(true);
    globalFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Replays never send ambient cookies, not even with the removed 0.5 preview
  // opt-in: a cookie acts for whoever signed in last, in any tab, not for the
  // partition.
  it.each([
    { legacyOptIn: false },
    { legacyOptIn: true },
  ] as const)('replays an upload staged before a reload through the new client fetch and bound headers, never with cookies (stale opt-in $legacyOptIn)', async ({ legacyOptIn }) => {
    const expected = 'omit';
    setOnline(false);
    const stagingFetch = vi.fn<typeof fetch>();
    const beforeReload = createFileFnClient({
      baseUrl: BASE,
      fetch: stagingFetch,
      credentials: 'include',
      getAuthHeaders: () => ({ 'x-csrf-token': 'csrf-before-reload' }),
      offline: {
        enabled: true,
        partition: PARTITION,
        currentPrincipal: () => PARTITION.principal,
        getAuthHeaders: () => ({ 'x-csrf-token': 'csrf-before-reload' }),
        queue: { coordinator: locks.forTab('before') },
      },
    });
    beforeReload.uploadFile({ policy: 'p', file: new Blob(['hello'], { type: 'text/plain' }), fileName: 'a.txt', fileId: 'file_00000001' });
    await vi.waitFor(() => expect(persistedText()).toContain('g1.bin'));
    expect(stagingFetch).not.toHaveBeenCalled();
    // Auth material is resolved at replay time and never written to OPFS.
    expect(journals()).not.toContain('csrf-before-reload');
    locks.closeTab('before');

    // Reload: a fresh client with a fresh CSRF token, now online.
    setOnline(true);
    const calls: Array<{ url: string; method: string; headers: Headers; credentials?: RequestCredentials; body?: BodyInit | null }> = [];
    const replayFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), credentials: init.credentials, body: init.body });
      if (url.endsWith('/upload/init')) {
        return envelope({ uploadSessionId: 'sess_1', uploadSessionToken: 'upls_1', uploadMode: 'proxy', chunkSizeBytes: 100, totalParts: 1, ...replayScopeOf(init) });
      }
      if (url.endsWith('/parts/1/sign')) {
        return envelope({ url: '/upload/sess_1/parts/1', headers: {}, expiresAt: 'x' });
      }
      if (url.endsWith('/parts/1')) return envelope({ etag: 'proxy-etag', recorded: true });
      if (url.endsWith('/upload/sess_1/complete')) return envelope({ fileId: 'file_00000001', versionId: 'ver_1' });
      return new Response('not found', { status: 404 });
    });
    const afterReload = createFileFnClient({
      baseUrl: BASE,
      fetch: replayFetch as unknown as typeof fetch,
      credentials: 'include',
      getAuthHeaders: () => ({ 'x-csrf-token': 'csrf-after-reload' }),
      offline: {
        enabled: true,
        partition: PARTITION,
        currentPrincipal: () => PARTITION.principal,
        // Replays send credentials issued for the partition's principal, resolved at replay time.
        getAuthHeaders: () => ({ 'x-csrf-token': 'csrf-after-reload' }),
        // An unknown key (the removed opt-in) changes nothing.
        ...(legacyOptIn ? ({ replayAmbientCredentials: true } as Record<string, unknown>) : {}),
        queue: { coordinator: locks.forTab('after') },
      },
    });

    // Touching offline state starts the client's sync loop, which replays the staged upload.
    await afterReload.getPendingLocalDescriptor('file_00000001');
    await vi.waitFor(async () => expect((await afterReload.getOfflineQueue().get('file_00000001'))?.state).toBe('published'));
    expect(persistedText()).not.toContain('.bin');

    expect(globalFetch).not.toHaveBeenCalled();
    expect(stagingFetch).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.url.slice(BASE.length)}`)).toEqual([
      'POST /upload/init',
      'POST /upload/sess_1/parts/1/sign',
      'PUT /upload/sess_1/parts/1',
      'POST /upload/sess_1/complete',
    ]);
    for (const call of calls) {
      expect(call.headers.get('x-csrf-token')).toBe('csrf-after-reload');
      expect(call.credentials).toBe(expected);
    }
    // The journaled replay key travels in the header, not the body.
    const init = calls[0];
    expect(init.headers.get('x-idempotency-key')).toMatch(/^idem_/);
    expect(journals()).toContain(init.headers.get('x-idempotency-key'));
    expect(JSON.parse(String(init.body))).not.toHaveProperty('idempotencyKey');
    // The replayed part carries the bytes staged before the reload.
    const partPut = calls.find((c) => c.method === 'PUT');
    expect(await new Response(partPut?.body).text()).toBe('hello');
  });
});

describe('completed-session replay settlement', () => {
  const FILE = 'file_00000000readback';

  beforeEach(() => {
    storage = createStorage();
    locks = new SharedLockManager();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => storage.root } });
    setOnline(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A server whose upload/init replays a session that already completed. */
  function completedServer(replay: Record<string, unknown>, onInit?: () => Promise<void>) {
    const paths: string[] = [];
    const keys: Array<string | null> = [];
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).slice(BASE.length);
      paths.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/upload/init') {
        keys.push(new Headers(init.headers).get('x-idempotency-key'));
        await onInit?.();
        return envelope({ uploadSessionId: 'sess_1', uploadMode: 'proxy', chunkSizeBytes: 1024, totalParts: 1, expiresAt: 'x', status: 'completed', fileId: FILE, versionId: 'ver_1', ...replayScopeOf(init), ...replay });
      }
      if (path === `/${FILE}/versions/ver_1`) {
        return replay.versionConfirmed === true
          ? new Response(JSON.stringify({ ok: false, error: { code: 'FILEFN_FORBIDDEN', message: 'forbidden' } }), { status: 403, headers: { 'content-type': 'application/json' } })
          : envelope({ fileId: FILE, versionId: 'ver_1' });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;
    return { fetch, paths, keys };
  }

  function client(fetch: typeof globalThis.fetch, tab: string) {
    return createFileFnClient({
      baseUrl: BASE,
      fetch,
      retryOptions: { maxRetries: 0 },
      offline: {
        enabled: true,
        partition: PARTITION,
        currentPrincipal: () => PARTITION.principal,
        getAuthHeaders: () => ({ authorization: 'Bearer test-token-alice' }),
        implicitReplay: false,
        queue: { coordinator: locks.forTab(tab) },
      },
    });
  }

  it('settles on the version the server confirmed for the session owner, without a file read a write-only uploader may lack', async () => {
    const server = completedServer({ versionConfirmed: true });
    const a = client(server.fetch, 'a');
    const queue = a.getOfflineQueue();
    await queue.stage({ policy: 'p', file: new Blob(['bytes']), fileId: FILE });
    expect(await queue.process(FILE)).toMatchObject({ status: 'published', entry: { upload: { fileId: FILE, versionId: 'ver_1' } } });
    // No read of the file (403 for this uploader) and no part signed.
    expect(server.paths).toEqual(['POST /upload/init']);
    a.dispose();
  });

  it('uses no attempt for a hold placed before the readback is sent, and resumes it under the same key on release without signing parts', async () => {
    let holdId: string | undefined;
    let generation = 0;
    const other = () => client(server.fetch, 'b').getOfflineQueue();
    let b: ReturnType<typeof other> | undefined;
    const server = completedServer({}, async () => {
      if (holdId) return;
      b = other();
      const held = await b.hold(FILE, generation);
      if (held.status !== 'held') throw new Error('hold refused');
      holdId = held.holdId;
    });
    const a = client(server.fetch, 'a');
    const queue = a.getOfflineQueue();
    const staged = await queue.stage({ policy: 'p', file: new Blob(['bytes']), fileId: FILE });
    if (staged.status !== 'staged') throw new Error('not staged');
    generation = staged.entry.generation;

    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'held', entry: { attempts: 0 } });
    // The readback was never sent while held.
    expect(server.paths).toEqual(['POST /upload/init']);

    expect(await b!.release(FILE, generation, holdId!)).toBe(true);
    expect(await queue.process(FILE)).toMatchObject({ status: 'published', entry: { upload: { versionId: 'ver_1' } } });
    expect(server.paths).toEqual(['POST /upload/init', 'POST /upload/init', `GET /${FILE}/versions/ver_1`]);
    expect(new Set(server.keys).size).toBe(1);
    a.dispose();
    b!.dispose();
  });
});
