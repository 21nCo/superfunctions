import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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

describe('replay settlement boundaries', () => {
  const FILE = 'file_00000000boundary';
  // Its own partition (and work channel): clients of earlier tests never drive these entries.
  const OWN = { serviceId: 'svc-boundaries', principal: { kind: 'user', principalId: 'user-alice' } } as const;

  beforeEach(() => {
    storage = createStorage();
    locks = new SharedLockManager();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => storage.root } });
    setOnline(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The scope @filefn/server computes for an authenticated caller. */
  function scopeOf(principalId: string, tenantId: string | null = null): string {
    return `rs_${createHash('sha256').update(JSON.stringify(['filefn-replay-scope', principalId, tenantId])).digest('hex')}`;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  type Route = (path: string, init: RequestInit, call: number) => Response | Promise<Response> | undefined;

  /** A scripted FileFn: `route` answers first; otherwise a proxy upload that completes as ver_1. */
  function server(route: Route = () => undefined) {
    const paths: string[] = [];
    const scopes: Array<string | null> = [];
    const keys: Array<string | null> = [];
    const counts = new Map<string, number>();
    const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input).slice(BASE.length);
      const call = (counts.get(path) ?? 0) + 1;
      counts.set(path, call);
      paths.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/upload/init') {
        scopes.push(new Headers(init.headers).get('x-filefn-replay-scope'));
        keys.push(new Headers(init.headers).get('x-idempotency-key'));
      }
      const scripted = await route(path, init, call);
      if (scripted) return scripted;
      if (path === '/upload/init') {
        return envelope({ uploadSessionId: 'sess_1', uploadSessionToken: 'upls_1', uploadMode: 'proxy', chunkSizeBytes: 100, totalParts: 1, ...replayScopeOf(init) });
      }
      if (path === '/upload/sess_1/parts/1/sign') return envelope({ url: '/upload/sess_1/parts/1', headers: {}, expiresAt: 'x' });
      if (path === '/upload/sess_1/parts/1') return envelope({ etag: 'proxy-etag', recorded: true });
      if (path === '/upload/sess_1/complete') return envelope({ fileId: FILE, versionId: 'ver_1' });
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;
    return { fetch, paths, scopes, keys };
  }

  function client(fetch: typeof globalThis.fetch, offline: Record<string, unknown> = {}) {
    return createFileFnClient({
      baseUrl: BASE,
      fetch,
      retryOptions: { maxRetries: 0 },
      offline: {
        enabled: true,
        partition: OWN,
        currentPrincipal: () => OWN.principal,
        getAuthHeaders: () => ({ authorization: 'Bearer test-token-alice' }),
        implicitReplay: false,
        queue: { coordinator: locks.forTab('a') },
        ...offline,
      },
    });
  }

  async function stageOne(queue: ReturnType<ReturnType<typeof createFileFnClient>['getOfflineQueue']>) {
    const staged = await queue.stage({ policy: 'p', file: new Blob(['bytes']), fileId: FILE });
    if (staged.status !== 'staged') throw new Error('not staged');
    return staged;
  }

  it('pins the first upload/init to the partition account, so credentials of another account create nothing', async () => {
    let otherAccount = true;
    const s = server((path, init) =>
      path === '/upload/init' && otherAccount
        ? json({ ok: false, error: { code: 'FILEFN_REPLAY_SCOPE_MISMATCH', message: 'another account' } }, 409)
        : undefined,
    );
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect(s.scopes).toEqual([scopeOf('user-alice')]);
    // Journaled with the replay identity before the first init was sent.
    expect(journals()).toContain(`"scope":"${scopeOf('user-alice')}"`);
    otherAccount = false;
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(s.scopes).toEqual([scopeOf('user-alice'), scopeOf('user-alice')]);
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  it('pins to the server account replayAccount names, and sends nothing when it names none', async () => {
    const s = server();
    let account: { principalId: string; tenantId?: string } | null = null;
    const c = client(s.fetch, { replayAccount: () => account });
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).not.toMatchObject({ status: 'published' });
    expect(s.paths).toEqual([]);
    account = { principalId: 'server-user-7', tenantId: 'tenant-a' };
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(s.scopes).toEqual([scopeOf('server-user-7', 'tenant-a')]);
    c.dispose();
  });

  it('keeps the key of a session an explicit failure envelope reports as expired', async () => {
    const s = server((path, init, call) => {
      if (path !== '/upload/init') return undefined;
      if (call === 1) return json({ ok: false, data: { uploadSessionId: 'sess_1', status: 'expired', ...replayScopeOf(init) } });
      return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) });
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect(await queue.process(FILE)).toMatchObject({ status: 'published', entry: { upload: { versionId: 'ver_1' } } });
    expect(s.keys).toHaveLength(2);
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  it.each([
    ['completion', (path: string) => (path === '/upload/sess_1/complete' ? json({ ok: false, fileId: FILE, versionId: 'ver_1' }) : undefined)],
    [
      'a completed init',
      (path: string, init: RequestInit) =>
        path === '/upload/init'
          ? json({ ok: false, data: { uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) } })
          : undefined,
    ],
    [
      'the version readback',
      (path: string, init: RequestInit) => {
        if (path === '/upload/init') return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', ...replayScopeOf(init) });
        if (path === `/${FILE}/versions/ver_1`) return json({ ok: false, fileId: FILE, versionId: 'ver_1', error: { code: 'FILEFN_INTERNAL' } });
        return undefined;
      },
    ],
  ] as const)('confirms no stored version from an explicit failure envelope at %s', async (_label, route) => {
    const s = server(route as Route);
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect((await queue.get(FILE))?.upload).toBeUndefined();
    expect(persistedText()).toContain('.bin');
    c.dispose();
  });

  it.each([
    ['an inner ok: false', { ok: false }],
    ['an inner error', { error: { code: 'FILEFN_INTERNAL', message: 'test failure' } }],
  ] as const)('keeps the key of an expired or aborted session reported inside a success envelope with %s', async (_label, marker) => {
    for (const status of ['expired', 'aborted'] as const) {
      storage = createStorage();
      const s = server((path, init, call) => {
        if (path !== '/upload/init') return undefined;
        if (call === 1) return envelope({ ...marker, uploadSessionId: 'sess_1', status, ...replayScopeOf(init) });
        return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) });
      });
      const c = client(s.fetch);
      const queue = c.getOfflineQueue();
      await stageOne(queue);
      expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
      expect(persistedText()).toContain('.bin');
      expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
      // One key for both answers: the first was never taken as a confirmed end.
      expect(s.keys).toHaveLength(2);
      expect(new Set(s.keys).size).toBe(1);
      c.dispose();
    }
  });

  it.each(
    (
      [
        ['an inner ok: false', { ok: false }],
        ['an inner error', { error: { code: 'FILEFN_INTERNAL', message: 'test failure' } }],
      ] as const
    ).flatMap(([label, marker]) => [
      [`completion with ${label}`, (path: string) => (path === '/upload/sess_1/complete' ? envelope({ ...marker, fileId: FILE, versionId: 'ver_1' }) : undefined)],
      [
        `a completed init with ${label}`,
        (path: string, init: RequestInit) =>
          path === '/upload/init'
            ? envelope({ ...marker, uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) })
            : undefined,
      ],
      [
        `the version readback with ${label}`,
        (path: string, init: RequestInit) => {
          if (path === '/upload/init') return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', ...replayScopeOf(init) });
          if (path === `/${FILE}/versions/ver_1`) return envelope({ ...marker, fileId: FILE, versionId: 'ver_1' });
          return undefined;
        },
      ],
    ]),
  )('confirms no stored version from a success envelope whose payload carries a failure marker: %s', async (_label, route) => {
    const s = server(route as Route);
    const verify = vi.fn(async () => ({ verified: true as const }));
    const c = client(s.fetch, { queue: { coordinator: locks.forTab('a'), hooks: { verify } } });
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect((await queue.get(FILE))?.upload).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    expect(persistedText()).toContain('.bin');
    c.dispose();
  });

  it.each([
    ['expired with completionStarted', { status: 'expired', completionStarted: true }],
    ['expired with versionConfirmed', { status: 'expired', versionConfirmed: true }],
    ['aborted naming a stored file and version', { status: 'aborted', fileId: FILE, versionId: 'ver_1' }],
    ['expired with every completion marker', { status: 'expired', completionStarted: true, versionConfirmed: true, fileId: FILE, versionId: 'ver_1' }],
  ] as const)('keeps the key of a self-contradicting ended init: %s', async (_label, body) => {
    const s = server((path, init, call) => {
      if (path !== '/upload/init') return undefined;
      if (call === 1) return envelope({ uploadSessionId: 'sess_1', ...body, ...replayScopeOf(init) });
      return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) });
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect(persistedText()).toContain('.bin');
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(s.keys).toHaveLength(2);
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  it('keeps the key when a refusal merely names FILEFN_UPLOAD_SESSION_ENDED', async () => {
    const s = server((path, init, call) => {
      if (path !== '/upload/init') return undefined;
      if (call === 1) return json({ ok: false, error: { code: 'FILEFN_UPLOAD_SESSION_ENDED', message: 'test refusal' } }, 410);
      return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) });
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(s.keys).toHaveLength(2);
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  it.each([
    ['completion', (path: string) => (path === '/upload/sess_1/complete' ? envelope({ fileId: FILE, versionId: 'ver_1', status: 'aborted' }) : undefined)],
    [
      'the version readback',
      (path: string, init: RequestInit) => {
        if (path === '/upload/init') return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', ...replayScopeOf(init) });
        if (path === `/${FILE}/versions/ver_1`) return envelope({ fileId: FILE, versionId: 'ver_1', status: 'aborted' });
        return undefined;
      },
    ],
    [
      'a completed init with completionStarted',
      (path: string, init: RequestInit) =>
        path === '/upload/init'
          ? envelope({ uploadSessionId: 'sess_1', status: 'completed', completionStarted: true, fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) })
          : undefined,
    ],
  ] as const)('confirms no stored version from a self-contradicting answer at %s', async (_label, route) => {
    const s = server(route as Route);
    const verify = vi.fn(async () => ({ verified: true as const }));
    const c = client(s.fetch, { queue: { coordinator: locks.forTab('a'), hooks: { verify } } });
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect((await queue.get(FILE))?.upload).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    expect(persistedText()).toContain('.bin');
    c.dispose();
  });

  it('lets go of the entry when disposed while replayAccount never settles, so a new instance processes it', async () => {
    const s = server();
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const stuck = client(s.fetch, {
      replayAccount: () => {
        asked();
        return new Promise<never>(() => {});
      },
    });
    const queue = stuck.getOfflineQueue();
    await stageOne(queue);
    const pass = queue.process(FILE);
    void pass.catch(() => {});
    await reached;
    stuck.dispose();
    await expect(pass).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    // Same tab, same principal: the entry lock is free again.
    const next = client(s.fetch);
    expect(await next.getOfflineQueue().process(FILE)).toMatchObject({ status: 'published' });
    expect(s.keys).toHaveLength(1);
    next.dispose();
  });

  it('lets go of the entry when disposed while getAuthHeaders never settles, so a new instance processes it', async () => {
    const s = server();
    let asked!: () => void;
    const reached = new Promise<void>((resolve) => (asked = resolve));
    const stuck = client(s.fetch, {
      getAuthHeaders: () => {
        asked();
        return new Promise<never>(() => {});
      },
    });
    const queue = stuck.getOfflineQueue();
    await stageOne(queue);
    const pass = queue.process(FILE);
    void pass.catch(() => {});
    await reached;
    stuck.dispose();
    await expect(pass).rejects.toMatchObject({ code: 'FILEFN_QUEUE_DISPOSED' });
    expect(s.paths).toEqual([]);
    // Same tab, same principal: the entry lock is free again.
    const next = client(s.fetch);
    expect(await next.getOfflineQueue().process(FILE)).toMatchObject({ status: 'published' });
    expect(s.keys).toHaveLength(1);
    next.dispose();
  });

  it('keeps a coded 404 from a same-origin signed storage URL provisional, and reconciles it under the same key', async () => {
    const s = server((path, init, call) => {
      if (path === '/upload/sess_1/parts/1/sign') return envelope({ url: `${BASE}/storage-bucket/object-1`, headers: {}, expiresAt: 'x' });
      if (path === '/storage-bucket/object-1') return json({ ok: false, error: { code: 'FILEFN_NOT_FOUND', message: 'gone' } }, 404);
      if (path === '/upload/init' && call === 2) {
        return envelope({ uploadSessionId: 'sess_1', status: 'completed', fileId: FILE, versionId: 'ver_1', versionConfirmed: true, ...replayScopeOf(init) });
      }
      return undefined;
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  // Architecture reset (A): one decoder decides what a FileFn answer proves.
  const completed = (init: RequestInit, extra: Record<string, unknown> = {}) => ({
    uploadSessionId: 'sess_1',
    status: 'completed',
    fileId: FILE,
    versionId: 'ver_1',
    versionConfirmed: true,
    ...replayScopeOf(init),
    ...extra,
  });

  it.each([
    ['an outer error with ok: true', (init: RequestInit) => json({ ok: true, error: { code: 'FILEFN_INTERNAL', message: 'x' }, data: { uploadSessionId: 'sess_1', status: 'expired', ...replayScopeOf(init) } })],
    ['ok: false', (init: RequestInit) => json({ ok: false, data: { uploadSessionId: 'sess_1', status: 'aborted', ...replayScopeOf(init) } })],
    ['no session ID', (init: RequestInit) => envelope({ status: 'expired', ...replayScopeOf(init) })],
    ['a numeric session ID', (init: RequestInit) => envelope({ uploadSessionId: 12, status: 'expired', ...replayScopeOf(init) })],
    ['a dot-segment session ID', (init: RequestInit) => envelope({ uploadSessionId: '..', status: 'aborted', ...replayScopeOf(init) })],
  ] as const)('keeps the key of a session reported ended by an init answer with %s', async (_label, answer) => {
    const s = server((path, init, call) => {
      if (path !== '/upload/init') return undefined;
      return call === 1 ? answer(init) : envelope(completed(init));
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    expect(await queue.process(FILE)).toMatchObject({ status: 'published', entry: { upload: { versionId: 'ver_1' } } });
    expect(s.keys).toHaveLength(2);
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  it('retires the key of a session a well-formed init answer reports expired, and journals a fresh one before sending it', async () => {
    let journaledFirst = false;
    const s = server((path, init, call) => {
      if (path !== '/upload/init') return undefined;
      if (call === 1) return envelope({ uploadSessionId: 'sess_1', status: 'expired', ...replayScopeOf(init) });
      journaledFirst = journals().includes(`"idempotencyKey":"${new Headers(init.headers).get('x-idempotency-key')}"`);
      return undefined;
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(s.keys).toHaveLength(2);
    expect(s.keys[1]).not.toBe(s.keys[0]);
    expect(journaledFirst).toBe(true);
    c.dispose();
  });

  it.each([
    [
      'completion: an outer error with ok: true',
      (path: string) =>
        path === '/upload/sess_1/complete' ? json({ ok: true, error: { code: 'FILEFN_INTERNAL' }, data: { fileId: FILE, versionId: 'ver_1' } }) : undefined,
    ],
    ['completion: a malformed versionId', (path: string) => (path === '/upload/sess_1/complete' ? envelope({ fileId: FILE, versionId: '..' }) : undefined)],
    [
      'a completed init: an outer error with ok: true',
      (path: string, init: RequestInit) =>
        path === '/upload/init' ? json({ ok: true, error: { code: 'FILEFN_INTERNAL' }, data: completed(init) }) : undefined,
    ],
    [
      'a completed init: a malformed session ID',
      (path: string, init: RequestInit) => (path === '/upload/init' ? envelope(completed(init, { uploadSessionId: '.' })) : undefined),
    ],
    [
      'a completed init: a malformed versionId',
      (path: string, init: RequestInit) => (path === '/upload/init' ? envelope(completed(init, { versionId: 'ver\n1' })) : undefined),
    ],
    [
      'the readback: an outer error with ok: true',
      (path: string, init: RequestInit) => {
        if (path === '/upload/init') return envelope(completed(init, { versionConfirmed: undefined }));
        if (path === `/${FILE}/versions/ver_1`) return json({ ok: true, error: { code: 'FILEFN_INTERNAL' }, data: { fileId: FILE, versionId: 'ver_1' } });
        return undefined;
      },
    ],
  ] as const)('confirms no stored version from %s', async (_label, route) => {
    const s = server(route as Route);
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous', entry: { phase: 'uploading' } });
    expect((await queue.get(FILE))?.upload).toBeUndefined();
    expect(persistedText()).toContain('.bin');
    c.dispose();
  });

  it.each([
    ['redirected elsewhere', true, { status: 'provisional', reason: 'ambiguous' }],
    ['answered by the verified part route', false, { status: 'provisional', reason: 'failed' }],
  ] as const)('reads a coded part refusal only when %s is not the case', async (label, redirected, expected) => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const s = server((path, init) => {
      if (path !== '/upload/sess_1/parts/1') return undefined;
      redirects.push(init.redirect);
      const refusal = json({ ok: false, error: { code: 'FILEFN_INVALID_PART', message: 'refused' } }, 400);
      if (redirected) Object.defineProperty(refusal, 'redirected', { value: true });
      return refusal;
    });
    const c = client(s.fetch);
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    const result = await queue.process(FILE);
    expect(result, label).toMatchObject(expected);
    // FileFn's part route is never followed elsewhere.
    expect(redirects).toEqual(['error']);
    if (redirected) {
      // Retried under the same generation and key.
      expect(await queue.get(FILE)).toMatchObject({ generation: 1, phase: 'uploading', state: 'provisional' });
    } else {
      expect(await queue.get(FILE)).toMatchObject({ phase: 'failed', error: { code: 'FILEFN_INVALID_PART' } });
    }
    c.dispose();
  });

  // Architecture reset (B): the scope is part of the journaled replay identity.
  it('replays a lost first init only under the scope journaled before it, whatever replayAccount names later', async () => {
    let tenant = 'tenant-a';
    const s = server((path, _init, call) =>
      path === '/upload/init' && call === 1 ? Promise.reject(new TypeError('network connection lost')) : undefined,
    );
    const c = client(s.fetch, { replayAccount: () => ({ principalId: 'server-user-7', tenantId: tenant }) });
    const queue = c.getOfflineQueue();
    await stageOne(queue);
    expect(await queue.process(FILE)).toMatchObject({ status: 'provisional', reason: 'ambiguous' });
    tenant = 'tenant-b';
    // More passes than the attempt limit: each sends nothing and uses no attempt.
    for (let pass = 0; pass < 7; pass += 1) {
      expect(await queue.process(FILE)).toMatchObject({
        status: 'provisional',
        reason: 'scope-unconfirmed',
        entry: { attempts: 1, error: { code: 'FILEFN_REPLAY_SCOPE_MISMATCH' }, pending: { reason: 'scope-unconfirmed' } },
      });
    }
    // Nothing was sent for the other tenant.
    expect(s.scopes).toEqual([scopeOf('server-user-7', 'tenant-a')]);
    // The original account resumes it by itself, under the same key: no reconcile.
    tenant = 'tenant-a';
    expect(await queue.process(FILE)).toMatchObject({ status: 'published' });
    expect(s.scopes).toEqual([scopeOf('server-user-7', 'tenant-a'), scopeOf('server-user-7', 'tenant-a')]);
    expect(new Set(s.keys).size).toBe(1);
    c.dispose();
  });

  it('journals the scope with the claim before the first request, so a reload replays the same key and scope', async () => {
    const s = server();
    let first = true;
    const c1 = client(s.fetch, {
      // The first request's credentials never resolve: the tab closes before anything is sent.
      getAuthHeaders: () => (first ? ((first = false), new Promise<never>(() => {})) : { authorization: 'Bearer test-token-alice' }),
    });
    const q1 = c1.getOfflineQueue();
    await stageOne(q1);
    void q1.process(FILE).catch(() => {});
    await vi.waitFor(() => expect(journals()).toContain(`"scope":"${scopeOf('user-alice')}"`));
    expect(s.paths).toEqual([]);
    const key = JSON.parse(journals()).current.replay.idempotencyKey as string;
    locks.closeTab('a');
    c1.dispose();

    const c2 = client(s.fetch, { queue: { coordinator: locks.forTab('b') } });
    expect(await c2.getOfflineQueue().process(FILE)).toMatchObject({ status: 'published' });
    expect(s.scopes).toEqual([scopeOf('user-alice')]);
    expect(s.keys).toEqual([key]);
    c2.dispose();
  });

  it('refuses an offline idempotencyKey longer than the queue keeps, before returning a handle', () => {
    setOnline(false);
    const c = client(server().fetch);
    expect(() => c.uploadFile({ policy: 'p', file: new Blob(['bytes']), fileId: FILE, idempotencyKey: 'k'.repeat(201) })).toThrow(
      expect.objectContaining({ code: 'FILEFN_INVALID_IDEMPOTENCY_KEY' }),
    );
    c.dispose();
  });
});
