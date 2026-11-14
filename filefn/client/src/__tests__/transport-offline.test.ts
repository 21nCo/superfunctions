import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileFnClient } from '../index.js';

// OPFS contents persist across page reloads; model that with a module-level map
// shared by every OPFSStore instance (one per created client).
const persisted = new Map<string, Record<string, unknown>>();

vi.mock('../offline/opfs-store.js', () => ({
  OPFSStore: class {
    static isSupported = () => true;
    async init() {}
    async stagePendingUpload(upload: Record<string, unknown>) {
      persisted.set(upload.uploadSessionId as string, structuredClone(upload));
    }
    async getPendingUpload(id: string) {
      return persisted.get(id) ?? null;
    }
    async getPendingLocalDescriptor(fileId: string) {
      const upload = [...persisted.values()].find((entry) => entry.fileId === fileId);
      return upload
        ? { fileId, uploadSessionId: upload.uploadSessionId, state: 'pending-local', source: { url: `blob:${fileId}` } }
        : null;
    }
    async listPendingUploads() {
      return [...persisted.keys()];
    }
    async deletePendingUpload(id: string) {
      persisted.delete(id);
    }
    async incrementRetryCount(id: string) {
      const upload = persisted.get(id);
      if (upload) upload.retryCount = (upload.retryCount as number) + 1;
    }
  },
}));

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
    persisted.clear();
    vi.stubGlobal('fetch', globalFetch);
    // Node 21+ has a global navigator; older supported runtimes do not, and a
    // real navigator's onLine is a getter, so give each test its own object.
    vi.stubGlobal('navigator', {});
    setOnline(true);
    globalFetch.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replays an upload staged before a reload through the new client fetch, headers and credentials', async () => {
    setOnline(false);
    const stagingFetch = vi.fn<typeof fetch>();
    const beforeReload = createFileFnClient({
      baseUrl: BASE,
      fetch: stagingFetch,
      credentials: 'include',
      getAuthHeaders: () => ({ 'x-csrf-token': 'csrf-before-reload' }),
      offline: { enabled: true },
    });
    beforeReload.uploadFile({ policy: 'p', file: new Blob(['hello'], { type: 'text/plain' }), fileName: 'a.txt', fileId: 'file_00000001' });
    await vi.waitFor(() => expect(persisted.size).toBe(1));
    expect(stagingFetch).not.toHaveBeenCalled();
    // Auth material is resolved at replay time and never written to OPFS.
    expect(JSON.stringify([...persisted.values()])).not.toContain('csrf-before-reload');

    // Reload: a fresh client with a fresh CSRF token, now online.
    setOnline(true);
    const calls: Array<{ url: string; method: string; headers: Headers; credentials?: RequestCredentials; body?: BodyInit | null }> = [];
    const replayFetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), credentials: init.credentials, body: init.body });
      if (url.endsWith('/upload/init')) {
        return envelope({ uploadSessionId: 'sess_1', uploadSessionToken: 'upls_1', uploadMode: 'proxy', chunkSizeBytes: 100, totalParts: 1 });
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
      offline: { enabled: true },
    });

    // Touching offline state starts the client's sync loop, which replays the staged upload.
    await afterReload.getPendingLocalDescriptor('file_00000001');
    await vi.waitFor(() => expect(persisted.size).toBe(0));

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
      expect(call.credentials).toBe('include');
    }
    // The replayed part carries the bytes staged before the reload.
    const partPut = calls.find((c) => c.method === 'PUT');
    expect(await new Response(partPut?.body).text()).toBe('hello');
  });
});
