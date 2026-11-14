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
  readFormBody,
  requireParam
} from '../http.js';
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
  createDeviceCode,
  findByUserCode,
  findDeviceCode,
  normalizeUserCode,
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

/** Rejects a malformed `pluginRuntime.oauthProvider.deviceAuthorization` at startup. */
export function validateDeviceConfig(device: unknown): void {
  if (device === undefined) {
    return;
  }
  const invalid = (message: string) => new AuthFnConfigError(`pluginRuntime.oauthProvider.deviceAuthorization ${message}`);
  if (!isPlainObject(device) || typeof device.verification !== 'function') {
    throw invalid('needs a verification hook');
  }
  const { rateLimit } = device as Partial<OAuthDeviceAuthorizationConfig>;
  if (rateLimit !== undefined && (!isPlainObject(rateLimit) || !Object.entries(rateLimit).every(([name, value]) =>
    ['perUser', 'global', 'windowSeconds'].includes(name) &&
    (value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0))))) {
    throw invalid('rateLimit takes positive integers perUser, global and windowSeconds');
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
  const configured = Object.fromEntries(Object.entries(device.rateLimit ?? {}).filter(([, value]) => value !== undefined));
  const { perUser, global, windowSeconds } = { ...DEFAULT_RATE_LIMIT, ...configured };
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
 * Approves a pending device authorization for `user`: creates its grant, then
 * records the decision, which only one decision wins. The disconnect
 * generation is read before the grant is created and again after the
 * decision, as an authorization code approval does; a disconnect in between
 * revokes the new grant. Returns whether the device will receive tokens.
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
  if (!(await claimDecision(store, record.id, { decision: 'approved', userId: user.id, grantId: grant.id, now: runtime.now() }))) {
    await revokeGrant(store, grant.id, 'device_decided', runtime.now());
    return 'decided';
  }
  if (await readGeneration(store, triple) !== generation) {
    await revokeGrant(store, grant.id, 'consent_withdrawn', runtime.now());
    return 'withdrawn';
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
      meta: createAuthFnRouteMeta('oauthDeviceAuthorization', 'OAuth 2.0 device authorization endpoint', { mode: 'none' }),
      handler: (request) => handleOAuth(async () => {
        const params = await readFormBody(request);
        const client = await authenticateClient(runtime, request, params);
        if (!runtime.findClient(client.clientId)) {
          throw new OAuthError('unauthorized_client', 'This client may not use the device authorization grant');
        }
        const resource = requireResource(runtime, params.get('resource'));
        const scopes = resolveRequestedScopes(resource, params.get('scope'));
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
 * to it), `access_denied` after a denial and `expired_token` after 10
 * minutes. An approval yields the same tokens as an authorization code: an
 * access token for the approved scopes and a refresh token under the grant.
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
    if (record.grantId) {
      await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    }
    throw deviceError('invalid_grant', 'Device code has already been used');
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    throw deviceError('expired_token', 'Device code has expired');
  }
  if (!(await admitPoll(runtime.store, record, now))) {
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
    throw deviceError('invalid_grant', 'Authorization grant is no longer valid');
  }
  // As for a code: the staged tokens become valid only when the claim on the
  // device code commits, and a concurrent exchange that loses is a replay.
  const { tokens, claimId } = await stageTokens(runtime.store, grant, grant.scopes, now, record.id);
  if (!(await claimDeviceCode(runtime.store, record.id, now, claimId))) {
    await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    throw deviceError('invalid_grant', 'Device code has already been used');
  }
  if (!(await findLiveGrant(runtime.store, record.grantId))) {
    throw deviceError('invalid_grant', 'Authorization grant is no longer valid');
  }
  return tokens;
}
