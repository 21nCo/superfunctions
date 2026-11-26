import { createAuthFnClient } from './client.js';
import { isRegionId } from './region-id.js';
import { repeatsSecret, safeText } from './secret-text.js';
import type {
  AuthFnClientOptions,
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
 * cannot claim atomically (`atomic: false`) is refused. In a browser the
 * store is `createIndexedDbHandoffStore()`: its compare-and-set runs in one
 * IndexedDB readwrite transaction, which the browser serializes across every
 * window, tab and process of the origin.
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
   * (every window, tab and renderer process of the origin).
   */
  compareAndSet(key: string, expected: string, next: string | null): Awaitable<boolean>;
  /**
   * `true` only when `compareAndSet` is atomic across participants. Any
   * other value, including a missing one, makes the handoff refuse to begin
   * or complete.
   */
  readonly atomic: boolean;
  /**
   * `true` when the store holds records for one origin only, as the bundled
   * IndexedDB and memory stores do. `begin()` then refuses a `returnTo` on
   * another origin than the page's, whose return could never find the
   * record.
   */
  readonly originScoped?: boolean;
}

/** The part of `IDBFactory` (`globalThis.indexedDB`) the store uses. */
export interface AuthFnIndexedDbFactoryLike {
  open(name: string, version?: number): unknown;
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
   * `createRegionalHandoffExchange({ regionalClient, resolveBaseUrl })`.
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
       * `client.completeTwoFactorChallenge({ challengeId, code })` in the
       * region that issued the challenge (`regionId`).
       */
      status: 'two-factor-required';
      handoffId: string;
      challengeId: string;
      primaryMethod: string;
      /**
       * The region passed to `begin()`, read back from the store, never from
       * the callback URL. The challenge exists only there.
       */
      regionId?: string;
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
  /** A store failure throws `AuthFnBrowserHandoffStorageError`, never the store's own error. */
  begin(input: AuthFnBrowserHandoffBeginInput): Promise<AuthFnBrowserHandoffBeginResult>;
  /** Completes the handoff named by a callback URL (usually `location.href`). Never throws for callback or store content. */
  complete(callbackUrl: string | URL): Promise<AuthFnBrowserHandoffResult>;
  /**
   * Retires a pending handoff, for example when the user closes the sign-in.
   * Throws `AuthFnBrowserHandoffStorageError` only if the store could neither
   * retire nor delete it.
   */
  abandon(handoffId: string): Promise<void>;
  /**
   * Retires expired or malformed records and removes expired tombstones.
   * `begin()` also does this. Returns how many it confirmed retired or
   * removed; a record the store fails on is left and not counted.
   */
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
const READ_FAILED = Symbol('read-failed');
/** Query parameters the social callback adds to the return target. */
const SERVER_QUERY_PARAMS = [...ERROR_QUERY_PARAMS, ...TWO_FACTOR_QUERY_PARAMS];
const TWO_FACTOR_REQUIRED_CODE = 'AUTHFN_2FA_REQUIRED';
const HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
/** The server's canonical challenge id spelling (`CANONICAL_CHALLENGE_ID`). */
const CHALLENGE_ID_PATTERN = /^[a-z0-9_-]{1,255}$/;
/** The social sign-in methods the social callback names (`SOCIAL_PROVIDER_METHODS`). */
const SOCIAL_METHODS = new Set(['oauth-google', 'oauth-apple', 'oauth-github']);
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
  + 'this store is not atomic: true (for example createIndexedDbHandoffStore without IndexedDB)';
const NO_WEB_CRYPTO_MESSAGE = 'createBrowserHandoff needs Web Crypto (crypto.getRandomValues and crypto.subtle), '
  + 'which browsers provide only in secure contexts (https, or http on localhost)';
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
  const guarded = guardStore(store);
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

