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
  consents: 'oauth_provider_consents',
  disconnects: 'oauth_provider_disconnects'
} as const;

export function createOAuthProviderSchema(): AuthFnSchemaDefinition['schemas'] {
  const id = { type: 'string', required: true, fieldName: 'id', maxLength: 255 } as const;
  const ref = (fieldName: string) => ({ type: 'string', required: true, fieldName, maxLength: 255 }) as const;
  const text = (fieldName: string) => ({ type: 'string', required: true, fieldName }) as const;
  const date = (fieldName: string, required = true) => ({ type: 'date', required, fieldName }) as const;
  const scopes = { type: 'json', required: true, fieldName: 'scopes' } as const;
  // Written with every conditional claim and read back to decide its winner.
  const claimId = { type: 'string', required: false, fieldName: 'claim_id', maxLength: 64 } as const;
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
        claimId,
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
        claimId,
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
        claimId,
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
        // The number of disconnects of the triple when the user approved.
        generation: { type: 'number', required: true, fieldName: 'generation' },
        createdAt: date('created_at')
      },
      indexes: [{ name: 'idx_authfn_oauth_provider_consents_user_id', fields: ['userId'] }]
    },
    {
      modelName: MODELS.disconnects,
      fields: { id, userId, clientId: ref('client_id'), resource: text('resource'), createdAt: date('created_at') },
      indexes: [{ name: 'idx_authfn_oauth_provider_disconnects_user_id', fields: ['userId'] }]
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

function whereId(id: string, unset: string[] = []) {
  return [
    { field: 'id', operator: 'eq' as const, value: id },
    ...unset.map((field) => ({ field, operator: 'eq' as const, value: null }))
  ];
}

/** A won claim; `release` undoes it unless someone else has claimed the row since. */
export interface OAuthClaim {
  release(): Promise<void>;
}

/**
 * Updates the row `id` only while every field in `unset` is still null, in one
 * conditional statement that also writes a fresh claim ID, then reads the row
 * back: the caller whose claim ID is stored won. Exactly one concurrent caller
 * wins; that is the single-use guarantee for codes and refresh tokens. The
 * adapter's affected-row count is never consulted, because adapters do not
 * all report it reliably. Only a `releasable` claim (spending a code or
 * refresh token) is undone when its write or read-back fails, for example
 * when the write commits but its acknowledgement is lost; a revocation never
 * is. Releasing matches this claim's ID, so it never undoes another's.
 */
async function claimIfUnset(
  store: OAuthStore,
  model: Model,
  id: string,
  unset: string[],
  data: Record<string, unknown>,
  releasable = true
): Promise<OAuthClaim | null> {
  const claimId = createIdentifier('ocl');
  const reset = Object.fromEntries([...Object.keys(data), 'claimId'].map((field) => [field, null]));
  const claim: OAuthClaim = {
    release: async () => {
      await store.database.updateMany({
        model,
        where: [...whereId(id), { field: 'claimId', operator: 'eq', value: claimId }],
        data: reset,
        namespace: namespace(store)
      });
    }
  };
  const claimAndReadBack = async () => {
    await store.database.updateMany({ model, where: whereId(id, unset), data: { ...data, claimId }, namespace: namespace(store) });
    return findBy<{ claimId?: string | null }>(store, model, 'id', id);
  };
  const row = releasable ? await releaseOnFailure(claim, claimAndReadBack) : await claimAndReadBack();
  return row?.claimId === claimId ? claim : null;
}

/**
 * Runs `step` for a won claim. If it throws, the claim is released (only
 * while it is still this caller's), so a client retrying after a failure that
 * issued nothing is not treated as replaying its code or refresh token.
 */
export async function releaseOnFailure<T>(claim: OAuthClaim, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    await claim.release().catch(() => undefined);
    throw error;
  }
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
): Promise<{ grantId: string; code: string }> {
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
  return { grantId: grant.id, code };
}

export function findCode(store: OAuthStore, code: string): Promise<OAuthAuthorizationCodeRecord | null> {
  return findBy(store, MODELS.codes, 'codeHash', hashSecret(code));
}

/** Atomically marks a code consumed; null when another caller already did. */
export function claimCode(store: OAuthStore, codeId: string, now: Date): Promise<OAuthClaim | null> {
  return claimIfUnset(store, MODELS.codes, codeId, ['consumedAt'], { consumedAt: now });
}

export function findGrant(store: OAuthStore, grantId: string): Promise<OAuthGrantRecord | null> {
  return findBy(store, MODELS.grants, 'id', grantId);
}

/**
 * Revokes a grant. Every code, access token and refresh token issued under it
 * stops working at once, because each validity check reads the grant.
 */
export async function revokeGrant(store: OAuthStore, grantId: string, reason: string, now: Date): Promise<boolean> {
  const data = { revokedAt: now, revokedReason: reason, updatedAt: now };
  return (await claimIfUnset(store, MODELS.grants, grantId, ['revokedAt'], data, false)) !== null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  scopes: string[];
}

/**
 * Issues a one-hour access token for `scopes` and a 30-day refresh token for
 * the full grant scope, in exchange for the code or refresh token `claim` won.
 * Both tokens are stored or neither is: when a write fails, the tokens already
 * written are deleted and the claim is released, so the client can retry with
 * the same code or refresh token.
 */
