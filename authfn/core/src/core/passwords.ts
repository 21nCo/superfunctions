import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as nodeCrypto from 'node:crypto';
import type {
  AuthFnRuntimeConfig,
  AuthFnHooks,
  AuthFnHookContext,
  AuthFnPasswordCompromiseCheckResult,
  AuthFnPasswordCompromiseChecker,
  AuthFnPasswordCredentialRecord,
  AuthFnEnvironment,
  AuthFnSession,
  AuthFnUserRecord
} from '../types.js';
import {
  AuthFnError,
  AuthFnConflictError,
  AuthFnEmailNotVerifiedError,
  AuthFnInternalError,
  AuthFnInvalidCredentialsError,
  AuthFnPluginAbortedError,
  AuthFnRateLimitedError,
  AuthFnValidationError
} from './errors.js';
import { createUser, findUserById, findUserByPrimaryEmail, readSignUpProfile } from './users.js';
import {
  allowsPasswordForAuthenticatedUser,
  emitAccountLinkingConflictEvent
} from './account-linking.js';
import { emitAuthEvent, eventRequestId } from './observability.js';
import {
  getMultiRegionPluginConfig,
  unregisterRegionLookupForIdentifier
} from './regions.js';
import {
  AUTHFN_DATABASE_KEY_MAX_LENGTH,
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  assertAuthFnDatabaseKeyLength
} from './limits.js';

const PASSWORD_HASH_ALGO = 'scrypt';
const PASSWORD_HASH_N = 16384;
const PASSWORD_HASH_R = 8;
const PASSWORD_HASH_P = 1;
const PASSWORD_HASH_KEY_LENGTH = 64;
const PASSWORD_HASH_SALT_BYTES = 16;
/** Node's default scrypt memory ceiling. Parameters above the stored cost never reach it. */
const PASSWORD_HASH_MAXMEM_BYTES = 32 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;
/** UTF-8 byte cap enforced before any scrypt work. */
export const AUTHFN_PASSWORD_MAX_BYTES = 1024;
/** How many scrypt operations may run at once. Further calls wait. */
export const AUTHFN_PASSWORD_KDF_CONCURRENCY = 4;
const MAX_PENDING_PASSWORD_OPERATIONS = 16;

/**
 * Same cost and size as a real hash, with a fixed fake digest. Sign-in of a
 * missing account or a missing password runs scrypt against this value so the
 * work matches a real verification.
 */
const DUMMY_PASSWORD_HASH = {
  salt: Buffer.from('test-password!!!').toString('base64url'),
  digest: Buffer.alloc(PASSWORD_HASH_KEY_LENGTH, 0x2e)
};

let scryptActive = 0;
const scryptWaiters: Array<() => void> = [];

export interface PasswordSignUpInput {
  email: string;
  password: string;
  profile?: Record<string, unknown>;
}

export interface PasswordSignInInput {
  email: string;
  password: string;
}

export interface PasswordSignUpResult {
  user: AuthFnUserRecord;
  credential: AuthFnPasswordCredentialRecord;
  linkedExistingUser?: boolean;
}

export interface PasswordSignInResult {
  user: AuthFnUserRecord;
  credential: AuthFnPasswordCredentialRecord;
}

export interface PasswordPolicyOptions {
  compromisedPasswordChecker?: AuthFnPasswordCompromiseChecker;
  requireEmailVerifiedForSignIn?: boolean;
  email?: string;
  purpose?: 'sign-up' | 'reset-password' | 'update-password';
  request?: Request;
  environment?: AuthFnEnvironment;
}

export interface HaveIBeenPwnedPasswordCheckerOptions {
  fetcher?: typeof fetch;
  minimumExposureCount?: number;
  userAgent?: string;
}

