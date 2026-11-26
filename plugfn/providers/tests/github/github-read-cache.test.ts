import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from 'plugfn';
import { githubProvider } from '../../src/github/index.js';

const params = { owner: 'octo', repo: 'demo', pullNumber: 7 };

function setup() {
  let accessToken = 'test-token-before';
  const manager = {
    markUsed: vi.fn(),
    resolveConnectionForAction: vi.fn(async () => ({ id: 'connection-1', scopes: [] as string[] })),
    getCredentials: vi.fn(async () => ({ type: 'oauth2', accessToken })),
  };
  const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('Authorization');
    return new Response(
      JSON.stringify({ id: 1, number: 7, title: `seen with ${authorization}`, body: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const executor = new ActionExecutor(manager as any, { get: () => githubProvider } as any, logger, {
    enableLogging: false,
    enableMetrics: false,
    enableRateLimit: false,
    enableRetry: false,
  });
  return { executor, fetchMock, replaceToken: (next: string) => { accessToken = next; } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('github reads through the action executor', () => {
  it('fetches pulls.get again under the current credential when no cache option is given', async () => {
    const { executor, fetchMock, replaceToken } = setup();

    const first = await executor.execute<any>('github', 'pulls.get', { userId: 'user-1', params });
    expect(first.success, String(first.error)).toBe(true);
    expect(first.data.title).toBe('seen with Bearer test-token-before');

    replaceToken('test-token-after');
    const second = await executor.execute<any>('github', 'pulls.get', { userId: 'user-1', params });

    expect(second.success, String(second.error)).toBe(true);
    expect(second.cached).toBe(false);
    expect(second.data.title).toBe('seen with Bearer test-token-after');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps caching a read when the caller asks for it', async () => {
    const { executor, fetchMock } = setup();

    await executor.execute('github', 'pulls.get', { userId: 'user-1', params, cache: true });
    const second = await executor.execute('github', 'pulls.get', { userId: 'user-1', params, cache: true });

    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