export async function issueTokens(
  store: OAuthStore,
  grant: OAuthGrantRecord,
  scopes: string[],
  now: Date,
  claim: OAuthClaim
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
  await releaseOnFailure(claim, async () => {
    try {
      await insert(store, MODELS.tokens, access);
      await insert(store, MODELS.tokens, refresh);
    } catch (error) {
      for (const id of [access.id, refresh.id]) {
        await store.database.deleteMany({ model: MODELS.tokens, where: whereId(id), namespace: namespace(store) }).catch(() => 0);
      }
      throw error;
    }
  });
  return { accessToken, refreshToken, accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scopes };
}

export function findToken(store: OAuthStore, token: string): Promise<OAuthTokenRecord | null> {
  return findBy(store, MODELS.tokens, 'tokenHash', hashSecret(token));
}

/** Atomically spends a refresh token; null when it was already rotated or revoked. */
export function claimRefreshToken(store: OAuthStore, tokenId: string, now: Date): Promise<OAuthClaim | null> {
  return claimIfUnset(store, MODELS.tokens, tokenId, ['rotatedAt', 'revokedAt'], { rotatedAt: now });
}

export async function revokeToken(store: OAuthStore, tokenId: string, now: Date): Promise<void> {
  await store.database.updateMany({
    model: MODELS.tokens,
    where: whereId(tokenId, ['revokedAt']),
    data: { revokedAt: now },
    namespace: namespace(store)
  });
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

/** A user's authorization of one client at one resource. */
export interface OAuthTriple {
  userId: string;
  clientId: string;
  resource: string;
}

function whereTriple({ userId, clientId, resource }: OAuthTriple) {
  return [
    { field: 'userId', operator: 'eq' as const, value: userId },
    { field: 'clientId', operator: 'eq' as const, value: clientId },
    { field: 'resource', operator: 'eq' as const, value: resource }
  ];
}

/**
 * Disconnects an app: the user's access for `clientId` at `resource`. The
 * consent is removed, so even a trusted client shows the consent page again,
 * and every live grant of that user, client and resource is revoked, with
 * every code, access token and refresh token issued under them. Returns the
 * number of grants revoked.
 *
 * The disconnect first appends a marker for the triple. An authorization in
 * progress reads the markers before it reads or records consent and again
 * after it creates its grant; seeing a new marker, it revokes its grant and
 * removes the consent it recorded. A grant created before the lookup below is
 * revoked here; one created after it sees the marker.
 */
export async function disconnectOAuthClient(
  store: OAuthStore,
  input: OAuthTriple & { now?: () => Date }
): Promise<number> {
  const { userId, clientId, resource } = input;
  const triple = { userId, clientId, resource };
  const now = input.now?.() ?? new Date();
  await insert(store, MODELS.disconnects, { ...triple, id: createIdentifier('odc'), createdAt: now });
  // Consent goes before the grants: if revoking a grant then fails, a retry
  // still finds the grant, while consent left behind would silently re-authorize.
  await store.database.deleteMany({ model: MODELS.consents, where: whereTriple(triple), namespace: namespace(store) });
  const grants = await store.database.findMany<OAuthGrantRecord>({
    model: MODELS.grants,
    where: whereTriple(triple),
    namespace: namespace(store)
  });
  let revoked = 0;
  for (const grant of grants) {
    if (!grant.revokedAt && (await revokeGrant(store, grant.id, 'revoked', now))) {
      revoked += 1;
    }
  }
  return revoked;
}

/**
 * Disconnects the app a grant belongs to, by grant ID (for example from a
 * token's `grantId`). With `userId`, only that user's grant is accepted. Like
 * `disconnectOAuthClient`, it revokes every live grant of the same user,
 * client and resource, not only `grantId`, and removes the consent. Returns
 * whether a live grant was revoked.
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
  const { userId, clientId, resource } = grant;
  return (await disconnectOAuthClient(store, { userId, clientId, resource, now: options?.now })) > 0;
}

/** How many times the triple was disconnected; markers are never removed. */
export async function countDisconnects(store: OAuthStore, triple: OAuthTriple): Promise<number> {
  return (await store.database.findMany({ model: MODELS.disconnects, where: whereTriple(triple), namespace: namespace(store) })).length;
}

/**
 * The scopes the user has approved for the triple since its latest disconnect
 * (`generation`, from `countDisconnects`): the union of those approvals, or
 * null when there is none. Each approval is its own row, so concurrent
 * approvals never overwrite each other, and an approval made before a
 * disconnect never counts after it, even if it was written late.
 */
export async function findConsentScopes(store: OAuthStore, triple: OAuthTriple, generation: number): Promise<string[] | null> {
  const records = await store.database.findMany<OAuthConsentRecord>({
    model: MODELS.consents,
    where: [...whereTriple(triple), { field: 'generation', operator: 'eq', value: generation }],
    namespace: namespace(store)
  });
  return records.length === 0 ? null : [...new Set(records.flatMap((record) => record.scopes))];
}

/** Records that the user approved `scopes` for the triple in `generation`; returns the approval's ID. */
export async function recordConsent(
  store: OAuthStore,
  input: OAuthTriple & { scopes: string[]; generation: number; now: Date }
): Promise<string> {
  const { now, ...consent } = input;
  const id = createIdentifier('ocs');
  await insert(store, MODELS.consents, { ...consent, id, createdAt: now });
  return id;
}

export async function deleteConsent(store: OAuthStore, consentId: string): Promise<void> {
  await store.database.deleteMany({ model: MODELS.consents, where: whereId(consentId), namespace: namespace(store) });
}
