import type { AtomicKVStoreAdapter, KVStoreAdapter } from '@superfunctions/db';
import type { Middleware } from '@superfunctions/http';
import { AuthFnConfigError, AuthFnPayloadTooLargeError, AuthFnRateLimitedError } from './errors.js';
import { readCookieValues, resolveCookiePolicy } from './cookies.js';
import { resolveEnvironment } from './environment.js';
import type {
  AuthFnRateLimitCategory,
  AuthFnRateLimitConfig,
  AuthFnRateLimitMode,
  AuthFnRuntimeConfig
} from '../types.js';
import { CANONICAL_CHALLENGE_ID } from './challenge-id.js';

interface RateLimitCheck {
  /** Counter key: namespace, route scope, dimension, hashed value and window index. */
  key: string;
  limit: number;
  windowSeconds: number;
  /** Epoch milliseconds at which this check's fixed window ends. */
  windowEndsAt: number;
  dimension: string;
  scope: AuthFnRateLimitScope;
}

type AuthFnRateLimitScope = keyof NonNullable<AuthFnRateLimitConfig['policies']>;

const defaultPolicies: Record<AuthFnRateLimitScope, AuthFnRateLimitCategory> = {
  password: { ipLimit: 30, identifierLimit: 10, windowSeconds: 60 },
  'otp-send': { ipLimit: 20, identifierLimit: 5, windowSeconds: 300 },
  'otp-verify': { ipLimit: 30, identifierLimit: 10, windowSeconds: 300 },
  'password-reset': { ipLimit: 20, identifierLimit: 5, windowSeconds: 300 },
  'social-start': { ipLimit: 60, windowSeconds: 60 },
  handoff: { ipLimit: 30, windowSeconds: 60 },
  'two-factor': { ipLimit: 30, identifierLimit: 5, windowSeconds: 300 },
  'region-lookup': { ipLimit: 120, identifierLimit: 60, windowSeconds: 60 },
  account: { ipLimit: 120, windowSeconds: 60 },
};

export function createAuthFnRateLimitMiddleware(config: AuthFnRuntimeConfig): Middleware | undefined {
  const rateLimit = config.rateLimit;
  if (!rateLimit?.enabled) {
    return undefined;
  }
  const mode = resolveMode(rateLimit.mode, config);
  if (mode === 'strict' && !config.stores?.atomicKv) {
    throw new Error('AUTHFN_ATOMIC_STORE_REQUIRED: rateLimit strict mode requires stores.atomicKv');
  }
  assertValidWindows(config);
  const localState = createLocalRateLimitState();

  return async (request, _context, next) => {
    const path = new URL(request.url).pathname;
    const scope = scopeForPath(path);
    const policy = policyForScope(config, scope);
    const identifier = scope === 'two-factor'
      ? await readTwoFactorIdentifier(request.clone(), config, normalizePath(path))
      : await readIdentifier(request.clone());
    const ip = (await rateLimit.resolveClientIp?.(request))?.trim() || 'unknown';
    const identifierHash = identifier && policy.identifierLimit ? await hashIdentifier(identifier) : null;
    // One clock reading per request, taken after every asynchronous step, so
    // every check and the local counters agree on which window the request
    // belongs to, and that window is the one current when it is counted.
    const now = Date.now();
    const checks = buildChecks(config, scope, policy, ip, identifierHash, now);

    for (const check of checks) {
      // Local counters are read and updated without yielding, so no other
      // request can sweep this window's counters between the clock reading
      // and the increment.
      const count = usesLocalCounters(mode, config)
        ? incrementLocal(localState, check.key, check.windowEndsAt, now)
        : await incrementStore(config, mode, check);
      if (count > check.limit) {
        throw new AuthFnRateLimitedError(undefined, {
          path,
          scope,
          dimension: check.dimension,
          // Windows are fixed, so a refused request reports the end of the
          // window that refused it rather than a time measured from itself.
          resetAt: new Date(check.windowEndsAt).toISOString()
        });
      }
    }

    return next();
  };
}

function usesLocalCounters(mode: AuthFnRateLimitMode, config: AuthFnRuntimeConfig): boolean {
  return mode === 'local' || (mode === 'best-effort' && !config.stores?.kv);
}

function resolveMode(
  mode: AuthFnRateLimitMode | undefined,
  config: AuthFnRuntimeConfig
): AuthFnRateLimitMode {
  return mode ?? (config.stores?.atomicKv ? 'strict' : config.stores?.kv ? 'best-effort' : 'local');
}

