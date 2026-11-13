import type { Route } from '@superfunctions/http';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import {
  handleOAuth,
  OAuthError,
  oauthJson,
  readBearerToken,
  readFormBody,
  requireParam,
  secretsEqual
} from '../http.js';
import { resolveEndpoints, type OAuthProviderRuntime } from '../runtime.js';
import { loadActiveToken } from '../store.js';

export const OAUTH_INTROSPECTION_PATH = '/oauth/introspect';

/**
 * Token introspection (RFC 7662) for resource servers. The caller
 * authenticates with its resource's introspection secret, and a token is
 * reported active only when it is an active access token issued for that
 * resource: a token presented at the wrong audience is inactive.
 */
export function createIntrospectionRoute(runtime: OAuthProviderRuntime): Route {
  return {
    method: 'POST',
    path: OAUTH_INTROSPECTION_PATH,
    meta: createAuthFnRouteMeta('oauthIntrospect', 'OAuth 2.0 token introspection', { mode: 'bearer' }),
    handler: (request) => handleOAuth(async () => {
      const secret = readBearerToken(request);
      const caller = secret === null
        ? undefined
        : runtime.config.resources.find((resource) =>
          resource.introspectionSecret !== undefined && secretsEqual(secret, resource.introspectionSecret));
      if (!caller) {
        throw new OAuthError('invalid_token', 'Resource server authentication failed', 401, {
          'www-authenticate': 'Bearer error="invalid_token"'
        });
      }

      const params = await readFormBody(request);
      const active = await loadActiveToken(runtime.store, requireParam(params, 'token'), 'access', runtime.now());
      if (!active || active.record.resource !== caller.resource) {
        return oauthJson({ active: false });
      }
      const { record } = active;
      return oauthJson({
        active: true,
        scope: record.scopes.join(' '),
        client_id: record.clientId,
        sub: record.userId,
        aud: record.resource,
        iss: (await resolveEndpoints(runtime, request)).issuer,
        token_type: 'Bearer',
        iat: Math.floor(record.createdAt.getTime() / 1000),
        exp: Math.floor(record.expiresAt.getTime() / 1000)
      });
    })
  };
}