export async function signUpWithPassword(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  input: PasswordSignUpInput,
  context: {
    request?: Request;
    environment?: AuthFnEnvironment;
    authenticatedSession?: AuthFnSession | null;
    policy?: PasswordPolicyOptions;
  } = {}
): Promise<PasswordSignUpResult> {
  const email = normalizeEmail(input.email);
  assertPasswordWithinLimits(input.password);

  const profile = readSignUpProfile(input.profile);
  const beforeUserInput = await runBeforeUserCreateHook(hooks, {
    config,
    request: context.request,
    environment: context.environment
  }, {
    primaryEmail: email,
    metadata: profile
  });
  const resolvedEmail = normalizeEmail(readString(beforeUserInput.primaryEmail) ?? email);
  const resolvedMetadata = readRecord(beforeUserInput.metadata) ?? profile;
  await assertValidPassword(input.password, {
    ...context.policy,
    request: context.request,
    environment: context.environment,
    email: resolvedEmail,
    purpose: 'sign-up'
  });

  const existingUser = await findUserByPrimaryEmail(config, resolvedEmail);
  if (existingUser) {
    return linkPasswordCredentialForExistingUser(config, input.password, {
      existingUser,
      authenticatedSession: context.authenticatedSession,
      request: context.request,
      environment: context.environment,
      policy: context.policy
    });
  }

  const passwordHash = await hashPassword(input.password, context.request?.signal);

  return runUserCredentialTransaction(async () => {
    const user = await createUser(config, {
      primaryEmail: resolvedEmail,
      metadata: resolvedMetadata
    });
    let credential: AuthFnPasswordCredentialRecord | undefined;

    try {
      credential = await createPasswordCredential(config, {
        userId: user.id,
        passwordHash
      });
      try {
        await hooks.afterUserCreate?.({
          config,
          request: context.request,
          environment: context.environment,
          actorId: user.id
        }, {
          id: user.id,
          primaryEmail: user.primaryEmail,
          metadata: user.metadata ?? {}
        });
      } catch (afterHookError) {
        // Fail-open by public hook contract unless the composed plugin runner
        // promoted a critical after hook failure into an AuthFnError.
        if (afterHookError instanceof AuthFnError) {
          throw afterHookError;
        }
      }
      return { user, credential };
    } catch (error) {
      await rollbackPasswordSignUp(config, user.id, user.primaryEmail, credential?.id);
      throw error;
    }
  });
}

async function linkPasswordCredentialForExistingUser(
  config: AuthFnRuntimeConfig,
  password: string,
  context: {
    existingUser: AuthFnUserRecord;
    authenticatedSession?: AuthFnSession | null;
    request?: Request;
    environment?: AuthFnEnvironment;
    policy?: PasswordPolicyOptions;
  }
): Promise<PasswordSignUpResult> {
  const linkingPolicy = allowsPasswordForAuthenticatedUser(config);
  // Only an interactive user session may add a sign-in method; an API key
  // acts as its owner but must not mint a password for that account.
  const authenticatedUserId = context.authenticatedSession?.type === 'session'
    ? context.authenticatedSession.actorId
    : undefined;

  if (!linkingPolicy.allowed || authenticatedUserId !== context.existingUser.id) {
    await emitAccountLinkingConflictEvent(config, {
      request: context.request,
      user: context.existingUser,
      regionId: context.environment?.regionId,
      method: 'password',
      reason: authenticatedUserId ? 'authenticated_user_mismatch' : 'authentication_required',
      metadata: {
        authenticatedUserId
      }
    });
    throw new AuthFnConflictError('A user with this email already exists', {
      primaryEmail: context.existingUser.primaryEmail,
      linking: {
        method: 'password',
        required: 'authenticated-session'
      }
    });
  }

  if (linkingPolicy.requireExistingEmailVerified && !context.existingUser.emailVerifiedAt) {
    await emitAccountLinkingConflictEvent(config, {
      request: context.request,
      user: context.existingUser,
      regionId: context.environment?.regionId,
      method: 'password',
      reason: 'existing_email_unverified'
    });
    throw new AuthFnEmailNotVerifiedError('Email address must be verified before adding a password', {
      userId: context.existingUser.id,
      primaryEmail: context.existingUser.primaryEmail
    });
  }

  const existingCredential = await getPasswordCredentialByUserId(config, context.existingUser.id);
  if (existingCredential) {
    await emitAccountLinkingConflictEvent(config, {
      request: context.request,
      user: context.existingUser,
      regionId: context.environment?.regionId,
      method: 'password',
      reason: 'password_already_exists'
    });
    throw new AuthFnConflictError('Password sign-in is already configured for this user', {
      primaryEmail: context.existingUser.primaryEmail,
      linking: {
        method: 'password',
        reason: 'password_already_exists'
      }
    });
  }

  const credential = await createPasswordCredential(config, {
    userId: context.existingUser.id,
    passwordHash: await hashPassword(password, context.request?.signal)
  });

  return {
    user: context.existingUser,
    credential,
    linkedExistingUser: true
  };
}

