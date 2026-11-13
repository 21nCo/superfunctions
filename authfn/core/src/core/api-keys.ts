import { randomBytes } from 'node:crypto';
import type {
  AuthFnApiKeyRecord,
  AuthFnRuntimeConfig,
  AuthFnSession,
  AuthFnUserRecord
} from '../types.js';
import { AuthFnApiKeyRevokedError, AuthFnNotFoundError, AuthFnValidationError } from './errors.js';
import {
  AUTHFN_DATABASE_KEY_MAX_LENGTH,
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  assertAuthFnDatabaseKeyLength
} from './limits.js';
import { assertRegisteredScopes } from './scopes.js';
import { hashSecret } from './sessions.js';
import { findUserById } from './users.js';

export interface CreateApiKeyInput {
  /** Explicit null creates an unowned key for a trusted service principal. */
  userId: string | null;
  name: string;
  /**
   * Each entry must be a scope from `config.scopes`, `<owner>:*` for a
   * registered owner, or `*`; anything else is rejected with
   * `AUTHFN_VALIDATION_ERROR`. Omitted scopes grant nothing.
   */
  scopes?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date;
}

export interface CreatedApiKey {
  keyId: string;
  secret: string;
  record: AuthFnApiKeyRecord;
}

export interface SanitizedApiKey {
  id: string;
  userId?: string | null;
  name?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createApiKey(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace' | 'scopes'>,
  input: CreateApiKeyInput,
  options?: { now?: () => Date; secretPrefix?: string }
): Promise<CreatedApiKey> {
  assertValidApiKeyName(input.name);
  assertValidApiKeyExpiry(input.expiresAt);
  const scopes = input.scopes === undefined
    ? undefined
    : assertRegisteredScopes(config.scopes, input.scopes);
  let userId = input.userId;
  if (userId !== null) {
    const userIdLength = Array.from(userId).length;
    assertAuthFnDatabaseKeyLength(
      userId,
      'userId',
      AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
    );
    const legacyUser = userIdLength > AUTHFN_DATABASE_KEY_MAX_LENGTH
      ? await findUserById(config, userId)
      : null;
    userId = legacyUser
      ? assertAuthFnDatabaseKeyLength(
          userId,
          'userId',
          AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
        )
      : assertAuthFnDatabaseKeyLength(userId, 'userId');
  }
  const now = options?.now?.() ?? new Date();
  const secret = createApiKeySecret(options?.secretPrefix);
  const record: AuthFnApiKeyRecord = {
    id: createIdentifier('key'),
    userId,
    name: input.name,
    secretHash: hashSecret(secret),
    scopes,
    metadata: input.metadata,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now
  };

  await config.database.create<AuthFnApiKeyRecord>({
    model: 'api_keys',
    data: record,
    namespace: namespace(config)
  });

  return {
    keyId: record.id,
    secret,
    record
  };
}

export async function listApiKeysForUser(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<SanitizedApiKey[]> {
  const records = await config.database.findMany<AuthFnApiKeyRecord>({
    model: 'api_keys',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    orderBy: [
      { field: 'createdAt', direction: 'asc' },
      { field: 'id', direction: 'asc' }
    ],
    namespace: namespace(config)
  });

  return records.map((record) => sanitizeApiKeyRecord(record));
}

export async function findApiKeyById(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  keyId: string
): Promise<AuthFnApiKeyRecord | null> {
  return config.database.findOne<AuthFnApiKeyRecord>({
    model: 'api_keys',
    where: [{ field: 'id', operator: 'eq', value: keyId }],
    namespace: namespace(config)
  });
}

export async function revokeApiKeyById(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  keyId: string,
  options?: { userId?: string; now?: () => Date }
): Promise<AuthFnApiKeyRecord> {
  const record = await findApiKeyById(config, keyId);
  if (!record || (options?.userId && record.userId !== options.userId)) {
    throw new AuthFnNotFoundError('API key not found', { keyId });
  }

  if (record.revokedAt) {
    return record;
  }

  const revokedAt = options?.now?.() ?? new Date();
  return config.database.update<AuthFnApiKeyRecord>({
    model: 'api_keys',
    where: [{ field: 'id', operator: 'eq', value: keyId }],
    data: {
      revokedAt,
      updatedAt: revokedAt
    },
    namespace: namespace(config)
  });
}

export async function authenticateApiKey(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  secret: string,
  options?: { now?: () => Date }
): Promise<AuthFnSession | null> {
  const record = await config.database.findOne<AuthFnApiKeyRecord>({
    model: 'api_keys',
    where: [{ field: 'secretHash', operator: 'eq', value: hashSecret(secret) }],
    namespace: namespace(config)
  });

  if (!record) {
    return null;
  }

  if (record.revokedAt) {
    throw new AuthFnApiKeyRevokedError('API key has been revoked', {
      keyId: record.id
    });
  }

  const now = options?.now?.() ?? new Date();
  if (record.expiresAt && record.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  // An owned key acts as its owner, so the owner must still be able to act:
  // a deleted or disabled owner leaves the key authenticating as no one.
  let owner: AuthFnUserRecord | null = null;
  if (record.userId != null) {
    owner = await findActiveApiKeyOwner(config, record.userId);
    if (!owner) {
      return null;
    }
  }

  const updatedRecord = await config.database.update<AuthFnApiKeyRecord>({
    model: 'api_keys',
    where: [{ field: 'id', operator: 'eq', value: record.id }],
    data: {
      lastUsedAt: now,
      updatedAt: now
    },
    namespace: namespace(config)
  });

  // Keys stored before scopes were validated may hold any JSON; only string
  // entries can grant, and `requireScopes` matches them exactly.
  const grantedScopes = Array.isArray(updatedRecord.scopes)
    ? updatedRecord.scopes.filter((scope): scope is string => typeof scope === 'string')
    : [];
  const actor = owner
    ? { actorId: owner.id, actorType: 'user' as const }
    : { actorId: updatedRecord.id, actorType: 'api-key' as const };

  return {
    id: updatedRecord.id,
    type: 'api-key',
    subject: { ...actor },
    ...actor,
    credential: { type: 'api-key', id: updatedRecord.id },
    resourceIds: [],
    methods: ['api-key'],
    scopes: [...grantedScopes],
    expiresAt: updatedRecord.expiresAt ?? undefined,
    metadata: {
      ...(updatedRecord.metadata ?? {}),
      // Deprecated: kept for one minor version; read `actorId` instead.
      ownerUserId: owner?.id,
      // Deprecated: read `session.scopes` (checked by `requireScopes`).
      scopes: [...grantedScopes]
    }
  };
}

/**
 * AuthFn has no user status column; a host disables a user by setting
 * `metadata.disabled` to `true` on the user record. Every API-key path
 * (`authenticateApiKey` and the placement-context issuer) checks it through
 * `findActiveApiKeyOwner`; interactive sessions do not check it today.
 */
export function isAuthFnUserDisabled(user: Pick<AuthFnUserRecord, 'metadata'>): boolean {
  return user.metadata?.disabled === true;
}

/**
 * Loads the owner an API key acts as. Returns `null` when the owner was
 * deleted or is disabled, so the key authenticates as no one. Shared by every
 * API-key authentication path so they cannot disagree on owner eligibility.
 */
export async function findActiveApiKeyOwner(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<AuthFnUserRecord | null> {
  const owner = await findUserById(config, userId);
  if (!owner || isAuthFnUserDisabled(owner)) {
    return null;
  }
  return owner;
}

export function sanitizeApiKeyRecord(record: AuthFnApiKeyRecord): SanitizedApiKey {
  return {
    id: record.id,
    userId: record.userId,
    name: record.name,
    scopes: record.scopes,
    metadata: record.metadata,
    expiresAt: record.expiresAt ?? null,
    revokedAt: record.revokedAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function createApiKeySecret(prefix: string = 'ak'): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}

function assertValidApiKeyName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AuthFnValidationError('API key name is required', {
      field: 'name'
    });
  }

  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > 128) {
    throw new AuthFnValidationError('API key name must be 128 UTF-8 bytes or fewer', {
      field: 'name',
      maxBytes: 128,
      receivedBytes: bytes
    });
  }
}

function assertValidApiKeyExpiry(expiresAt: Date | undefined): void {
  if (!expiresAt) {
    return;
  }

  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new AuthFnValidationError('API key expiry must be a valid date', {
      field: 'expiresAt'
    });
  }
}
