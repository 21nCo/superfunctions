import type { Route } from '@superfunctions/http';
import { assertValidCsrf, getCookieSessionState, requireCookieSession } from 'authfn/core/sessions';
import { createAuthFnRouteMeta, readOptionalJson } from 'authfn/http/router';
import { jsonSuccess } from 'authfn/http/envelopes';
import { OAuthError, oauthErrorResponse, readSingleParams } from '../http.js';
import { isS256Challenge } from '../pkce.js';
import {
  matchesRedirectUri,
  requireResource,
  resolveEndpoints,
  resolveRequestedScopes,
  type OAuthProviderRuntime
} from '../runtime.js';
import { createGrantWithCode, findConsent, recordConsent } from '../store.js';
import type { OAuthAuthorizationRequestParams, OAuthProviderClient, OAuthProviderUser } from '../types.js';

export const OAUTH_AUTHORIZE_PATH = '/oauth/authorize';

/** A validated request, or an error to return to the client's redirect URI. */
type AuthorizationRequest =
  | { ok: true; client: OAuthProviderClient; params: OAuthAuthorizationRequestParams; scopes: string[] }
  | { ok: false; redirectUri: string; state?: string; error: OAuthError };

/**
 * Validates an authorization request (RFC 6749 4.1.1, RFC 7636 4.3, RFC 8707
 * 2). A problem with `client_id` or `redirect_uri` throws, because the client
 * cannot be trusted with a redirect (RFC 6749 4.1.2.1); anything else is
 * returned for an error redirect.
 */
