import type { Route } from '@superfunctions/http';
import { AuthFnConfigError, AuthFnValidationError } from 'authfn/core/errors';
import { assertValidCsrf, getCookieSessionState, requireCookieSession } from 'authfn/core/sessions';
import { jsonSuccess } from 'authfn/http/envelopes';
import { createAuthFnRouteMeta, readOptionalJson } from 'authfn/http/router';
import {
  authenticateClient,
  handleOAuth,
  OAuthError,
  oauthJson,
  readSingleParams,
  requireParam
} from '../http.js';
import { BodyTimeoutError, declaresMoreThan, readCappedBody } from '../registration/document.js';
import { REGISTRATION_BODY_TIMEOUT_MS } from '../registration/index.js';
import { isPlainObject } from '../registration/metadata.js';
import { admitRegistrationEvent } from '../registration/store.js';
import {
  requireResource,
  resolveEndpoints,
  resolveRequestedScopes,
  type OAuthProviderRuntime
} from '../runtime.js';
import {
  createGrant,
  findLiveGrant,
  readGeneration,
  revokeGrant,
  stageTokens,
  type IssuedTokens
} from '../store.js';
import type { OAuthProviderClient, OAuthProviderUser } from '../types.js';
import {
  admitPoll,
  claimDecision,
  claimDeviceCode,
  closeExpiredDeviceCode,
  createDeviceCode,
  EXPIRED_CLAIM_PREFIX,
  findByUserCode,
  findDeviceCode,
  normalizeUserCode,
  pruneDeviceCodes,
  OAUTH_DEVICE_CODE_TTL_SECONDS,
  OAUTH_DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceCodeRecord
} from './store.js';
import type { OAuthDeviceAuthorizationConfig, OAuthDeviceVerificationInput } from './types.js';

export { createDeviceSchema, OAUTH_DEVICE_CODE_TTL_SECONDS, OAUTH_DEVICE_POLL_INTERVAL_SECONDS } from './store.js';
export * from './types.js';

export const OAUTH_DEVICE_AUTHORIZATION_PATH = '/oauth/device_authorization';
export const OAUTH_DEVICE_VERIFICATION_PATH = '/oauth/device';

const DEFAULT_RATE_LIMIT = { perUser: 10, global: 1000, windowSeconds: 600 };
const DEFAULT_AUTHORIZATION_RATE_LIMIT = { perIp: 20, global: 1000, windowSeconds: 600 };

/** True when `limits` is absent or an object of positive integers named in `names`. */
function validLimits(limits: unknown, names: string[]): boolean {
  return limits === undefined || (isPlainObject(limits) && Object.entries(limits).every(([name, value]) =>
    names.includes(name) &&
    (value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0))));
}

/** The configured limits over the defaults; an `undefined` value keeps the default. */
function limitsWithDefaults<T extends object>(defaults: T, configured: Partial<T> | undefined): T {
  return { ...defaults, ...Object.fromEntries(Object.entries(configured ?? {}).filter(([, value]) => value !== undefined)) };
}

/** Rejects a malformed `pluginRuntime.oauthProvider.deviceAuthorization` at startup. */
export function validateDeviceConfig(device: unknown): void {
  if (device === undefined) {
    return;
  }
  const invalid = (message: string) => new AuthFnConfigError(`pluginRuntime.oauthProvider.deviceAuthorization ${message}`);
  if (!isPlainObject(device) || typeof device.verification !== 'function') {
    throw invalid('needs a verification hook');
  }
  const { rateLimit, authorizationRateLimit, resolveClientIp } = device as Partial<OAuthDeviceAuthorizationConfig>;
  if (!validLimits(rateLimit, ['perUser', 'global', 'windowSeconds'])) {
    throw invalid('rateLimit takes positive integers perUser, global and windowSeconds');
  }
  if (!validLimits(authorizationRateLimit, ['perIp', 'global', 'windowSeconds'])) {
    throw invalid('authorizationRateLimit takes positive integers perIp, global and windowSeconds');
  }
  if (resolveClientIp !== undefined && typeof resolveClientIp !== 'function') {
    throw invalid('resolveClientIp must be a function');
  }
}

/** The largest device authorization request body; its parameters are a few short strings. */
const MAX_DEVICE_AUTHORIZATION_BODY_BYTES = 8 * 1024;