function policyForScope(
  config: AuthFnRuntimeConfig,
  scope: AuthFnRateLimitScope
): AuthFnRateLimitCategory {
  const policies = {
    ...defaultPolicies,
    ...config.rateLimit?.policies
  };
  return policies[scope] ?? defaultPolicies.account;
}

/**
 * Shortest window: one second. Windows are whole seconds so that the window's
 * end is an exact millisecond (a refusal's `resetAt` is then the first instant
 * of the next window) and every store TTL is at least one second (stores such
 * as Redis and DynamoDB floor TTLs to whole seconds, and a TTL of 0 deletes
 * or rejects the counter).
 */
const MIN_WINDOW_SECONDS = 1;
/**
 * Longest window: half the range of a JavaScript `Date` (8.64e15 ms), so the
 * end of the current window is always a valid date.
 */
const MAX_WINDOW_SECONDS = 4_320_000_000_000;

/**
 * Rejects, when the middleware is created, any route policy whose window
 * every mode cannot enforce as fixed windows. Otherwise a refusal could have
 * no valid reset time (a 500 instead of a 429), local counters could never
 * expire, or a store could drop or refuse the counter.
 */
function assertValidWindows(config: AuthFnRuntimeConfig): void {
  for (const scope of Object.keys(defaultPolicies) as AuthFnRateLimitScope[]) {
    const windowSeconds: unknown = policyForScope(config, scope).windowSeconds;
    if (
      typeof windowSeconds !== 'number'
      || !Number.isInteger(windowSeconds)
      || windowSeconds < MIN_WINDOW_SECONDS
      || windowSeconds > MAX_WINDOW_SECONDS
    ) {
      throw new AuthFnConfigError(
        `rateLimit.policies.${scope}.windowSeconds must be a whole number of seconds `
          + `from ${MIN_WINDOW_SECONDS} to ${MAX_WINDOW_SECONDS}`,
        { scope, windowSeconds: String(windowSeconds) }
      );
    }
  }
}

function normalizePath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function scopeForPath(rawPath: string): AuthFnRateLimitScope {
  const path = normalizePath(rawPath);
  if (path.endsWith('/sign-in/password') || path.endsWith('/sign-up/password')) return 'password';
  if (path.endsWith('/otp/send')) return 'otp-send';
  if (path.endsWith('/otp/verify')) return 'otp-verify';
  if (
    path.endsWith('/password/reset/start')
    || path.endsWith('/password/reset/complete')
  ) return 'password-reset';
  if (path.endsWith('/social/start')) return 'social-start';
  if (
    path.endsWith('/2fa/challenge')
    || path.endsWith('/2fa/confirm')
    || path.endsWith('/2fa/disable')
  ) return 'two-factor';
  if (path.includes('/handoff/')) return 'handoff';
  if (path.endsWith('/regions/lookup')) return 'region-lookup';
  return 'account';
}

/**
 * Builds one check per counted dimension. Every counter key carries the route
 * scope, so each route category is counted separately, and the index of the
 * fixed window `floor(now / windowSeconds)`, so a later write (or its TTL) can
 * never extend a window: the next window always starts from a new key. All
 * modes (`strict`, `best-effort`, `local`) use this key shape.
 */
function buildChecks(
  config: AuthFnRuntimeConfig,
  scope: AuthFnRateLimitScope,
  policy: AuthFnRateLimitCategory,
  ip: string,
  identifierHash: string | null,
  now: number
): RateLimitCheck[] {
  const windowMs = policy.windowSeconds * 1000;
  const windowIndex = Math.floor(now / windowMs);
  const windowEndsAt = (windowIndex + 1) * windowMs;
  const counterKey = (dimension: string, value: string): string =>
    `authfn:${config.namespace ?? 'authfn'}:ratelimit:${scope}:${dimension}:${value}:${windowIndex}`;

  const checks: RateLimitCheck[] = [
    {
      key: counterKey('ip', hashKeyPart(ip)),
      limit: policy.ipLimit,
      windowSeconds: policy.windowSeconds,
      windowEndsAt,
      dimension: 'ip',
      scope
    }
  ];

  if (identifierHash && policy.identifierLimit) {
    checks.push({
      key: counterKey('identifier', identifierHash),
      limit: policy.identifierLimit,
      windowSeconds: policy.windowSeconds,
      windowEndsAt,
      dimension: 'identifier',
      scope
    });
  }

  return checks;
}

