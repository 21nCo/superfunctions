import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
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
import { createUser, findUserById, findUserByPrimaryEmail } from './users.js';
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
/**
 * scrypt cost for new hashes: N = 2^15, r = 8, p = 3, one of OWASP's
 * recommended settings (32 MiB of memory per hash; the same strength as
 * N = 2^17, p = 1 at a quarter of the memory, which matters on Workers).
 * Hashes stored with other parameters are re-hashed the next time their
 * password is used to sign in.
 */
const PASSWORD_HASH_N = 32768;
const PASSWORD_HASH_R = 8;
const PASSWORD_HASH_P = 3;
const PASSWORD_HASH_KEY_LENGTH = 64;
/** Room for N = 2^15 with r = 8 (32 MiB) plus scrypt's own overhead. */
const PASSWORD_HASH_MAXMEM = 64 * 1024 * 1024;
/**
 * Most memory a stored hash may ask for (128 * N * r bytes); above it the
 * hash is treated as corrupt rather than evaluated.
 */
const PASSWORD_HASH_MAX_MEMORY = 256 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;
/** Longest new password accepted, so one request cannot make hashing expensive. */
const MAX_PASSWORD_LENGTH = 1024;
/**
 * The scrypt parameter sets AuthFn has written: the current one and the one
 * before AUTH-32. Any other stored set is treated as corrupt rather than
 * evaluated, which bounds the work a stored hash can ask for.
 */
const ISSUED_PARAMETER_SETS = new Set(['32768:8:3', '16384:8:1']);
/**
 * Longest submitted password that is hashed; a longer one is refused as
 * wrong (after the same work), so a request cannot hand scrypt a huge input.
 * Far above what any earlier release could have stored in practice.
 */
const MAX_SUBMITTED_PASSWORD_LENGTH = 64 * 1024;
/**
 * scrypt jobs run at once in this process, and jobs allowed to wait for one.
 * Sign-in costs two jobs even for an unknown email, so without a bound a
 * flood of anonymous sign-ins could fill the crypto thread pool and memory.
 * Beyond the queue, requests get AUTHFN_RATE_LIMITED.
 */