/**
 * Reads the form body of an anonymous device authorization request, bounded
 * before anything else runs: a declared or streamed body over 8 KB, or one
 * that has not arrived within 5 seconds, is an `invalid_request` and the
 * stream is cancelled.
 */
async function readCappedFormBody(request: Request): Promise<Map<string, string>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 'Request body must be application/x-www-form-urlencoded');
  }
  const tooLarge = new OAuthError('invalid_request', 'Request body must be at most 8 KB');
  if (declaresMoreThan(request.headers, MAX_DEVICE_AUTHORIZATION_BODY_BYTES)) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge;
  }
  let bytes: Uint8Array | null = new Uint8Array();
  try {
    if (request.body) {
      bytes = await readCappedBody(request.body.getReader(), MAX_DEVICE_AUTHORIZATION_BODY_BYTES, REGISTRATION_BODY_TIMEOUT_MS);
    }
  } catch (error) {
    if (error instanceof BodyTimeoutError) {
      throw new OAuthError('invalid_request', 'Request body must arrive within 5 seconds');
    }
    throw error;
  }
  if (!bytes) {
    throw tooLarge;
  }
  return readSingleParams(new URLSearchParams(new TextDecoder().decode(bytes)));
}

/**
 * Counts one device authorization request per client IP and overall, or
 * throws a 429 `temporarily_unavailable` before anything is stored.
 */
async function admitDeviceAuthorization(
  runtime: OAuthProviderRuntime,
  device: OAuthDeviceAuthorizationConfig,
  request: Request
): Promise<void> {
  const resolve = device.resolveClientIp ?? runtime.ctx.config.rateLimit?.resolveClientIp;
  const ip = (await resolve?.(request))?.trim() || undefined;
  const { perIp, global, windowSeconds } = limitsWithDefaults(DEFAULT_AUTHORIZATION_RATE_LIMIT, device.authorizationRateLimit);
  const result = await admitRegistrationEvent(runtime.store, {
    kind: 'device_code',
    ip,
    now: runtime.now(),
    limits: { perIp, global, windowSeconds }
  });
  if (!result.admitted) {
    throw new OAuthError('temporarily_unavailable', 'Too many device authorization requests; try again later', 429, {
      'retry-after': String(result.retryAfterSeconds)
    });
  }
}

/**
 * Counts one user code lookup by `user`, or reports the seconds until the
 * window ends. Lookups share the windowed event store of client registration.
 */
async function admitUserCodeLookup(
  runtime: OAuthProviderRuntime,
  device: OAuthDeviceAuthorizationConfig,
  user: OAuthProviderUser
): Promise<number | null> {
  const { perUser, global, windowSeconds } = limitsWithDefaults(DEFAULT_RATE_LIMIT, device.rateLimit);
  const result = await admitRegistrationEvent(runtime.store, {
    kind: 'user_code',
    ip: `user:${user.id}`,
    now: runtime.now(),
    limits: { perIp: perUser, global, windowSeconds }
  });
  return result.admitted ? null : result.retryAfterSeconds;
}

type UserCodeLookup =
  | { ok: true; record: DeviceCodeRecord; client: OAuthProviderClient }
  | { ok: false; error: 'invalid_user_code' | 'expired_user_code' }
  | { ok: false; error: 'too_many_attempts'; retryAfterSeconds: number };

/**
 * Finds the pending device authorization a user code names, after counting
 * the lookup. A code that is decided, unknown or whose client is no longer
 * configured is `invalid_user_code`.
 */
async function lookUpUserCode(
  runtime: OAuthProviderRuntime,
  device: OAuthDeviceAuthorizationConfig,
  user: OAuthProviderUser,
  userCode: string | null
): Promise<UserCodeLookup> {
  const retryAfterSeconds = await admitUserCodeLookup(runtime, device, user);
  if (retryAfterSeconds !== null) {
    return { ok: false, error: 'too_many_attempts', retryAfterSeconds };
  }
  const record = userCode ? await findByUserCode(runtime.store, userCode) : null;
  const client = record ? runtime.findClient(record.clientId) : undefined;
  if (!record || !client || record.decidedAt) {
    return { ok: false, error: 'invalid_user_code' };
  }
  if (record.expiresAt.getTime() <= runtime.now().getTime()) {
    return { ok: false, error: 'expired_user_code' };
  }
  return { ok: true, record, client };
}

