import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createLocalStorageAdapter } from '@superfunctions/storage-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A server whose generated session and version IDs carry '@', '+' and '=',
// path characters that `encodeURIComponent` would escape and the router never decodes.
vi.mock('../src/ids.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ids.js')>();
  let n = 0;
  return {
    ...actual,
    generateFileFnId: (prefix: Parameters<typeof actual.generateFileFnId>[0]) => {
      n += 1;
      if (prefix === 'upl') return `sess@2026+${n}`;
      if (prefix === 'ver') return `ver=2026@${n}`;
      return actual.generateFileFnId(prefix);
    },
  };
});

const { createFileFn } = await import('../src/index.js');
const { createFileFnClient } = await import('../../client/src/index.js');
const { SharedLockManager, createStorage } = await import('../../client/src/__tests__/helpers/offline-fixtures.js');

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
  const root = await mkdtemp(join(tmpdir(), 'filefn-session-id-'));
  roots.push(root);
  const fileFn = createFileFn({
    database: memoryAdapter(),
    storage: createLocalStorageAdapter({ rootDir: root }),
    policies: [{ name: 'doc', contentTypes: ['text/plain'], maxSizeBytes: 1024, visibility: 'private' } as any],
    auth: { required: true, resolveSession: async () => ({ principalId: 'user-owner' }) },
  });
  const paths: string[] = [];
  let loseOnce: string | undefined;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input : new URL(String(input), BASE), init);
    const body = init?.body;
    if (body instanceof Blob && !request.headers.has('content-length')) request.headers.set('content-length', String(body.size));
    const path = new URL(request.url).pathname;
    paths.push(`${request.method} ${path}`);
    const response = (await fileFn.router.handle(request)) ?? new Response('no route', { status: 404 });
    if (loseOnce && path.endsWith(loseOnce)) {
      loseOnce = undefined;
      throw new TypeError('fetch failed');
    }
    return response;
  }) as typeof globalThis.fetch;
  return {
    paths,
    fetch,
    loseResponse(suffix: string) {
      loseOnce = suffix;
    },
  };
}

describe('server-generated IDs with path characters, through the real FileFn router', () => {
  it('completes an online upload: every session route finds the raw ID', async () => {
    const app = await createApp();
    const client = createFileFnClient({ baseUrl: BASE, fetch: app.fetch, retryOptions: { maxRetries: 0 } });
    const result = await client
      .uploadFile({ policy: 'doc', file: new Blob(['hello'], { type: 'text/plain' }), fileName: 'a.txt', fileId: 'file_00000000segment1' })
      .done();
    expect(result.fileId).toBe('file_00000000segment1');
    expect(result.versionId).toMatch(/^ver=2026@\d+$/);
    const sessionPaths = app.paths.filter((p) => p.includes('/upload/sess@2026+'));
    expect(sessionPaths.some((p) => p.endsWith('/sign'))).toBe(true);
    expect(sessionPaths.some((p) => p.startsWith('POST') && p.endsWith('/complete') && !p.includes('/parts/'))).toBe(true);
  });

  it('replays an offline upload through status and complete under the same key', async () => {
    const app = await createApp();
    const storage = createStorage();
    const locks = new SharedLockManager();
    const client = createFileFnClient({
      baseUrl: BASE,
      fetch: app.fetch,
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
    const staged = await queue.stage({ policy: 'doc', file: new Blob(['hello'], { type: 'text/plain' }), fileName: 'a.txt', fileId: 'file_00000000segment2' });
    expect(staged.status).toBe('staged');
    app.loseResponse('/parts/1');

    // The lost part answer is replayed under the same key (within
    // the pass or by the next one): status, then completion of that session.
    let result = await queue.process('file_00000000segment2');
    if (result.status === 'provisional') result = await queue.process('file_00000000segment2');
    expect(result).toMatchObject({ status: 'published', entry: { upload: { fileId: 'file_00000000segment2' } } });
    expect(app.paths.some((p) => /^GET \/upload\/sess@2026\+\d+\/status$/.test(p))).toBe(true);
    expect(app.paths.some((p) => /^POST \/upload\/sess@2026\+\d+\/complete$/.test(p))).toBe(true);
    expect(app.paths.some((p) => p.includes('%'))).toBe(false);
  });
});
