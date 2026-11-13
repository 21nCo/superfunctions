import { randomBytes } from 'node:crypto';
import {
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  type AuthFnRuntimeConfig,
  type AuthFnSchemaDefinition
} from 'authfn';
import { findActiveApiKeyOwner } from 'authfn/core/api-keys';
import { hashSecret } from 'authfn/core/sessions';
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  type OAuthAccessTokenInfo,
  type OAuthAuthorizationCodeRecord,
  type OAuthConsentRecord,
  type OAuthGrantRecord,
  type OAuthTokenKind,
  type OAuthTokenRecord
} from './types.js';

/** Storage scope: the AuthFn database adapter and namespace (default `authfn`). */
export interface OAuthStore {
  database: AuthFnRuntimeConfig['database'];
  namespace?: string;
}

const MODELS = {
  grants: 'oauth_provider_grants',
  codes: 'oauth_provider_codes',
  tokens: 'oauth_provider_tokens',
  consents: 'oauth_provider_consents'
} as const;

export function createOAuthProviderSchema(): AuthFnSchemaDefinition['schemas'] {
  const id = { type: 'string', required: true, fieldName: 'id', maxLength: 255 } as const;
  const ref = (fieldName: string) => ({ type: 'string', required: true, fieldName, maxLength: 255 }) as const;
  const text = (fieldName: string) => ({ type: 'string', required: true, fieldName }) as const;
  const date = (fieldName: string, required = true) => ({ type: 'date', required, fieldName }) as const;
  const scopes = { type: 'json', required: true, fieldName: 'scopes' } as const;
  // Users created before AuthFn v2 may have IDs up to the legacy bound.
  const userId = { ...ref('user_id'), maxLength: AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH } as const;
  return [
    {
      modelName: MODELS.grants,
      fields: {
        id,
        clientId: ref('client_id'),
        userId,
        resource: text('resource'),
        scopes,
        revokedAt: date('revoked_at', false),
        revokedReason: { type: 'string', required: false, fieldName: 'revoked_reason', maxLength: 64 },
        createdAt: date('created_at'),
        updatedAt: date('updated_at')
      },
      indexes: [{ name: 'idx_authfn_oauth_provider_grants_user_id', fields: ['userId'] }]
    },
    {
      modelName: MODELS.codes,
      fields: {
        id,
        codeHash: ref('code_hash'),
        grantId: ref('grant_id'),
        clientId: ref('client_id'),
        userId,
        resource: text('resource'),
        scopes,
        redirectUri: text('redirect_uri'),
        codeChallenge: ref('code_challenge'),
        expiresAt: date('expires_at'),
        consumedAt: date('consumed_at', false),
        createdAt: date('created_at')
      },
      indexes: [{ name: 'idx_authfn_oauth_provider_codes_code_hash', fields: ['codeHash'], unique: true }]
    },
    {
      modelName: MODELS.tokens,
      fields: {
        id,
        kind: { type: 'string', required: true, fieldName: 'kind', maxLength: 16 },
        tokenHash: ref('token_hash'),
        grantId: ref('grant_id'),
        clientId: ref('client_id'),
        userId,
        resource: text('resource'),
        scopes,
        expiresAt: date('expires_at'),
        rotatedAt: date('rotated_at', false),
        revokedAt: date('revoked_at', false),
        createdAt: date('created_at')
      },
      indexes: [
        { name: 'idx_authfn_oauth_provider_tokens_token_hash', fields: ['tokenHash'], unique: true },
        { name: 'idx_authfn_oauth_provider_tokens_grant_id', fields: ['grantId'] }
      ]
    },
    {
      modelName: MODELS.consents,
      fields: {
        id,
        userId,
        clientId: ref('client_id'),
        resource: text('resource'),
        scopes,
        createdAt: date('created_at'),
        updatedAt: date('updated_at')
      },
      indexes: [{ name: 'idx_authfn_oauth_provider_consents_user_id', fields: ['userId'] }]
    }
  ];
}