/**
 * Approves a pending device authorization for `user`: creates its grant,
 * checks the disconnect generation, and only then records the decision,
 * which makes the code exchangeable and which only one decision wins. As for
 * an authorization code, the generation is read before the grant is created
 * and again after: a disconnect in between revokes the new grant and records
 * the request as denied, so the device gets `access_denied`. A disconnect
 * after the second read finds the grant, which already exists, and revokes
 * it; the device then also gets `access_denied` (see `exchangeDeviceCode`).
 * Expiry is checked before the decision is recorded and again after: an
 * approval that crosses it revokes its grant and throws `invalid_grant`. One
 * that crossed before the write records nothing. One that crossed after it
 * spends the code with an expiry claim, unless an exchange claimed it first:
 * an exchange judges expiry with a clock read after it read the approval, so
 * its winning claim proves the approval was published before expiry, and the
 * approval stands. An approval interrupted anywhere before the decision
 * leaves the request pending.
 * Returns whether the device will receive tokens.
 */
async function approve(
  runtime: OAuthProviderRuntime,
  record: DeviceCodeRecord,
  user: OAuthProviderUser
): Promise<'approved' | 'decided' | 'withdrawn'> {
  const { store } = runtime;
  const triple = { userId: user.id, clientId: record.clientId, resource: record.resource };
  const generation = await readGeneration(store, triple);
  const grant = await createGrant(store, { ...triple, scopes: record.scopes, now: runtime.now() });
  if (await readGeneration(store, triple) !== generation) {
    await revokeGrant(store, grant.id, 'consent_withdrawn', runtime.now());
    await claimDecision(store, record.id, { decision: 'denied', userId: user.id, now: runtime.now() });
    return 'withdrawn';
  }
  const now = runtime.now();
  if (record.expiresAt.getTime() <= now.getTime()) {
    await revokeGrant(store, grant.id, 'device_code_expired', now);
    throw new OAuthError('invalid_grant', 'The user code has expired');
  }
  if (!(await claimDecision(store, record.id, { decision: 'approved', userId: user.id, grantId: grant.id, now }))) {
    await revokeGrant(store, grant.id, 'device_decided', runtime.now());
    return 'decided';
  }
  // Expired by the time the decision was written: spend the code so nothing
  // can exchange it, unless an exchange that found it unexpired already did.
  if (record.expiresAt.getTime() <= runtime.now().getTime() && await closeExpiredDeviceCode(store, record.id, runtime.now())) {
    await revokeGrant(store, grant.id, 'device_code_expired', runtime.now());
    throw new OAuthError('invalid_grant', 'The user code has expired');
  }
  return 'approved';
}

function deviceConfig(runtime: OAuthProviderRuntime): OAuthDeviceAuthorizationConfig | undefined {
  return runtime.config.deviceAuthorization;
}

/**
 * The device authorization endpoint (RFC 8628 3.1, 3.2), the verification
 * page with its decision endpoint (3.3), when `deviceAuthorization` is
 * configured. The token endpoint accepts the device code grant through
 * `exchangeDeviceCode`.
 */
