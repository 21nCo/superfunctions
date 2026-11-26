import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthFnBrowserHandoffStorageError,
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

/**
 * The data of an exchange that issued a session, in the shape the server
 * sends it (core `buildUserSession`, social-oauth `buildSessionHandoffPayload`).
 */
function issuedData(sessionId: string, token: string) {
  return {
    session: {
      id: sessionId,
      type: 'session',
      subject: { actorId: 'user-1', actorType: 'user' },
      actorType: 'user',
      actorId: 'user-1',
      resourceIds: [] as string[],
      methods: ['oauth-google']
    },
    handoff: { type: 'session-token', token, sessionId, regionId: null as string | null, expiresAt: null as string | null }
  };
}

/** Server-shaped exchange data with one defect, each of which `complete()` must refuse. */
const refusedSessionData: ReadonlyArray<readonly [string, unknown]> = ([
  ['an empty session', (data) => { data.session = {}; }],
  ['an empty token', (data) => { data.handoff.token = ''; }],
  ['a whitespace-only token', (data) => { data.handoff.token = '   '; }],
  ['a whitespace-only session id', (data) => { data.session.id = ' '; data.handoff.sessionId = ' '; }],
  ['no handoff', (data) => { delete data.handoff; }],
  ['a handoff for another session', (data) => { data.handoff.sessionId = 'different-session'; }],
  ['a session without an actor id', (data) => { delete data.session.actorId; }],
  ['methods that are not an array', (data) => { data.session.methods = 'oauth-google'; }],
  ['a subject that is not the actor', (data) => { data.session.subject = { actorId: 'user-2', actorType: 'user' }; }],
  ['a handoff given as an array', (data) => { data.handoff = Object.assign([], data.handoff); }],
  ['an API key session', (data) => { data.session.type = 'api-key'; }],
  ['an API key actor', (data) => {
    data.session.actorType = 'api-key';
    data.session.subject = { actorId: 'user-1', actorType: 'api-key' };
  }],
  ['an unknown actor type', (data) => {
    data.session.actorType = 'robot';
    data.session.subject = { actorId: 'user-1', actorType: 'robot' };
  }],
  ['a handoff region that is not a string or null', (data) => { data.handoff.regionId = 7; }]
] as Array<[string, (data: { session: Record<string, unknown>; handoff: Record<string, unknown> }) => void]>)
  .map(([label, defect]) => {
    const data = issuedData('session-1', 'test-session-token') as unknown as {
      session: Record<string, unknown>;
      handoff: Record<string, unknown>;
    };
    defect(data);
    return [label, data] as const;
  });

