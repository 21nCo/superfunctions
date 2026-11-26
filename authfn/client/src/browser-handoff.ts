import type {
  AuthFnErrorEnvelope,
  AuthFnRegionalClient,
  AuthFnSocialHandoffClient
} from './types.js';

/**
 * Single-use browser handoff for social sign-in (AUTH-38).
 *
 * `begin()` keeps a random verifier in `store`, binds the flow to a random
 * handoff id carried in the `returnTo` fragment, and returns the
 * `/social/start` input. When the callback lands, `complete()` checks the
 * origin and the flow, claims the stored record by replacing it with a
 * tombstone that no longer holds the verifier, and only then exchanges the
 * one-time code with the verifier through the existing
 * `/social/handoff/exchange` route. The claim must be atomic across every
 * window that shares the store: the server consumes each code once, but a
 * retried `/social/start` can mint a second code for the same handoff, so
 * only the claim keeps a begun handoff to one completion. A store that
 * cannot claim atomically (`atomic: false`) is refused.
 *
 * Navigation (sending the browser to `redirectTo`, removing the callback
 * parameters from the address bar with `cleanUrl`) stays with the host.
 */

type Awaitable<T> = T | Promise<T>;

/** Key-value storage the handoff keeps its single-use records in. */
export interface AuthFnBrowserHandoffStore {
  get(key: string): Awaitable<string | null | undefined>;
  set(key: string, value: string): Awaitable<void>;
  delete(key: string): Awaitable<void>;
  /** Keys currently stored, used by `prune()` to retire expired records. */
  keys(): Awaitable<Iterable<string>>;
  /**
   * Replaces the value of `key` with `next` (or removes it when `next` is
   * `null`) only if it still equals `expected`, and reports whether it did.
   * It must be atomic across every participant that shares the store
   * (several windows over `localStorage`).
   */
  compareAndSet(key: string, expected: string, next: string | null): Awaitable<boolean>;
  /**
   * `false` when `compareAndSet` cannot be atomic across participants; the
   * handoff then refuses to begin or complete. Omitted means atomic.
   */
  readonly atomic?: boolean;
}

/** The part of Web Storage (`localStorage`, `sessionStorage`) the store uses. */
export interface AuthFnWebStorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The part of the Web Locks API (`navigator.locks`) the store uses. */
export interface AuthFnLockManagerLike {
  request(name: string, options: { mode: 'exclusive' }, callback: () => unknown): Promise<unknown>;
}

export interface AuthFnBrowserHandoffClock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export type AuthFnBrowserHandoffExchange = (
  input: { code: string; verifier: string },
  /**
   * `regionId` is the region passed to `begin()`, read back from the store,
   * never from the callback URL.
   */
  context: { handoffId: string; regionId?: string }
) => ReturnType<AuthFnSocialHandoffClient['exchangeSocialHandoff']>;

export type AuthFnBrowserHandoffEvent =
  | { type: 'begun'; handoffId: string; expiresAt: string }
  | { type: 'completed'; handoffId: string }
  | { type: 'two-factor-required'; handoffId: string }
  | { type: 'failed'; handoffId?: string; reason: AuthFnBrowserHandoffFailureReason }
  | { type: 'pruned'; count: number };

export interface AuthFnBrowserHandoffOptions {
  store: AuthFnBrowserHandoffStore;
  /** Absolute http(s) origins on which a handoff may begin and complete. */
  allowedOrigins: readonly string[];
  /**
   * Usually `client.exchangeSocialHandoff`; with the region-aware client,
   * `createRegionalHandoffExchange(regionalClient)`.
   */
  exchange: AuthFnBrowserHandoffExchange;
  clock?: AuthFnBrowserHandoffClock;
  /** How long a begun handoff may wait for its callback. Default 10 minutes, at most 1 hour. */
  ttlMs?: number;
  /** Store key prefix. Default `authfn.handoff.`. */
  keyPrefix?: string;
  /** Observability hook. Events never carry the verifier or the code. */
  onEvent?(event: AuthFnBrowserHandoffEvent): void;
}