export function createDeviceRoutes(runtime: OAuthProviderRuntime): Route[] {
  const device = deviceConfig(runtime);
  if (!device) {
    return [];
  }
  return [
    {
      method: 'POST',
      path: OAUTH_DEVICE_AUTHORIZATION_PATH,
      meta: {
        ...createAuthFnRouteMeta('oauthDeviceAuthorization', 'OAuth 2.0 device authorization endpoint', { mode: 'none' }),
        authfnOwnBodyLimit: true
      },
      handler: (request) => handleOAuth(async () => {
        const params = await readCappedFormBody(request);
        const client = await authenticateClient(runtime, request, params);
        if (!runtime.findClient(client.clientId)) {
          throw new OAuthError('unauthorized_client', 'This client may not use the device authorization grant');
        }
        const resource = requireResource(runtime, params.get('resource'));
        const scopes = resolveRequestedScopes(resource, params.get('scope'));
        await admitDeviceAuthorization(runtime, device, request);
        await pruneDeviceCodes(runtime.store, runtime.now());
        const { deviceCode, userCode } = await createDeviceCode(runtime.store, {
          clientId: client.clientId,
          resource: resource.resource,
          scopes,
          now: runtime.now()
        });
        const verificationUri = (await resolveEndpoints(runtime, request)).deviceVerification;
        return oauthJson({
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: verificationUri,
          verification_uri_complete: `${verificationUri}?${new URLSearchParams({ user_code: userCode })}`,
          expires_in: OAUTH_DEVICE_CODE_TTL_SECONDS,
          interval: OAUTH_DEVICE_POLL_INTERVAL_SECONDS
        });
      })
    },
    {
      method: 'GET',
      path: OAUTH_DEVICE_VERIFICATION_PATH,
      meta: createAuthFnRouteMeta('oauthDeviceVerification', 'OAuth 2.0 device verification page', { mode: 'hybrid' }),
      handler: async (request) => {
        const state = await getCookieSessionState(runtime.ctx.config, request);
        if (!state.session || !state.user) {
          return runtime.config.loginRequired({ request, returnTo: request.url });
        }
        const user = { id: state.user.id, primaryEmail: state.user.primaryEmail };
        const endpoints = await resolveEndpoints(runtime, request);
        const input: OAuthDeviceVerificationInput = {
          request,
          user,
          verificationUrl: endpoints.deviceVerification,
          decisionUrl: endpoints.deviceVerification
        };
        const entered = new URL(request.url).searchParams.getAll('user_code');
        if (entered.length === 0) {
          return device.verification(input);
        }
        const userCode = entered.length === 1 ? normalizeUserCode(entered[0]) : null;
        const lookup = await lookUpUserCode(runtime, device, user, userCode);
        input.userCode = userCode ?? undefined;
        if (lookup.ok) {
          input.authorization = {
            client: { clientId: lookup.client.clientId, name: lookup.client.name, trusted: lookup.client.trusted === true },
            resource: lookup.record.resource,
            scopes: [...lookup.record.scopes]
          };
        } else {
          input.error = lookup.error;
          if (lookup.error === 'too_many_attempts') {
            input.retryAfterSeconds = lookup.retryAfterSeconds;
          }
        }
        return device.verification(input);
      }
    },
    {
      method: 'POST',
      path: OAUTH_DEVICE_VERIFICATION_PATH,
      meta: createAuthFnRouteMeta('oauthDeviceDecision', 'Record the decision for an OAuth device authorization', {
        mode: 'cookie-session',
        csrf: true
      }),
      handler: (request) => handleOAuth(async () => {
        const session = await requireCookieSession(runtime.ctx.config, request);
        assertValidCsrf(request, session);
        let body: unknown;
        try {
          body = await readOptionalJson<Record<string, unknown>>(request);
        } catch (error) {
          if (error instanceof AuthFnValidationError) {
            throw new OAuthError('invalid_request', 'The decision body must be valid JSON');
          }
          throw error;
        }
        if (!isPlainObject(body) || typeof body.user_code !== 'string' ||
          (body.decision !== 'approve' && body.decision !== 'deny')) {
          throw new OAuthError('invalid_request', 'The decision body must be { user_code, decision: approve | deny }');
        }
        const user = { id: session.user.id, primaryEmail: session.user.primaryEmail };
        const lookup = await lookUpUserCode(runtime, device, user, normalizeUserCode(body.user_code));
        if (!lookup.ok) {
          if (lookup.error === 'too_many_attempts') {
            throw new OAuthError('temporarily_unavailable', 'Too many user code attempts; try again later', 429, {
              'retry-after': String(lookup.retryAfterSeconds)
            });
          }
          throw new OAuthError('invalid_grant', lookup.error === 'expired_user_code'
            ? 'The user code has expired'
            : 'The user code is invalid or was already used');
        }
        let outcome: 'approved' | 'denied' | 'decided' | 'withdrawn';
        if (body.decision === 'approve') {
          outcome = await approve(runtime, lookup.record, user);
        } else {
          const denied = await claimDecision(runtime.store, lookup.record.id, { decision: 'denied', userId: user.id, now: runtime.now() });
          outcome = denied ? 'denied' : 'decided';
        }
        if (outcome === 'decided') {
          throw new OAuthError('invalid_grant', 'The user code is invalid or was already used');
        }
        if (outcome === 'withdrawn') {
          throw new OAuthError('access_denied', 'The authorization was withdrawn while it was being approved');
        }
        return jsonSuccess(request, { decision: outcome }, { headers: { 'cache-control': 'no-store' } });
      })
    }
  ];
}

