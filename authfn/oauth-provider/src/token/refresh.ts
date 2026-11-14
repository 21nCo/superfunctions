import { OAuthError, requireParam } from '../http.js';
import type { OAuthProviderRuntime } from '../runtime.js';
import {
  activeTokenState,
  claimRefreshToken,
  findLiveGrant,
  findToken,
  revokeGrant,
  stageTokens,
  type IssuedTokens
} from '../store.js';
import type { OAuthProviderClient } from '../types.js';

function invalidGrant(description: string): OAuthError {
  return new OAuthError('invalid_grant', description);
}

/**
 * Refresh token grant (RFC 6749 6) with rotation: every use spends the
 * refresh token and returns a new one. Presenting a spent refresh token is
 * reuse, which revokes the whole grant (OAuth 2.1 4.3.1).
 */
export async function refreshAccessToken(
  runtime: OAuthProviderRuntime,
  client: OAuthProviderClient,
  params: Map<string, string>
): Promise<IssuedTokens> {
  const token = requireParam(params, 'refresh_token');
  const now = runtime.now();
  const record = await findToken(runtime.store, token);
  if (record?.kind !== 'refresh' || record.clientId !== client.clientId) {
    throw invalidGrant('Refresh token is invalid');
  }
  if (record.rotatedAt) {
    await revokeGrant(runtime.store, record.grantId, 'refresh_reuse', now);
    throw invalidGrant('Refresh token has already been used');
  }
  const active = await activeTokenState(runtime.store, record, 'refresh', now);
  if (!active) {
    throw invalidGrant('Refresh token is expired or revoked');
  }

  const resource = params.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    throw new OAuthError('invalid_target', 'resource does not match the grant');
  }
  const scope = params.get('scope');
  const scopes = scope === undefined ? active.grant.scopes : [...new Set(scope.split(' '))];
  if (scopes.some((entry) => !active.grant.scopes.includes(entry))) {
    throw new OAuthError('invalid_scope', 'scope must not exceed the original grant');
  }

  // Staged tokens become valid only when this claim on the refresh token commits.
  const { tokens, claimId } = await stageTokens(runtime.store, active.grant, scopes, now, record.id);
  if (!(await claimRefreshToken(runtime.store, record.id, now, claimId))) {
    await revokeGrant(runtime.store, record.grantId, 'refresh_reuse', now);
    throw invalidGrant('Refresh token has already been used');
  }
  // As for a code: a grant or user that ended before the claim committed wins.
  if (!(await findLiveGrant(runtime.store, record.grantId))) {
    throw invalidGrant('Refresh token is expired or revoked');
  }
  return tokens;
}