export interface AuthFnBrowserHandoffBeginInput {
  /** Absolute http(s) URL on an allowed origin, without a fragment. */
  returnTo: string;
  /**
   * The region the sign-in starts in (`regionalClient.getCurrentRegionId()`).
   * It is stored with the handoff and given to `exchange`, so the exchange
   * after a reload reaches the region that issued the code.
   */
  regionId?: string;
}

export interface AuthFnBrowserHandoffBeginResult {
  handoffId: string;
  expiresAt: string;
  /** Spread into `client.startSocialSignIn({ provider, ...start })`. */
  start: {
    returnTo: string;
    callbackMode: 'redirect';
    handoffMode: 'session-token';
    handoffChallenge: string;
  };
}

export type AuthFnBrowserHandoffFailureReason =
  /** The callback is not on an allowed origin, or not on the origin the handoff began on. */
  | 'origin-mismatch'
  /** The callback is not the code-and-verifier return of the handoff it names. */
  | 'flow-mismatch'
  /** No handoff with this id is stored (never begun here, abandoned, or long expired). */
  | 'unknown-handoff'
  | 'expired'
  /** The handoff was already claimed: a duplicate return, a reload, or another window. */
  | 'already-used'
  /** The stored record could not be read; it is removed. */
  | 'malformed-state'
  | 'malformed-callback'
  /** The callback reports that sign-in failed before a code was issued. */
  | 'provider-error'
  /** The server refused the code. Start the sign-in again. */
  | 'exchange-rejected'
  /** The exchange did not complete (network failure or abort). Start the sign-in again. */
  | 'exchange-canceled'
  /** The store cannot claim atomically across windows (`atomic: false`); nothing was exchanged. */
  | 'store-not-atomic';

export type AuthFnBrowserHandoffResult =
  | {
      status: 'completed';
      handoffId: string;
      session: SocialHandoffData['session'];
      handoff: SocialHandoffData['handoff'];
      requestId: string;
      /** The callback URL without the handoff parameters, for `history.replaceState`. */
      cleanUrl: string;
    }
  | {
      /**
       * The server needs a second factor before it issues a session. The
       * handoff is retired; continue with
       * `client.completeTwoFactorChallenge({ challengeId, code })`.
       */
      status: 'two-factor-required';
      handoffId: string;
      challengeId: string;
      primaryMethod: string;
      cleanUrl: string;
    }
  | {
      status: 'failed';
      reason: AuthFnBrowserHandoffFailureReason;
      handoffId?: string;
      /** A fixed message; it never repeats free-form text from the exchange. */
      error?: { code: string; message: string };
      requestId?: string;
      /** Present whenever the callback URL could be parsed. */
      cleanUrl?: string;
    }
  /** The URL carries no handoff callback; there is nothing to do. */
  | { status: 'not-callback' };

export interface AuthFnBrowserHandoff {
  begin(input: AuthFnBrowserHandoffBeginInput): Promise<AuthFnBrowserHandoffBeginResult>;
  /** Completes the handoff named by a callback URL (usually `location.href`). Never throws for callback or store content. */
  complete(callbackUrl: string | URL): Promise<AuthFnBrowserHandoffResult>;
  /** Retires a pending handoff, for example when the user closes the sign-in. */
  abandon(handoffId: string): Promise<void>;
  /** Removes expired records and tombstones. `begin()` also does this. Returns how many were removed. */
  prune(): Promise<number>;
}

type SocialHandoffData = Extract<
  Awaited<ReturnType<AuthFnSocialHandoffClient['exchangeSocialHandoff']>>,
  { ok: true }
>['data'];

interface PendingRecord {
  v: 1;
  id: string;
  state: 'pending';
  origin: string;
  path: string;
  verifier: string;
  expiresAt: number;
  regionId?: string;
}

interface UsedRecord {
  v: 1;
  id: string;
  state: 'used';
  expiresAt: number;
}

type StoredRecord = PendingRecord | UsedRecord;