async function incrementStore(
  config: AuthFnRuntimeConfig,
  mode: AuthFnRateLimitMode,
  check: RateLimitCheck,
): Promise<number> {
  // Store TTLs only bound how long a counter is kept. They may be refreshed by
  // later writes, but the key belongs to one window, so that cannot move the
  // window's end.
  if (mode === 'strict') {
    return incrementAtomic(config.stores!.atomicKv!, check.key, check.windowSeconds);
  }
  return incrementCache(config.stores!.kv!, check.key, check.windowSeconds);
}

async function incrementAtomic(
  store: AtomicKVStoreAdapter,
  key: string,
  windowSeconds: number
): Promise<number> {
  return (await store.incr({ key, by: 1, ttlSeconds: windowSeconds })).value;
}

const MAX_LOCAL_RATE_LIMIT_WINDOWS = 10_000;
const LOCAL_SWEEP_INTERVAL = 128;

interface LocalRateLimitState {
  windows: Map<string, { count: number; expiresAt: number }>;
  incrementCount: number;
}

function createLocalRateLimitState(): LocalRateLimitState {
  return { windows: new Map(), incrementCount: 0 };
}

async function incrementCache(
  store: KVStoreAdapter,
  key: string,
  windowSeconds: number
): Promise<number> {
  const current = Number(await store.get(key) ?? '0');
  const next = current + 1;
  await store.set({
    key,
    value: String(next),
    ttlSeconds: windowSeconds
  });
  return next;
}

function incrementLocal(
  state: LocalRateLimitState,
  key: string,
  windowEndsAt: number,
  now: number,
): number {
  state.incrementCount += 1;
  if (state.incrementCount % LOCAL_SWEEP_INTERVAL === 0) {
    sweepExpiredLocalWindows(state, now);
  }
  const existing = state.windows.get(key);
  if (!existing || existing.expiresAt <= now) {
    if (!existing && state.windows.size >= MAX_LOCAL_RATE_LIMIT_WINDOWS) {
      sweepExpiredLocalWindows(state, now);
      if (state.windows.size >= MAX_LOCAL_RATE_LIMIT_WINDOWS) {
        // Preserve every active counter. Admitting an untracked key here would
        // let key churn reset a victim's limit, so local mode fails closed
        // until an existing window expires.
        return Number.POSITIVE_INFINITY;
      }
    }
    state.windows.set(key, { count: 1, expiresAt: windowEndsAt });
    return 1;
  }
  existing.count += 1;
  return existing.count;
}

function sweepExpiredLocalWindows(state: LocalRateLimitState, now: number): void {
  for (const [key, window] of state.windows) {
    if (window.expiresAt <= now) {
      state.windows.delete(key);
    }
  }
}

function hashKeyPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 128);
}

async function hashIdentifier(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function readIdentifier(request: Request): Promise<string | null> {
  if (request.method !== 'POST') {
    return null;
  }

  try {
    const body = await request.json() as { email?: unknown; identifier?: unknown };
    const value = typeof body.email === 'string'
      ? body.email
      : typeof body.identifier === 'string'
        ? body.identifier
        : undefined;
    return value?.trim().toLowerCase() ?? null;
  } catch (error) {
    if (error instanceof AuthFnPayloadTooLargeError) {
      throw error;
    }
    return null;
  }
}

/**
 * Two-factor attempts are counted per sign-in challenge (`challengeId`,
 * trimmed and lower-cased so differently spelled ids of one challenge share a
 * counter) or, for `/2fa/confirm` and `/2fa/disable`, per session cookie,
 * which is the only credential those routes accept. Other body fields and
 * headers are ignored so a caller cannot change the counter by adding them.
 */
async function readTwoFactorIdentifier(
  request: Request,
  config: AuthFnRuntimeConfig,
  path: string
): Promise<string | null> {
  if (path.endsWith('/2fa/challenge')) {
    if (request.method !== 'POST') return null;
    try {
      const body = await request.json() as { challengeId?: unknown };
      if (typeof body.challengeId !== 'string') return null;
      const challengeId = body.challengeId.trim().toLowerCase();
      if (!challengeId) return null;
      // Ids are ASCII; anything else shares one counter so collation tricks gain nothing.
      return CANONICAL_CHALLENGE_ID.test(challengeId)
        ? `two-factor-challenge:${challengeId}`
        : 'two-factor-challenge:non-canonical';
    } catch (error) {
      if (error instanceof AuthFnPayloadTooLargeError) {
        throw error;
      }
      return null;
    }
  }
  const runtime = await resolveEnvironment(config, request);
  const { sessionToken } = readCookieValues(request, resolveCookiePolicy(config, request, runtime));
  return sessionToken ? `two-factor-session:${sessionToken}` : null;
}