function validateAuthorizationRequest(
  runtime: OAuthProviderRuntime,
  params: Map<string, string>
): AuthorizationRequest {
  const clientId = params.get('client_id');
  const client = clientId ? runtime.findClient(clientId) : undefined;
  if (!client) {
    throw new OAuthError('invalid_request', 'Unknown client_id');
  }
  const redirectUri = params.get('redirect_uri');
  if (!redirectUri || !matchesRedirectUri(client, redirectUri)) {
    throw new OAuthError('invalid_request', 'redirect_uri is missing or not registered for this client');
  }

  const state = params.get('state');
  try {
    if (params.get('response_type') !== 'code') {
      throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
    }
    const challenge = params.get('code_challenge');
    if (params.get('code_challenge_method') !== 'S256' || !challenge || !isS256Challenge(challenge)) {
      throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const resource = requireResource(runtime, params.get('resource'));
    const scopes = resolveRequestedScopes(resource, params.get('scope'));
    return {
      ok: true,
      client,
      scopes,
      params: {
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        ...(state === undefined ? {} : { state }),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: resource.resource
      }
    };
  } catch (error) {
    if (error instanceof OAuthError) {
      return { ok: false, redirectUri, state, error };
    }
    throw error;
  }
}

/** Validates, answering a client or redirect URI problem directly. */
function validateOrRespond(
  runtime: OAuthProviderRuntime,
  readParams: () => Map<string, string>
): AuthorizationRequest | Response {
  try {
    return validateAuthorizationRequest(runtime, readParams());
  } catch (error) {
    if (error instanceof OAuthError) {
      return oauthErrorResponse(error);
    }
    throw error;
  }
}

/** Builds the redirect back to the client, with `iss` (RFC 9207). */
async function clientRedirectUrl(
  runtime: OAuthProviderRuntime,
  request: Request,
  redirectUri: string,
  values: Record<string, string | undefined>
): Promise<string> {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  url.searchParams.set('iss', (await resolveEndpoints(runtime, request)).issuer);
  return url.toString();
}

function errorRedirectValues(error: OAuthError, state: string | undefined): Record<string, string | undefined> {
  return { error: error.error, error_description: error.description, state };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}

async function issueCode(
  runtime: OAuthProviderRuntime,
  user: OAuthProviderUser,
  request: AuthorizationRequest & { ok: true }
): Promise<Record<string, string | undefined>> {
  const code = await createGrantWithCode(runtime.store, {
    clientId: request.client.clientId,
    userId: user.id,
    resource: request.params.resource,
    scopes: request.scopes,
    redirectUri: request.params.redirect_uri,
    codeChallenge: request.params.code_challenge,
    now: runtime.now()
  });
  return { code, state: request.params.state };
}

export function createAuthorizeRoutes(runtime: OAuthProviderRuntime): Route[] {
  return [
    {
      method: 'GET',
      path: OAUTH_AUTHORIZE_PATH,
      meta: createAuthFnRouteMeta('oauthAuthorize', 'OAuth 2.1 authorization endpoint', { mode: 'hybrid' }),
      handler: async (request) => {
        const validated = validateOrRespond(runtime, () => readSingleParams(new URL(request.url).searchParams));
        if (validated instanceof Response) {
          return validated;
        }
        if (!validated.ok) {
          return redirect(await clientRedirectUrl(
            runtime,
            request,
            validated.redirectUri,
            errorRedirectValues(validated.error, validated.state)
          ));
        }

        const state = await getCookieSessionState(runtime.ctx.config, request);
        if (!state.session || !state.user) {
          return runtime.config.loginRequired({ request, returnTo: request.url });
        }
        const user = { id: state.user.id, primaryEmail: state.user.primaryEmail };

        if (validated.client.trusted) {
          const consent = await findConsent(runtime.store, user.id, validated.client.clientId, validated.params.resource);
          if (consent && validated.scopes.every((scope) => consent.scopes.includes(scope))) {
            return redirect(await clientRedirectUrl(
              runtime,
              request,
              validated.params.redirect_uri,
              await issueCode(runtime, user, validated)
            ));
          }
        }

        return runtime.config.consent({
          request,
          user,
          client: {
            clientId: validated.client.clientId,
            name: validated.client.name,
            trusted: validated.client.trusted === true
          },
          resource: validated.params.resource,
          scopes: validated.scopes,
          params: validated.params,
          decisionUrl: (await resolveEndpoints(runtime, request)).authorization
        });
      }
    },
    {
      method: 'POST',
      path: OAUTH_AUTHORIZE_PATH,
      meta: createAuthFnRouteMeta('oauthAuthorizeDecision', 'Record the consent decision for an OAuth authorization', {
        mode: 'cookie-session',
        csrf: true
      }),
      handler: async (request) => {
        const session = await requireCookieSession(runtime.ctx.config, request);
        assertValidCsrf(request, session);
        const body = await readOptionalJson<Record<string, unknown>>(request);
        const params = new Map<string, string>();
        const validated = validateOrRespond(runtime, () => {
          for (const [name, value] of Object.entries(body)) {
            if (typeof value !== 'string') {
              throw new OAuthError('invalid_request', `Parameter ${name} must be a string`);
            }
            params.set(name, value);
          }
          return params;
        });
        if (validated instanceof Response) {
          return validated;
        }

        const decision = params.get('decision');
        let values: Record<string, string | undefined>;
        if (!validated.ok) {
          values = errorRedirectValues(validated.error, validated.state);
        } else if (decision === 'approve') {
          const user = { id: session.user.id, primaryEmail: session.user.primaryEmail };
          await recordConsent(runtime.store, {
            userId: user.id,
            clientId: validated.client.clientId,
            resource: validated.params.resource,
            scopes: validated.scopes,
            now: runtime.now()
          });
          values = await issueCode(runtime, user, validated);
        } else if (decision === 'deny') {
          values = errorRedirectValues(
            new OAuthError('access_denied', 'The user denied the authorization request'),
            validated.params.state
          );
        } else {
          return oauthErrorResponse(new OAuthError('invalid_request', 'decision must be approve or deny'));
        }

        const redirectUri = validated.ok ? validated.params.redirect_uri : validated.redirectUri;
        return jsonSuccess(request, {
          redirectTo: await clientRedirectUrl(runtime, request, redirectUri, values)
        }, { headers: { 'cache-control': 'no-store' } });
      }
    }
  ];
}