const HANDOFF_ID_PARAM = 'authfn_handoff';
const CODE_PARAM = 'token';
const MODE_PARAM = 'handoff';
const REGION_PARAM = 'regionId';
const FRAGMENT_PARAMS = [HANDOFF_ID_PARAM, CODE_PARAM, MODE_PARAM, REGION_PARAM];
const ERROR_QUERY_PARAMS = ['auth_error', 'auth_error_code', 'auth_provider', 'auth_request_id'];
const TWO_FACTOR_CODE_PARAM = 'authfnCode';
const TWO_FACTOR_QUERY_PARAMS = [TWO_FACTOR_CODE_PARAM, 'challengeId', 'primaryMethod'];
/** Query parameters the social callback adds to the return target. */
const SERVER_QUERY_PARAMS = [...ERROR_QUERY_PARAMS, ...TWO_FACTOR_QUERY_PARAMS];
const TWO_FACTOR_REQUIRED_CODE = 'AUTHFN_2FA_REQUIRED';
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const REGION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const CHALLENGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const METHOD_PATTERN = /^[a-z0-9_-]{1,64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const USED_RECORD_KEYS = ['expiresAt', 'id', 'state', 'v'].join();
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const DEFAULT_KEY_PREFIX = 'authfn.handoff.';
const REPLAYED_CODE = 'AUTHFN_OAUTH_STATE_REPLAYED';
const NETWORK_ERROR_CODE = 'AUTHFN_NETWORK_ERROR';
const INTERNAL_ERROR_CODE = 'AUTHFN_INTERNAL_ERROR';
const NOT_ATOMIC_MESSAGE = 'createBrowserHandoff needs a store that claims atomically across windows; '
  + 'this store is atomic: false (for example localStorage without navigator.locks)';
const EXCHANGE_FAILURE_MESSAGES: Partial<Record<AuthFnBrowserHandoffFailureReason, string>> = {
  'already-used': 'This social sign-in was already completed',
  'exchange-canceled': 'The social sign-in exchange did not complete',
  'exchange-rejected': 'The server refused the social sign-in code'
};

export function createBrowserHandoff(options: AuthFnBrowserHandoffOptions): AuthFnBrowserHandoff {
  const store = options.store;
  if (!store || typeof store.compareAndSet !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('createBrowserHandoff needs a store with get, set, delete, keys and compareAndSet');
  }
  if (typeof options.exchange !== 'function') {
    throw new TypeError('createBrowserHandoff needs an exchange function, such as client.exchangeSocialHandoff');
  }
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`createBrowserHandoff ttlMs must be a whole number of milliseconds from 1 to ${MAX_TTL_MS}`);
  }
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  if (typeof keyPrefix !== 'string' || keyPrefix.length === 0) {
    throw new TypeError('createBrowserHandoff keyPrefix must be a non-empty string');
  }
  const now = () => options.clock?.now() ?? Date.now();
  const keyFor = (handoffId: string) => `${keyPrefix}${handoffId}`;
  const emit = (event: AuthFnBrowserHandoffEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability must not change the outcome.
    }
  };
  const fail = (
    reason: AuthFnBrowserHandoffFailureReason,
    extra: Omit<Extract<AuthFnBrowserHandoffResult, { status: 'failed' }>, 'status' | 'reason'> = {}
  ): AuthFnBrowserHandoffResult => {
    emit({ type: 'failed', handoffId: extra.handoffId, reason });
    return { status: 'failed', reason, ...extra };
  };

  const prune = async (): Promise<number> => {
    const current = now();
    let removed = 0;
    for (const key of Array.from(await store.keys())) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      const raw = await store.get(key);
      if (typeof raw !== 'string') {
        continue;
      }
      const record = parseRecord(raw, key.slice(keyPrefix.length));
      if ((!record || record.expiresAt <= current) && await store.compareAndSet(key, raw, null)) {
        removed += 1;
      }
    }
    if (removed > 0) {
      emit({ type: 'pruned', count: removed });
    }
    return removed;
  };

  return {
    async begin(input) {
      const target = parseBeginTarget(input?.returnTo, allowedOrigins);
      const regionId = input?.regionId;
      if (regionId !== undefined && (typeof regionId !== 'string' || !REGION_ID_PATTERN.test(regionId))) {
        throw new TypeError('begin regionId must be a region id of letters, digits, dot, dash or underscore');
      }
      if (store.atomic === false) {
        throw new Error(NOT_ATOMIC_MESSAGE);
      }
      await prune();
      const handoffId = randomBase64Url(16);
      const verifier = randomBase64Url(32);
      const handoffChallenge = await sha256Base64Url(verifier);
      const expiresAt = now() + ttlMs;
      const record: PendingRecord = {
        v: 1,
        id: handoffId,
        state: 'pending',
        origin: target.origin,
        // Serialized as the callback's query is compared, so a target whose
        // query the server re-encodes (auth_error, authfnCode) still matches.
        path: target.pathname + stripServerParams(target.search),
        verifier,
        expiresAt,
        ...(regionId ? { regionId } : {})
      };
      await store.set(keyFor(handoffId), JSON.stringify(record));
      const returnTo = new URL(target.href);
      returnTo.hash = new URLSearchParams({ [HANDOFF_ID_PARAM]: handoffId }).toString();
      const expiresAtIso = new Date(expiresAt).toISOString();
      emit({ type: 'begun', handoffId, expiresAt: expiresAtIso });
      return {
        handoffId,
        expiresAt: expiresAtIso,
        start: {
          returnTo: returnTo.href,
          callbackMode: 'redirect',
          handoffMode: 'session-token',
          handoffChallenge
        }
      };
    },

    async complete(callbackUrl) {
      let url: URL;
      try {
        url = new URL(String(callbackUrl));
      } catch {
        return fail('malformed-callback');
      }
      const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
      const handoffIdValues = fragment.getAll(HANDOFF_ID_PARAM);
      const looksLikeHandoff = fragment.has(CODE_PARAM)
        || fragment.has(MODE_PARAM)
        || url.searchParams.has('auth_error')
        || url.searchParams.has(TWO_FACTOR_CODE_PARAM);
      if (handoffIdValues.length === 0 && !looksLikeHandoff) {
        return { status: 'not-callback' };
      }
      const cleanUrl = stripCallbackParams(url);
      if (!allowedOrigins.has(url.origin)) {
        return fail('origin-mismatch', { cleanUrl });
      }
      if (handoffIdValues.length === 0) {
        // A callback that no handoff of this helper is bound to.
        return fail('flow-mismatch', { cleanUrl });
      }
      const handoffId = handoffIdValues[0]!;
      if (handoffIdValues.length !== 1 || !HANDOFF_ID_PATTERN.test(handoffId)) {
        return fail('malformed-callback', { cleanUrl });
      }
      const key = keyFor(handoffId);
      if (store.atomic === false) {
        // Without an atomic claim two windows could both exchange; retire
        // the verifier instead (removing it is safe without a lock).
        await retire(() => store.delete(key));
        return fail('store-not-atomic', { handoffId, cleanUrl });
      }
      let raw: string | null | undefined;
      try {
        raw = await store.get(key);
      } catch {
        return fail('malformed-state', { handoffId, cleanUrl });
      }
      if (raw === null || raw === undefined) {
        return fail('unknown-handoff', { handoffId, cleanUrl });
      }
      if (typeof raw !== 'string') {
        await retire(() => store.delete(key));
        return fail('malformed-state', { handoffId, cleanUrl });
      }
      const record = parseRecord(raw, handoffId);
      if (!record) {
        await retire(() => store.compareAndSet(key, raw, null));
        return fail('malformed-state', { handoffId, cleanUrl });
      }
      if (record.state === 'used') {
        return fail('already-used', { handoffId, cleanUrl });
      }
      if (record.expiresAt <= now()) {
        await retire(() => store.compareAndSet(key, raw, null));
        return fail('expired', { handoffId, cleanUrl });
      }

      // From here on the callback names a live handoff, so any outcome
      // retires it: a misdirected or corrupted return must not leave the
      // verifier for a second attempt.
      const tombstone = JSON.stringify({
        v: 1,
        id: handoffId,
        state: 'used',
        expiresAt: record.expiresAt
      } satisfies UsedRecord);
      let claimed: boolean;
      try {
        claimed = await store.compareAndSet(key, raw, tombstone);
      } catch {
        return fail('malformed-state', { handoffId, cleanUrl });
      }
      if (!claimed) {
        return fail('already-used', { handoffId, cleanUrl });
      }
      // The claim can wait on another window's lock: the deadline is checked
      // again before anything is exchanged. The tombstone stays.
      if (record.expiresAt <= now()) {
        return fail('expired', { handoffId, cleanUrl });
      }

      if (url.origin !== record.origin) {
        return fail('origin-mismatch', { handoffId, cleanUrl });
      }
      if (url.pathname + stripServerParams(url.search) !== record.path) {
        return fail('flow-mismatch', { handoffId, cleanUrl });
      }
      const twoFactor = readTwoFactorChallenge(url, fragment);
      if (twoFactor === 'malformed') {
        return fail('malformed-callback', { handoffId, cleanUrl });
      }
      if (twoFactor) {
        emit({ type: 'two-factor-required', handoffId });
        return { status: 'two-factor-required', handoffId, ...twoFactor, cleanUrl };
      }
      if (url.searchParams.has('auth_error')) {
        if (fragment.has(CODE_PARAM)) {
          return fail('malformed-callback', { handoffId, cleanUrl });
        }
        const requestId = matching(url.searchParams.get('auth_request_id'), REQUEST_ID_PATTERN);
        return fail('provider-error', {
          handoffId,
          cleanUrl,
          error: {
            code: matching(url.searchParams.get('auth_error_code'), ERROR_CODE_PATTERN) ?? 'AUTHFN_OAUTH_CALLBACK_FAILED',
            message: 'Social sign-in did not complete'
          },
          ...(requestId ? { requestId } : {})
        });
      }
      const codes = fragment.getAll(CODE_PARAM);
      const modes = fragment.getAll(MODE_PARAM);
      if (modes.length !== 1 || modes[0] !== 'code') {
        return fail(modes.length === 0 && codes.length === 0 ? 'malformed-callback' : 'flow-mismatch', {
          handoffId,
          cleanUrl
        });
      }
      const code = codes[0];
      if (codes.length !== 1 || !code || !CODE_PATTERN.test(code)) {
        return fail('malformed-callback', { handoffId, cleanUrl });
      }
      // Text from the exchange is passed on only in a fixed shape that cannot
      // carry the verifier or the code back out.
      const verifier = record.verifier;
      const safeText = (value: unknown, pattern: RegExp): string | undefined =>
        typeof value === 'string' && pattern.test(value) && !value.includes(verifier) && !value.includes(code)
          ? value
          : undefined;

      let envelope: Awaited<ReturnType<AuthFnBrowserHandoffExchange>>;
      try {
        envelope = await options.exchange(
          { code, verifier },
          { handoffId, ...(record.regionId ? { regionId: record.regionId } : {}) }
        );
      } catch {
        return fail('exchange-canceled', {
          handoffId,
          cleanUrl,
          error: { code: NETWORK_ERROR_CODE, message: EXCHANGE_FAILURE_MESSAGES['exchange-canceled']! }
        });
      }
      if (!envelope || typeof envelope !== 'object') {
        return fail('exchange-rejected', { handoffId, cleanUrl });
      }
      const requestId = safeText((envelope as { requestId?: unknown }).requestId, REQUEST_ID_PATTERN);
      if (envelope.ok !== true) {
        const errorCode = safeText((envelope as AuthFnErrorEnvelope).error?.code, ERROR_CODE_PATTERN)
          ?? INTERNAL_ERROR_CODE;
        const reason: AuthFnBrowserHandoffFailureReason = errorCode === REPLAYED_CODE
          ? 'already-used'
          : errorCode === NETWORK_ERROR_CODE
            ? 'exchange-canceled'
            : 'exchange-rejected';
        return fail(reason, {
          handoffId,
          cleanUrl,
          error: { code: errorCode, message: EXCHANGE_FAILURE_MESSAGES[reason]! },
          ...(requestId ? { requestId } : {})
        });
      }
      const data = envelope.data;
      if (!data || typeof data.handoff?.token !== 'string' || !data.session) {
        return fail('exchange-rejected', { handoffId, cleanUrl });
      }
      emit({ type: 'completed', handoffId });
      return {
        status: 'completed',
        handoffId,
        session: data.session,
        handoff: data.handoff,
        requestId: requestId ?? 'authfn-browser-handoff',
        cleanUrl
      };
    },

    async abandon(handoffId) {
      if (typeof handoffId !== 'string' || !HANDOFF_ID_PATTERN.test(handoffId)) {
        return;
      }
      await store.delete(keyFor(handoffId));
    },

    prune
  };
}

