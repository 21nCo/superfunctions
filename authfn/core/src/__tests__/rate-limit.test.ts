import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtomicKVStoreAdapter } from '../../../../packages/db/src/adapter/types.js';
import { createMemoryAtomicKVStore } from '../../../../packages/db/src/adapters/memory/index.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import type { AuthFnRuntimeConfig } from '../index.js';
import type { AuthFnRateLimitConfig, AuthFnRateLimitMode } from '../types.js';
import { createAuthFnRateLimitMiddleware } from '../core/rate-limit.js';

const middlewareByConfig = new WeakMap<AuthFnRuntimeConfig, ReturnType<typeof createAuthFnRateLimitMiddleware>>();

function createConfig(namespace: string): AuthFnRuntimeConfig {
  return {
    database: memoryAdapter({ debug: false }),
    namespace,
    plugins: [],
    rateLimit: {
      enabled: true,
      mode: 'local',
      policies: {
        password: { ipLimit: 1, windowSeconds: 60 },
        'password-reset': { ipLimit: 1, windowSeconds: 60 },
        'social-start': { ipLimit: 1, windowSeconds: 60 }
      }
    }
  };
}

async function callRateLimitedRoute(
  config: AuthFnRuntimeConfig,
  path: string,
  headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.10' }
): Promise<Response> {
  let middleware = middlewareByConfig.get(config);
  if (middleware === undefined) {
    middleware = createAuthFnRateLimitMiddleware(config);
    middlewareByConfig.set(config, middleware);
  }
  if (!middleware) {
    throw new Error('Expected rate-limit middleware');
  }
  return middleware(
    new Request(`https://account.example.com${path}`, {
      headers
    }),
    {} as never,
    async () => new Response('ok')
  );
}