export async function signInWithPassword(
  config: AuthFnRuntimeConfig,
  input: PasswordSignInInput,
  options: PasswordPolicyOptions = {}
): Promise<PasswordSignInResult> {
  const email = normalizeEmail(input.email);
  assertPasswordInput(email, input.password);
  assertPasswordByteLimit(input.password);

  const user = await findUserByPrimaryEmail(config, email);
  const credential = user ? await getPasswordCredentialByUserId(config, user.id) : null;
  // A missing account and a missing password do the same scrypt work as a real
  // check, then return the same error. Verification status is reported only
  // after the password matches.
  if (!user || !credential) {
    await deriveScryptKey(input.password, DUMMY_PASSWORD_HASH.salt, options.request?.signal);
    throw new AuthFnInvalidCredentialsError('Invalid email or password');
  }

  const valid = await verifyPassword(input.password, credential.passwordHash, options.request?.signal);
  if (!valid) {
    throw new AuthFnInvalidCredentialsError('Invalid email or password');
  }

  if (options.requireEmailVerifiedForSignIn && !user.emailVerifiedAt) {
    throw new AuthFnEmailNotVerifiedError('Email address must be verified before signing in', {
      userId: user.id,
      primaryEmail: user.primaryEmail
    });
  }

  return { user, credential };
}

export async function createPasswordCredential(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  input: { userId: string; passwordHash: string }
): Promise<AuthFnPasswordCredentialRecord> {
  const userIdLength = Array.from(input.userId).length;
  assertAuthFnDatabaseKeyLength(
    input.userId,
    'userId',
    AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
  );
  const legacyUser = userIdLength > AUTHFN_DATABASE_KEY_MAX_LENGTH
    ? await findUserById(config, input.userId)
    : null;
  const userId = legacyUser
    ? assertAuthFnDatabaseKeyLength(
        input.userId,
        'userId',
        AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
      )
    : assertAuthFnDatabaseKeyLength(input.userId, 'userId');
  const now = new Date();
  const record: AuthFnPasswordCredentialRecord = {
    id: createIdentifier('pwd'),
    userId,
    passwordHash: input.passwordHash,
    createdAt: now,
    updatedAt: now
  };

  return config.database.create<AuthFnPasswordCredentialRecord>({
    model: 'password_credentials',
    data: record,
    namespace: namespace(config)
  });
}