/** A store over `Map`, atomic within one JavaScript realm. */
export function createMemoryHandoffStore(): AuthFnBrowserHandoffStore {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
    delete: (key) => {
      values.delete(key);
    },
    keys: () => Array.from(values.keys()),
    compareAndSet: (key, expected, next) => compareAndSetSync(values, key, expected, next),
    atomic: true
  };
}

/**
 * The exchange for the region-aware client: it sends the code to the region
 * passed to `begin()` (through the client's own `resolveBaseUrl`), even when
 * the page after the redirect starts in the default region, and leaves the
 * client in that region once the session is issued.
 */
export function createRegionalHandoffExchange(
  client: Pick<AuthFnRegionalClient, 'getCurrentRegionId' | 'setCurrentRegionId'> & AuthFnSocialHandoffClient
): AuthFnBrowserHandoffExchange {
  return async (input, context) => {
    if (!context.regionId) {
      return client.exchangeSocialHandoff(input);
    }
    const previous = client.getCurrentRegionId();
    client.setCurrentRegionId(context.regionId);
    const response = await client.exchangeSocialHandoff(input).catch((error: unknown) => {
      client.setCurrentRegionId(previous);
      throw error;
    });
    if (!response.ok) {
      client.setCurrentRegionId(previous);
    }
    return response;
  };
}

