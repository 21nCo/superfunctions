import type { Route } from '@superfunctions/http';
import { createAuthFnRouteMeta } from 'authfn/http/router';
import { authenticateClient, handleOAuth, requireParam, readFormBody } from '../http.js';
import type { OAuthProviderRuntime } from '../runtime.js';
import { findToken, revokeGrant, revokeToken } from '../store.js';

export const OAUTH_REVOCATION_PATH = '/oauth/revoke';

/**
 * Token revocation (RFC 7009). Revoking a refresh token revokes its whole
 * grant, including every access token issued under it (2.1); revoking an
 * access token revokes only that token. An unknown token, or one issued to
 * another client, is answered with 200 and left untouched (2.2), so the
 * endpoint never reveals whether a token exists.
 */
export function createRevocationRoute(runtime: OAuthProviderRuntime): Route {
  return {
    method: 'POST',
    path: OAUTH_REVOCATION_PATH,
    meta: createAuthFnRouteMeta('oauthRevoke', 'OAuth 2.0 token revocation', { mode: 'none' }),
    handler: (request) => handleOAuth(async () => {
      const params = await readFormBody(request);
      const client = await authenticateClient(runtime, request, params);
      const record = await findToken(runtime.store, requireParam(params, 'token'));
      if (record?.clientId === client.clientId) {
        const now = runtime.now();
        if (record.kind === 'refresh') {
          await revokeGrant(runtime.store, record.grantId, 'revoked', now);
        } else {
          await revokeToken(runtime.store, record.id, now);
        }
      }
      return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
    })
  };
}