export async function getPasswordCredentialByUserId(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<AuthFnPasswordCredentialRecord | null> {
  return config.database.findOne<AuthFnPasswordCredentialRecord>({
    model: 'password_credentials',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });
}

export async function updatePasswordCredential(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  input: { userId: string; password: string },
  options: PasswordPolicyOptions = {}
): Promise<AuthFnPasswordCredentialRecord> {
  const update = await preparePasswordCredentialUpdate(config, input, options);
  return update();
}

/** Prepare the update without mutating the credential or consuming a reset code. */
export async function preparePasswordCredentialUpdate(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  input: { userId: string; password: string },
  options: PasswordPolicyOptions
): Promise<() => Promise<AuthFnPasswordCredentialRecord>> {
  const { userId, password } = input;
  assertAuthFnDatabaseKeyLength(userId, 'userId', AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH);
  await assertValidPassword(password, {
    ...options,
    purpose: options.purpose ?? 'update-password'
  });
  const passwordHash = await hashPassword(password, options.request?.signal);
  return () => storeUpdatedPasswordCredential(config, userId, passwordHash);
}

async function storeUpdatedPasswordCredential(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  requestedUserId: string,
  passwordHash: string
): Promise<AuthFnPasswordCredentialRecord> {
  const userIdLength = Array.from(requestedUserId).length;
  const existing = await getPasswordCredentialByUserId(config, requestedUserId);
  const legacyUser = !existing && userIdLength > AUTHFN_DATABASE_KEY_MAX_LENGTH
    ? await findUserById(config, requestedUserId)
    : null;
  const userId = existing?.userId === requestedUserId
    ? requestedUserId
    : legacyUser
      ? assertAuthFnDatabaseKeyLength(
          requestedUserId,
          'userId',
          AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
        )
      : assertAuthFnDatabaseKeyLength(requestedUserId, 'userId');

  if (!existing) {
    return createPasswordCredential(config, {
      userId,
      passwordHash
    });
  }

  return config.database.update<AuthFnPasswordCredentialRecord>({
    model: 'password_credentials',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    data: {
      passwordHash,
      updatedAt: new Date()
    },
    namespace: namespace(config)
  });
}

export async function hashPassword(password: string, signal?: AbortSignal): Promise<string> {
  assertPasswordWithinLimits(password);
  const salt = randomBytes(PASSWORD_HASH_SALT_BYTES).toString('base64url');
  const derived = await deriveScryptKey(password, salt, signal);

  return [
    PASSWORD_HASH_ALGO,
    String(PASSWORD_HASH_N),
    String(PASSWORD_HASH_R),
    String(PASSWORD_HASH_P),
    salt,
    derived.toString('base64url')
  ].join('$');
}

export async function verifyPassword(password: string, storedHash: string, signal?: AbortSignal): Promise<boolean> {
  assertPasswordByteLimit(password);
  const parsed = parseStoredPasswordHash(storedHash);
  // Python's hex-encoded hashes have always failed verification here.
  // Preserve that result without deriving a longer key for those hashes.
  const supported = parsed ?? DUMMY_PASSWORD_HASH;
  const derived = await deriveScryptKey(password, supported.salt, signal);
  return timingSafeEqual(derived, supported.digest) && parsed !== null;
}

/**
 * Rejects a password before any scrypt work. The minimum is characters; the
 * maximum is UTF-8 bytes, so a long multibyte password cannot reach the KDF.
 */
export function assertPasswordWithinLimits(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthFnValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      field: 'password',
      minLength: MIN_PASSWORD_LENGTH
    });
  }
  assertPasswordByteLimit(password);
}

function assertPasswordByteLimit(password: string): void {
  if (typeof password !== 'string') {
    throw new AuthFnValidationError('Password must be a string', { field: 'password' });
  }
  if (password.length > AUTHFN_PASSWORD_MAX_BYTES || Buffer.byteLength(password, 'utf8') > AUTHFN_PASSWORD_MAX_BYTES) {
    throw new AuthFnValidationError(`Password must be at most ${AUTHFN_PASSWORD_MAX_BYTES} bytes`, {
      field: 'password',
      maxBytes: AUTHFN_PASSWORD_MAX_BYTES
    });
  }
}

function assertPasswordInput(email: string, password: string): void {
  if (!email) {
    throw new AuthFnValidationError('Email is required', {
      field: 'email'
    });
  }

  if (!password) {
    throw new AuthFnValidationError('Password is required', {
      field: 'password'
    });
  }
}