export interface AuthFnWebStorageHandoffStoreOptions {
  /**
   * Lock manager that makes `compareAndSet` atomic across windows of the
   * origin. Defaults to `navigator.locks` when the browser has it. Without
   * one the store is `atomic: false`, and the handoff refuses to use it.
   */
  locks?: AuthFnLockManagerLike | null;
}

/** A store over `localStorage` or `sessionStorage`, atomic through Web Locks. */
export function createWebStorageHandoffStore(
  storage: AuthFnWebStorageLike,
  options: AuthFnWebStorageHandoffStoreOptions = {}
): AuthFnBrowserHandoffStore {
  const locks = options.locks === undefined
    ? (globalThis as { navigator?: { locks?: AuthFnLockManagerLike } }).navigator?.locks ?? null
    : options.locks;
  const map = {
    get: (key: string) => storage.getItem(key) ?? undefined,
    set: (key: string, value: string) => storage.setItem(key, value),
    delete: (key: string) => storage.removeItem(key)
  };
  return {
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    delete: (key) => storage.removeItem(key),
    keys: () => {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null) {
          keys.push(key);
        }
      }
      return keys;
    },
    compareAndSet: async (key, expected, next) => locks
      ? await locks.request(`authfn-handoff:${key}`, { mode: 'exclusive' }, () =>
          compareAndSetSync(map, key, expected, next)) === true
      : compareAndSetSync(map, key, expected, next),
    atomic: locks !== null
  };
}