const MAX_CONCURRENT_SCRYPT_JOBS = 16;
const MAX_QUEUED_SCRYPT_JOBS = 1024;
const LEGACY_PARAMETER_SET = '16384:8:1';

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
  assertPasswordLength(input.password);

  const beforeUserInput = await runBeforeUserCreateHook(hooks, {
    config,
    request: context.request,
    environment: context.environment
  }, {
    primaryEmail: email,
    metadata: input.profile ?? {}
  });
  const resolvedEmail = normalizeEmail(readString(beforeUserInput.primaryEmail) ?? email);
  const resolvedMetadata = readRecord(beforeUserInput.metadata) ?? input.profile;
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

  const passwordHash = await hashPassword(input.password);

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
    passwordHash: await hashPassword(password)
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

  const user = await findUserByPrimaryEmail(config, email);
  const credential = user ? await getPasswordCredentialByUserId(config, user.id) : null;
  // Every answer costs one hash at the current cost, so response time does
  // not tell which emails have accounts: an unknown email or an account
  // without a password is checked against a dummy hash, and a hash stored at
  // the older, cheaper cost is checked while a current-cost hash of the same
  // password is derived alongside (it becomes the upgrade when the password
  // is right).
  //
  // Every sign-in does the same work, one scrypt at the current cost and one
  // at the older one, whatever is stored, whatever the thread pool or
  // runtime: a current-cost hash is checked next to a dummy legacy check; a
  // legacy hash is checked next to deriving its current-cost upgrade; no
  // stored hash means two dummy checks.
  const submitted = typeof input.password === 'string' ? input.password : '';
  const tooLong = submitted.length > MAX_SUBMITTED_PASSWORD_LENGTH;
  const password = tooLong ? '' : submitted;
  const storedHash = credential?.passwordHash;
  const legacy = storedHash !== undefined && isLegacyHash(storedHash);
  const [valid, upgradedHash] = await Promise.all([
    verifyPassword(password, storedHash ?? DUMMY_CURRENT_HASH),
    legacy
      ? derivePasswordHash(password)
      : verifyPassword(password, DUMMY_LEGACY_HASH).then(() => undefined)
  ]);
  if (!user || !credential || !valid || tooLong) {
    throw new AuthFnInvalidCredentialsError('Invalid email or password');
  }

  // The credential may have changed while the hash ran: a reset (the checked
  // password is no longer the account's) or another sign-in's upgrade (it
  // still is). The submitted password must match what is stored now, read
  // again after every check, a few times at most.
  let checkedHash = credential.passwordHash;
  let latest: AuthFnPasswordCredentialRecord | null = null;
  for (let round = 0; round < 3 && !latest; round += 1) {
    const current = await getPasswordCredentialByUserId(config, user.id);
    if (!current) {
      throw new AuthFnInvalidCredentialsError('Invalid email or password');
    }
    if (current.passwordHash === checkedHash) {
      latest = current;
    } else if (await verifyPassword(password, current.passwordHash)) {
      checkedHash = current.passwordHash;
    } else {
      throw new AuthFnInvalidCredentialsError('Invalid email or password');
    }
  }
  if (!latest) {
    throw new AuthFnInvalidCredentialsError('Invalid email or password');
  }

  // Checked only once the password is known to be the account's current
  // one, so the answer reveals nothing to someone who does not know it.
  if (options.requireEmailVerifiedForSignIn && !user.emailVerifiedAt) {
    throw new AuthFnEmailNotVerifiedError('Email address must be verified before signing in', {
      primaryEmail: user.primaryEmail
    });
  }

  if (upgradedHash && latest.passwordHash === credential.passwordHash) {
    await upgradePasswordHash(config, credential, upgradedHash, password);
  }

  return { user, credential: latest };
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
  const userIdLength = Array.from(input.userId).length;
  assertAuthFnDatabaseKeyLength(
    input.userId,
    'userId',
    AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
  );
  const existing = await getPasswordCredentialByUserId(config, input.userId);
  const legacyUser = !existing && userIdLength > AUTHFN_DATABASE_KEY_MAX_LENGTH
    ? await findUserById(config, input.userId)
    : null;
  const userId = existing?.userId === input.userId
    ? input.userId
    : legacyUser
      ? assertAuthFnDatabaseKeyLength(
          input.userId,
          'userId',
          AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
        )
      : assertAuthFnDatabaseKeyLength(input.userId, 'userId');
  await assertValidPassword(input.password, {
    ...options,
    purpose: options.purpose ?? 'update-password'
  });
  const passwordHash = await hashPassword(input.password);

  if (!existing) {
    return createPasswordCredential(config, {
      userId,
      passwordHash
    });
  }

  const updatedAt = new Date();
  return config.database.update<AuthFnPasswordCredentialRecord>({
    model: 'password_credentials',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    data: {
      passwordHash,
      updatedAt
    },
    namespace: namespace(config)
  });
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  return derivePasswordHash(password);
}

async function derivePasswordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derived = await scryptAsync(password, salt, PASSWORD_HASH_KEY_LENGTH, {
    N: PASSWORD_HASH_N,
    r: PASSWORD_HASH_R,
    p: PASSWORD_HASH_P,
    maxmem: PASSWORD_HASH_MAXMEM
  });

  return [
    PASSWORD_HASH_ALGO,
    String(PASSWORD_HASH_N),
    String(PASSWORD_HASH_R),
    String(PASSWORD_HASH_P),
    salt,
    derived.toString('base64url')
  ].join('$');
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (typeof password !== 'string') {
    // Still spend the hash, so the refusal takes as long as a real check.
    await scryptAsync('', parsed.salt, parsed.expected.length, parsed.options);
    return false;
  }
  const derived = await scryptAsync(password, parsed.salt, parsed.expected.length, parsed.options);

  if (derived.length !== parsed.expected.length) {
    return false;
  }

  return timingSafeEqual(derived, parsed.expected);
}

function parseStoredHash(storedHash: string): { salt: string; expected: Buffer; options: ScryptOptions; n: number } {
  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== PASSWORD_HASH_ALGO) {
    throw new AuthFnInternalError('Stored password hash format is invalid');
  }

  const [, nRaw, rRaw, pRaw, salt, digest] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  const expected = Buffer.from(digest ?? '', 'base64url');
  if (
    !ISSUED_PARAMETER_SETS.has(`${nRaw}:${rRaw}:${pRaw}`)
    || 128 * n * r > PASSWORD_HASH_MAX_MEMORY
    // A short (or empty) digest would let scrypt's equally short output match.
    || expected.length !== PASSWORD_HASH_KEY_LENGTH
    || !salt
  ) {
    throw new AuthFnInternalError('Stored password hash format is invalid');
  }
  return {
    salt,
    expected,
    // Room for 128 * N * r bytes plus scrypt's own overhead.
    options: { N: n, r, p, maxmem: Math.max(PASSWORD_HASH_MAXMEM, 2 * 128 * n * r) },
    n
  };
}

