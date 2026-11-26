import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from 'plugfn';
import { githubProvider } from '../../src/github/index.js';

// 615d6f44e set the GitHub contract reads to readScopes [], so no local scope
// gate re-checks access to their data. They are never served from or written
// to the action cache, whatever cache option the caller passes.
const reads: Array<[string, Record<string, unknown>]> = [
  ['repos.list', {}],
  ['issues.list', { owner: 'octo', repo: 'demo' }],
  ['issues.get', { owner: 'octo', repo: 'demo', issueNumber: 7 }],
  ['issues.comments.list', { owner: 'octo', repo: 'demo', maxPages: 1 }],
  ['pulls.list', { owner: 'octo', repo: 'demo', maxPages: 1 }],
  ['pulls.get', { owner: 'octo', repo: 'demo', pullNumber: 7 }],
];

const cacheModes: Array<[string, undefined | true | { key: string }]> = [
  ['the default cache mode', undefined],
  ['cache: true', true],
  ['cache: { key }', { key: 'caller-chosen-key' }],
];

function setup() {
  let accessToken = 'test-token-before';
  let revoked = false;
  const manager = {
    markUsed: vi.fn(),
    resolveConnectionForAction: vi.fn(async () => ({ id: 'connection-1', scopes: [] as string[] })),
    getCredentials: vi.fn(async () => ({ type: 'oauth2', accessToken })),
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (revoked) {
      return new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const authorization = new Headers(init?.headers).get('Authorization');
    const url = new URL(String(input instanceof Request ? input.url : input));
    const single = /\/(issues|pulls)\/7$/.test(url.pathname);
    const body = single
      ? { id: 1, number: 7, title: `seen with ${authorization}`, body: null, state: 'open', html_url: 'https://example.invalid/7' }
      : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const store = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const executor = new ActionExecutor(manager as any, { get: () => githubProvider } as any, logger, {
    enableLogging: false,
    enableMetrics: false,
    enableRateLimit: false,
    enableRetry: false,
    cacheStore: store as any,
  });
  return {
    executor,
    fetchMock,
    store,
    replaceToken: (next: string) => { accessToken = next; },
    revoke: () => { revoked = true; },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github reads through the action executor', () => {
  it.each(reads)('marks %s as never cacheable', (name) => {
    expect((githubProvider.actions as Record<string, { cacheable?: unknown }>)[name]!.cacheable).toBe('never');
  });

  describe.each(cacheModes)('with %s', (_label, cache) => {
    it.each(reads)('asks GitHub again for %s and never touches the cache store', async (name, params) => {
      const { executor, fetchMock, store } = setup();
      const options = { userId: 'user-1', params, ...(cache === undefined ? {} : { cache }) };

      const first = await executor.execute<any>('github', name, options);
      expect(first.success, String(first.error)).toBe(true);
      const second = await executor.execute<any>('github', name, options);
      expect(second.success, String(second.error)).toBe(true);

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();
    });

    it.each(reads)('returns the revocation GitHub reports for %s on the next call', async (name, params) => {
      const { executor, fetchMock, revoke } = setup();
      const options = { userId: 'user-1', params, ...(cache === undefined ? {} : { cache }) };

      const first = await executor.execute<any>('github', name, options);
      expect(first.success, String(first.error)).toBe(true);
      // Same token and scopes; access was revoked on GitHub's side.
      revoke();
      const second = await executor.execute<any>('github', name, options);

      expect(second.success).toBe(false);
      expect(second.cached).not.toBe(true);
      expect(second.data).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  it('reads pulls.get under the current credential', async () => {
    const { executor, replaceToken } = setup();
    await executor.execute<any>('github', 'pulls.get', { userId: 'user-1', params: reads[5]![1], cache: true });
    replaceToken('test-token-after');
    const second = await executor.execute<any>('github', 'pulls.get', { userId: 'user-1', params: reads[5]![1], cache: true });
    expect(second.data.title).toBe('seen with Bearer test-token-after');
  });
});