function compareAndSetSync(
  map: { get(key: string): string | undefined; set(key: string, value: string): unknown; delete(key: string): unknown },
  key: string,
  expected: string,
  next: string | null
): boolean {
  if (map.get(key) !== expected) {
    return false;
  }
  if (next === null) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
  return true;
}

function matching(value: string | null, pattern: RegExp): string | undefined {
  return value !== null && pattern.test(value) ? value : undefined;
}

async function retire(action: () => Awaitable<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // The outcome is already decided; a store failure must not replace it.
  }
}

function normalizeAllowedOrigins(input: readonly string[] | undefined): Set<string> {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('createBrowserHandoff needs at least one allowed origin');
  }
  const origins = new Set<string>();
  for (const entry of input) {
    let url: URL | undefined;
    try {
      url = typeof entry === 'string' ? new URL(entry) : undefined;
    } catch {
      url = undefined;
    }
    if (
      !url
      || (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search
      || url.hash
      || (entry !== url.origin && entry !== `${url.origin}/`)
    ) {
      throw new TypeError(`createBrowserHandoff allowedOrigins entries must be http(s) origins: ${String(entry)}`);
    }
    origins.add(url.origin);
  }
  return origins;
}

function parseBeginTarget(returnTo: unknown, allowedOrigins: Set<string>): URL {
  let target: URL;
  try {
    target = new URL(String(returnTo));
  } catch {
    throw new TypeError('begin returnTo must be an absolute URL');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    throw new TypeError('begin returnTo must be an http(s) URL');
  }
  if (typeof returnTo !== 'string' || !allowedOrigins.has(target.origin)) {
    throw new TypeError('begin returnTo must be on an allowed origin');
  }
  if (target.username || target.password) {
    throw new TypeError('begin returnTo must not carry credentials');
  }
  if (target.hash || returnTo.includes('#')) {
    throw new TypeError('begin returnTo must not have a fragment; the handoff uses it');
  }
  if (SERVER_QUERY_PARAMS.some((name) => target.searchParams.has(name))) {
    throw new TypeError(`begin returnTo must not carry the callback parameters ${SERVER_QUERY_PARAMS.join(', ')}`);
  }
  return target;
}

