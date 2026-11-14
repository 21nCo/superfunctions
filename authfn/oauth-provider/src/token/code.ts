import { OAuthError, requireParam } from '../http.js';
import { verifyS256 } from '../pkce.js';
import type { OAuthProviderRuntime } from '../runtime.js';
import {
  claimCode,
  findCode,
  findGrant,
  isActiveUser,
  revokeGrant,
  stageTokens,
  type IssuedTokens
} from '../store.js';
import type { OAuthProviderClient } from '../types.js';

function invalidGrant(description: string): OAuthError {
  return new OAuthError('invalid_grant', description);
}

/**
 * Authorization code grant (RFC 6749 4.1.3, RFC 7636 4.6). A code works once:
 * when its own client presents a spent code again with the right
 * redirect_uri and code_verifier, the whole grant is revoked, so tokens
 * already issued from it stop working (RFC 6749 4.1.2, 10.5).
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
  // Bind the presenter to the code before anything else: only the client the
  // code was issued to, holding the PKCE verifier, may trigger replay
  // revocation. Anyone else holding a spent code gets invalid_grant and the
  // grant stays untouched.
  if (record.clientId !== client.clientId) {
    throw invalidGrant('Authorization code was issued to another client');
  }
  if (params.get('redirect_uri') !== record.redirectUri) {
    throw invalidGrant('redirect_uri does not match the authorization request');
  }
  if (!verifyS256(verifier, record.codeChallenge)) {
    throw invalidGrant('code_verifier does not match the code_challenge');
  }
  if (record.consumedAt) {
    await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    throw invalidGrant('Authorization code has already been used');
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    throw invalidGrant('Authorization code has expired');
  }
  const resource = params.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the authorization request');
  }

  const grant = await findGrant(runtime.store, record.grantId);
  if (!grant || grant.revokedAt || !(await isActiveUser(runtime.store, grant.userId))) {
    throw invalidGrant('Authorization grant is no longer valid');
  }

  // The tokens are staged first; the conditional claim on the code commits
  // them and is the single-use guarantee: a concurrent redemption that loses
  // the race is a replay, and its staged tokens never become valid.
  const { tokens, claimId } = await stageTokens(runtime.store, grant, grant.scopes, now, record.id);
  if (!(await claimCode(runtime.store, record.id, now, claimId))) {
    await revokeGrant(runtime.store, record.grantId, 'code_replay', now);
    throw invalidGrant('Authorization code has already been used');
  }
  return tokens;
}
