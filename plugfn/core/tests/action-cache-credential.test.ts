import { describe, expect, it, vi } from 'vitest';
import type { KVStoreAdapter } from '@superfunctions/db';
import { ActionExecutor } from '../src/core/action-executor.js';
import { mockProvider, mockResponse } from '../src/testing/index.js';

// SFNS-107 architecture reset: an executor cache entry is bound to the exact
// credential and granted scopes that produced it, for parameter-derived and
// custom keys alike, so a replaced or narrowed credential on the same
// connection never reads data cached under the earlier one.

type Credentials = { type: 'oauth2'; accessToken: string };

function setup() {
  let credentials: Credentials = { type: 'oauth2', accessToken: 'test-token-before' };
  let scopes = ['read', 'write'];
  const keys: string[] = [];
  const entries = new Map<string, string>();
  const store: KVStoreAdapter = {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set({ key, value }) {
      keys.push(key);
      entries.set(key, value);
    },
    async delete(key) {
      entries.delete(key);
    },
  } as KVStoreAdapter;
  const manager = {
    markUsed: vi.fn(),
    resolveConnectionForAction: vi.fn(async () => ({ id: 'connection-1', scopes: [...scopes] })),
    getCredentials: vi.fn(async () => ({ ...credentials })),
  };
  const provider = mockProvider('test', { getProfile: mockResponse({}) });
  const seen: string[] = [];
  let gate: Promise<void> | undefined;
  let started: () => void = () => {};
  provider.actions.getProfile.execute = async (_params, context) => {
    const token = (context.auth.credentials as Credentials).accessToken;
    started();
    if (gate) await gate;
    seen.push(token);
    return { seenWith: token };
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const executor = new ActionExecutor(manager as any, { get: () => provider } as any, logger, {
    enableLogging: false,
    enableMetrics: false,
    enableRateLimit: false,
    enableRetry: false,
    cacheStore: store,
  });
  return {
    executor,
    keys,
    seen,
    replaceCredentials: (next: Credentials) => { credentials = next; },
    narrowScopes: (next: string[]) => { scopes = next; },
    holdNextExecution: () => {
      let release: () => void = () => {};
      gate = new Promise<void>((resolve) => { release = resolve; });
      const running = new Promise<void>((resolve) => { started = resolve; });
      return { running, release: () => { gate = undefined; release(); } };
    },
  };
}

const read = (cache: true | { key: string }) => ({ userId: 'user-1', params: { id: 1 }, cache });

describe.each([
  ['parameter-derived', true as const],
  ['custom', { key: 'profile' }],
] as const)('ActionExecutor %s cache keys', (_label, cache) => {
  it('refetches under a replaced credential instead of serving the older entry', async () => {
    const { executor, seen, replaceCredentials } = setup();

    await executor.execute('test', 'getProfile', read(cache));
    replaceCredentials({ type: 'oauth2', accessToken: 'test-token-after' });
    const second = await executor.execute<any>('test', 'getProfile', read(cache));

    expect(second.cached).toBe(false);
    expect(second.data).toEqual({ seenWith: 'test-token-after' });
    expect(seen).toEqual(['test-token-before', 'test-token-after']);
  });

  it('refetches after the granted scopes narrow on the same credential', async () => {
    const { executor, seen, narrowScopes } = setup();

    await executor.execute('test', 'getProfile', read(cache));
    narrowScopes(['read']);
    const second = await executor.execute('test', 'getProfile', read(cache));

    expect(second.cached).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('never lets a late write under the old credential reach a read under the new one', async () => {
    const { executor, seen, replaceCredentials, holdNextExecution } = setup();

    const held = holdNextExecution();
    const first = executor.execute('test', 'getProfile', read(cache));
    await held.running;
    replaceCredentials({ type: 'oauth2', accessToken: 'test-token-after' });
    held.release();
    await first;

    const second = await executor.execute<any>('test', 'getProfile', read(cache));
    expect(second.cached).toBe(false);
    expect(second.data).toEqual({ seenWith: 'test-token-after' });
    expect(seen).toEqual(['test-token-before', 'test-token-after']);
  });

  it('still hits for an unchanged credential, with a key that carries no secret', async () => {
    const { executor, seen, keys } = setup();

    await executor.execute('test', 'getProfile', read(cache));
    const second = await executor.execute('test', 'getProfile', read(cache));

    expect(second.cached).toBe(true);
    expect(seen).toHaveLength(1);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain('test-token-before');
    expect(keys[0]).toMatch(/:credential-sha256=[a-f0-9]{64}:/);
  });
});