let runningScryptJobs = 0;
const waitingScryptJobs: Array<() => void> = [];

async function scryptAsync(password: string, salt: string, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  if (runningScryptJobs >= MAX_CONCURRENT_SCRYPT_JOBS) {
    if (waitingScryptJobs.length >= MAX_QUEUED_SCRYPT_JOBS) {
      throw new AuthFnRateLimitedError('Too many password checks at once; try again shortly', {
        scope: 'password-hashing',
        resetAt: new Date(Date.now() + 1000).toISOString()
      });
    }
    await new Promise<void>((resolve) => {
      waitingScryptJobs.push(resolve);
    });
  }
  runningScryptJobs += 1;
  try {
    return await runScrypt(password, salt, keyLength, options);
  } finally {
    runningScryptJobs -= 1;
    waitingScryptJobs.shift()?.();
  }
}

function runScrypt(password: string, salt: string, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });
}

/**
 * Stand-ins for a check with no stored hash: they cost one check at their
 * cost and match no password (an all-zero digest), and need no derivation,
 * so the first sign-in after start-up costs the same as the others.
 */
const DUMMY_DIGEST = Buffer.alloc(PASSWORD_HASH_KEY_LENGTH).toString('base64url');
const DUMMY_CURRENT_HASH = [PASSWORD_HASH_ALGO, '32768', '8', '3', 'authfn-dummy-salt', DUMMY_DIGEST].join('$');
const DUMMY_LEGACY_HASH = [PASSWORD_HASH_ALGO, '16384', '8', '1', 'authfn-dummy-salt', DUMMY_DIGEST].join('$');

function isLegacyHash(storedHash: string): boolean {
  const parts = storedHash.split('$');
  return parts.length === 6 && `${parts[1]}:${parts[2]}:${parts[3]}` === LEGACY_PARAMETER_SET;
}

/**
 * Replaces a hash stored at the older cost with one at the current cost,
 * after its password was used to sign in. The write only applies while the
 * stored hash is unchanged, so it cannot undo a concurrent reset; if that
 * happened, the sign-in is refused, because the password it checked is no
 * longer the account's. A write that fails otherwise leaves the old hash,
 * which still works.
 */
async function upgradePasswordHash(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  credential: AuthFnPasswordCredentialRecord,
  upgradedHash: string,
  password: string
): Promise<void> {
  let written: number;
  try {
    written = await config.database.updateMany({
      model: 'password_credentials',
      where: [
        { field: 'id', operator: 'eq', value: credential.id },
        { field: 'passwordHash', operator: 'eq', value: credential.passwordHash, connector: 'AND' }
      ],
      data: { passwordHash: upgradedHash, updatedAt: new Date() },
      namespace: namespace(config)
    });
  } catch {
    return;
  }
  if (written === 0) {
    const current = await config.database.findOne<AuthFnPasswordCredentialRecord>({
      model: 'password_credentials',
      where: [{ field: 'id', operator: 'eq', value: credential.id }],
      namespace: namespace(config)
    });
    // Another sign-in upgraded it first (the password still matches), or a
    // reset replaced it (it does not).
    if (!current || (current.passwordHash !== credential.passwordHash && !(await verifyPassword(password, current.passwordHash)))) {
      throw new AuthFnInvalidCredentialsError('Invalid email or password');
    }
  }
}

/**
 * Checks the length of a new password; exported so a reset can check it
 * before its code is used.
 */
export function assertNewPasswordLength(password: string): void {
  assertPasswordLength(password);
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
  assertPasswordLength(password);
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

function assertPasswordLength(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthFnValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      field: 'password',
      minLength: MIN_PASSWORD_LENGTH
    });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthFnValidationError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`, {
      field: 'password',
      maxLength: MAX_PASSWORD_LENGTH
    });
  }
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