  /**
   * Retires the record under `key`, which was last seen holding `observed`
   * (anything but a string when it could not be read or is not a string),
   * by replacing it with a used tombstone that holds no verifier. A
   * tombstone is final: retirement only ever replaces it with another
   * tombstone, and only `prune()` removes it once it has expired. The ladder, in the order of what matters most (at most one
   * exchange, then no verifier left behind, then a later return still
   * reading `already-used`):
   * 1. compare-and-set `observed` -> tombstone; `changed` when another
   *    participant moved the record first;
   * 2. if that throws (or nothing could be compared), a plain write of the
   *    tombstone, which can at most overwrite another participant's
   *    tombstone with one;
   * 3. if that throws too, delete: the verifier is gone, and a later return
   *    reads `unknown-handoff` instead of `already-used`.
   */
  const retire = async (
    key: string,
    observed: unknown,
    expiresAt: number
  ): Promise<'tombstoned' | 'changed' | 'deleted' | 'failed'> => {
    const tombstone = tombstoneFor(key.slice(keyPrefix.length), expiresAt);
    if (typeof observed === 'string') {
      try {
        return await guarded.compareAndSet(key, observed, tombstone) ? 'tombstoned' : 'changed';
      } catch {
        // The plain write below.
      }
    }
    try {
      await guarded.set(key, tombstone);
      return 'tombstoned';
    } catch {
      // The delete below.
    }
    try {
      await guarded.delete(key);
      return 'deleted';
    } catch {
      return 'failed';
    }
  };
  /** When a retired record's tombstone expires: its own deadline, never earlier than now. */
  const tombstoneExpiry = (record: StoredRecord | null): number =>
    record ? Math.max(record.expiresAt, now()) : now() + ttlMs;
  /** The stored value, or `READ_FAILED` when the store could not read it. */
  const read = async (key: string): Promise<unknown> => {
    try {
      return await guarded.get(key);
    } catch {
      return READ_FAILED;
    }
  };