function parseRecord(raw: string, handoffId: string): StoredRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1
    || record.id !== handoffId
    || typeof record.expiresAt !== 'number'
    || !Number.isFinite(record.expiresAt)
  ) {
    return null;
  }
  if (record.state === 'used') {
    // A tombstone holds nothing else; one that still carries the verifier
    // (or anything more) is not one this helper wrote.
    return Object.keys(record).sort().join() === USED_RECORD_KEYS
      ? { v: 1, id: handoffId, state: 'used', expiresAt: record.expiresAt }
      : null;
  }
  if (
    record.state !== 'pending'
    || typeof record.origin !== 'string'
    || typeof record.path !== 'string'
    || !record.path.startsWith('/')
    || typeof record.verifier !== 'string'
    || !VERIFIER_PATTERN.test(record.verifier)
    || (record.regionId !== undefined
      && (typeof record.regionId !== 'string' || !REGION_ID_PATTERN.test(record.regionId)))
  ) {
    return null;
  }
  return {
    v: 1,
    id: handoffId,
    state: 'pending',
    origin: record.origin,
    path: record.path,
    verifier: record.verifier,
    expiresAt: record.expiresAt,
    ...(typeof record.regionId === 'string' ? { regionId: record.regionId } : {})
  };
}

/**
 * Reads the social callback's two-factor return
 * (`?authfnCode=AUTHFN_2FA_REQUIRED&challengeId=…&primaryMethod=…`, no code).
 */
function readTwoFactorChallenge(
  url: URL,
  fragment: URLSearchParams
): { challengeId: string; primaryMethod: string } | 'malformed' | null {
  const present = TWO_FACTOR_QUERY_PARAMS.some((name) => url.searchParams.has(name));
  if (!present) {
    return null;
  }
  const single = (name: string, pattern: RegExp) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 && pattern.test(values[0]!) ? values[0]! : undefined;
  };
  const authfnCode = single(TWO_FACTOR_CODE_PARAM, ERROR_CODE_PATTERN);
  const challengeId = single('challengeId', CHALLENGE_ID_PATTERN);
  const primaryMethod = single('primaryMethod', METHOD_PATTERN);
  if (
    authfnCode !== TWO_FACTOR_REQUIRED_CODE
    || !challengeId
    || !primaryMethod
    || fragment.has(CODE_PARAM)
    || fragment.has(MODE_PARAM)
    || url.searchParams.has('auth_error')
  ) {
    return 'malformed';
  }
  return { challengeId, primaryMethod };
}

function stripServerParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of SERVER_QUERY_PARAMS) {
    params.delete(name);
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

function stripCallbackParams(url: URL): string {
  const clean = new URL(url.href);
  clean.search = stripServerParams(url.search);
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
  for (const name of FRAGMENT_PARAMS) {
    fragment.delete(name);
  }
  const hash = fragment.toString();
  clean.hash = hash;
  return clean.href;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
