import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KVStoreAdapter } from '@superfunctions/db';
import { ActionExecutor } from '../src/core/action-executor.js';
import { deriveCacheBindingKey } from '../src/middleware/caching.js';
import { mockProvider, mockResponse } from '../src/testing/index.js';

// SFNS-107 architecture reset: an executor cache entry is bound to the exact
// credential and granted scopes that produced it, for parameter-derived and
// custom keys alike, so a replaced or narrowed credential on the same
// connection never reads data cached under the earlier one. The binding is a
// keyed HMAC (node:crypto), so the key is no offline verifier for the
// credential and needs no global WebCrypto (absent on Node 18).

type Credentials = { type: 'oauth2'; accessToken: string };

function setup(options: { cacheBindingKey?: Uint8Array; entries?: Map<string, string> } = {}) {
  let credentials: Credentials = { type: 'oauth2', accessToken: 'test-token-before' };
  let scopes = ['read', 'write'];
  const keys: string[] = [];
  const reads: string[] = [];
  const entries = options.entries ?? new Map<string, string>();
  const store: KVStoreAdapter = {
    async get(key) {
      reads.push(key);
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
    cacheBindingKey: options.cacheBindingKey,
  });
  return {
    executor,
    provider,
    keys,
    reads,
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
    expect(keys[0]).toMatch(/:credential-hmac=[a-f0-9]{64}:/);
  });
});

describe('ActionExecutor credential binding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Test-only encryption keys: obviously fake, valid 32-byte hex shape.
  const encryptionKeyA = '0'.repeat(63) + '1';
  const encryptionKeyB = '0'.repeat(63) + '2';

  it('carries a keyed digest, not the plain SHA-256 of the credential and scopes', async () => {
    const { executor, keys } = setup({ cacheBindingKey: deriveCacheBindingKey(encryptionKeyA) });
    await executor.execute('test', 'getProfile', read(true));

    const canonical = JSON.stringify({
      credentials: { accessToken: 'test-token-before', type: 'oauth2' },
      scopes: ['read', 'write'],
    });
    const unkeyed = createHash('sha256').update(canonical).digest('hex');
    const segment = /:credential-hmac=([a-f0-9]{64}):/.exec(keys[0])?.[1];
    expect(segment).toBeDefined();
    expect(segment).not.toBe(unkeyed);
    expect(keys[0]).not.toContain(unkeyed);
    expect(keys[0]).not.toContain('test-token-before');
    expect(keys[0]).not.toContain(encryptionKeyA);
  });

  it('works without a global WebCrypto', async () => {
    vi.stubGlobal('crypto', undefined);
    expect(globalThis.crypto).toBeUndefined();
    const { executor, seen } = setup({ cacheBindingKey: deriveCacheBindingKey(encryptionKeyA) });

    await executor.execute('test', 'getProfile', read(true));
    const second = await executor.execute('test', 'getProfile', read(true));
    expect(second.cached).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('shares entries only between executors keyed from the same encryption key', async () => {
    const entries = new Map<string, string>();
    const first = setup({ cacheBindingKey: deriveCacheBindingKey(encryptionKeyA), entries });
    await first.executor.execute('test', 'getProfile', read(true));

    const sameKey = setup({ cacheBindingKey: deriveCacheBindingKey(encryptionKeyA), entries });
    expect((await sameKey.executor.execute('test', 'getProfile', read(true))).cached).toBe(true);

    const otherKey = setup({ cacheBindingKey: deriveCacheBindingKey(encryptionKeyB), entries });
    expect((await otherKey.executor.execute('test', 'getProfile', read(true))).cached).toBe(false);
  });
});

// An action with cacheable: 'never' (no local authorization gate on its data)
// is never served from or written to the cache, whatever the caller asks for.
describe('ActionExecutor cacheable: never', () => {
  const modes = [
    ['no cache option', undefined],
    ['cache: true', true],
    ['cache: { key }', { key: 'profile' }],
  ] as const;

  it.each(modes)('neither reads nor writes the store with %s', async (_label, cache) => {
    const entries = new Map<string, string>();
    const { executor, provider, keys, reads, seen } = setup({ entries });
    provider.actions.getProfile.cacheable = 'never';
    const options = { userId: 'user-1', params: { id: 1 }, ...(cache === undefined ? {} : { cache }) };

    const first = await executor.execute<any>('test', 'getProfile', options);
    const second = await executor.execute<any>('test', 'getProfile', options);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(seen).toHaveLength(2);
    expect(reads).toEqual([]);
    expect(keys).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it.each([
    ['cacheable: true with no cache option', true, undefined],
    ['an ordinary action with cache: true', undefined, true],
    ['an ordinary action with cache: { key }', undefined, { key: 'profile' }],
  ] as const)('still caches %s', async (_label, cacheable, cache) => {
    const { executor, provider, seen } = setup();
    if (cacheable !== undefined) provider.actions.getProfile.cacheable = cacheable;
    const options = { userId: 'user-1', params: { id: 1 }, ...(cache === undefined ? {} : { cache }) };

    await executor.execute<any>('test', 'getProfile', options);
    const second = await executor.execute<any>('test', 'getProfile', options);

    expect(second.cached).toBe(true);
    expect(seen).toHaveLength(1);
  });
});
