import { randomBytes } from 'node:crypto';
import type { Adapter } from '@superfunctions/db';
import type { AuthFnRuntimeConfig, AuthFnUserRecord } from '../types.js';
import { AuthFnConflictError, AuthFnValidationError } from './errors.js';
import { assertAuthFnDatabaseKeyLength } from './limits.js';

export interface CreateUserInput {
  id?: string;
  primaryEmail?: string;
  emailVerifiedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

export async function createUser(
  config: AuthFnRuntimeConfig,
  input: CreateUserInput
): Promise<AuthFnUserRecord> {
  const now = new Date();
  const primaryEmail = normalizeEmail(input.primaryEmail);
  if (primaryEmail) assertAuthFnDatabaseKeyLength(primaryEmail, 'primaryEmail');
  if (primaryEmail && await findUserByPrimaryEmail(config, primaryEmail)) {
    throw emailConflict(primaryEmail);
  }

  const user: AuthFnUserRecord = {
    id: assertAuthFnDatabaseKeyLength(input.id ?? createIdentifier('user'), 'id'),
    primaryEmail,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now
  };

  try {
    return await createRecord(
      config.database,
      namespace(config),
      'users',
      user as unknown as Record<string, unknown>
    ) as unknown as AuthFnUserRecord;
  } catch (error) {
    // A concurrent sign-up can claim the email between the check above and
    // this insert; the unique index rejects the second row with a
    // driver-specific error. Report it as the same conflict.
    if (primaryEmail && await findUserByPrimaryEmail(config, primaryEmail)) {
      throw emailConflict(primaryEmail);
    }
    throw error;
  }
}

function emailConflict(primaryEmail: string): AuthFnConflictError {
  return new AuthFnConflictError('A user with this email already exists', {
    primaryEmail,
    emailExists: true
  });
}

export async function findUserById(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<AuthFnUserRecord | null> {
  return config.database.findOne<AuthFnUserRecord>({
    model: 'users',
    where: [{ field: 'id', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });
}

export async function findUserByPrimaryEmail(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  primaryEmail: string
): Promise<AuthFnUserRecord | null> {
  const email = normalizeEmail(primaryEmail);
  if (!email) {
    return null;
  }

  return config.database.findOne<AuthFnUserRecord>({
    model: 'users',
    where: [{ field: 'primaryEmail', operator: 'eq', value: email }],
    namespace: namespace(config)
  });
}

export async function markUserEmailVerified(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string,
  verifiedAt: Date = new Date()
): Promise<AuthFnUserRecord> {
  return config.database.update<AuthFnUserRecord>({
    model: 'users',
    where: [{ field: 'id', operator: 'eq', value: userId }],
    data: {
      emailVerifiedAt: verifiedAt,
      updatedAt: verifiedAt
    },
    namespace: namespace(config)
  });
}

async function createRecord<TRecord extends Record<string, unknown>>(
  database: Adapter,
  namespaceValue: string,
  model: string,
  data: TRecord
): Promise<TRecord> {
  return database.create<TRecord>({
    model,
    data,
    namespace: namespaceValue
  });
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function normalizeEmail(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

/**
 * AuthFn has no user status column; a host disables a user by setting
 * `metadata.disabled` to `true` on the user record. Every API-key path
 * (`authenticateApiKey` and the placement-context issuer) checks it through
 * `findActiveApiKeyOwner`, and session cookies, bearer session tokens and
 * placement contexts refuse the user's sessions while it is set. The session
 * records are not revoked, so clearing the flag restores bearer tokens (a
 * browser whose cookies were cleared in the meantime signs in again).
 */
export function isAuthFnUserDisabled(user: Pick<AuthFnUserRecord, 'metadata'>): boolean {
  return user.metadata?.disabled === true;
}

/** Largest sign-up `profile` accepted, measured as JSON in UTF-8 bytes. */
export const AUTHFN_MAX_SIGN_UP_PROFILE_BYTES = 4096;

/**
 * Keys of `users.metadata` that AuthFn itself reads. A caller cannot set them
 * through a sign-up `profile`; a host can still set them from a
 * `beforeUserCreate` hook or its own code.
 */
const SERVER_OWNED_METADATA_KEYS = new Set(['disabled']);

/**
 * Reads the `profile` a caller sends with a sign-up. It becomes the new
 * user's `metadata` unless a `beforeUserCreate` hook replaces it, so it is
 * caller-controlled data: it must be a plain JSON object of at most
 * AUTHFN_MAX_SIGN_UP_PROFILE_BYTES, and keys AuthFn reads (`disabled`) are
 * dropped. Hosts must not trust it for roles, plans or other authorization
 * state; set those from a hook or server-side code instead.
 */
export function readSignUpProfile(profile: unknown): Record<string, unknown> {
  if (profile === undefined || profile === null) {
    return {};
  }
  if (typeof profile !== 'object' || Array.isArray(profile)
    || Object.getPrototypeOf(profile) !== Object.prototype) {
    throw new AuthFnValidationError('profile must be an object', { field: 'profile' });
  }
  // A cheap lower bound first, which stops after visiting about as many
  // values and keys as the limit allows, so an oversized profile is refused
  // without being serialized; only a profile within it is. (A very wide
  // object may still have its key list built by the engine. The auth router
  // bounds the request body before this runs.)
  if (
    jsonSizeExceeds(profile, AUTHFN_MAX_SIGN_UP_PROFILE_BYTES)
    || new TextEncoder().encode(JSON.stringify(profile)).length > AUTHFN_MAX_SIGN_UP_PROFILE_BYTES
  ) {
    throw new AuthFnValidationError('profile is too large', {
      field: 'profile',
      maxBytes: AUTHFN_MAX_SIGN_UP_PROFILE_BYTES
    });
  }
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) => !SERVER_OWNED_METADATA_KEYS.has(key))
  );
}

/**
 * Whether the JSON text of `value` is certainly longer than `budget` bytes.
 * It adds up a lower bound (each string's length plus its quotes, a key's
 * length plus quotes and colon, one byte between entries, at least one byte
 * for every other value) and stops as soon as the sum passes the budget.
 * Containers are walked entry by entry without copying them, so it visits
 * at most about `budget` values and keys. (The engine may still build an
 * object's key list before the walk. Nothing here bounds the request body,
 * which the routes parse in full; a body size cap is audit finding AF-12.)
 */
function jsonSizeExceeds(value: unknown, budget: number): boolean {
  let used = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'string') {
      used += current.length + 2;
    } else if (Array.isArray(current)) {
      used += 2;
      for (let index = 0; index < current.length; index += 1) {
        used += index > 0 ? 1 : 0;
        if (used > budget) {
          return true;
        }
        stack.push(current[index]);
      }
    } else if (current !== null && typeof current === 'object') {
      used += 2;
      let first = true;
      for (const key in current as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) {
          continue;
        }
        used += (first ? 0 : 1) + key.length + 3;
        first = false;
        if (used > budget) {
          return true;
        }
        stack.push((current as Record<string, unknown>)[key]);
      }
    } else {
      used += 1;
    }
    if (used > budget) {
      return true;
    }
  }
  return false;
}
