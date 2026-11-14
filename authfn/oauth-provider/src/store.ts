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
        // The code or refresh token this token was issued for, and the claim
        // that must have spent it: the token is valid only once it has.
        sourceId: ref('source_id'),
        issuingClaimId: { type: 'string', required: true, fieldName: 'issuing_claim_id', maxLength: 64 },
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
        // The triple's disconnect generation when the user approved.
        generation: { type: 'string', required: true, fieldName: 'generation', maxLength: 64 },
        createdAt: date('created_at')
      },
      // A user's rows for one client and resource are few (see recordConsent);
      // `resource` is unbounded text, so it cannot be part of a MySQL key.
      indexes: [{ name: 'idx_authfn_oauth_provider_consents_user_id', fields: ['userId'] }]
    },
    {
      modelName: MODELS.disconnects,
      // Found by triple: one row, or a few after concurrent first disconnects
      // (see readGeneration); each disconnect writes a fresh `generation`.
      fields: {
        id,
        userId,
        clientId: ref('client_id'),
        resource: text('resource'),
        generation: { type: 'string', required: true, fieldName: 'generation', maxLength: 64 },
        createdAt: date('created_at'),
        updatedAt: date('updated_at')
      },
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

const CODE_ID_PREFIX = 'oco';

/**
 * Updates the row `id` only while every field in `unset` is still null, in one
 * conditional statement that also writes `claimId`, then reads the row back:
 * the caller whose claim ID is stored won. Exactly one concurrent caller wins;
 * that is the single-use guarantee for codes and refresh tokens. The adapter's
 * affected-row count is never consulted, because adapters do not all report
 * it reliably. When the write throws, the read-back still decides: it may have
 * committed before its acknowledgement was lost. A claim is never undone.
 */
async function claimIfUnset(
  store: OAuthStore,
  model: Model,
  id: string,
  unset: string[],
  data: Record<string, unknown>,
  claimId = createIdentifier('ocl')
): Promise<boolean> {
  let writeError: { error: unknown } | undefined;
  try {
    await store.database.updateMany({ model, where: whereId(id, unset), data: { ...data, claimId }, namespace: namespace(store) });
  } catch (error) {
    writeError = { error };
  }
  const row = await findBy<{ claimId?: string | null }>(store, model, 'id', id);
  if (row?.claimId === claimId) {
    return true;
  }
  // Unclaimed after a failed write: nothing happened, so report the failure.
  if (writeError && !row?.claimId) {
    throw writeError.error;
  }
  return false;
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
    id: createIdentifier(CODE_ID_PREFIX),
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

/**
 * Atomically marks a code consumed with `claimId`, which commits the tokens
 * staged under it; false when another caller already did.
 */
export function claimCode(store: OAuthStore, codeId: string, now: Date, claimId: string): Promise<boolean> {
  return claimIfUnset(store, MODELS.codes, codeId, ['consumedAt'], { consumedAt: now }, claimId);
}

export function findGrant(store: OAuthStore, grantId: string): Promise<OAuthGrantRecord | null> {
  return findBy(store, MODELS.grants, 'id', grantId);
}

/**
 * The grant, while it is unrevoked and its user still exists and is not
 * disabled (the same owner rule API keys follow); null otherwise. This is the
 * one grant rule: token issuance checks it before staging and again after its
 * claim commits, and `activeTokenState` checks it at every use.
 */
export async function findLiveGrant(store: OAuthStore, grantId: string): Promise<OAuthGrantRecord | null> {
  const grant = await findGrant(store, grantId);
  return grant && !grant.revokedAt && (await isActiveUser(store, grant.userId)) ? grant : null;
}

/**
 * Revokes a grant. Every code, access token and refresh token issued under it
 * stops working at once, because each validity check reads the grant.
 */
export async function revokeGrant(store: OAuthStore, grantId: string, reason: string, now: Date): Promise<boolean> {
  const data = { revokedAt: now, revokedReason: reason, updatedAt: now };
  return claimIfUnset(store, MODELS.grants, grantId, ['revokedAt'], data);
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  scopes: string[];
}

/**
 * Stages a one-hour access token for `scopes` and a 30-day refresh token for
 * the full grant scope, in exchange for the code or refresh token `sourceId`.
 * Both are written before the caller claims the source with the returned
 * `claimId` (`claimCode`, `claimRefreshToken`), and neither is valid until
 * that claim commits: the claim is the single commit point. A failure before
 * it leaves the source unspent and the staged rows inert; a lost race leaves
 * the loser's rows inert. If the response is lost after the claim, a retry is
 * a replay, which revokes the grant (RFC 6749 4.1.2).
 */
export async function stageTokens(
  store: OAuthStore,
  grant: OAuthGrantRecord,
  scopes: string[],
  now: Date,
  sourceId: string
): Promise<{ tokens: IssuedTokens; claimId: string }> {
  const accessToken = createSecret('oat');
  const refreshToken = createSecret('ort');
  const claimId = createIdentifier('ocl');
  const base = {
    grantId: grant.id,
    clientId: grant.clientId,
    userId: grant.userId,
    resource: grant.resource,
    rotatedAt: null,
    revokedAt: null,
    sourceId,
    issuingClaimId: claimId,
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
  return { tokens: { accessToken, refreshToken, accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_TTL_SECONDS, scopes }, claimId };
}

export function findToken(store: OAuthStore, token: string): Promise<OAuthTokenRecord | null> {
  return findBy(store, MODELS.tokens, 'tokenHash', hashSecret(token));
}

/**
 * Atomically spends a refresh token with `claimId`, which commits the tokens
 * staged under it; false when it was already rotated or revoked.
 */
export function claimRefreshToken(store: OAuthStore, tokenId: string, now: Date, claimId: string): Promise<boolean> {
  return claimIfUnset(store, MODELS.tokens, tokenId, ['rotatedAt', 'revokedAt'], { rotatedAt: now }, claimId);
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
 * kind, unexpired and unrevoked, the claim that issued it committed (its code
 * or parent refresh token stores `issuingClaimId`), and its grant is live
 * (`findLiveGrant`).
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
  const sourceModel = record.sourceId.startsWith(`${CODE_ID_PREFIX}_`) ? MODELS.codes : MODELS.tokens;
  const source = await findBy<{ claimId?: string | null }>(store, sourceModel, 'id', record.sourceId);
  if (!source?.claimId || source.claimId !== record.issuingClaimId) {
    return null;
  }
  const grant = await findLiveGrant(store, record.grantId);
  return grant ? { record, grant } : null;
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
 * The disconnect first writes a new generation for the triple. An
 * authorization in progress reads the generation before it reads or records
 * consent and again after it creates its grant; seeing it change, it revokes
 * its grant and removes the consent it recorded. A grant created before the
 * lookup below is revoked here; one created after it sees the change.
 */
export async function disconnectOAuthClient(
  store: OAuthStore,
  input: OAuthTriple & { now?: () => Date }
): Promise<number> {
  const { userId, clientId, resource } = input;
  const triple = { userId, clientId, resource };
  const now = input.now?.() ?? new Date();
  await writeNewGeneration(store, triple, now);
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

/** The generation before the triple's first disconnect. */
const INITIAL_GENERATION = 'initial';

type DisconnectRow = { id: string; generation: string };

function findDisconnects(store: OAuthStore, triple: OAuthTriple): Promise<DisconnectRow[]> {
  return store.database.findMany<DisconnectRow>({ model: MODELS.disconnects, where: whereTriple(triple), namespace: namespace(store) });
}

/**
 * The triple's disconnect generation, whatever the disconnect history: its
 * disconnect row holds the value. Concurrent first disconnects can each add
 * a row; the one with the lowest ID decides. Every value written is new and
 * each disconnect overwrites every row, so a generation read before a
 * disconnect never matches one read after it.
 */
export async function readGeneration(store: OAuthStore, triple: OAuthTriple): Promise<string> {
  const [first] = (await findDisconnects(store, triple)).sort((a, b) => (a.id < b.id ? -1 : 1));
  return first?.generation ?? INITIAL_GENERATION;
}

async function writeNewGeneration(store: OAuthStore, triple: OAuthTriple, now: Date): Promise<void> {
  if ((await findDisconnects(store, triple)).length === 0) {
    const id = createIdentifier('odc');
    await insert(store, MODELS.disconnects, { ...triple, id, generation: createIdentifier('ogn'), createdAt: now, updatedAt: now });
  }
  await store.database.updateMany({
    model: MODELS.disconnects,
    where: whereTriple(triple),
    data: { generation: createIdentifier('ogn'), updatedAt: now },
    namespace: namespace(store)
  });
}

function findConsents(store: OAuthStore, triple: OAuthTriple, generation: string): Promise<OAuthConsentRecord[]> {
  return store.database.findMany<OAuthConsentRecord>({
    model: MODELS.consents,
    where: [...whereTriple(triple), { field: 'generation', operator: 'eq', value: generation }],
    namespace: namespace(store)
  });
}

function unionScopes(records: OAuthConsentRecord[], scopes: string[] = []): string[] {
  return [...new Set([...records.flatMap((record) => record.scopes), ...scopes])];
}

/**
 * The scopes the user has approved for the triple since its latest disconnect
 * (`generation`, from `readGeneration`): the union of those approvals, or
 * null when there is none. An approval made before a disconnect never counts
 * after it, even if it was written late.
 */
export async function findConsentScopes(store: OAuthStore, triple: OAuthTriple, generation: string): Promise<string[] | null> {
  const records = await findConsents(store, triple, generation);
  return records.length === 0 ? null : unionScopes(records);
}

/**
 * Records that the user approved `scopes` for the triple in `generation`;
 * returns the approval's ID. The new row stores the union of the approvals it
 * read, which it then deletes, so a generation keeps one row plus one per
 * approval that ran concurrently. Concurrent approvals never overwrite each
 * other: each only deletes rows written before it read them.
 */
export async function recordConsent(
  store: OAuthStore,
  input: OAuthTriple & { scopes: string[]; generation: string; now: Date }
): Promise<string> {
  const { now, scopes, ...consent } = input;
  const earlier = await findConsents(store, consent, consent.generation);
  const id = createIdentifier('ocs');
  await insert(store, MODELS.consents, { ...consent, scopes: unionScopes(earlier, scopes), id, createdAt: now });
  for (const record of earlier) {
    await deleteConsent(store, record.id);
  }
  return id;
}

export async function deleteConsent(store: OAuthStore, consentId: string): Promise<void> {
  await store.database.deleteMany({ model: MODELS.consents, where: whereId(consentId), namespace: namespace(store) });
}