  const prune = async (): Promise<number> => {
    let removed = 0;
    for (const key of await guarded.keys()) {
      // Only this instance's records: a key whose suffix is not a handoff id
      // belongs to another instance (a nested prefix) or to the host.
      if (typeof key !== 'string' || !key.startsWith(keyPrefix) || !HANDOFF_ID_PATTERN.test(key.slice(keyPrefix.length))) {
        continue;
      }
      const raw = await read(key);
      if (raw === READ_FAILED || raw === null || raw === undefined) {
        // An unreadable record is left for complete(), which retires it.
        continue;
      }
      // The clock is read after the record, so a record another window
      // began while this prune was enumerating is judged by a time no
      // earlier than its own begin.
      const current = now();
      const record = typeof raw === 'string' ? parseRecord(raw, key.slice(keyPrefix.length), current) : null;
      if (record?.state === 'used') {
        // An expired tombstone holds no secret: it is removed only if it is
        // still the same tombstone, and left when the store fails.
        if (record.expiresAt <= current) {
          try {
            if (await guarded.compareAndSet(key, raw as string, null)) {
              removed += 1;
            }
          } catch {
            // Left for a later prune.
          }
        }
        continue;
      }
      // Expired or malformed pending state and values this helper never
      // writes (it stores strings) may hold a verifier: retire them.
      if (!record || record.expiresAt <= current) {
        const outcome = await retire(key, raw, tombstoneExpiry(record));
        if (outcome === 'tombstoned' || outcome === 'deleted') {
          removed += 1;
        }
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
      if (regionId !== undefined && !isRegionId(regionId)) {
        throw new TypeError('begin regionId must be a region id: 1 to 255 characters, '
          + 'no control characters and no leading or trailing whitespace');
      }
      if (store.atomic !== true) {
        throw new Error(NOT_ATOMIC_MESSAGE);
      }
      const pageOrigin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
      if (store.originScoped === true && typeof pageOrigin === 'string' && target.origin !== pageOrigin) {
        throw new TypeError('begin returnTo must be on the page\'s own origin: this store keeps records for one origin');
      }
      // Checked before anything is stored: on a page that is not a secure
      // context `crypto.subtle` is missing.
      const webCrypto = (globalThis as { crypto?: Partial<Crypto> }).crypto;
      if (typeof webCrypto?.getRandomValues !== 'function' || typeof webCrypto.subtle?.digest !== 'function') {
        throw new Error(NO_WEB_CRYPTO_MESSAGE);
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
      const key = keyFor(handoffId);
      const serialized = JSON.stringify(record);
      try {
        await guarded.set(key, serialized);
      } catch (error) {
        // The write may have committed before the store failed: retire it.
        await retire(key, serialized, expiresAt);
        throw error;
      }
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
      const raw = await read(key);
      if (raw === null || raw === undefined) {
        return fail(store.atomic === true ? 'unknown-handoff' : 'store-not-atomic', { handoffId, cleanUrl });
      }
      const record = typeof raw === 'string' ? parseRecord(raw, handoffId, now()) : null;
      if (store.atomic !== true) {
        // Without an atomic claim two windows could both exchange; retire
        // the verifier instead.
        if (record?.state !== 'used') {
          await retire(key, raw, tombstoneExpiry(record));
        }
        return fail('store-not-atomic', { handoffId, cleanUrl });
      }
      if (!record) {
        // Unreadable, not a string, or not a record this helper wrote: it
        // cannot be trusted to be claimed later, so it is retired.
        await retire(key, raw, tombstoneExpiry(null));
        return fail('malformed-state', { handoffId, cleanUrl });
      }
      if (record.state === 'used') {
        return fail('already-used', { handoffId, cleanUrl });
      }
      if (record.expiresAt <= now()) {
        await retire(key, raw, tombstoneExpiry(record));
        return fail('expired', { handoffId, cleanUrl });
      }

      // From here on the callback names a live handoff, so any outcome
      // retires it: a misdirected or corrupted return must not leave the
      // verifier for a second attempt.
      let claimed: boolean;
      try {
        claimed = await guarded.compareAndSet(key, raw as string, tombstoneFor(handoffId, record.expiresAt));
      } catch {
        // Whether the claim committed is unknown, so this window never
        // exchanges. It reads the record again: another participant's
        // tombstone is left as it is; anything else is retired.
        const current = await read(key);
        if (typeof current === 'string' && parseRecord(current, handoffId, now())?.state === 'used') {
          return fail('already-used', { handoffId, cleanUrl });
        }
        if (current !== null && current !== undefined && await retire(key, current, record.expiresAt) === 'changed') {
          return fail('already-used', { handoffId, cleanUrl });
        }
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
        return {
          status: 'two-factor-required',
          handoffId,
          ...twoFactor,
          ...(record.regionId ? { regionId: record.regionId } : {}),
          cleanUrl
        };
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
      const secrets = [code, verifier];

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
      const requestId = safeText((envelope as { requestId?: unknown }).requestId, REQUEST_ID_PATTERN, secrets);
      if (envelope.ok !== true) {
        const errorCode = safeText((envelope as AuthFnErrorEnvelope).error?.code, ERROR_CODE_PATTERN, secrets)
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
      const data = acceptedHandoffSession(envelope, secrets);
      if (!data) {
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
      const key = keyFor(handoffId);
      const raw = await read(key);
      if (raw === null || raw === undefined) {
        return;
      }
      const record = typeof raw === 'string' ? parseRecord(raw, handoffId, now()) : null;
      if (record?.state !== 'used' && await retire(key, raw, tombstoneExpiry(record)) === 'failed') {
        throw new AuthFnBrowserHandoffStorageError();
      }
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
    atomic: true,
    originScoped: true
  };
}

export interface AuthFnRegionalHandoffExchangeOptions {
  /** The region-aware client of the page; it is moved to the handoff's region once a session is issued. */
  regionalClient: Pick<AuthFnRegionalClient, 'setCurrentRegionId'> & AuthFnSocialHandoffClient;
  /** The same trusted region-to-URL mapping the regional client was created with. */
  resolveBaseUrl(regionId: string): string;
  /** The same client options the regional client was created with. */
  clientOptions?: Omit<AuthFnClientOptions, 'baseUrl'>;
}

/**
 * The exchange for the region-aware client. It sends the code to the region
 * passed to `begin()` through a client of that region alone, so it never
 * changes which region other calls use while it runs, even when the page
 * after the redirect starts in the default region. Only once the session is
 * issued does it move `regionalClient` to that region, where the session
 * lives. Without a stored region it uses `regionalClient` as it is.
 */
export function createRegionalHandoffExchange(
  options: AuthFnRegionalHandoffExchangeOptions
): AuthFnBrowserHandoffExchange {
  const { regionalClient, resolveBaseUrl, clientOptions } = options ?? ({} as AuthFnRegionalHandoffExchangeOptions);
  if (!regionalClient || typeof resolveBaseUrl !== 'function') {
    throw new TypeError('createRegionalHandoffExchange needs regionalClient and resolveBaseUrl');
  }
  const clients = new Map<string, AuthFnSocialHandoffClient>();
  const clientFor = (regionId: string) => {
    let client = clients.get(regionId);
    if (!client) {
      client = createAuthFnClient({ ...(clientOptions ?? {}), baseUrl: resolveBaseUrl(regionId) });
      clients.set(regionId, client);
    }
    return client;
  };
  return async (input, context) => {
    if (!context.regionId) {
      return regionalClient.exchangeSocialHandoff(input);
    }
    const response = await clientFor(context.regionId).exchangeSocialHandoff(input);
    // Moves the page only for a response complete() accepts as a session.
    if (acceptedHandoffSession(response, [input.code, input.verifier])) {
      regionalClient.setCurrentRegionId(context.regionId);
    }
    return response;
  };
}

export interface AuthFnIndexedDbHandoffStoreOptions {
  /** Defaults to `globalThis.indexedDB`. Without one the store is `atomic: false`. */
  indexedDB?: AuthFnIndexedDbFactoryLike | null;
  /** Database name. Default `authfn-handoff`. */
  databaseName?: string;
}

const IDB_OBJECT_STORE = 'records';

/**
 * The browser store: records live in an IndexedDB database of the origin,
 * which every window, tab and popup of the origin shares, and
 * `compareAndSet` reads and writes in one readwrite transaction. The browser
 * runs readwrite transactions over the same object store one at a time
 * across all connections, so a claim is atomic across renderer processes
 * (unlike Web Storage, whose `sessionStorage` is copied into popups and whose
 * `localStorage` reaches other processes asynchronously).
 */
export function createIndexedDbHandoffStore(
  options: AuthFnIndexedDbHandoffStoreOptions = {}
): AuthFnBrowserHandoffStore {
  const factory = (options.indexedDB === undefined
    ? (globalThis as { indexedDB?: AuthFnIndexedDbFactoryLike }).indexedDB ?? null
    : options.indexedDB) as IDBFactory | null;
  const databaseName = options.databaseName ?? 'authfn-handoff';
  if (typeof databaseName !== 'string' || databaseName.length === 0) {
    throw new TypeError('createIndexedDbHandoffStore databaseName must be a non-empty string');
  }
  let opening: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    if (!factory) {
      return Promise.reject(new Error('IndexedDB is not available'));
    }
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(IDB_OBJECT_STORE)) {
          request.result.createObjectStore(IDB_OBJECT_STORE);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const forget = () => {
          opening = null;
        };
        db.onversionchange = () => {
          db.close();
          forget();
        };
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB open is blocked'));
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  /**
   * Runs `body` in one transaction and settles once the transaction has
   * committed, with the value `body` decided, or rejects if it aborts.
   */
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (records: IDBObjectStore, decide: (value: T) => void) => void
  ): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(IDB_OBJECT_STORE, mode);
      let decided: T | undefined;
      transaction.oncomplete = () => resolve(decided as T);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
      body(transaction.objectStore(IDB_OBJECT_STORE), (value) => {
        decided = value;
      });
    });
  };
  return {
    // A value that is not a string is passed on as it is, so the handoff
    // removes it as malformed state.
    get: (key) => run<string | null>('readonly', (records, decide) => {
      const request = records.get(key);
      request.onsuccess = () => decide((request.result ?? null) as string | null);
    }),
    set: (key, value) => run<void>('readwrite', (records) => {
      records.put(value, key);
    }),
    delete: (key) => run<void>('readwrite', (records) => {
      records.delete(key);
    }),
    keys: () => run<string[]>('readonly', (records, decide) => {
      const request = records.getAllKeys();
      request.onsuccess = () => decide(request.result.filter((key): key is string => typeof key === 'string'));
    }),
    compareAndSet: (key, expected, next) => run<boolean>('readwrite', (records, decide) => {
      decide(false);
      const request = records.get(key);
      request.onsuccess = () => {
        if (request.result !== expected) {
          return;
        }
        if (next === null) {
          records.delete(key);
        } else {
          records.put(next, key);
        }
        decide(true);
      };
    }),
    atomic: factory !== null,
    originScoped: true
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

/**
 * The session and handoff of an exchange response that issued a session in
 * the shape the server sends, or `undefined`. The handoff is a session-token
 * handoff for this session (`sessionId` is `session.id`) with a non-blank
 * token; the session is a user session whose subject is its actor. No string
 * in the envelope but its request id (checked on its own) may repeat the code
 * or the verifier. `complete()` and the regional
 * exchange both accept only this.
 */
function acceptedHandoffSession(envelope: unknown, secrets: readonly string[]): SocialHandoffData | undefined {
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.data)) {
    return undefined;
  }
  const { session, handoff } = envelope.data;
  if (
    !isRecord(session)
    || !isRecord(handoff)
    || !isNonBlank(session.id)
    || session.type !== 'session'
    || !isNonBlank(session.actorId)
    || typeof session.actorType !== 'string'
    || !isRecord(session.subject)
    || session.subject.actorId !== session.actorId
    || session.subject.actorType !== session.actorType
    || !Array.isArray(session.resourceIds)
    || !Array.isArray(session.methods)
    || handoff.type !== 'session-token'
    // The bearer resolver trims the token, so whitespace alone is no token.
    || !isNonBlank(handoff.token)
    || handoff.sessionId !== session.id
    || (handoff.regionId !== null && typeof handoff.regionId !== 'string')
    || (handoff.expiresAt !== null && typeof handoff.expiresAt !== 'string')
    || repeatsSecret(withoutRequestId(envelope), secrets)
  ) {
    return undefined;
  }
  return { session, handoff } as unknown as SocialHandoffData;
}

/** The envelope without its request id, which callers check on its own. */
function withoutRequestId(envelope: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = envelope;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The only error the handoff throws for a store failure. It never carries
 * the store's own message or cause, which may repeat the stored record.
 */
export class AuthFnBrowserHandoffStorageError extends Error {
  constructor() {
    super('The browser handoff store failed');
    this.name = 'AuthFnBrowserHandoffStorageError';
  }
}

/**
 * Wraps every store call so that a rejection or synchronous throw becomes
 * the fixed `AuthFnBrowserHandoffStorageError`.
 */
function guardStore(store: AuthFnBrowserHandoffStore) {
  const guard = async <T>(action: () => Awaitable<T>): Promise<T> => {
    try {
      return await action();
    } catch {
      throw new AuthFnBrowserHandoffStorageError();
    }
  };
  return {
    get: (key: string) => guard<unknown>(() => store.get(key)),
    set: (key: string, value: string) => guard(() => store.set(key, value)),
    delete: (key: string) => guard(() => store.delete(key)),
    keys: () => guard(async () => Array.from(await store.keys())),
    compareAndSet: (key: string, expected: string, next: string | null) =>
      guard(() => store.compareAndSet(key, expected, next))
  };
}

function tombstoneFor(handoffId: string, expiresAt: number): string {
  return JSON.stringify({ v: 1, id: handoffId, state: 'used', expiresAt } satisfies UsedRecord);
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

function parseRecord(raw: string, handoffId: string, now: number): StoredRecord | null {
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
    // No handoff this helper begins outlives the longest TTL.
    || record.expiresAt > now + MAX_TTL_MS
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
    || (record.regionId !== undefined && !isRegionId(record.regionId))
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
  const methods = url.searchParams.getAll('primaryMethod');
  const primaryMethod = methods.length === 1 && SOCIAL_METHODS.has(methods[0]!) ? methods[0]! : undefined;
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