export function createHaveIBeenPwnedPasswordChecker(
  options: HaveIBeenPwnedPasswordCheckerOptions = {}
): AuthFnPasswordCompromiseChecker {
  return async ({ password }) => {
    const fetcher = options.fetcher ?? globalThis.fetch;
    if (typeof fetcher !== 'function') {
      throw new AuthFnInternalError('No fetch implementation is available for compromised-password screening');
    }

    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const headers = new Headers({
      accept: 'text/plain'
    });
    if (options.userAgent) {
      headers.set('user-agent', options.userAgent);
    }

    const response = await fetcher(`https://api.pwnedpasswords.com/range/${prefix}`, {
      method: 'GET',
      headers
    });
    if (response.status === 429) {
      throw new AuthFnRateLimitedError('Compromised-password check is temporarily rate limited', {
        provider: 'haveibeenpwned',
        status: response.status
      });
    }
    if (!response.ok) {
      throw new AuthFnInternalError('Compromised-password check failed', {
        provider: 'haveibeenpwned',
        status: response.status
      });
    }

    const exposures = await response.text();
    const minimumExposureCount = options.minimumExposureCount ?? 1;
    for (const line of exposures.split(/\r?\n/)) {
      const [candidateSuffix, rawCount] = line.trim().split(':', 2);
      if (!candidateSuffix || !rawCount) {
        continue;
      }
      if (candidateSuffix.toUpperCase() !== suffix) {
        continue;
      }

      const count = Number.parseInt(rawCount, 10);
      return {
        compromised: Number.isFinite(count) && count >= minimumExposureCount,
        count: Number.isFinite(count) ? count : undefined
      };
    }

    return false;
  };
}

async function assertValidPassword(
  password: string,
  options: PasswordPolicyOptions = {}
): Promise<void> {
  assertPasswordWithinLimits(password);
  const checker = options.compromisedPasswordChecker;
  if (!checker) {
    return;
  }

  const result = await checker({
    password,
    email: options.email,
    purpose: options.purpose ?? 'update-password',
    request: options.request,
    environment: options.environment
  });
  const { compromised, count } = readCompromiseCheckResult(result);
  if (compromised) {
    throw new AuthFnValidationError('Password has appeared in known credential breaches', {
      field: 'password',
      exposureCount: count
    });
  }
}

function deriveScryptKey(password: string, salt: string, signal?: AbortSignal): Promise<Buffer> {
  return withScryptSlot(() => new Promise((resolve, reject) => {
    nodeCrypto.scrypt(password, salt, PASSWORD_HASH_KEY_LENGTH, {
      N: PASSWORD_HASH_N,
      r: PASSWORD_HASH_R,
      p: PASSWORD_HASH_P,
      maxmem: PASSWORD_HASH_MAXMEM_BYTES
    }, (error, derived) => {
      if (error || !Buffer.isBuffer(derived)) {
        reject(error ?? new AuthFnInternalError('Password hashing failed'));
        return;
      }
      resolve(derived);
    });
  }), signal);
}

function withScryptSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const run = async (): Promise<T> => {
    scryptActive += 1;
    try {
      return await work();
    } finally {
      scryptActive -= 1;
      scryptWaiters.shift()?.();
    }
  };

  if (scryptActive >= AUTHFN_PASSWORD_KDF_CONCURRENCY) {
    if (scryptWaiters.length >= MAX_PENDING_PASSWORD_OPERATIONS) {
      throw new AuthFnRateLimitedError('Password processing is temporarily busy');
    }
    return new Promise((resolve, reject) => {
      function start() {
        signal?.removeEventListener('abort', abort);
        run().then(resolve, reject);
      }
      function abort() {
        const index = scryptWaiters.indexOf(start);
        if (index >= 0) scryptWaiters.splice(index, 1);
        reject(signal?.reason);
      }
      scryptWaiters.push(start);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  return run();
}

function parseStoredPasswordHash(storedHash: string): { salt: string; digest: Buffer } | null {
  const parts = storedHash.split('$');
  if (
    parts.length !== 6
    || parts[0] !== PASSWORD_HASH_ALGO
    || parts[1] !== String(PASSWORD_HASH_N)
    || parts[2] !== String(PASSWORD_HASH_R)
    || parts[3] !== String(PASSWORD_HASH_P)
  ) {
    throw new AuthFnInternalError('Stored password hash format is invalid');
  }

  const salt = parts[4] ?? '';
  const digestText = parts[5] ?? '';
  if (/^[0-9a-f]{32}$/.test(salt) && /^[0-9a-f]{128}$/.test(digestText)) {
    return null;
  }
  const digest = decodeExactBase64Url(digestText, PASSWORD_HASH_KEY_LENGTH);
  if (!decodeExactBase64Url(salt, PASSWORD_HASH_SALT_BYTES) || !digest) {
    throw new AuthFnInternalError('Stored password hash format is invalid');
  }
  return { salt, digest };
}

function decodeExactBase64Url(value: string, expectedBytes: number): Buffer | null {
  const remainder = expectedBytes % 3;
  const expectedLength = Math.floor(expectedBytes / 3) * 4 + (remainder === 0 ? 0 : remainder + 1);
  if (value.length !== expectedLength || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === expectedBytes ? decoded : null;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw new AuthFnValidationError('A valid email is required', {
      field: 'email'
    });
  }
  return normalized;
}

function readCompromiseCheckResult(
  result: AuthFnPasswordCompromiseCheckResult
): { compromised: boolean; count?: number } {
  if (typeof result === 'boolean') {
    return {
      compromised: result
    };
  }

  return {
    compromised: Boolean(result.compromised),
    count: typeof result.count === 'number' ? result.count : undefined
  };
}

async function runUserCredentialTransaction<T>(
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw wrapPasswordError(error);
  }
}

async function rollbackPasswordSignUp(
  config: Pick<AuthFnRuntimeConfig, 'stores' | 'database' | 'namespace' | 'observability' | 'plugins' | 'pluginRuntime'>,
  userId: string,
  primaryEmail?: string | null,
  credentialId?: string
): Promise<void> {
  const failures: string[] = [];
  const multiRegion = getMultiRegionPluginConfig(config);
  if (primaryEmail && multiRegion) {
    await unregisterRegionLookupForIdentifier(config, multiRegion, primaryEmail)
      .catch((error) => failures.push(readRollbackFailure('region_lookup.delete', error)));
  }

  if (credentialId) {
    await config.database.delete({
      model: 'password_credentials',
      where: [{ field: 'id', operator: 'eq', value: credentialId }],
      namespace: namespace(config)
    }).catch((error) => failures.push(readRollbackFailure('password_credentials.delete', error)));
  }

  await config.database.deleteMany({
    model: 'password_credentials',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  }).catch((error) => failures.push(readRollbackFailure('password_credentials.deleteMany', error)));

  await config.database.deleteMany({
    model: 'region_profiles',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  }).catch((error) => failures.push(readRollbackFailure('region_profiles.deleteMany', error)));

  await config.database.delete({
    model: 'users',
    where: [{ field: 'id', operator: 'eq', value: userId }],
    namespace: namespace(config)
  }).catch((error) => failures.push(readRollbackFailure('users.delete', error)));

  if (failures.length > 0) {
    await emitAuthEvent(config, {
      type: 'authfn.password.signup.rollback_failed',
      requestId: eventRequestId(),
      actorId: userId,
      userId,
      outcome: 'error',
      metadata: {
        failures
      }
    });
  }
}

function readRollbackFailure(operation: string, error: unknown): string {
  const reason = error instanceof Error ? error.name : 'UnknownError';
  return `${operation}: ${reason}`;
}

async function runBeforeUserCreateHook(
  hooks: Partial<AuthFnHooks>,
  ctx: AuthFnHookContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!hooks.beforeUserCreate) {
    return input;
  }

  try {
    const transformed = await hooks.beforeUserCreate(ctx, input);
    return transformed ?? input;
  } catch (error) {
    if (error instanceof AuthFnError) {
      throw error;
    }
    throw new AuthFnPluginAbortedError('beforeUserCreate hook aborted password sign-up', {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function wrapPasswordError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new AuthFnInternalError('Password operation failed');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