function deviceError(error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant', description: string) {
  return new OAuthError(error, description);
}

/**
 * Device access token request (RFC 8628 3.4, 3.5). The device polls with its
 * device code: `authorization_pending` until the user decides, `slow_down`
 * for a poll within the interval of the previous one (which adds 5 seconds
 * to it), `access_denied` after a denial or once the approved grant was
 * revoked (the app was disconnected, or the user disabled) and
 * `expired_token` after 10 minutes. A `resource` other than the requested
 * one is `invalid_target` and leaves the code as it was. A poll that loses to
 * 16 concurrent polls, or cannot tell whether it was stored, is a 429
 * `temporarily_unavailable` whose `Retry-After` is the time left until the
 * stored last poll time plus the stored interval (none once that has passed),
 * plus 5 seconds when its own `slow_down` may count.
 * An approval yields the same tokens as an authorization code: an
 * access token for the approved scopes and a refresh token under the grant.
 * The exchange is judged unexpired with a clock read after the row read that
 * showed the approval, and its tokens are issued at that time; tokens whose
 * exchange was judged in time stay valid even when the claim commits later.
 * The device code works once; when its client presents it again after the
 * exchange, the grant is revoked, as for a replayed authorization code.
 */
export async function exchangeDeviceCode(
  runtime: OAuthProviderRuntime,
  client: OAuthProviderClient,
  params: Map<string, string>
): Promise<IssuedTokens> {
  const deviceCode = requireParam(params, 'device_code');
  const now = runtime.now();
  const record = await findDeviceCode(runtime.store, deviceCode);
  if (record?.clientId !== client.clientId) {
    throw deviceError('invalid_grant', 'Device code is invalid');
  }
  if (record.consumedAt) {
    if (record.claimId?.startsWith(`${EXPIRED_CLAIM_PREFIX}_`)) {
      throw deviceError('expired_token', 'Device code has expired');
    }
    if (record.grantId) {
      await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    }
    throw deviceError('invalid_grant', 'Device code has already been used');
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    throw deviceError('expired_token', 'Device code has expired');
  }
  const resource = params.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the device authorization request');
  }
  const poll = await admitPoll(runtime.store, record, now);
  if (poll.outcome === 'busy' || poll.outcome === 'unknown') {
    throw new OAuthError('temporarily_unavailable', 'Too many concurrent polls of this device code; try again later', 429, {
      'retry-after': String(poll.retryAfterSeconds)
    });
  }
  if (poll.outcome === 'slow_down') {
    throw deviceError('slow_down', 'Polling too fast; wait longer between requests');
  }
  if (!record.decidedAt) {
    throw deviceError('authorization_pending', 'The user has not yet completed the authorization');
  }
  if (record.decision !== 'approved' || !record.grantId) {
    throw deviceError('access_denied', 'The user denied the authorization request');
  }

  const grant = await findLiveGrant(runtime.store, record.grantId);
  if (!grant) {
    throw deviceError('access_denied', 'The authorization was withdrawn');
  }
  // `now` was read before the row, so the approval may have been published
  // after it. Expiry is judged again with a clock read after the row showed
  // the approval: only then does a committed exchange prove the approval was
  // published in time, which `approve` relies on when its close loses.
  const issuedAt = runtime.now();
  if (record.expiresAt.getTime() <= issuedAt.getTime()) {
    throw deviceError('expired_token', 'Device code has expired');
  }
  // As for a code: the staged tokens become valid only when the claim on the
  // device code commits, and a concurrent exchange that loses is a replay.
  const { tokens, claimId } = await stageTokens(runtime.store, grant, grant.scopes, issuedAt, record.id);
  if (!(await claimDeviceCode(runtime.store, record.id, issuedAt, claimId))) {
    await revokeGrant(runtime.store, record.grantId, 'code_replay', issuedAt);
    throw deviceError('invalid_grant', 'Device code has already been used');
  }
  if (!(await findLiveGrant(runtime.store, record.grantId))) {
    throw deviceError('invalid_grant', 'Authorization grant is no longer valid');
  }
  return tokens;
}