function namespace(store: OAuthStore): string {
  return store.namespace ?? 'authfn';
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

type Model = (typeof MODELS)[keyof typeof MODELS];

function insert(store: OAuthStore, model: Model, data: object): Promise<unknown> {
  return store.database.create({ model, data: data as Record<string, unknown>, namespace: namespace(store) });
}

function findBy<T>(store: OAuthStore, model: Model, field: string, value: string): Promise<T | null> {
  return store.database.findOne<T>({ model, where: [{ field, operator: 'eq', value }], namespace: namespace(store) });
}

/**
 * Updates the row `id` only while every field in `unset` is still null, in one
 * conditional statement. Exactly one concurrent caller wins; that is the
 * single-use guarantee for codes and refresh tokens.
 */
async function updateIfUnset(
  store: OAuthStore,
  model: Model,
  id: string,
  unset: string[],
  data: Record<string, unknown>
): Promise<boolean> {
  const updated = await store.database.updateMany({
    model,
    where: [
      { field: 'id', operator: 'eq', value: id },
      ...unset.map((field) => ({ field, operator: 'eq' as const, value: null }))
    ],
    data,
    namespace: namespace(store)
  });
  return updated === 1;
}

export async function createGrantWithCode(
  store: OAuthStore,
  input: {
    clientId: string;
    userId: string;
    resource: string;
    scopes: string[];
    redirectUri: string;
    codeChallenge: string;
    now: Date;
  }
): Promise<string> {
  const { redirectUri, codeChallenge, now, ...shared } = input;
  const grant: OAuthGrantRecord = {
    ...shared,
    id: createIdentifier('ogr'),
    revokedAt: null,
    revokedReason: null,
    createdAt: now,
    updatedAt: now
  };
  await insert(store, MODELS.grants, grant);

  const code = createSecret('oac');
  const record: OAuthAuthorizationCodeRecord = {
    ...shared,
    id: createIdentifier('oco'),
    codeHash: hashSecret(code),
    grantId: grant.id,
    redirectUri,
    codeChallenge,
    expiresAt: addSeconds(now, OAUTH_AUTHORIZATION_CODE_TTL_SECONDS),
    consumedAt: null,
    createdAt: now
  };
  await insert(store, MODELS.codes, record);
  return code;
}

export function findCode(store: OAuthStore, code: string): Promise<OAuthAuthorizationCodeRecord | null> {
  return findBy(store, MODELS.codes, 'codeHash', hashSecret(code));
}

/** Atomically marks a code consumed; false when another caller already did. */
export function claimCode(store: OAuthStore, codeId: string, now: Date): Promise<boolean> {
  return updateIfUnset(store, MODELS.codes, codeId, ['consumedAt'], { consumedAt: now });
}

export function findGrant(store: OAuthStore, grantId: string): Promise<OAuthGrantRecord | null> {
  return findBy(store, MODELS.grants, 'id', grantId);
}

/**
 * Revokes a grant. Every code, access token and refresh token issued under it
 * stops working at once, because each validity check reads the grant.
 */
export function revokeGrant(store: OAuthStore, grantId: string, reason: string, now: Date): Promise<boolean> {
  return updateIfUnset(store, MODELS.grants, grantId, ['revokedAt'], { revokedAt: now, revokedReason: reason, updatedAt: now });
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  scopes: string[];
}

/**
 * Issues a one-hour access token for `scopes` and a 30-day refresh token for
 * the full grant scope.
 */
export async function issueTokens(
  store: OAuthStore,
  grant: OAuthGrantRecord,
  scopes: string[],
  now: Date
): Promise<IssuedTokens> {
  const accessToken = createSecret('oat');
  const refreshToken = createSecret('ort');
  const base = {
    grantId: grant.id,
    clientId: grant.clientId,
    userId: grant.userId,
    resource: grant.resource,
    rotatedAt: null,
    revokedAt: null,
    createdAt: now
  };
  const access: OAuthTokenRecord = {
    ...base,
    id: createIdentifier('otk'),
    kind: 'access',
    tokenHash: hashSecret(accessToken),
    scopes,
    expiresAt: addSeconds(now, OAUTH_ACCESS_TOKEN_TTL_SECONDS)
  };
  const refresh: OAuthTokenRecord = {
    ...base,
    id: createIdentifier('otk'),
    kind: 'refresh',
    tokenHash: hashSecret(refreshToken),
    scopes: grant.scopes,
    expiresAt: addSeconds(now, OAUTH_REFRESH_TOKEN_TTL_SECONDS)
  };
  await insert(store, MODELS.tokens, access);
  await insert(store, MODELS.tokens, refresh);
  return { accessToken, refreshToken, accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scopes };
}

export function findToken(store: OAuthStore, token: string): Promise<OAuthTokenRecord | null> {
  return findBy(store, MODELS.tokens, 'tokenHash', hashSecret(token));
}

/** Atomically spends a refresh token; false when it was already rotated or revoked. */
export function claimRefreshToken(store: OAuthStore, tokenId: string, now: Date): Promise<boolean> {
  return updateIfUnset(store, MODELS.tokens, tokenId, ['rotatedAt', 'revokedAt'], { rotatedAt: now });
}

export async function revokeToken(store: OAuthStore, tokenId: string, now: Date): Promise<void> {
  await updateIfUnset(store, MODELS.tokens, tokenId, ['revokedAt'], { revokedAt: now });
}

/**
 * The one validity rule for issued tokens: the token is of the expected
 * kind, unexpired and unrevoked, its grant is unrevoked, and the user it acts
 * for still exists and is not disabled (the same owner rule API keys follow).
 */
export async function loadActiveToken(
  store: OAuthStore,
  token: string,
  kind: OAuthTokenKind,
  now: Date
): Promise<{ record: OAuthTokenRecord; grant: OAuthGrantRecord } | null> {
  const record = await findToken(store, token);
  return record ? activeTokenState(store, record, kind, now) : null;
}

/** Applies the validity rule of `loadActiveToken` to a record already loaded. */
export async function activeTokenState(
  store: OAuthStore,
  record: OAuthTokenRecord,
  kind: OAuthTokenKind,
  now: Date
): Promise<{ record: OAuthTokenRecord; grant: OAuthGrantRecord } | null> {
  if (record.kind !== kind || record.revokedAt || record.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  const grant = await findGrant(store, record.grantId);
  if (!grant || grant.revokedAt) {
    return null;
  }
  return (await isActiveUser(store, record.userId)) ? { record, grant } : null;
}

/** The user exists and is not disabled; shared with the API-key owner rule. */
export async function isActiveUser(store: OAuthStore, userId: string): Promise<boolean> {
  return (await findActiveApiKeyOwner({ database: store.database, namespace: namespace(store) }, userId)) !== null;
}

export function toAccessTokenInfo(record: OAuthTokenRecord): OAuthAccessTokenInfo {
  return {
    tokenId: record.id,
    grantId: record.grantId,
    clientId: record.clientId,
    userId: record.userId,
    resource: record.resource,
    scopes: [...record.scopes],
    issuedAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}

/**
 * Verifies an access token for a resource server in the same process. Returns
 * `null` unless the token is active and was issued for exactly `resource`
 * (its audience, RFC 8707). Pass the result to `requireScopes`.
 */
export async function verifyOAuthAccessToken(
  store: OAuthStore,
  token: string,
  options: { resource: string; now?: () => Date }
): Promise<OAuthAccessTokenInfo | null> {
  if (typeof token !== 'string' || token.length === 0 || typeof options?.resource !== 'string') {
    return null;
  }
  const active = await loadActiveToken(store, token, 'access', options.now?.() ?? new Date());
  return active && active.record.resource === options.resource ? toAccessTokenInfo(active.record) : null;
}

/**
 * Revokes a grant by ID, for account settings that let a user disconnect an
 * app. With `userId`, only that user's grant is revoked. Returns whether a
 * live grant was revoked.
 */
export async function revokeOAuthGrant(
  store: OAuthStore,
  grantId: string,
  options?: { userId?: string; now?: () => Date }
): Promise<boolean> {
  const grant = await findGrant(store, grantId);
  if (!grant || (options?.userId !== undefined && grant.userId !== options.userId)) {
    return false;
  }
  return revokeGrant(store, grantId, 'revoked', options?.now?.() ?? new Date());
}

export async function findConsent(
  store: OAuthStore,
  userId: string,
  clientId: string,
  resource: string
): Promise<OAuthConsentRecord | null> {
  const records = await store.database.findMany<OAuthConsentRecord>({
    model: MODELS.consents,
    where: [
      { field: 'userId', operator: 'eq', value: userId },
      { field: 'clientId', operator: 'eq', value: clientId }
    ],
    namespace: namespace(store)
  });
  return records.find((record) => record.resource === resource) ?? null;
}

/** Records that the user approved `scopes` for this client at this resource. */
export async function recordConsent(
  store: OAuthStore,
  input: { userId: string; clientId: string; resource: string; scopes: string[]; now: Date }
): Promise<void> {
  const { now, ...consent } = input;
  const existing = await findConsent(store, input.userId, input.clientId, input.resource);
  if (!existing) {
    await insert(store, MODELS.consents, { ...consent, id: createIdentifier('ocs'), createdAt: now, updatedAt: now });
    return;
  }
  await store.database.updateMany({
    model: MODELS.consents,
    where: [{ field: 'id', operator: 'eq', value: existing.id }],
    data: { scopes: [...new Set([...existing.scopes, ...input.scopes])], updatedAt: now },
    namespace: namespace(store)
  });
}
