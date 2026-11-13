import { OAuthError, requireParam } from '../http.js';
import { verifyS256 } from '../pkce.js';
import type { OAuthProviderRuntime } from '../runtime.js';
import { claimCode, findCode, findGrant, isActiveUser, issueTokens, revokeGrant, type IssuedTokens } from '../store.js';
import type { OAuthProviderClient } from '../types.js';

function invalidGrant(description: string): OAuthError {
  return new OAuthError('invalid_grant', description);
}

/**
 * Authorization code grant (RFC 6749 4.1.3, RFC 7636 4.6). A code works once:
 * presenting a spent code again revokes the whole grant, so tokens already
 * issued from it stop working (RFC 6749 4.1.2, 10.5).
 */
export async function exchangeAuthorizationCode(
  runtime: OAuthProviderRuntime,
  client: OAuthProviderClient,
  params: Map<string, string>
): Promise<IssuedTokens> {
  const code = requireParam(params, 'code');
  const verifier = requireParam(params, 'code_verifier');
  const now = runtime.now();
  const record = await findCode(runtime.store, code);
  if (!record) {
    throw invalidGrant('Authorization code is invalid');
  }
  if (record.consumedAt) {
    await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    throw invalidGrant('Authorization code has already been used');
  }
  if (record.clientId !== client.clientId) {
    throw invalidGrant('Authorization code was issued to another client');
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    throw invalidGrant('Authorization code has expired');
  }
  if (params.get('redirect_uri') !== record.redirectUri) {
    throw invalidGrant('redirect_uri does not match the authorization request');
  }
  if (!verifyS256(verifier, record.codeChallenge)) {
    throw invalidGrant('code_verifier does not match the code_challenge');
  }
  const resource = params.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the authorization request');
  }

  // The conditional update is the single-use guarantee: a concurrent
  // redemption that loses the race is a replay.
  if (!(await claimCode(runtime.store, record.id, now))) {
    await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    throw invalidGrant('Authorization code has already been used');
  }

  const grant = await findGrant(runtime.store, record.grantId);
  if (!grant || grant.revokedAt || !(await isActiveUser(runtime.store, grant.userId))) {
    throw invalidGrant('Authorization grant is no longer valid');
  }
  return issueTokens(runtime.store, grant, grant.scopes, now);
}