// A minute boundary: every window length used below divides it.
const WINDOW_START = Date.UTC(2026, 0, 1, 0, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

function freezeClock(at: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

interface ModeFixture {
  config: AuthFnRuntimeConfig;
  /** Store writes observed in modes backed by a store; local mode has none. */
  storeWrites: () => number;
}

function createModeConfig(
  mode: AuthFnRateLimitMode,
  namespace: string,
  policies: AuthFnRateLimitConfig['policies']
): ModeFixture {
  const store = createMemoryAtomicKVStore();
  let writes = 0;
  const counted: AtomicKVStoreAdapter = {
    ...store,
    async set(input) {
      writes += 1;
      return store.set(input);
    },
    async incr(input) {
      writes += 1;
      return store.incr(input);
    }
  };
  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace,
    plugins: [],
    ...(mode === 'strict' ? { stores: { atomicKv: counted } } : {}),
    ...(mode === 'best-effort' ? { stores: { kv: counted } } : {}),
    rateLimit: {
      enabled: true,
      mode,
      resolveClientIp: (request) => request.headers.get('x-test-client-ip') ?? undefined,
      policies
    }
  };
  return { config, storeWrites: () => writes };
}

async function postRateLimitedRoute(
  config: AuthFnRuntimeConfig,
  path: string,
  input: { ip: string; email: string }
): Promise<Response> {
  let middleware = middlewareByConfig.get(config);
  if (middleware === undefined) {
    middleware = createAuthFnRateLimitMiddleware(config);
    middlewareByConfig.set(config, middleware);
  }
  if (!middleware) {
    throw new Error('Expected rate-limit middleware');
  }
  return middleware(
    new Request(`https://account.example.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-client-ip': input.ip },
      body: JSON.stringify({ email: input.email })
    }),
    {} as never,
    async () => new Response('ok')
  );
}

const modes: AuthFnRateLimitMode[] = ['strict', 'best-effort', 'local'];

describe('authfn rate limiting', () => {
  describe.each(modes)('%s mode', (mode) => {
    it.each([
      // Same IP, a new email per request: only the IP counter accumulates.
      { dimension: 'ip', client: (i: number) => ({ ip: '203.0.113.7', email: `user${i}@example.com` }) },
      // Same email, a new IP per request: only the identifier counter accumulates.
      { dimension: 'identifier', client: (i: number) => ({ ip: `198.51.100.${i}`, email: 'Victim@Example.com' }) }
    ])('counts otp-verify and otp-send separately by $dimension', async ({ dimension, client }) => {
      freezeClock(WINDOW_START + 5_000);
      const { config, storeWrites } = createModeConfig(mode, `rate-limit-${mode}-${dimension}-scope`, {
        'otp-send': { ipLimit: 2, identifierLimit: 2, windowSeconds: 300 },
        'otp-verify': { ipLimit: 4, identifierLimit: 4, windowSeconds: 300 }
      });
      let request = 0;

      // Four mistyped codes use up otp-verify's budget but none of otp-send's.
      for (let i = 0; i < 4; i += 1) {
        await expect(postRateLimitedRoute(config, '/auth/otp/verify', client(request++)))
          .resolves.toHaveProperty('status', 200);
      }
      for (let i = 0; i < 2; i += 1) {
        await expect(postRateLimitedRoute(config, '/auth/otp/send', client(request++)))
          .resolves.toHaveProperty('status', 200);
      }
      await expect(postRateLimitedRoute(config, '/auth/otp/send', client(request++))).rejects.toMatchObject({
        name: 'AuthFnRateLimitedError',
        details: { scope: 'otp-send', dimension }
      });
      await expect(postRateLimitedRoute(config, '/auth/otp/verify', client(request++))).rejects.toMatchObject({
        name: 'AuthFnRateLimitedError',
        details: { scope: 'otp-verify', dimension }
      });
      expect(storeWrites() > 0).toBe(mode !== 'local');
    });

    it('does not let refused requests move the end of a fixed window', async () => {
      const windowEndsAt = WINDOW_START + 60_000;
      const client = { ip: '203.0.113.9', email: 'retry@example.com' };
      const { config, storeWrites } = createModeConfig(mode, `rate-limit-${mode}-fixed-window`, {
        'otp-send': { ipLimit: 2, identifierLimit: 2, windowSeconds: 60 }
      });

      freezeClock(WINDOW_START + 10_000);
      await expect(postRateLimitedRoute(config, '/auth/otp/send', client)).resolves.toHaveProperty('status', 200);
      await expect(postRateLimitedRoute(config, '/auth/otp/send', client)).resolves.toHaveProperty('status', 200);
      const writesBeforeRefusals = storeWrites();

      // Refused retries throughout the window, the last one just before it ends,
      // all report the same reset time: the window's original end.
      for (const at of [WINDOW_START + 20_000, WINDOW_START + 45_000, windowEndsAt - 1]) {
        vi.setSystemTime(at);
        await expect(postRateLimitedRoute(config, '/auth/otp/send', client)).rejects.toMatchObject({
          name: 'AuthFnRateLimitedError',
          details: { scope: 'otp-send', resetAt: new Date(windowEndsAt).toISOString() }
        });
      }
      // Refusals still write their counters (and refresh store TTLs).
      expect(storeWrites() > writesBeforeRefusals).toBe(mode !== 'local');

      vi.setSystemTime(windowEndsAt);
      await expect(postRateLimitedRoute(config, '/auth/otp/send', client)).resolves.toHaveProperty('status', 200);
      await expect(postRateLimitedRoute(config, '/auth/otp/send', client)).resolves.toHaveProperty('status', 200);
      await expect(postRateLimitedRoute(config, '/auth/otp/send', client)).rejects.toMatchObject({
        details: { scope: 'otp-send', resetAt: new Date(windowEndsAt + 60_000).toISOString() }
      });
    });
  });

  it('keeps counters isolated by route scope', async () => {
    const config = createConfig('rate-limit-scope-test');

    await expect(callRateLimitedRoute(config, '/auth/sign-in/password')).resolves.toHaveProperty('status', 200);
    await expect(callRateLimitedRoute(config, '/auth/social/start')).resolves.toHaveProperty('status', 200);
    await expect(callRateLimitedRoute(config, '/auth/sign-in/password')).rejects.toMatchObject({
      name: 'AuthFnRateLimitedError',
      details: {
        scope: 'password'
      }
    });
    await expect(callRateLimitedRoute(config, '/auth/social/start')).rejects.toMatchObject({
      name: 'AuthFnRateLimitedError',
      details: {
        scope: 'social-start'
      }
    });
  });

  it('applies the password policy to password sign-up', async () => {
    const config = createConfig('rate-limit-sign-up-test');

    await expect(callRateLimitedRoute(config, '/auth/sign-up/password')).resolves.toHaveProperty('status', 200);
    await expect(callRateLimitedRoute(config, '/auth/sign-up/password')).rejects.toMatchObject({
      name: 'AuthFnRateLimitedError',
      details: {
        scope: 'password'
      }
    });
  });

  it('applies the password-reset policy to reset completion', async () => {
    const config = createConfig('rate-limit-reset-complete-test');

    await expect(callRateLimitedRoute(config, '/auth/password/reset/start')).resolves.toHaveProperty('status', 200);
    await expect(callRateLimitedRoute(config, '/auth/password/reset/complete')).rejects.toMatchObject({
      name: 'AuthFnRateLimitedError',
      details: {
        scope: 'password-reset'
      }
    });
  });

  it('does not trust forwarding headers without an explicit resolver', async () => {
    const config = createConfig('rate-limit-untrusted-forwarding-test');

    await expect(callRateLimitedRoute(config, '/auth/social/start', {
      'x-forwarded-for': '203.0.113.1'
    })).resolves.toHaveProperty('status', 200);
    await expect(callRateLimitedRoute(config, '/auth/social/start', {
      'x-forwarded-for': '203.0.113.2'
    })).rejects.toMatchObject({
      name: 'AuthFnRateLimitedError',
      details: { scope: 'social-start', dimension: 'ip' }
    });
  });

  it('uses a configured trusted client-IP resolver', async () => {
    const config = createConfig('rate-limit-trusted-resolver-test');
    config.rateLimit!.resolveClientIp = (request) => request.headers.get('x-test-client-ip') ?? undefined;

    await expect(callRateLimitedRoute(config, '/auth/social/start', {
      'x-test-client-ip': '203.0.113.1'
    })).resolves.toHaveProperty('status', 200);
    await expect(callRateLimitedRoute(config, '/auth/social/start', {
      'x-test-client-ip': '203.0.113.2'
    })).resolves.toHaveProperty('status', 200);
  });

  it('fails closed at capacity without evicting active windows', async () => {
    // A frozen clock keeps every window open, so the run cannot cross a window
    // boundary and see its counters expire.
    freezeClock(WINDOW_START + 1_000);
    const config = createConfig('rate-limit-capacity-test');
    config.rateLimit!.policies!.account = { ipLimit: 1, windowSeconds: 60 };
    config.rateLimit!.resolveClientIp = (request) => request.headers.get('x-test-client-ip') ?? undefined;

    // Must fill exactly MAX_LOCAL_RATE_LIMIT_WINDOWS (10_000) distinct windows
    // in core/rate-limit.ts; one more would trip fail-closed mid-loop.
    for (let i = 0; i < 10_000; i += 1) {
      await expect(callRateLimitedRoute(config, '/auth/account', {
        'x-test-client-ip': `198.51.${Math.floor(i / 256)}.${i % 256}`
      })).resolves.toHaveProperty('status', 200);
    }

    await expect(callRateLimitedRoute(config, '/auth/account', {
      'x-test-client-ip': '192.0.2.250'
    })).rejects.toMatchObject({ name: 'AuthFnRateLimitedError' });
    await expect(callRateLimitedRoute(config, '/auth/account', {
      'x-test-client-ip': '198.51.0.0'
    })).rejects.toMatchObject({ name: 'AuthFnRateLimitedError' });
  }, 30_000);
});