const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
/** `text` with every byte percent-encoded, as an echo that hides it would send it. */
const percentEncoded = (text: string) => Array.from(
  new TextEncoder().encode(text),
  (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
).join('');
const MAX_TTL_MS = 60 * 60 * 1000;

/** `text` with each printable ASCII character replaced by its fullwidth form. */
const fullwidth = (text: string) => text.replace(/[!-~]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

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
      data: issuedData(`session-${exchanged}`, `test-session-token-${exchanged}`)
    } as never;
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

/** `tombstone` when `key` holds a used record with nothing but its id and expiry. */
async function retiredState(store: AuthFnBrowserHandoffStore, key: string): Promise<'absent' | 'tombstone' | 'other'> {
  const raw = await store.get(key);
  if (raw === null || raw === undefined) {
    return 'absent';
  }
  try {
    const record = JSON.parse(String(raw)) as Record<string, unknown>;
    return record.state === 'used' && Object.keys(record).sort().join() === 'expiresAt,id,issuedAt,state,v' ? 'tombstone' : 'other';
  } catch {
    return 'other';
  }
}

type StoreOp = 'get' | 'set' | 'delete' | 'keys' | 'compareAndSet';
interface ScriptStep {
  op: StoreOp;
  /** Which call of `op` (1-based) the step applies to. */
  call: number;
  /** Runs before the call reaches the store, for example another window's completion. */
  before?: () => Promise<unknown>;
  /** The call then fails instead of reaching the store. */
  fail?: boolean;
}

/** A window's view of a shared store whose calls follow `steps`. */
function scriptedStore(inner: AuthFnBrowserHandoffStore, steps: ScriptStep[]): AuthFnBrowserHandoffStore {
  const calls: Record<StoreOp, number> = { get: 0, set: 0, delete: 0, keys: 0, compareAndSet: 0 };
  const step = async (op: StoreOp) => {
    calls[op] += 1;
    const match = steps.find((candidate) => candidate.op === op && candidate.call === calls[op]);
    await match?.before?.();
    if (match?.fail) {
      throw new Error('storage unavailable');
    }
  };
  return {
    atomic: true,
    get: async (key) => (await step('get'), inner.get(key)),
    set: async (key, value) => (await step('set'), inner.set(key, value)),
    delete: async (key) => (await step('delete'), inner.delete(key)),
    keys: async () => (await step('keys'), inner.keys()),
    compareAndSet: async (key, expected, next) => (await step('compareAndSet'), inner.compareAndSet(key, expected, next))
  };
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
      issuedAt: T0,
      expiresAt: T0 + 10 * 60 * 1000
    });
    expect(await dumpStore(store)).not.toContain(verifier);
    expect(JSON.stringify(events)).not.toContain(verifier);
    expect(events.map((event) => event.type)).toEqual(['begun', 'completed']);
  });

  it('removes only the handoff parameters from cleanUrl and leaves others as the URL has them', async () => {
    const { make, server } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    const code = String(new URLSearchParams(new URL(callback).hash.slice(1)).get('token'));

    // A copy under another name is the URL author's own parameter, not the handoff's.
    const result = await make().complete(`${callback}&copy=${code}&keep=1`);

    expect(result).toMatchObject({ status: 'completed', cleanUrl: `${RETURN_TO}#copy=${code}&keep=1` });
    expect(server.exchange).toHaveBeenCalledTimes(1);
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
    expect(await retiredState(shared, `authfn.handoff.${begun.handoffId}`)).toBe('tombstone');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('treats a custom store that does not declare atomic: true as not atomic', async () => {
    const shared = createMemoryHandoffStore();
    // A read-then-write store that never says whether its claim is atomic.
    const { atomic: _atomic, ...undeclared } = shared;
    const unsure = undeclared as unknown as AuthFnBrowserHandoffStore;
    const { make, server } = setup();

    await expect(make({ store: unsure }).begin({ returnTo: RETURN_TO })).rejects.toThrow(/atomic/);
    expect(Array.from(await shared.keys())).toEqual([]);

    const begun = await make({ store: shared }).begin({ returnTo: RETURN_TO });
    expect(failed(await make({ store: unsure }).complete(server.callbackFor(begun))).reason).toBe('store-not-atomic');
    expect(await retiredState(shared, `authfn.handoff.${begun.handoffId}`)).toBe('tombstone');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('refuses to begin outside a secure context, before storing anything', async () => {
    const { make, store } = setup();
    // Browsers leave crypto.subtle undefined on pages that are not secure contexts.
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    try {
      await expect(make().begin({ returnTo: RETURN_TO })).rejects.toThrow(/secure context/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(Array.from(await store.keys())).toEqual([]);
  });

  it.each([
    ['the memory store', () => createMemoryHandoffStore()],
    ['the IndexedDB store', () => createIndexedDbHandoffStore({ indexedDB: new IDBFactory() })]
  ] as const)('refuses to begin with %s for a return on another allowed origin than the page', async (_label, createStore) => {
    const store = createStore();
    const { make } = setup({ store });
    // The bundled stores keep records for the page's origin only.
    vi.stubGlobal('location', { origin: APP });
    try {
      await expect(make().begin({ returnTo: 'https://other.example.com/post-auth' })).rejects.toThrow(/own origin/);
      expect(Array.from(await store.keys())).toEqual([]);
      expect((await make().begin({ returnTo: RETURN_TO })).handoffId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets a custom store that is not origin-scoped begin for another allowed origin', async () => {
    const inner = createMemoryHandoffStore();
    const shared: AuthFnBrowserHandoffStore = {
      get: inner.get,
      set: inner.set,
      delete: inner.delete,
      keys: inner.keys,
      compareAndSet: inner.compareAndSet,
      atomic: true
    };
    const { make } = setup({ store: shared });
    vi.stubGlobal('location', { origin: APP });
    try {
      const begun = await make().begin({ returnTo: 'https://other.example.com/post-auth' });
      expect(new URL(begun.start.returnTo).origin).toBe('https://other.example.com');
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('expires a handoff by the injected clock and retires it', async () => {
    const { make, server, store, clock } = setup({ ttlMs: 60_000 });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    clock.advance(60_000);

    expect(failed(await make().complete(callback)).reason).toBe('expired');
    expect(await retiredState(store, `authfn.handoff.${begun.handoffId}`)).toBe('tombstone');
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    // The tombstone expired with the handoff, so the next prune removes it.
    expect(await make().prune()).toBe(1);
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

  it('leaves a handoff pending when its return arrives on another allowed origin', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    const before = await dumpStore(store);

    expect(failed(await make().complete(callback.replace(APP, 'https://other.example.com'))).reason).toBe('origin-mismatch');
    expect(await dumpStore(store)).toBe(before);
    expect(server.exchange).not.toHaveBeenCalled();
    // The return on the origin it was begun for still completes.
    expect((await make().complete(callback)).status).toBe('completed');
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('completes a handoff only on a page of the callback origin, over a store shared across origins', async () => {
    const inner = createMemoryHandoffStore();
    const shared: AuthFnBrowserHandoffStore = { ...inner, atomic: true, originScoped: false };
    const { make, server } = setup({ store: shared });
    const OTHER = 'https://other.example.com';
    vi.stubGlobal('location', { origin: APP });
    try {
      const begun = await make().begin({ returnTo: `${OTHER}/post-auth` });
      const key = `authfn.handoff.${begun.handoffId}`;
      const callback = server.callbackFor(begun);
      const before = await inner.get(key);

      // A page on APP is handed the other origin's callback.
      expect(failed(await make().complete(callback)).reason).toBe('origin-mismatch');
      // A page on APP rewrites the callback onto its own origin.
      expect(failed(await make().complete(callback.replace(OTHER, APP))).reason).toBe('origin-mismatch');
      expect(await inner.get(key)).toBe(before);
      expect(server.exchange).not.toHaveBeenCalled();

      vi.stubGlobal('location', { origin: OTHER });
      expect((await make().complete(callback)).status).toBe('completed');
      expect(server.exchange).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('a return on another origin over a store shared across origins', () => {
    const OTHER = 'https://other.example.com';
    const sharedSetup = (ttlMs?: number) => {
      const inner = createMemoryHandoffStore();
      const shared: AuthFnBrowserHandoffStore = { ...inner, atomic: true, originScoped: false };
      return { inner, shared, ...setup({ store: shared, ...(ttlMs ? { ttlMs } : {}) }) };
    };

    it('leaves an expired handoff of another origin as it is', async () => {
      const { inner, make, server, clock } = sharedSetup(60_000);
      const begun = await make().begin({ returnTo: RETURN_TO });
      const callback = server.callbackFor(begun);
      clock.advance(61_000);
      const before = await dumpStore(inner);

      expect(failed(await make().complete(callback.replace(APP, OTHER))).reason).toBe('origin-mismatch');
      expect(await dumpStore(inner)).toBe(before);
      expect(server.exchange).not.toHaveBeenCalled();
    });

    it('leaves another origin\'s handoff as it is on a store that cannot claim atomically', async () => {
      const { inner, shared, make, server } = sharedSetup();
      const begun = await make().begin({ returnTo: RETURN_TO });
      const callback = server.callbackFor(begun);
      const before = await dumpStore(inner);

      expect(failed(await make({ store: { ...shared, atomic: false } }).complete(callback.replace(APP, OTHER))).reason)
        .toBe('origin-mismatch');
      expect(await dumpStore(inner)).toBe(before);
      expect(server.exchange).not.toHaveBeenCalled();
    });

    it('leaves another origin\'s handoff as it is when the first read fails and the re-read finds it', async () => {
      const { inner, shared, make, server } = sharedSetup();
      const begun = await make().begin({ returnTo: RETURN_TO });
      const callback = server.callbackFor(begun);
      const before = await dumpStore(inner);
      const flaky = scriptedStore(shared, [{ op: 'get', call: 1, fail: true }]);

      expect(failed(await make({ store: flaky }).complete(callback.replace(APP, OTHER))).reason).toBe('origin-mismatch');
      expect(await dumpStore(inner)).toBe(before);
      expect(server.exchange).not.toHaveBeenCalled();
      expect((await make().complete(callback)).status).toBe('completed');
      expect(server.exchange).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
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
    ['with a social method the callback never sends', (url: URL) => url.searchParams.set('primaryMethod', 'oauth-unknown')],
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

    const events: AuthFnBrowserHandoffEvent[] = [];
    expect(failed(await make({ onEvent: (event) => events.push(event) }).complete(url.href)).reason)
      .toBe('malformed-callback');
    expect(events.map((event) => event.type)).toEqual(['failed']);
    // The handoff is retired: a well-formed return of it cannot complete later.
    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('already-used');
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

  it('ends as exchange-canceled when fetch fails for a code equal to the network error code', async () => {
    const exchange = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => {
        throw new TypeError('fetch failed');
      }
    }).exchangeSocialHandoff;
    const { make, server } = setup({ exchange });
    const callback = new URL(server.callbackFor(await make().begin({ returnTo: RETURN_TO })));
    const fragment = new URLSearchParams(callback.hash.slice(1));
    fragment.set('token', 'AUTHFN_NETWORK_ERROR');
    callback.hash = fragment.toString();

    expect(failed(await make().complete(callback.href))).toMatchObject({
      reason: 'exchange-canceled',
      error: { code: 'AUTHFN_NETWORK_ERROR' }
    });
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

  const reflectedResponses = [
    ['a 502 with no body', 502, '', 'exchange-rejected'],
    ['a 502 error envelope repeating the body', 502, 'error-echo', 'exchange-rejected'],
    ['a 502 text body repeating the body', 502, 'text', 'exchange-rejected'],
    ['a 200 with no body', 200, '', 'exchange-rejected'],
    ['a 200 text body repeating the body', 200, 'text', 'exchange-rejected'],
    ['a 302 whose location repeats the code', 302, '', 'exchange-rejected'],
    ['a 200 issuing a session', 200, 'session', 'completed']
  ] as const;
  const exchangePaths = [
    ['the client', 'direct'],
    ['the regional client without a stored region', 'regional-current'],
    ['the regional adapter with a stored region', 'regional-bound']
  ] as const;
  it.each(exchangePaths.flatMap(([label, path]) => reflectedResponses.map(
    ([response, status, body, outcome]) => [label, response, path, status, body, outcome] as const
  )))('keeps the verifier and code out of metrics and envelopes when response headers repeat the body through %s, on %s', async (
    _label, _response, path, status, body, outcome
  ) => {
    const metrics: AuthFnClientRequestMetric[] = [];
    const envelopes: unknown[] = [];
    // A proxy or adapter that reflects the request body into response headers.
    const clientOptions = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sent = String(init?.body);
        const { code, verifier } = JSON.parse(sent) as { code: string; verifier: string };
        const payload = body === 'session'
          ? JSON.stringify({ ok: true, requestId: 'req-ok', data: issuedData('session-1', 'test-session-token') })
          : body === 'error-echo'
            ? JSON.stringify({ ok: false, requestId: code, error: { code: 'AUTHFN_BAD_GATEWAY', message: `upstream rejected ${sent}`, retryable: true, details: { sent } } })
            : body === 'text'
              ? `upstream rejected ${sent}`
              : '';
        return new Response(payload || null, {
          status,
          headers: {
            // Each value is shaped like the field it fills, so only the
            // check against the body keeps it out.
            'x-request-id': code,
            'server-timing': `proxy;desc="${encodeURIComponent(sent)}"`,
            'x-account-region': verifier.slice(0, 20),
            'x-account-db-duration-ms': encodeURIComponent(sent),
            'x-account-db-call-count': sent,
            'x-account-cache-duration-ms': code,
            'x-account-cache-call-count': verifier,
            'x-account-lookup-duration-ms': '2.5',
            'x-account-lookup-call-count': '3',
            'x-account-worker-colo': 'test-colo',
            ...(status === 302 ? { location: `${APP}/next?code=${code}` } : {})
          }
        });
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

    const result = await make().complete(callback);

    if (outcome === 'completed') {
      expect(result.status).toBe('completed');
    } else {
      expect(failed(result).reason).toBe(outcome);
    }
    expect(metrics).toEqual([{
      method: 'POST',
      path: '/social/handoff/exchange',
      url: expect.stringMatching(/\/social\/handoff\/exchange$/),
      status,
      ok: status === 200,
      durationMs: expect.any(Number),
      lookupDurationMs: '2.5',
      lookupCallCount: '3',
      workerColo: 'test-colo'
    }]);
    expect(envelopes).toHaveLength(1);
    if (status === 200 && body === '') {
      // An empty success has no session; its request id came from the echoing header.
      expect(envelopes[0]).toEqual({ ok: true, data: {}, requestId: 'authfn-redacted' });
    } else if (outcome !== 'completed') {
      expect(envelopes[0]).toEqual({
        ok: false,
        error: {
          code: expect.stringMatching(/^AUTHFN_[A-Z_]+$/),
          message: `AuthFn request failed (${status})`,
          retryable: expect.any(Boolean),
          details: { status }
        },
        requestId: expect.stringMatching(/^authfn-/)
      });
    }
    const observed = JSON.stringify({ metrics, envelopes, result });
    expect(observed).not.toContain(verifier.slice(0, 8));
    expect(observed).not.toContain(code);
    expect(observed).not.toContain('upstream rejected');
  });

  /**
   * Builds the exchange of `path` over a fetch that answers `respond(body)`,
   * recording every metric, envelope and region selection.
   */
  function exchangeOver(
    path: 'direct' | 'regional-current' | 'regional-bound' | 'custom',
    respond: (sent: { code: string; verifier: string }) => Record<string, unknown>
  ) {
    const metrics: AuthFnClientRequestMetric[] = [];
    const envelopes: unknown[] = [];
    const selections: string[] = [];
    const clientOptions = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) =>
        Response.json(respond(JSON.parse(String(init?.body)) as { code: string; verifier: string })),
      onRequestMetric: (metric: AuthFnClientRequestMetric) => metrics.push(metric)
    };
    const resolveBaseUrl = (regionId: string) => `https://${regionId}.account.example.com/auth`;
    let exchange: AuthFnBrowserHandoffExchange;
    if (path === 'custom') {
      // A host adapter that does not go through the AuthFn client at all.
      exchange = async (input) => respond(input) as never;
    } else if (path === 'direct') {
      exchange = createAuthFnClient({ ...clientOptions, baseUrl: `${APP}/auth` }).exchangeSocialHandoff;
    } else {
      const regionalClient = createAuthFnRegionalClient({
        defaultRegionId: 'us',
        resolveBaseUrl,
        storage: { get: async () => null, set: async () => undefined, delete: async () => undefined },
        clientOptions
      });
      exchange = createRegionalHandoffExchange({
        regionalClient: {
          exchangeSocialHandoff: regionalClient.exchangeSocialHandoff,
          setCurrentRegionId: (regionId) => {
            selections.push(regionId);
            regionalClient.setCurrentRegionId(regionId);
          }
        },
        resolveBaseUrl,
        clientOptions
      });
    }
    const recorded: AuthFnBrowserHandoffExchange = async (input, context) => {
      const envelope = await exchange(input, context);
      envelopes.push(envelope);
      return envelope;
    };
    return { exchange: recorded, metrics, envelopes, selections };
  }
  const successPaths = [
    ['the client', 'direct'],
    ['the regional client without a stored region', 'regional-current'],
    ['the regional adapter with a stored region', 'regional-bound'],
    ['a custom exchange', 'custom']
  ] as const;
  const successEchoes = [
    ['8 characters of the verifier in the session metadata', ({ verifier }: { code: string; verifier: string }) => {
      const data = issuedData('session-1', 'test-session-token');
      return { ok: true, requestId: 'req-echo', data: { ...data, session: { ...data.session, metadata: { debug: `v=${verifier.slice(9, 17)}` } } } };
    }],
    ['8 characters of the code in an extra handoff field', ({ code }: { code: string; verifier: string }) => {
      const data = issuedData('session-1', 'test-session-token');
      return { ok: true, requestId: 'req-echo', data: { ...data, handoff: { ...data.handoff, debugCode: code.slice(3, 11) } } };
    }],
    ['the verifier percent-encoded in the session metadata', ({ verifier }: { code: string; verifier: string }) => {
      const data = issuedData('session-1', 'test-session-token');
      return { ok: true, requestId: 'req-echo', data: { ...data, session: { ...data.session, metadata: { debug: percentEncoded(verifier) } } } };
    }],
    ['the whole body in an extra top-level field', (sent: { code: string; verifier: string }) => (
      { ok: true, requestId: 'req-echo', data: issuedData('session-1', 'test-session-token'), debug: { sent } }
    )]
  ] as const;

  it.each(successPaths.flatMap(([label, path]) => successEchoes.map(
    ([echo, respond]) => [label, echo, path, respond] as const
  )))('refuses a success through %s that repeats the body (%s)', async (_label, _echo, path, respond) => {
    const { exchange, metrics, envelopes, selections } = exchangeOver(path, respond);
    const { make, server, store, events } = setup({ exchange });
    const begun = await make().begin({ returnTo: RETURN_TO, ...(path === 'regional-bound' ? { regionId: 'eu' } : {}) });
    const verifier = await storedVerifier(store, begun.handoffId);
    const callback = server.callbackFor(begun);
    const code = new URL(callback).hash.match(/token=([^&]+)/)![1]!;

    const result = await make().complete(callback);

    expect(failed(result).reason).toBe('exchange-rejected');
    expect(selections).toEqual([]);
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    if (path !== 'custom') {
      // The client itself never passes the echo on.
      expect(envelopes).toEqual([{
        ok: false,
        error: { code: 'AUTHFN_INTERNAL_ERROR', message: 'AuthFn request failed (200)', retryable: false, details: { status: 200 } },
        requestId: 'req-echo'
      }]);
    }
    const observed = JSON.stringify({ metrics, envelopes: path === 'custom' ? [] : envelopes, result, events });
    for (const secret of [code, verifier]) {
      for (let index = 0; index + 8 <= secret.length; index += 1) {
        expect(observed).not.toContain(secret.slice(index, index + 8));
      }
    }
  });

  it.each(successPaths)('passes a genuine server success through %s unchanged and completes', async (_label, path) => {
    const body = { ok: true, requestId: 'req-issued', data: issuedData('session-1', 'test-session-token') };
    const { exchange, envelopes, selections } = exchangeOver(path, () => body);
    const { make, server } = setup({ exchange });
    const begun = await make().begin({ returnTo: RETURN_TO, ...(path === 'regional-bound' ? { regionId: 'eu' } : {}) });

    expect(await make().complete(server.callbackFor(begun))).toMatchObject({
      status: 'completed',
      session: body.data.session,
      handoff: body.data.handoff,
      requestId: 'req-issued'
    });
    expect(envelopes).toEqual([body]);
    expect(selections).toEqual(path === 'regional-bound' ? ['eu'] : []);
  });

  it('redacts by the body as sent, even when the caller changes the input before the response', async () => {
    const metrics: AuthFnClientRequestMetric[] = [];
    const sentBodies: string[] = [];
    const input = { code: 'test-handoff-code-1', verifier: 'test-verifier-'.padEnd(43, 'v') };
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async (_url, init) => {
        const sent = String(init?.body);
        sentBodies.push(sent);
        // The caller reuses its input object while the request is in flight.
        input.code = 'test-other-code';
        input.verifier = 'test-other-verifier';
        const { code } = JSON.parse(sent) as { code: string };
        return new Response(
          JSON.stringify({ ok: false, requestId: code, error: { code: 'AUTHFN_BAD_GATEWAY', message: sent, retryable: true } }),
          { status: 502, headers: { 'x-request-id': code } }
        );
      },
      onRequestMetric: (metric) => metrics.push(metric)
    });

    const envelope = await client.exchangeSocialHandoff(input);

    expect(JSON.parse(sentBodies[0]!)).toEqual({ code: 'test-handoff-code-1', verifier: 'test-verifier-'.padEnd(43, 'v') });
    expect(metrics[0]?.requestId).toBeUndefined();
    expect(envelope).toMatchObject({ ok: false, requestId: 'authfn-redacted', error: { code: 'AUTHFN_BAD_GATEWAY' } });
    const observed = JSON.stringify({ metrics, envelope });
    expect(observed).not.toContain('test-handoff-code-1');
    expect(observed).not.toContain('test-verifier-');
  });

  it.each(exchangePaths)('reports a response whose body stream aborts as exchange-canceled through %s', async (_label, path) => {
    const metrics: AuthFnClientRequestMetric[] = [];
    const envelopes: unknown[] = [];
    let fetched = 0;
    // The headers arrive, then the body stream fails with an error that repeats the request.
    const clientOptions = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetched += 1;
        const sent = String(init?.body);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new DOMException(`aborted while reading ${sent}`, 'AbortError'));
          }
        });
        return new Response(stream, { status: 200, headers: { 'x-request-id': 'req-body-aborted' } });
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
    expect(envelopes).toEqual([{
      ok: false,
      error: {
        code: 'AUTHFN_NETWORK_ERROR',
        message: 'AuthFn request failed before a response was received',
        retryable: true,
        details: { status: 200 }
      },
      requestId: 'req-body-aborted'
    }]);
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(fetched).toBe(1);
    const observed = JSON.stringify({ metrics, envelopes, result });
    expect(observed).not.toContain(verifier);
    expect(observed).not.toContain(code);
    expect(observed).not.toContain('aborted while reading');
  });

  const detailsInput = { code: 'test-handoff-code-1', verifier: 'test-verifier-'.padEnd(43, 'v') };
  /** The details a sensitive request returns for an error envelope with `details`. */
  const keptDetailsFor = async (
    code: string,
    status: number,
    details: Record<string, unknown>,
    input: { code: string; verifier: string } = detailsInput
  ) => {
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => Response.json({
        ok: false,
        requestId: 'req-detailed',
        error: { code, message: 'Request must continue elsewhere', retryable: status === 429, details }
      }, { status })
    });
    const envelope = await client.exchangeSocialHandoff(input);
    expect(envelope).toMatchObject({ ok: false, error: { code, message: `AuthFn request failed (${status})` } });
    return (envelope as { error: { details: Record<string, unknown> } }).error.details;
  };
  const mismatchDetails = {
    regionId: 'aws:eu-west-1',
    authority: 'https://eu.account.example.com',
    redirectTo: 'https://eu.account.example.com/auth',
    continueLocally: false
  };

  it('keeps the region-mismatch details hosts continue with, and nothing else', async () => {
    expect(await keptDetailsFor('AUTHFN_REGION_MISMATCH', 409, {
      ...mismatchDetails,
      userId: 'user-1',
      note: 'dropped'
    })).toEqual({ status: 409, ...mismatchDetails });
    expect(await keptDetailsFor('AUTHFN_REGION_MISMATCH', 409, { regionId: 'eu' })).toEqual({ status: 409, regionId: 'eu' });
    expect(await keptDetailsFor('AUTHFN_REGION_MISMATCH', 409, { authority: 'https://eu.example.test/', redirectTo: 'https://EU.example.test/' }))
      .toEqual({ status: 409, authority: 'https://eu.example.test/', redirectTo: 'https://EU.example.test/' });
  });

  it.each([
    ['a region id that is the code', { regionId: detailsInput.code }],
    ['a region id that is the verifier', { regionId: detailsInput.verifier }],
    ['a region id with a control character', { regionId: 'eu\u0007' }],
    ['a region id that is not a string', { regionId: 7 }],
    ['an authority that carries the code', { authority: `https://eu.account.example.com/?c=${detailsInput.code}` }],
    ['a redirect that carries part of the verifier', { redirectTo: `https://eu.account.example.com/${detailsInput.verifier.slice(10, 18)}` }],
    ['a javascript: redirect', { redirectTo: 'javascript:alert(1)' }],
    ['a relative authority', { authority: '/auth' }],
    // Built at runtime so no URL with credentials is committed.
    ['a redirect with credentials', { redirectTo: ['https://', 'test-user', ':', 'test-pass', '@eu.account.example.com'].join('') }],
    ['a redirect longer than 2048 characters', { redirectTo: `https://eu.account.example.com/${'a'.repeat(2048)}` }],
    ['a redirect with a space', { redirectTo: 'https://eu.account.example.com/a b' }],
    ['continueLocally that is not a boolean', { continueLocally: 'false' }],
    ['a redirect that carries the percent-encoded code', { redirectTo: `https://eu.example.test/?c=${percentEncoded(detailsInput.code)}` }],
    ['an authority that carries double-encoded verifier bytes', {
      authority: `https://eu.example.test/${percentEncoded(percentEncoded(detailsInput.verifier.slice(5, 25)))}`
    }],
    // new URL lowercases and IDNA-maps the hostname, which rebuilds the secret.
    ['an authority whose host is the code in upper case', { authority: `https://${detailsInput.code.toUpperCase()}.example.test/` }],
    ['a redirect whose host is the code in upper case', { redirectTo: `https://${detailsInput.code.toUpperCase()}.example.test/` }],
    ['a redirect whose host spells the code in fullwidth letters', { redirectTo: `https://${fullwidth(detailsInput.code)}.example.test/` }],
    ['an authority whose host splits a verifier run with a soft hyphen', {
      authority: `https://${detailsInput.verifier.slice(0, 6)}\u00ad${detailsInput.verifier.slice(6, 13)}.example.test/`
    }]
  ] as const)('drops a region-mismatch detail that is %s', async (_label, bad) => {
    const field = Object.keys(bad)[0]!;
    const details = await keptDetailsFor('AUTHFN_REGION_MISMATCH', 409, { ...mismatchDetails, ...bad });
    const { [field]: _dropped, ...expected } = mismatchDetails as Record<string, unknown>;
    expect(details).toEqual({ status: 409, ...expected });
  });

  it('keeps only the reset time of a rate limit, when it is an ISO timestamp', async () => {
    expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, {
      path: '/social/handoff/exchange',
      scope: 'social',
      dimension: 'ip',
      resetAt: '2026-11-26T00:10:00.000Z'
    })).toEqual({ status: 429, resetAt: '2026-11-26T00:10:00.000Z' });
    expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, { resetAt: 'tomorrow' })).toEqual({ status: 429 });
    expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, { resetAt: '2026-11-26' })).toEqual({ status: 429 });
    expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, { resetAt: Date.parse('2026-11-26T00:10:00.000Z') })).toEqual({ status: 429 });
    // A detail of another code is not kept for this one.
    expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, { regionId: 'eu' })).toEqual({ status: 429 });
  });

  it('keeps a reset time with an offset and drops one whose date or time does not exist', async () => {
    expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, { resetAt: '2028-02-29T23:59:59+05:30' }))
      .toEqual({ status: 429, resetAt: '2028-02-29T23:59:59+05:30' });
    for (const resetAt of [
      '2026-02-31T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-11-00T00:00:00Z',
      '2026-11-26T24:00:00Z',
      '2026-11-26T00:60:00Z',
      '2026-11-26T00:00:60Z',
      '2026-11-26T00:00:00+24:00'
    ]) {
      expect(await keptDetailsFor('AUTHFN_RATE_LIMITED', 429, { resetAt }), resetAt).toEqual({ status: 429 });
    }
  });

  // A verifier with no run of 8 characters in common with the field names.
  const plainInput = { code: 'test-handoff-code-1', verifier: 'test-pkce-'.padEnd(43, 'v') };

  it.each(['code', 'verifier', 'userId'])('keeps the exchange field %s a validation error names', async (field) => {
    expect(await keptDetailsFor('AUTHFN_VALIDATION_ERROR', 400, { field }, plainInput)).toEqual({ status: 400, field });
  });

  it.each([
    ['a field the exchange does not have', { field: 'email' }, plainInput],
    ['a field with different case', { field: 'Verifier' }, plainInput],
    ['a field that is not a string', { field: 7 }, plainInput]
  ] as const)('drops a validation-error field that is %s', async (_label, details, input) => {
    expect(await keptDetailsFor('AUTHFN_VALIDATION_ERROR', 400, { ...details, issue: 'required', path: ['body'] }, input))
      .toEqual({ status: 400 });
  });

  // A field name is one of the client's fixed labels, not a reflection of the request.
  it.each([
    ['equal to the code', 'verifier', { code: 'verifier', verifier: plainInput.verifier }],
    ['equal to the code', 'userId', { code: 'userId', verifier: plainInput.verifier }],
    ['inside the verifier', 'verifier', detailsInput]
  ] as const)('keeps a validation-error field %s when the field is %s', async (_label, field, input) => {
    expect(await keptDetailsFor('AUTHFN_VALIDATION_ERROR', 400, { field }, input)).toEqual({ status: 400, field });
  });

  it('keeps an error code equal to the request code only when it is one of the client\'s fixed codes', async () => {
    const errorFor = async (code: string) => {
      const client = createAuthFnClient({
        baseUrl: `${APP}/auth`,
        fetch: async () => Response.json(
          { ok: false, requestId: 'req-reflected', error: { code, message: 'Rejected', retryable: false } },
          { status: 400 }
        )
      });
      return ((await client.exchangeSocialHandoff({ code, verifier: plainInput.verifier })) as { error: { code: string } }).error.code;
    };
    expect(await errorFor('AUTHFN_OAUTH_STATE_INVALID')).toBe('AUTHFN_OAUTH_STATE_INVALID');
    expect(await errorFor('AUTHFN_REFLECTED_CODE')).toBe('AUTHFN_INTERNAL_ERROR');
  });

  it('keeps the redirect error the client builds when the request code is that label', async () => {
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => new Response(null, { status: 302, headers: { location: `${APP}/elsewhere` } })
    });
    const envelope = await client.exchangeSocialHandoff({ code: 'AUTHFN_REDIRECT_REQUIRES_NAVIGATION', verifier: plainInput.verifier });

    expect((envelope as { error: { code: string } }).error.code).toBe('AUTHFN_REDIRECT_REQUIRES_NAVIGATION');
  });

  it('keeps the destination of a redirect the exchange answers with, unless it carries the request', async () => {
    const redirectFor = async (location: string) => {
      const client = createAuthFnClient({
        baseUrl: `${APP}/auth`,
        fetch: async () => new Response(null, { status: 302, headers: { location } })
      });
      const envelope = await client.exchangeSocialHandoff(detailsInput) as { error: { code: string; details: Record<string, unknown> } };
      expect(envelope.error.code).toBe('AUTHFN_REDIRECT_REQUIRES_NAVIGATION');
      return envelope.error.details;
    };
    expect(await redirectFor('https://app.example.test/next')).toEqual({ status: 302, redirectTo: 'https://app.example.test/next' });
    expect(await redirectFor('/next?tab=1')).toEqual({ status: 302, redirectTo: '/next?tab=1' });
    expect(await redirectFor(`https://app.example.test/next?c=${detailsInput.code}`)).toEqual({ status: 302 });
    expect(await redirectFor(`/next?c=${percentEncoded(detailsInput.code)}`)).toEqual({ status: 302 });
    expect(await redirectFor(`https://${detailsInput.code.toUpperCase()}.example.test/`)).toEqual({ status: 302 });
    expect(await redirectFor('//elsewhere.example.test/next')).toEqual({ status: 302 });
    expect(await redirectFor('next')).toEqual({ status: 302 });
  });

  it('keeps only the field of a validation error', async () => {
    expect(await keptDetailsFor('AUTHFN_VALIDATION_ERROR', 400, {
      field: 'verifier',
      reason: 'required',
      regionId: 'eu',
      resetAt: '2026-11-26T00:10:00.000Z'
    }, plainInput)).toEqual({ status: 400, field: 'verifier' });
  });

  it('keeps no details but the status for errors without kept details', async () => {
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => Response.json({
        ok: false,
        requestId: 'req-invalid',
        error: { code: 'AUTHFN_OAUTH_STATE_INVALID', message: 'invalid', retryable: false, details: { regionId: 'eu', field: 'code' } }
      }, { status: 400 })
    });

    const envelope = await client.exchangeSocialHandoff({ code: 'test-handoff-code-1', verifier: 'test-verifier' });

    expect(envelope).toMatchObject({ ok: false, error: { code: 'AUTHFN_OAUTH_STATE_INVALID', details: { status: 400 } } });
    expect((envelope as { error: { details: unknown } }).error.details).toEqual({ status: 400 });
  });

  it('reports an exchange region header by the region id contract unless it repeats the verifier', async () => {
    const verifier = 'test-verifier-'.repeat(4);
    const metrics: AuthFnClientRequestMetric[] = [];
    const region = { value: 'aws:eu-west-1' };
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => new Response(null, { status: 502, headers: { 'x-account-region': region.value } }),
      onRequestMetric: (metric) => metrics.push(metric)
    });
    await client.exchangeSocialHandoff({ code: 'test-handoff-code-1', verifier });
    region.value = `eu:${verifier.slice(3, 11)}`;
    await client.exchangeSocialHandoff({ code: 'test-handoff-code-1', verifier });
    region.value = percentEncoded(verifier.slice(2, 22));
    await client.exchangeSocialHandoff({ code: 'test-handoff-code-1', verifier });

    expect(metrics[0]?.accountRegion).toBe('aws:eu-west-1');
    expect(metrics[1]).not.toHaveProperty('accountRegion');
    expect(metrics[2]).not.toHaveProperty('accountRegion');
  });

  it('still reports the response headers of requests without one-time secrets', async () => {
    const metrics: AuthFnClientRequestMetric[] = [];
    const client = createAuthFnClient({
      baseUrl: `${APP}/auth`,
      fetch: async () => new Response(null, {
        status: 502,
        headers: { 'x-request-id': 'req-session-1', 'server-timing': 'app;dur=3', 'x-account-region': 'us' }
      }),
      onRequestMetric: (metric) => metrics.push(metric)
    });
    const envelope = await client.getSession();

    expect(envelope).toMatchObject({ ok: false, requestId: 'req-session-1' });
    expect(metrics[0]).toMatchObject({ requestId: 'req-session-1', serverTiming: 'app;dur=3', accountRegion: 'us' });
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

  it.each(refusedSessionData)('refuses an ok exchange response with %s as exchange-rejected', async (_label, data) => {
    const exchange = vi.fn(async () => ({ ok: true, requestId: 'req-incomplete', data }) as never);
    const { make, server } = setup({ exchange });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);

    expect(failed(await make().complete(callback)).reason).toBe('exchange-rejected');
    expect(exchange).toHaveBeenCalledTimes(1);
    // The handoff stays retired.
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
  });

  it('completes with a server-shaped session and handoff passed on unchanged', async () => {
    const data = issuedData('session-1', 'test-session-token');
    data.handoff.regionId = 'eu';
    data.handoff.expiresAt = '2026-11-27T00:00:00.000Z';
    const exchange = vi.fn(async () => ({ ok: true, requestId: 'req-issued', data }) as never);
    const { make, server } = setup({ exchange });
    const begun = await make().begin({ returnTo: RETURN_TO });

    expect(await make().complete(server.callbackFor(begun))).toMatchObject({
      status: 'completed',
      session: data.session,
      handoff: data.handoff,
      requestId: 'req-issued'
    });
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
  ])('retires a persisted record that is %s without exchanging', async (_label, corrupt) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    await store.set(key, corrupt(JSON.parse(String(await store.get(key)))));

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['read', 'get'],
    ['claim', 'compareAndSet']
  ] as const)('reports a store that fails to %s as malformed-state and retires the verifier', async (_label, method) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const broken: AuthFnBrowserHandoffStore = {
      ...store,
      [method]: () => Promise.reject(new Error('storage unavailable'))
    };

    expect(failed(await make({ store: broken }).complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await retiredState(store, `authfn.handoff.${begun.handoffId}`)).toBe('tombstone');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('treats a pending record whose deadline is beyond any TTL as malformed-state', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const record = JSON.parse(String(await store.get(key)));
    await store.set(key, JSON.stringify({ ...record, expiresAt: T0 + 60 * 60 * 1000 + 1 }));

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    'not-an-origin',
    'javascript:',
    `${APP}/`,
    APP.toUpperCase(),
    '',
    'null'
  ])('retires a pending record whose stored origin %j is not a page origin', async (origin) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const record = JSON.parse(String(await store.get(key)));
    await store.set(key, JSON.stringify({ ...record, origin }));

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(await dumpStore(store)).not.toContain(record.verifier);
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('prunes a pending record whose stored origin is not a page origin', async () => {
    const { make, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const record = JSON.parse(String(await store.get(key)));
    await store.set(key, JSON.stringify({ ...record, origin: 'javascript:' }));

    expect(await make().prune()).toBe(1);
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(await dumpStore(store)).not.toContain(record.verifier);
  });

  it('retires a pending record with no lifetime but keeps a zero-lifetime tombstone final', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const callback = server.callbackFor(begun);
    const record = JSON.parse(String(await store.get(key)));
    // Both still in the future, so only the lifetime is wrong.
    await store.set(key, JSON.stringify({ ...record, issuedAt: record.expiresAt }));

    expect(failed(await make().complete(callback)).reason).toBe('malformed-state');
    expect(await dumpStore(store)).not.toContain(record.verifier);
    const tombstone = JSON.parse(String(await store.get(key)));
    expect(tombstone.state).toBe('used');
    await store.set(key, JSON.stringify({ ...tombstone, issuedAt: tombstone.expiresAt }));
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('judges a record lifetime by its own issue time, not the reading clock', async () => {
    const { make, server, store, clock } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const record = JSON.parse(String(await store.get(key)));
    await store.set(key, JSON.stringify({ ...record, expiresAt: record.issuedAt + MAX_TTL_MS + 1 }));
    // Read after the impossible deadline, when no reading clock would catch it.
    clock.advance(61 * 60 * 1000);

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(await dumpStore(store)).not.toContain(record.verifier);
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ['1 ms', 1],
    ['30 minutes', 30 * 60 * 1000]
  ] as const)('keeps a live handoff with the longest TTL when the clock steps back %s', async (_label, step) => {
    const { make, server, store, clock } = setup({ ttlMs: MAX_TTL_MS });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    clock.advance(-step);

    // Another window's prune, as its begin() runs one.
    expect(await make().prune()).toBe(0);
    expect((await make().complete(callback)).status).toBe('completed');
    expect(await retiredState(store, `authfn.handoff.${begun.handoffId}`)).toBe('tombstone');
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('keeps a tombstone final when the clock steps back', async () => {
    const { make, server, store, clock } = setup({ ttlMs: MAX_TTL_MS });
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const callback = server.callbackFor(begun);
    expect((await make().complete(callback)).status).toBe('completed');
    const tombstone = await store.get(key);
    clock.advance(-1);

    expect(await make().prune()).toBe(0);
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(await store.get(key)).toBe(tombstone);
    expect(server.exchange).toHaveBeenCalledTimes(1);
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
    }],
    ['a non-string', 'malformed-state', async (store: AuthFnBrowserHandoffStore, key: string) => {
      // Written by something other than this helper, which stores strings.
      await store.set(key, JSON.parse(String(await store.get(key))) as never);
    }]
  ] as const)('retires %s record even when the store cannot compare-and-set', async (_label, reason, prepare) => {
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
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(await dumpStore(store)).not.toContain('verifier');
    // A later return over a working store finds the tombstone.
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('deletes the record when the store can neither compare-and-set nor write', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const key = `authfn.handoff.${begun.handoffId}`;
    const callback = server.callbackFor(begun);
    await store.set(key, '{"v":1,');
    const unavailable = () => Promise.reject(new Error('storage unavailable'));
    const broken: AuthFnBrowserHandoffStore = { ...store, compareAndSet: unavailable, set: unavailable };

    expect(failed(await make({ store: broken }).complete(callback)).reason).toBe('malformed-state');
    // The verifier is gone; the documented cost is that a later return
    // reads unknown-handoff instead of already-used.
    expect(await retiredState(store, key)).toBe('absent');
    expect(failed(await make().complete(callback)).reason).toBe('unknown-handoff');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('keeps the tombstone of a window that claimed first when this window\'s claim fails', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    const key = `authfn.handoff.${begun.handoffId}`;
    // This window read the pending record; another window claims and
    // completes before this window's compare-and-set fails.
    const broken: AuthFnBrowserHandoffStore = {
      ...store,
      compareAndSet: async () => {
        expect((await make().complete(callback)).status).toBe('completed');
        throw new Error('storage unavailable');
      }
    };

    expect(failed(await make({ store: broken }).complete(callback)).reason).toBe('already-used');
    expect(JSON.parse(String(await store.get(key))).state).toBe('used');
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('keeps the tombstone of a window that claims after this window re-reads a failed claim', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    const key = `authfn.handoff.${begun.handoffId}`;
    // This window's claim throws; its cleanup re-reads the pending record,
    // and only then does another window claim and complete.
    let claimFailed = false;
    let otherWindowDone = false;
    const broken: AuthFnBrowserHandoffStore = {
      ...store,
      atomic: true,
      get: async (name) => {
        const value = await store.get(name);
        if (claimFailed && !otherWindowDone) {
          otherWindowDone = true;
          expect((await make().complete(callback)).status).toBe('completed');
        }
        return value;
      },
      compareAndSet: async (name, expected, next) => {
        if (!claimFailed) {
          claimFailed = true;
          throw new Error('storage unavailable');
        }
        return store.compareAndSet(name, expected, next);
      }
    };

    expect(failed(await make({ store: broken }).complete(callback)).reason).toBe('already-used');
    expect(otherWindowDone).toBe(true);
    expect(JSON.parse(String(await store.get(key))).state).toBe('used');
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  // Another window completes the same return at a chosen point of this
  // window's retirement: its tombstone must survive, a later return reads
  // already-used, and the code is exchanged exactly once.
  it.each([
    ['complete', 'its read fails after the other window completed', 'already-used',
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'get', call: 1, before: other, fail: true }]],
    ['complete', 'its read fails and the other window completes before the re-read', 'already-used',
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'get', call: 1, fail: true }, { op: 'get', call: 2, before: other }]],
    ['complete', 'its read fails and the other window completes before the retirement', 'already-used',
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'get', call: 1, fail: true }, { op: 'compareAndSet', call: 1, before: other }]],
    ['complete', 'its claim fails after the other window completed', 'already-used',
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'compareAndSet', call: 1, before: other, fail: true }]],
    ['complete', 'its claim fails and the other window completes after the re-read', 'already-used',
      (other: () => Promise<unknown>): ScriptStep[] => [
        { op: 'compareAndSet', call: 1, fail: true },
        { op: 'compareAndSet', call: 2, before: other }
      ]],
    ['complete', 'its claim and retirement fail around the other window\'s completion', 'already-used',
      (other: () => Promise<unknown>): ScriptStep[] => [
        { op: 'compareAndSet', call: 1, fail: true },
        { op: 'compareAndSet', call: 2, before: other, fail: true }
      ]],
    ['abandon', 'the other window completes before its read', undefined,
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'get', call: 1, before: other }]],
    ['abandon', 'the other window completes between its read and its write', undefined,
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'compareAndSet', call: 1, before: other }]],
    ['abandon', 'its compare-and-set fails after the other window completed', undefined,
      (other: () => Promise<unknown>): ScriptStep[] => [{ op: 'compareAndSet', call: 1, before: other, fail: true }]]
  ] as const)('keeps another window\'s tombstone when this window\'s %s runs and %s', async (action, _label, reason, script) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    const key = `authfn.handoff.${begun.handoffId}`;
    let winner: unknown;
    const other = async () => {
      expect((await make().complete(callback)).status).toBe('completed');
      winner = await store.get(key);
    };
    const thisWindow = make({ store: scriptedStore(store, script(other)) });

    if (action === 'complete') {
      expect(failed(await thisWindow.complete(callback)).reason).toBe(reason);
    } else {
      await thisWindow.abandon(begun.handoffId);
    }
    expect(await retiredState(store, key)).toBe('tombstone');
    // The other window's tombstone is left byte for byte.
    expect(await store.get(key)).toBe(winner);
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchanged).toBe(1);
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  // A window with a shorter TTL fails to read (or to claim and then read)
  // after another window completed: its retirement must not rewrite the
  // winner's tombstone with its own, earlier expiry, so a duplicate return
  // still reads already-used until the winner's deadline.
  it.each([
    ['complete', 'its read fails', (): ScriptStep[] => [{ op: 'get', call: 1, fail: true }]],
    ['abandon', 'its read fails', (): ScriptStep[] => [{ op: 'get', call: 1, fail: true }]],
    ['complete', 'its claim and the re-read of it fail', (other?: () => Promise<unknown>): ScriptStep[] => [
      { op: 'compareAndSet', call: 1, before: other, fail: true },
      { op: 'get', call: 2, fail: true }
    ]]
  ] as const)('keeps a committed tombstone final when this window\'s %s and %s', async (action, label, script) => {
    const { make, server, store, clock } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const callback = server.callbackFor(begun);
    const key = `authfn.handoff.${begun.handoffId}`;
    let winner: unknown;
    const other = async () => {
      expect((await make().complete(callback)).status).toBe('completed');
      winner = await store.get(key);
    };
    // A failed read happens after the other window completed; a failed
    // claim races it, so the other window completes just before it.
    const claimRace = label.startsWith('its claim');
    if (!claimRace) {
      await other();
    }
    const thisWindow = make({ ttlMs: 1000, store: scriptedStore(store, script(claimRace ? other : undefined)) });

    if (action === 'complete') {
      expect(failed(await thisWindow.complete(callback)).reason).toBe('already-used');
    } else {
      await thisWindow.abandon(begun.handoffId);
    }
    expect(winner).toEqual(expect.any(String));
    expect(await store.get(key)).toBe(winner);
    // Past this window's TTL, before the winner's deadline.
    clock.advance(5000);
    expect(await make().prune()).toBe(0);
    expect(failed(await make().complete(callback)).reason).toBe('already-used');
    expect(server.exchange).toHaveBeenCalledTimes(1);
  });

  it('surfaces only a fixed storage error when store failures repeat the stored records', async () => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO });
    const verifier = await storedVerifier(store, begun.handoffId);
    // Every call commits what it was asked to do, then fails with the
    // whole store in its message and cause.
    const leak = async () => {
      const dump = await dumpStore(store);
      return new Error(`storage failed: ${dump}`, { cause: dump });
    };
    const leaky: AuthFnBrowserHandoffStore = {
      atomic: true,
      get: async (key) => {
        await store.get(key);
        throw await leak();
      },
      set: async (key, value) => {
        await store.set(key, value);
        throw await leak();
      },
      delete: async (key) => {
        throw await leak().finally(() => store.delete(key));
      },
      keys: async () => {
        throw await leak();
      },
      compareAndSet: async (key, expected, next) => {
        const leaked = await leak();
        await store.compareAndSet(key, expected, next);
        throw leaked;
      }
    };
    const handoff = make({ store: leaky });
    const thrown: unknown[] = [];
    const capture = (promise: Promise<unknown>) => promise.then(
      () => expect.unreachable('expected a storage error'),
      (error: unknown) => thrown.push(error)
    );

    await capture(handoff.prune());
    await capture(handoff.abandon(begun.handoffId));
    const result = await make({ store: { ...leaky, keys: () => [] } }).complete(server.callbackFor(begun));

    expect(failed(result).reason).toBe('malformed-state');
    expect(thrown).toHaveLength(2);
    for (const error of thrown) {
      expect(error).toBeInstanceOf(AuthFnBrowserHandoffStorageError);
      expect(error).toMatchObject({ name: 'AuthFnBrowserHandoffStorageError', message: 'The browser handoff store failed' });
      expect((error as Error).cause).toBeUndefined();
    }
    const surfaced = JSON.stringify({
      result,
      thrown: thrown.map((error) => ({ ...(error as Error), message: (error as Error).message, stack: (error as Error).stack }))
    });
    expect(surfaced).not.toContain(verifier);
    expect(surfaced).not.toContain('storage failed');
    expect(server.exchange).not.toHaveBeenCalled();
  });

  it('retires a begun record whose write committed before the store failed', async () => {
    const { make, store } = setup();
    const committing: AuthFnBrowserHandoffStore = {
      ...store,
      set: async (key, value) => {
        await store.set(key, value);
        throw new Error(`storage failed after writing ${value}`);
      }
    };

    const error = await make({ store: committing }).begin({ returnTo: RETURN_TO }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthFnBrowserHandoffStorageError);
    expect(String((error as Error).message)).not.toContain('verifier');
    const keys = Array.from(await store.keys());
    expect(keys).toHaveLength(1);
    expect(await retiredState(store, keys[0]!)).toBe('tombstone');
    expect(await dumpStore(store)).not.toContain('verifier');
  });

  it('counts a pruned record only when it was removed', async () => {
    const { make, store, clock, events } = setup();
    const expired = await make().begin({ returnTo: RETURN_TO });
    const claimed = await make().begin({ returnTo: RETURN_TO });
    const claimedKey = `authfn.handoff.${claimed.handoffId}`;
    const record = JSON.parse(String(await store.get(claimedKey)));
    await store.set(claimedKey, JSON.stringify({ v: 1, id: record.id, state: 'used', issuedAt: record.issuedAt, expiresAt: record.expiresAt }));
    clock.advance(10 * 60 * 1000);
    const unavailable = () => Promise.reject(new Error('storage unavailable'));
    const failing: AuthFnBrowserHandoffStore = { ...store, compareAndSet: unavailable, set: unavailable, delete: unavailable };

    expect(await make({ store: failing }).prune()).toBe(0);
    expect(events.some((event) => event.type === 'pruned')).toBe(false);
    expect(await store.get(`authfn.handoff.${expired.handoffId}`)).not.toBeNull();

    // With only compare-and-set failing, the expired pending record is
    // retired by a plain write of its tombstone (counted), and the expired
    // tombstone, which holds no secret, is left (not counted).
    const casFailing: AuthFnBrowserHandoffStore = { ...store, compareAndSet: unavailable };
    expect(await make({ store: casFailing }).prune()).toBe(1);
    expect(await retiredState(store, `authfn.handoff.${expired.handoffId}`)).toBe('tombstone');
    expect(await retiredState(store, claimedKey)).toBe('tombstone');
    // A working store then removes both expired tombstones.
    expect(await make().prune()).toBe(2);
    expect(Array.from(await store.keys())).toEqual([]);
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
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(await store.get('unrelated-object')).toEqual({ note: 'unrelated' });
    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('already-used');
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
    const garbageKey = `authfn.handoff.${'g'.repeat(22)}`;
    await store.set(garbageKey, 'not json');
    // Under the prefix but not a handoff id: another instance's or the host's key.
    await store.set('authfn.handoff.garbage', 'not json');
    await store.set('unrelated', 'kept');
    clock.advance(1_000);
    const live = await handoff.begin({ returnTo: RETURN_TO });

    // The expired tombstone is removed; the expired and the garbage record
    // become tombstones without a verifier.
    expect(events).toContainEqual({ type: 'pruned', count: 3 });
    expect(await store.get(`authfn.handoff.${used.handoffId}`)).toBeNull();
    expect(await store.get('unrelated')).toBe('kept');
    expect(await retiredState(store, garbageKey)).toBe('tombstone');
    expect(await store.get('authfn.handoff.garbage')).toBe('not json');
    const liveKey = `authfn.handoff.${live.handoffId}`;
    const liveVerifier = await storedVerifier(store, live.handoffId);
    await handoff.abandon(live.handoffId);
    expect(await retiredState(store, liveKey)).toBe('tombstone');
    expect(await dumpStore(store)).not.toContain(liveVerifier);
    expect(failed(await handoff.complete(server.callbackFor(live))).reason).toBe('already-used');
    clock.advance(60 * 60 * 1000);
    expect(await handoff.prune()).toBe(3);
    expect(Array.from(await store.keys()).sort()).toEqual(['authfn.handoff.garbage', 'unrelated']);
  });

  it('leaves the records of an instance with a nested prefix on the same store alone', async () => {
    const { make, server, store } = setup();
    const outer = make();
    const inner = make({ keyPrefix: 'authfn.handoff.admin.' });
    const innerBegun = await inner.begin({ returnTo: RETURN_TO });
    // begin prunes, and so does an explicit prune: neither touches the other's record.
    const outerBegun = await outer.begin({ returnTo: RETURN_TO });
    expect(await outer.prune()).toBe(0);
    expect(await inner.prune()).toBe(0);

    expect(await inner.complete(server.callbackFor(innerBegun))).toMatchObject({ status: 'completed' });
    expect(await outer.complete(server.callbackFor(outerBegun))).toMatchObject({ status: 'completed' });
    expect(server.exchange).toHaveBeenCalledTimes(2);
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

  // 255 characters counted as code points, as the server counts them; each is two UTF-16 units.
  const longRegionId = '\u{1F30D}'.repeat(255);
  const invalidRegionIds = [
    ['empty', ''],
    ['256 characters', '\u{1F30D}'.repeat(256)],
    ['a control character', 'eu\u0007'],
    ['leading whitespace', ' eu'],
    ['trailing whitespace', 'eu\n']
  ] as const;

  it.each([
    ['a region id with a colon', 'aws:eu-west-1'],
    ['a 255-character region id', longRegionId]
  ])('keeps %s through begin, reload, the two-factor result and adapter routing', async (_label, regionId) => {
    const routed: string[] = [];
    const exchange = createRegionalHandoffExchange({
      regionalClient: {
        exchangeSocialHandoff: async () => {
          throw new Error('the stored region must be used');
        },
        setCurrentRegionId: () => undefined
      },
      resolveBaseUrl: (region) => {
        routed.push(region);
        return `https://region.account.example.com/auth`;
      },
      clientOptions: {
        fetch: async () => Response.json({
          ok: true,
          requestId: 'req-ok',
          data: issuedData('session-1', 'test-session-token')
        })
      }
    });
    const { make, server } = setup({ exchange });

    const twoFactor = await make().begin({ returnTo: RETURN_TO, regionId });
    const url = new URL(twoFactor.start.returnTo);
    url.searchParams.set('authfnCode', 'AUTHFN_2FA_REQUIRED');
    url.searchParams.set('challengeId', 'signin_2fa_test-challenge');
    url.searchParams.set('primaryMethod', 'oauth-google');
    // A fresh instance over the same store, as after a reload.
    expect(await make().complete(url.href)).toMatchObject({ status: 'two-factor-required', regionId });

    const begun = await make().begin({ returnTo: RETURN_TO, regionId });
    expect((await make().complete(server.callbackFor(begun))).status).toBe('completed');
    expect(routed).toEqual([regionId]);
  });

  it.each(invalidRegionIds)('refuses to begin with a region id that is %s', async (_label, regionId) => {
    const { make, store } = setup();
    await expect(make().begin({ returnTo: RETURN_TO, regionId })).rejects.toThrow(TypeError);
    expect(Array.from(await store.keys())).toEqual([]);
  });

  it.each(invalidRegionIds)('treats a stored region id that is %s as malformed-state', async (_label, regionId) => {
    const { make, server, store } = setup();
    const begun = await make().begin({ returnTo: RETURN_TO, regionId: 'eu' });
    const key = `authfn.handoff.${begun.handoffId}`;
    await store.set(key, JSON.stringify({ ...JSON.parse(String(await store.get(key))), regionId }));

    expect(failed(await make().complete(server.callbackFor(begun))).reason).toBe('malformed-state');
    expect(await retiredState(store, key)).toBe('tombstone');
    expect(server.exchange).not.toHaveBeenCalled();
  });
});

describe('createRegionalHandoffExchange', () => {
  const okEnvelope = (label: string) => ({
    ok: true as const,
    requestId: label,
    data: issuedData(`session-${label}`, `test-session-token-${label}`)
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

  it.each([
    ['no body', () => new Response(null, { status: 204 })] as const,
    ...refusedSessionData.map(([label, data]) => [
      label,
      () => Response.json({ ok: true, requestId: 'req-refused', data })
    ] as const)
  ])('moves the client only for a response that carries a session (%s)', async (_label, respond) => {
    const selections: string[] = [];
    const exchange = createRegionalHandoffExchange({
      regionalClient: {
        exchangeSocialHandoff: async () => okEnvelope('current'),
        setCurrentRegionId: (regionId) => selections.push(regionId)
      },
      resolveBaseUrl: (regionId) => `https://${regionId}.account.example.com/auth`,
      // An ok response complete() refuses, so the region must not move.
      clientOptions: { fetch: async () => respond() }
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
