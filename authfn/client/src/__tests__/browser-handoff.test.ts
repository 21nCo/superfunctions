import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthFnClient,
  createAuthFnRegionalClient,
  createBrowserHandoff,
  createIndexedDbHandoffStore,
  createMemoryHandoffStore,
  createRegionalHandoffExchange,
  type AuthFnBrowserHandoffBeginResult,
  type AuthFnBrowserHandoffEvent,
  type AuthFnBrowserHandoffExchange,
  type AuthFnBrowserHandoffOptions,
  type AuthFnBrowserHandoffResult,
  type AuthFnBrowserHandoffStore,
  type AuthFnClientRequestMetric,
  type AuthFnSocialHandoffClient
} from '../index.js';

const APP = 'https://app.example.com';
const RETURN_TO = `${APP}/post-auth?tab=settings`;
const T0 = Date.parse('2026-11-26T00:00:00.000Z');

function createClock(start = T0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/**
 * A fake of the server's single-use exchange: a code is bound to the
 * challenge it was minted for, and is consumed by the first exchange that
 * presents the matching verifier.
 */
function createFakeServer() {
  const codes = new Map<string, { challenge: string; used: boolean }>();
  const verifiersSeen: string[] = [];
  let minted = 0;
  let exchanged = 0;
  const exchange: AuthFnBrowserHandoffExchange = async ({ code, verifier }) => {
    verifiersSeen.push(verifier);
    // Let other participants run between the claim and the server's answer.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const entry = codes.get(code);
    if (!entry || challengeOf(verifier) !== entry.challenge) {
      return {
        ok: false,
        error: { code: 'AUTHFN_OAUTH_STATE_INVALID', message: 'Social handoff code is invalid', retryable: false },
        requestId: 'req-invalid'
      };
    }
    if (entry.used) {
      return {
        ok: false,
        error: { code: 'AUTHFN_OAUTH_STATE_REPLAYED', message: 'Social handoff code was already used or has expired', retryable: false },
        requestId: 'req-replayed'
      };
    }
    entry.used = true;
    exchanged += 1;
    return {
      ok: true,
      requestId: `req-exchange-${exchanged}`,
      data: {
        session: {
          id: `session-${exchanged}`,
          type: 'session',
          subject: { actorId: 'user-1', actorType: 'user' },
          actorType: 'user',
          actorId: 'user-1',
          resourceIds: [],
          methods: ['oauth-google']
        },
        handoff: {
          type: 'session-token',
          token: `test-session-token-${exchanged}`,
          sessionId: `session-${exchanged}`,
          regionId: null,
          expiresAt: null
        }
      }
    };
  };
  return {
    exchange: vi.fn(exchange),
    verifiersSeen,
    get exchanged() {
      return exchanged;
    },
    /** The redirect the callback sends for a begun handoff, as the social plugin builds it. */
    callbackFor(begun: AuthFnBrowserHandoffBeginResult, fragmentExtra: Record<string, string> = {}): string {
      minted += 1;
      const code = `test-handoff-code-${minted}`;
      codes.set(code, { challenge: begun.start.handoffChallenge, used: false });
      const url = new URL(begun.start.returnTo);
      const fragment = new URLSearchParams(url.hash.slice(1));
      fragment.set('token', code);
      fragment.set('handoff', 'code');
      for (const [name, value] of Object.entries(fragmentExtra)) {
        fragment.set(name, value);
      }
      url.hash = fragment.toString();
      return url.href;
    }
  };
}

function setup(overrides: Partial<AuthFnBrowserHandoffOptions> = {}) {
  const clock = createClock();
  const store = createMemoryHandoffStore();
  const server = createFakeServer();
  const events: AuthFnBrowserHandoffEvent[] = [];
  const make = (extra: Partial<AuthFnBrowserHandoffOptions> = {}) => createBrowserHandoff({
    store,
    clock,
    allowedOrigins: [APP, 'https://other.example.com'],
    exchange: server.exchange,
    onEvent: (event) => events.push(event),
    ...overrides,
    ...extra
  });
  return { clock, store, server, events, make };
}

async function storedVerifier(store: AuthFnBrowserHandoffStore, handoffId: string): Promise<string> {
  const raw = await store.get(`authfn.handoff.${handoffId}`);
  return JSON.parse(String(raw)).verifier as string;
}

async function dumpStore(store: AuthFnBrowserHandoffStore): Promise<string> {
  const entries: Array<[string, unknown]> = [];
  for (const key of await store.keys()) {
    entries.push([key, await store.get(key)]);
  }
  return JSON.stringify(entries);
}

function failed(result: AuthFnBrowserHandoffResult) {
  if (result.status !== 'failed') {
    throw new Error(`expected a failed result, got ${result.status}`);
  }
  return result;
}

const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * IndexedDB of one origin: each store opens its own connection to the same
 * database, as each window does, and the transaction scheduler decides
 * which readwrite transaction runs first.
 */
function createSharedIndexedDb() {
  const factory = new IDBFactory();
  return { factory, window: () => createIndexedDbHandoffStore({ indexedDB: factory }) };
}

describe('createBrowserHandoff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('begins a code-and-verifier social start bound to a handoff id in the return fragment', async () => {
    const { make, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });

    expect(begun.start).toMatchObject({ callbackMode: 'redirect', handoffMode: 'session-token' });
    // The server accepts only a 43-character base64url SHA-256 challenge.
    expect(begun.start.handoffChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const returnTo = new URL(begun.start.returnTo);
    expect(returnTo.origin + returnTo.pathname + returnTo.search).toBe(RETURN_TO);
    expect(returnTo.hash).toBe(`#authfn_handoff=${begun.handoffId}`);
    expect(begun.expiresAt).toBe(new Date(T0 + 10 * 60 * 1000).toISOString());
    expect(challengeOf(await storedVerifier(store, begun.handoffId))).toBe(begun.start.handoffChallenge);
  });

  it('completes after a reload from the shared store and retires the verifier', async () => {
    const { make, store, server, events } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO, regionId: 'region-a' });
    const verifier = await storedVerifier(store, begun.handoffId);
    // The callback's own regionId is not trusted for routing the exchange.
    const callback = server.callbackFor(begun, { regionId: 'region-b' });

    // A new instance stands in for the page that loads after the redirect.
    const result = await make().complete(`${callback}&keep=1`);

    expect(result).toMatchObject({
      status: 'completed',
      handoffId: begun.handoffId,
      session: { id: 'session-1' },
      handoff: { token: 'test-session-token-1' },
      requestId: 'req-exchange-1',
      cleanUrl: `${RETURN_TO}#keep=1`
    });
    expect(server.exchange).toHaveBeenCalledWith(
      { code: 'test-handoff-code-1', verifier },
      { handoffId: begun.handoffId, regionId: 'region-a' }
    );
    expect(JSON.parse(String(await store.get(`authfn.handoff.${begun.handoffId}`)))).toEqual({
      v: 1,
      id: begun.handoffId,
      state: 'used',
      expiresAt: T0 + 10 * 60 * 1000
    });
    expect(await dumpStore(store)).not.toContain(verifier);
    expect(JSON.stringify(events)).not.toContain(verifier);
    expect(events.map((event) => event.type)).toEqual(['begun', 'completed']);
  });

  it('lets only one of two windows over shared storage complete the same return', async () => {
    const { make, server } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);

    const results = await Promise.all([make().complete(callback), make().complete(callback)]);

    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'failed']);
    expect(results.find((result) => result.status === 'failed')).toMatchObject({ reason: 'already-used' });
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('lets one completion through when two windows return with different codes for one handoff', async () => {
    // A retried /social/start mints a second code with the same challenge;
    // the server consumes each code once, so only the claim stops the second.
    const { window } = createSharedIndexedDb();
    const { make, server } = setup();
    const begun = await make({ store: window() }).begin({ returnTo: RETURN_TO });
    const first = server.callbackFor(begun);
    const second = server.callbackFor(begun);

    const results = await Promise.all([
      make({ store: window() }).complete(first),
      make({ store: window() }).complete(second)
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'failed']);
    expect(results.find((result) => result.status === 'failed')).toMatchObject({ reason: 'already-used' });
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('claims through one IndexedDB transaction, so one of many concurrent connections wins', async () => {
    const { window } = createSharedIndexedDb();
    const windows = Array.from({ length: 6 }, window);
    for (let round = 0; round < 10; round += 1) {
      const key = `authfn.handoff.race-${round}`;
      await windows[0]!.set(key, 'pending');
      const claims = await Promise.all(windows.map((store, index) => store.compareAndSet(key, 'pending', `used-${index}`)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await windows[1]!.get(key)).toBe(`used-${claims.indexOf(true)}`);
    }
    expect(await windows[2]!.compareAndSet('authfn.handoff.missing', 'pending', null)).toBe(false);
    await windows[0]!.set('authfn.handoff.gone', 'x');
    expect(await windows[3]!.compareAndSet('authfn.handoff.gone', 'x', null)).toBe(true);
    expect(await windows[4]!.get('authfn.handoff.gone')).toBeNull();
    expect(Array.from(await windows[5]!.keys())).not.toContain('authfn.handoff.gone');
  });

  it('refuses to begin or complete on a store that cannot claim atomically', async () => {
    const shared = createMemoryHandoffStore();
    const nonAtomic: AuthFnBrowserHandoffStore = { ...shared, atomic: false };
    // Without IndexedDB the browser store cannot claim, and says so.
    expect(createIndexedDbHandoffStore({ indexedDB: null }).atomic).toBe(false);
    const { make, server } = setup();

    await expect(make({ store: nonAtomic }).begin({ returnTo: RETURN_TO })).rejects.toThrow(/atomic/);
    await expect(make({ store: createIndexedDbHandoffStore({ indexedDB: null }) }).begin({ returnTo: RETURN_TO }))
      .rejects.toThrow(/atomic/);
    expect(Array.from(await shared.keys())).toEqual([]);

    const begun = await make({ store: shared }).begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    expect(await make({ store: nonAtomic }).complete(callback)).toMatchObject({
      status: 'failed',
      reason: 'store-not-atomic',
      handoffId: begun.handoffId,
      cleanUrl: RETURN_TO
    });
    // The verifier is retired, so no window can exchange this return later.
    expect(Array.from(await shared.keys())).toEqual([]);
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('refuses a duplicate return without exchanging again', async () => {
    const { make, server } = setup();
    const handoff = make();
    const begun = await handoff.begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);

    expect((await handoff.complete(callback)).status).toBe('completed');
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('expires a handoff by the injected clock and removes it', async () => {
    const { make, server, store, clock } = setup({ ttlMs: 60_000 });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    clock.advance(60_000);

    expect(failed(await make().complete(callback)).reason).toBe('expired');
    expect(Array.from(await store.keys())).toEqual([]);
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('rechecks expiry after a claim that waited past the deadline, without exchanging', async () => {
    const { make, server, store, clock } = setup({ ttlMs: 60_000 });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    clock.advance(59_000);
    // The claim waits on another window's lock until after the deadline.
    const slow: AuthFnBrowserHandoffStore = {
      ...store,
      compareAndSet: async (key, expected, next) => {
        clock.advance(2_000);
        return store.compareAndSet(key, expected, next);
      }
    };

    expect(failed(await make({ store: slow }).complete(callback)).reason).toBe('expired');
    expect(JSON.parse(String(await store.get(`authfn.handoff.${begun.handoffId}`)))).toMatchObject({ state: 'used' });
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('refuses a callback on an origin that is not allowed without touching the store', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun).replace(APP, 'https://evil.example.com');
    const before = await dumpStore(store);

    expect(failed(await make().complete(callback)).reason).toBe('origin-mismatch');
    expect(await dumpStore(store)).toBe(before);
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['another allowed origin', (url: string) => url.replace(APP, 'https://other.example.com'), 'origin-mismatch'],
    ['another path', (url: string) => url.replace('/post-auth', '/elsewhere'), 'flow-mismatch'],
    ['a session token instead of a code', (url: string) => url.replace('handoff=code', 'handoff=token'), 'flow-mismatch']
  ] as const)('retires a handoff whose return arrives on %s', async (_label, mutate, reason) => {
    const { make, server } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);

    expect(failed(await make().complete(mutate(callback))).reason).toBe(reason);
    // The misdirected return used the handoff up: the real one cannot follow.
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('refuses a code return that no handoff is bound to, and ignores other pages', async () => {
    const { make, server } = setup();
    const handoff = make();

    expect(await handoff.complete(`${RETURN_TO}#token=test-handoff-code-1&handoff=code&keep=1`)).toEqual({
      status: 'failed',
      reason: 'flow-mismatch',
      cleanUrl: `${RETURN_TO}#keep=1`
    });
    expect(await handoff.complete('https://evil.example.com/post-auth?auth_error=x#token=test-handoff-code-1&handoff=code'))
      .toEqual({ status: 'failed', reason: 'origin-mismatch', cleanUrl: 'https://evil.example.com/post-auth' });
    expect(failed(await handoff.complete(`${RETURN_TO}#authfn_handoff=AAAAAAAAAAAAAAAAAAAAAA&token=x&handoff=code`)).reason)
      .toBe('unknown-handoff');
    expect(failed(await handoff.complete(`${RETURN_TO}#authfn_handoff=not-an-id`)).reason)
      .toBe('malformed-callback');
    expect(await handoff.complete(`${RETURN_TO}#section=2`)).toEqual({ status: 'not-callback' });
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('reports a provider error returned to the callback and retires the handoff', async () => {
    const { make, server } = setup();
    // The server re-encodes the query when it adds auth_error.
    const begun = await make().begin({ returnTo: `${APP}/post-auth?next=%2Fa%20b` });
    const url = new URL(begun.start.returnTo);
    url.searchParams.set('auth_error', 'oauth_callback_failed');
    url.searchParams.set('auth_error_code', 'AUTHFN_OAUTH_CALLBACK_INVALID');
    url.searchParams.set('auth_provider', 'google');
    url.searchParams.set('auth_request_id', 'req-callback');

    expect(await make().complete(url.href)).toMatchObject({
      status: 'failed',
      reason: 'provider-error',
      handoffId: begun.handoffId,
      error: { code: 'AUTHFN_OAUTH_CALLBACK_INVALID' },
      requestId: 'req-callback',
      cleanUrl: `${APP}/post-auth?next=%2Fa+b`
    });
    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('already-used');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('returns the two-factor challenge of the social callback and retires the handoff', async () => {
    const { make, server, events } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO, regionId: 'region-a' });
    // The callback's shape when two-factor is on: the challenge in the query,
    // the handoff id kept in the fragment, and no code.
    const url = new URL(begun.start.returnTo);
    url.searchParams.set('authfnCode', 'AUTHFN_2FA_REQUIRED');
    url.searchParams.set('challengeId', 'signin_2fa_test-challenge');
    url.searchParams.set('primaryMethod', 'oauth-google');
    // The region comes from the store, never from the callback.
    url.hash = `${url.hash.slice(1)}&regionId=region-b`;

    expect(await make().complete(url.href)).toEqual({
      status: 'two-factor-required',
      handoffId: begun.handoffId,
      challengeId: 'signin_2fa_test-challenge',
      primaryMethod: 'oauth-google',
      regionId: 'region-a',
      cleanUrl: RETURN_TO
    });
    expect(events.map((event) => event.type)).toEqual(['begun', 'two-factor-required']);
    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('already-used');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['without a challenge id', (url: URL) => url.searchParams.delete('challengeId')],
    ['with another code', (url: URL) => url.searchParams.set('authfnCode', 'AUTHFN_OTHER')],
    ['with a non-canonical challenge id', (url: URL) => url.searchParams.set('challengeId', 'Signin:2FA.Test')],
    ['with a method the social callback never sends', (url: URL) => url.searchParams.set('primaryMethod', 'password')],
    ['with a handoff code too', (url: URL) => {
      url.hash = `${url.hash.slice(1)}&token=test-handoff-code-1&handoff=code`;
    }]
  ])('refuses a two-factor return %s as malformed', async (_label, mutate) => {
    const { make, server } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const url = new URL(begun.start.returnTo);
    url.searchParams.set('authfnCode', 'AUTHFN_2FA_REQUIRED');
    url.searchParams.set('challengeId', 'signin_2fa_test-challenge');
    url.searchParams.set('primaryMethod', 'oauth-google');
    mutate(url);

    expect(failed(await make().complete(url.href)).reason).toBe('malformed-callback');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('never repeats exchange text that echoes the request', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const verifier = await storedVerifier(store, begun.handoffId);
    const callback = server.callbackFor(begun);
    const code = new URL(callback).hash.match(/token=([^&]+)/)![1]!;
    // A fetch adapter whose error message repeats the request body.
    const echo = JSON.stringify({ code, verifier });
    const result = await make({
      exchange: async () => ({
        ok: false as const,
        error: { code: 'AUTHFN_NETWORK_ERROR', message: `request ${echo} failed`, retryable: true },
        requestId: `req-${code}`
      })
    }).complete(callback);

    expect(result).toEqual({
      status: 'failed',
      reason: 'exchange-canceled',
      handoffId: begun.handoffId,
      cleanUrl: RETURN_TO,
      error: { code: 'AUTHFN_NETWORK_ERROR', message: 'The social sign-in exchange did not complete' }
    });
    const thrown = await make({
      exchange: async () => {
        throw new Error(`request ${echo} failed`);
      }
    }).complete(server.callbackFor(await make().begin({ returnTo: RETURN_TO })));
    expect(JSON.stringify(thrown)).not.toContain('request');
  });

  it.each([
    ['the client', 'direct'],
    ['the regional client without a stored region', 'regional-current'],
    ['the regional adapter with a stored region', 'regional-bound']
  ] as const)('keeps the verifier and code out of request metrics and envelopes when fetch fails through %s', async (_label, path) => {
    const metrics: AuthFnClientRequestMetric[] = [];
    const envelopes: unknown[] = [];
    // A fetch whose failure repeats the request body, as some adapters do.
    const clientOptions = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        throw new TypeError(`fetch failed for body ${String(init?.body)}`);
      },
      onRequestMetric: (metric: AuthFnClientRequestMetric) => metrics.push(metric)
    };
    const resolveBaseUrl = (regionId: string) => `https://${regionId}.account.example.com/auth`;
    let exchange: AuthFnBrowserHandoffExchange;
    if (path === 'direct') {
      exchange = createAuthFnClient({ ...clientOptions, baseUrl: `${APP}/auth` }).exchangeSocialHandoff;
    } else {
      const regionalClient = createAuthFnRegionalClient({
        defaultRegionId: 'us',
        resolveBaseUrl,
        storage: { get: async () => null, set: async () => undefined, delete: async () => undefined },
        clientOptions
      });
      exchange = createRegionalHandoffExchange({ regionalClient, resolveBaseUrl, clientOptions });
    }
    const { make, server, store } = setup({
      exchange: async (input, context) => {
        const envelope = await exchange(input, context);
        envelopes.push(envelope);
        return envelope;
      }
    });
    const begun = await make().begin({ returnTo: RETURN_TO, ...(path === 'regional-bound' ? { regionId: 'eu' } : {}) });
    const verifier = await storedVerifier(store, begun.handoffId);
    const callback = server.callbackFor(begun);
    const code = new URL(callback).hash.match(/token=([^&]+)/)![1]!;

    const result = failed(await make().complete(callback));

    expect(result.reason).toBe('exchange-canceled');
    expect(metrics).toEqual([expect.objectContaining({
      path: '/social/handoff/exchange',
      ok: false,
      error: { name: 'AuthFnTransportError', message: 'AuthFn request failed before a response was received' }
    })]);
    expect(envelopes).toEqual([expect.objectContaining({ ok: false })]);
    const observed = JSON.stringify({ metrics, envelopes, result });
    expect(observed).not.toContain(verifier);
    expect(observed).not.toContain(code);
    expect(observed).not.toContain('fetch failed for body');
  });

  it('still reports the fetch error of requests without one-time secrets', async () => {
    const metrics: AuthFnClientRequestMetric[] = [];
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => {
        throw new TypeError('network down');
      },
      onRequestMetric: (metric) => metrics.push(metric)
    });
    const envelope = await client.getSession();

    expect(envelope).toMatchObject({ ok: false, error: { code: 'AUTHFN_NETWORK_ERROR', message: 'network down' } });
    expect(metrics[0]?.error).toEqual({ name: 'TypeError', message: 'network down' });
  });

  it.each([
    ['throws (aborted)', async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }],
    ['returns a network error', async () => ({
      ok: false as const,
      error: { code: 'AUTHFN_NETWORK_ERROR', message: 'fetch failed', retryable: true },
      requestId: 'authfn-transport-error'
    })]
  ])('ends as exchange-canceled when the exchange %s, without a second attempt', async (_label, exchange) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const verifier = await storedVerifier(store, begun.handoffId);
    const callback = server.callbackFor(begun);

    const result = await make({ exchange: vi.fn(exchange) }).complete(callback);

    expect(failed(result).reason).toBe('exchange-canceled');
    expect(await dumpStore(store)).not.toContain(verifier);
    // A reload after the canceled exchange cannot reuse the verifier.
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('reports a code the server refuses as exchange-rejected', async () => {
    const { make, server } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun).replace('test-handoff-code-1', 'test-handoff-code-9');

    expect(await make().complete(callback)).toMatchObject({
      status: 'failed',
      reason: 'exchange-rejected',
      error: { code: 'AUTHFN_OAUTH_STATE_INVALID' },
      requestId: 'req-invalid'
    });
  });

  it.each([
    ['not JSON', () => '{"v":1,'],
    ['an array', () => '[]'],
    ['an unknown version', (record: Record<string, unknown>) => JSON.stringify({ ...record, v: 2 })],
    ['another handoff id', (record: Record<string, unknown>) => JSON.stringify({ ...record, id: 'BBBBBBBBBBBBBBBBBBBBBB' })],
    ['a short verifier', (record: Record<string, unknown>) => JSON.stringify({ ...record, verifier: 'short' })],
    ['no expiry', (record: Record<string, unknown>) => JSON.stringify({ ...record, expiresAt: 'later' })],
    ['a used record that keeps its verifier', (record: Record<string, unknown>) => JSON.stringify({ ...record, state: 'used' })]
  ])('removes a persisted record that is %s without exchanging', async (_label, corrupt) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    await store.set(key, corrupt(JSON.parse(String(await store.get(key)))));

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await store.get(key)).toBeNull();
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['read', 'get'],
    ['claim', 'compareAndSet']
  ] as const)('reports a store that fails to %s as malformed-state and removes the verifier', async (_label, method) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const broken: AuthFnBrowserHandoffStore = {
      ...store,
      [method]: () => Promise.reject(new Error('storage unavailable'))
    };

    expect(failed(await make({ store: broken }).complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await store.get(`authfn.handoff.${begun.handoffId}`)).toBeNull();
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('treats a pending record whose deadline is beyond any TTL as malformed-state', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const record = JSON.parse(String(await store.get(key)));
    await store.set(key, JSON.stringify({ ...record, expiresAt: T0 + 60 * 60 * 1000 + 1 }));

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await store.get(key)).toBeNull();
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed', 'malformed-state', async (store: AuthFnBrowserHandoffStore, key: string) => {
      await store.set(key, '{"v":1,');
    }],
    ['an expired', 'expired', async (_store: AuthFnBrowserHandoffStore, _key: string, clock: ReturnType<typeof createClock>) => {
      clock.advance(10 * 60 * 1000);
    }],
    ['an over-horizon', 'malformed-state', async (store: AuthFnBrowserHandoffStore, key: string) => {
      const record = JSON.parse(String(await store.get(key)));
      await store.set(key, JSON.stringify({ ...record, expiresAt: T0 + 60 * 60 * 1000 + 1 }));
    }]
  ] as const)('removes %s record even when the store cannot compare-and-set', async (_label, reason, prepare) => {
    const { make, server, store, clock } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const callback = server.callbackFor(begun);
    await prepare(store, key, clock);
    const broken: AuthFnBrowserHandoffStore = {
      ...store,
      compareAndSet: () => Promise.reject(new Error('storage unavailable'))
    };

    expect(failed(await make({ store: broken }).complete(callback)).reason).toBe(reason);
    expect(await store.get(key)).toBeNull();
    // A later return over a working store finds nothing to claim.
    expect(failed(await make().complete(callback)).reason).toBe('unknown-handoff');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('prunes a record under the prefix that is not a string, even one holding a verifier', async () => {
    const { factory, window } = createSharedIndexedDb();
    const store = window();
    const { make, server } = setup({ store });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const record = JSON.parse(String(await store.get(key)));
    // Written by something other than this helper: an object, not a string.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('authfn-handoff', 1);
      open.onsuccess = () => {
        const transaction = open.result.transaction('records', 'readwrite');
        transaction.objectStore('records').put(record, key);
        transaction.objectStore('records').put({ note: 'unrelated' }, 'unrelated-object');
        transaction.oncomplete = () => {
          open.result.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
      open.onerror = () => reject(open.error);
    });

    expect(await make().prune()).toBe(1);
    expect(await store.get(key)).toBeNull();
    expect(await store.get('unrelated-object')).toEqual({ note: 'unrelated' });
    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('unknown-handoff');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('keeps a handoff another window begins while a prune is enumerating', async () => {
    const { make, server, store, clock } = setup({ ttlMs: 60 * 60 * 1000 });
    let releaseKeys!: () => void;
    const keysPaused = new Promise<void>((resolve) => {
      releaseKeys = resolve;
    });
    let enumerating!: () => void;
    const enumerationStarted = new Promise<void>((resolve) => {
      enumerating = resolve;
    });
    const pausedStore: AuthFnBrowserHandoffStore = {
      ...store,
      keys: async () => {
        enumerating();
        await keysPaused;
        return store.keys();
      }
    };
    const pruning = make({ store: pausedStore }).prune();
    await enumerationStarted;
    // Time moves on and another window begins with the longest TTL.
    clock.advance(5 * 60 * 1000);
    const begun = await make().begin({ returnTo: RETURN_TO });
    releaseKeys();

    expect(await pruning).toBe(0);
    expect((await make().complete(server.callbackFor(begun))).status).toBe('completed');
  });

  it('never discloses the verifier through results, events, logs or the store after any outcome', async () => {
    const spies = consoleMethods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const { make, server, store, events } = setup();
    const results: unknown[] = [];
    const verifiers: string[] = [];
    const scenarios: Array<(callback: string) => string> = [
      (callback) => callback,
      (callback) => callback.replace('/post-auth', '/elsewhere'),
      (callback) => callback.replace('test-handoff-code', 'test-unknown-code')
    ];
    for (const mutate of scenarios) {
      const begun = await make().begin({ returnTo: RETURN_TO });
      verifiers.push(await storedVerifier(store, begun.handoffId));
      const callback = server.callbackFor(begun);
      results.push(await make().complete(mutate(callback)), await make().complete(callback));
    }
    const canceled = await make().begin({ returnTo: RETURN_TO });
    verifiers.push(await storedVerifier(store, canceled.handoffId));
    results.push(await make({
      exchange: async () => {
        throw new Error('network down');
      }
    }).complete(server.callbackFor(canceled)));

    const disclosed = [
      JSON.stringify(results),
      JSON.stringify(events),
      await dumpStore(store),
      JSON.stringify(spies.map((spy) => spy.mock.calls))
    ].join('\n');
    for (const verifier of verifiers) {
      expect(disclosed).not.toContain(verifier);
    }
    // Only the exchange itself, which sends it to the server, sees a verifier.
    expect(server.verifiersSeen.length).toBeGreaterThan(0);
  });

  it('prunes expired records and tombstones and leaves other keys alone', async () => {
    const { make, server, store, clock, events } = setup({ ttlMs: 1_000 });
    const handoff = make();
    const used = await handoff.begin({ returnTo: RETURN_TO });
    await handoff.complete(server.callbackFor(used));
    await handoff.begin({ returnTo: RETURN_TO });
    await store.set('authfn.handoff.garbage', 'not json');
    await store.set('unrelated', 'kept');
    clock.advance(1_000);
    const live = await handoff.begin({ returnTo: RETURN_TO });

    expect(Array.from(await store.keys()).sort()).toEqual([`authfn.handoff.${live.handoffId}`, 'unrelated']);
    expect(events).toContainEqual({ type: 'pruned', count: 3 });
    await handoff.abandon(live.handoffId);
    expect(Array.from(await store.keys())).toEqual(['unrelated']);
  });

  it.each([
    [{ allowedOrigins: [] }],
    [{ allowedOrigins: ['*'] }],
    [{ allowedOrigins: ['null'] }],
    [{ allowedOrigins: ['https://app.example.com/post-auth'] }],
    [{ allowedOrigins: ['exampleapp://oauthsignin'] }],
    [{ ttlMs: 0 }],
    [{ ttlMs: 2 * 60 * 60 * 1000 }]
  ])('refuses the configuration %j', (overrides) => {
    expect(() => setup(overrides as Partial<AuthFnBrowserHandoffOptions>).make()).toThrow(TypeError);
  });

  it.each([
    'https://evil.example.com/post-auth',
    `${RETURN_TO}#tab=x`,
    '/post-auth',
    `${APP}/post-auth?auth_error=x`,
    `${APP}/post-auth?authfnCode=AUTHFN_2FA_REQUIRED`,
    `blob:${APP}/00000000-0000-4000-8000-000000000001`
  ])('refuses to begin with returnTo %s', async (returnTo) => {
    const { make, store } = setup();
    await expect(make().begin({ returnTo })).rejects.toThrow(TypeError);
    expect(Array.from(await store.keys())).toEqual([]);
  });

  it('refuses to begin with a region id that is not a plain id', async () => {
    const { make, store } = setup();
    await expect(make().begin({ returnTo: RETURN_TO, regionId: 'eu/../x' })).rejects.toThrow(TypeError);
    expect(Array.from(await store.keys())).toEqual([]);
  });
});

describe('createRegionalHandoffExchange', () => {
  const okEnvelope = (label: string) => ({
    ok: true as const,
    requestId: label,
    data: { session: { id: `session-${label}` }, handoff: { type: 'session-token', token: `test-session-token-${label}` } }
  }) as never;
  const failedEnvelope = (label: string) => ({
    ok: false as const,
    requestId: label,
    error: { code: 'AUTHFN_OAUTH_STATE_INVALID', message: 'refused', retryable: false }
  }) as never;

  /** Region servers answer through `respond`; `regionalClient` records region selections. */
  function setupRegions() {
    const pending: Array<{ host: string; resolve: (response: Response) => void }> = [];
    const selections: string[] = [];
    let current = 'us';
    const regionalExchange = vi.fn<AuthFnSocialHandoffClient['exchangeSocialHandoff']>(async () => okEnvelope('current'));
    const regionalClient = {
      exchangeSocialHandoff: regionalExchange,
      setCurrentRegionId: (regionId: string) => {
        selections.push(regionId);
        current = regionId;
      }
    };
    const exchange = createRegionalHandoffExchange({
      regionalClient,
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      clientOptions: {
        fetch: (input) => new Promise<Response>((resolve) => {
          pending.push({ host: new URL(String(input)).host, resolve });
        })
      }
    });
    const respond = async (host: string, ok: boolean) => {
      await vi.waitFor(() => expect(pending.some((entry) => entry.host === host)).toBe(true));
      const entry = pending.splice(pending.findIndex((item) => item.host === host), 1)[0]!;
      entry.resolve(new Response(JSON.stringify(ok ? okEnvelope(host) : failedEnvelope(host)), {
        status: ok ? 200 : 400,
        headers: { 'content-type': 'application/json' }
      }));
    };
    return { exchange, respond, selections, regionalExchange, current: () => current };
  }

  const input = { code: 'test-handoff-code', verifier: 'test-verifier' };

  it.each([
    ['ap settles first', ['ap', 'eu']],
    ['eu settles first', ['eu', 'ap']]
  ] as const)('routes overlapping exchanges to their own regions without moving the client until success (%s)', async (_label, order) => {
    const { exchange, respond, selections, current } = setupRegions();
    const ap = exchange(input, { handoffId: 'handoff-ap', regionId: 'ap' });
    const eu = exchange(input, { handoffId: 'handoff-eu', regionId: 'eu' });
    // While both are in flight, the client stays where it was.
    expect(current()).toBe('us');

    for (const region of order) {
      await respond(`${region}.account.example.com`, region === 'ap');
    }

    expect((await ap).ok).toBe(true);
    expect((await eu).ok).toBe(false);
    // Only the successful exchange selects its region; the failure changes nothing.
    expect(selections).toEqual(['ap']);
    expect(current()).toBe('ap');
  });

  it('moves the client only for a response that carries a session', async () => {
    const selections: string[] = [];
    const exchange = createRegionalHandoffExchange({
      regionalClient: {
        exchangeSocialHandoff: async () => okEnvelope('current'),
        setCurrentRegionId: (regionId) => selections.push(regionId)
      },
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      // An ok response without a body: complete() refuses it, so the region must not move.
      clientOptions: { fetch: async () => new Response(null, { status: 204 }) }
    });
    const { make, server } = setup({ exchange });
    const begun = await make().begin({ returnTo: RETURN_TO, regionId: 'eu' });

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('exchange-rejected');
    expect(selections).toEqual([]);
  });

  it('uses the regional client as it is when the handoff has no region', async () => {
    const { exchange, regionalExchange, selections } = setupRegions();
    expect((await exchange(input, { handoffId: 'handoff-plain' })).ok).toBe(true);
    expect(regionalExchange).toHaveBeenCalledWith(input);
    expect(selections).toEqual([]);
  });

  it('leaves the region alone when resolving the region throws', async () => {
    const selections: string[] = [];
    const exchange = createRegionalHandoffExchange({
      regionalClient: {
        exchangeSocialHandoff: async () => okEnvelope('current'),
        setCurrentRegionId: (regionId) => selections.push(regionId)
      },
      resolveBaseUrl: () => {
        throw new Error('unknown region');
      }
    });
    const { make, server } = setup({ exchange });
    const begun = await make().begin({ returnTo: RETURN_TO, regionId: 'eu' });

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('exchange-canceled');
    expect(selections).toEqual([]);
  });
});
