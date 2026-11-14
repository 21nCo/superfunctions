import type { Route } from '@superfunctions/http';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import { authenticateClient, handleOAuth, OAuthError, oauthJson, readFormBody } from '../http.js';
import type { OAuthProviderRuntime } from '../runtime.js';
import type { IssuedTokens } from '../store.js';
import { exchangeAuthorizationCode } from './code.js';
import { refreshAccessToken } from './refresh.js';

export const OAUTH_TOKEN_PATH = '/oauth/token';

export function createTokenRoute(runtime: OAuthProviderRuntime): Route {
  return {
    method: 'POST',
    path: OAUTH_TOKEN_PATH,
    meta: createAuthFnRouteMeta('oauthToken', 'OAuth 2.1 token endpoint', { mode: 'none' }),
    handler: (request) => handleOAuth(async () => {
      const params = await readFormBody(request);
      const client = await authenticateClient(runtime, request, params);
      const grantType = params.get('grant_type');
      let issued: IssuedTokens;
      if (grantType === 'authorization_code') {
        issued = await exchangeAuthorizationCode(runtime, client, params);
      } else if (grantType === 'refresh_token') {
        issued = await refreshAccessToken(runtime, client, params);
      } else if (!grantType) {
        throw new OAuthError('invalid_request', 'Parameter grant_type is required');
      } else {
        throw new OAuthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
      }

      // RFC 6749 5.1: the response carries Cache-Control: no-store.
      return oauthJson({
        access_token: issued.accessToken,
        token_type: 'Bearer',
        expires_in: issued.accessTokenExpiresIn,
        refresh_token: issued.refreshToken,
        scope: issued.scopes.join(' ')
      });
    })
  };
}
