import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { AesGcmTokenCipher } from '@superfunctions/oauth-storage';
import type {
  AuthFnAuthMethod,
  AuthFnRuntimeConfig,
  AuthFnSession,
  AuthFnTwoFactorChallengeRecord,
  AuthFnTwoFactorEnrollmentRecord,
  AuthFnTwoFactorRecoveryCodeRecord,
  AuthFnUserRecord
} from '../types.js';
import type { TwoFactorPluginRuntimeConfig } from '../plugin-types.js';
import {
  AuthFnConfigError,
  AuthFnConflictError,
  AuthFnNotFoundError,
  AuthFnRateLimitedError,
  AuthFnTwoFactorInvalidCodeError,
  AuthFnTwoFactorRequiredError
} from './errors.js';
import { CANONICAL_CHALLENGE_ID } from './challenge-id.js';
import { updateRowIfMatches } from './conditional-update.js';
import { hashSecret } from './sessions.js';
import { findUserById } from './users.js';
import { readPluginRuntimeConfig } from './plugin-runtime.js';
import {
  AUTHFN_DATABASE_KEY_MAX_LENGTH,
  AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH,
  assertAuthFnDatabaseKeyLength
} from './limits.js';

const DEFAULT_ISSUER = 'authfn';
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_WINDOW = 1;
const DEFAULT_RECOVERY_CODE_COUNT = 10;
const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_ENCRYPTION_KEY_REF = 'authfn-2fa';
const DEFAULT_MAX_FAILED_ATTEMPTS = 10;
const DEFAULT_LOCKOUT_SECONDS = 15 * 60;
const MAX_FAILED_ATTEMPTS_LIMIT = 1000;
/** One year: longer locks would also push dates past what JavaScript can represent. */
const MAX_LOCKOUT_SECONDS = 365 * 24 * 60 * 60;
/**
 * A lock is dated from the clock read just before its write, so it must
 * comfortably outlast a slow write; shorter locks could land already over.
 */
const MIN_LOCKOUT_SECONDS = 60;
/** Compare-and-set rounds for one attempt reservation before giving up. */
const ATTEMPT_RESERVATION_ROUNDS = 16;
/** Random bytes per recovery code: 80 bits, shown as four groups of five. */
const RECOVERY_CODE_BYTES = 10;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface CreatedTwoFactorEnrollment {
  enrollment: AuthFnTwoFactorEnrollmentRecord;
  secret: string;
  otpauthUri: string;
  recoveryCodes: string[];
}

export interface CreatedTwoFactorChallenge {
  challenge: AuthFnTwoFactorChallengeRecord;
  user: AuthFnUserRecord;
}

export interface SatisfiedTwoFactorChallenge {
  challenge: AuthFnTwoFactorChallengeRecord;
  user: AuthFnUserRecord;
  methods: AuthFnAuthMethod[];
  usedRecoveryCode: boolean;
}

export function getTwoFactorPluginConfig(
  config: Pick<AuthFnRuntimeConfig, 'plugins' | 'pluginRuntime'>
): TwoFactorPluginRuntimeConfig | null {
  return config.plugins.some((plugin) => plugin.name === 'twoFactor')
    ? readPluginRuntimeConfig<TwoFactorPluginRuntimeConfig>(config as AuthFnRuntimeConfig, 'twoFactor')
    : null;
}

export async function getConfirmedTwoFactorEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<AuthFnTwoFactorEnrollmentRecord | null> {
  const enrollment = await config.database.findOne<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });

  return enrollment?.confirmedAt ? enrollment : null;
}

export async function hasConfirmedTwoFactorEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<boolean> {
  const enrollment = await config.database.findOne<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });

  return Boolean(enrollment?.confirmedAt);
}

export async function createTwoFactorEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  user: Pick<AuthFnUserRecord, 'id' | 'primaryEmail'>,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<CreatedTwoFactorEnrollment> {
  const userIdLength = Array.from(user.id).length;
  assertAuthFnDatabaseKeyLength(
    user.id,
    'userId',
    AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
  );
  const legacyUser = userIdLength > AUTHFN_DATABASE_KEY_MAX_LENGTH
    ? await findUserById(config, user.id)
    : null;
  const userId = legacyUser
    ? assertAuthFnDatabaseKeyLength(
        user.id,
        'userId',
        AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
      )
    : assertAuthFnDatabaseKeyLength(user.id, 'userId');
  const existing = await config.database.findOne<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });

  if (existing?.confirmedAt) {
    throw new AuthFnConflictError('Two-factor authentication is already enabled', {
      userId
    });
  }

  const now = resolveNow(pluginConfig);
  const secret = generateBase32Secret();
  const encryptedSecret = await encryptSecret(config, pluginConfig, secret);
  const recoveryCodes = generateRecoveryCodes(pluginConfig.recoveryCodeCount ?? DEFAULT_RECOVERY_CODE_COUNT);
  const enrollment: AuthFnTwoFactorEnrollmentRecord = {
    id: existing?.id ?? createIdentifier('tfa'),
    userId,
    secretEncrypted: encryptedSecret,
    lastUsedCounter: null,
    confirmedAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  if (existing) {
    await config.database.update<AuthFnTwoFactorEnrollmentRecord>({
      model: 'two_factor_enrollments',
      where: [{ field: 'id', operator: 'eq', value: existing.id }],
      data: {
        secretEncrypted: encryptedSecret,
        lastUsedCounter: null,
        confirmedAt: null,
        updatedAt: now
      },
      namespace: namespace(config)
    });
    await config.database.deleteMany({
      model: 'two_factor_recovery_codes',
      where: [{ field: 'enrollmentId', operator: 'eq', value: existing.id }],
      namespace: namespace(config)
    });
  } else {
    await config.database.create<AuthFnTwoFactorEnrollmentRecord>({
      model: 'two_factor_enrollments',
      data: enrollment,
      namespace: namespace(config)
    });
  }

  for (const recoveryCode of recoveryCodes) {
    await config.database.create<AuthFnTwoFactorRecoveryCodeRecord>({
      model: 'two_factor_recovery_codes',
      data: {
        id: createIdentifier('recovery'),
        enrollmentId: enrollment.id,
        codeHash: hashRecoveryCode(enrollment.id, normalizeTwoFactorCode(recoveryCode)),
        usedAt: null,
        createdAt: now
      },
      namespace: namespace(config)
    });
  }

  return {
    enrollment,
    secret,
    otpauthUri: buildOtpAuthUri(pluginConfig, user, secret),
    recoveryCodes
  };
}

export async function confirmTwoFactorEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<AuthFnTwoFactorEnrollmentRecord> {
  const enrollment = await requireTwoFactorEnrollment(config, userId);
  if (enrollment.confirmedAt) {
    return enrollment;
  }

  const attempt = await reserveTotpCheck(config, enrollment.id, pluginConfig);
  await verifyTwoFactorTotp(config, enrollment, code, pluginConfig);
  await attempt.succeeded();
  const now = resolveNow(pluginConfig);
  return config.database.update<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'id', operator: 'eq', value: enrollment.id }],
    data: {
      confirmedAt: now,
      updatedAt: now
    },
    namespace: namespace(config)
  });
}

export async function createTwoFactorChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  user: AuthFnUserRecord,
  primaryMethod: Exclude<AuthFnAuthMethod, 'two-factor' | 'api-key'>,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<CreatedTwoFactorChallenge | null> {
  const userIdLength = Array.from(user.id).length;
  assertAuthFnDatabaseKeyLength(
    user.id,
    'userId',
    AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
  );
  const legacyUser = userIdLength > AUTHFN_DATABASE_KEY_MAX_LENGTH
    ? await findUserById(config, user.id)
    : null;
  const userId = legacyUser
    ? assertAuthFnDatabaseKeyLength(
        user.id,
        'userId',
        AUTHFN_LEGACY_USER_REFERENCE_MAX_LENGTH
      )
    : assertAuthFnDatabaseKeyLength(user.id, 'userId');
  const enrollment = await requireConfirmedEnrollment(config, userId);
  if (!enrollment) {
    return null;
  }

  const now = resolveNow(pluginConfig);
  const challenge: AuthFnTwoFactorChallengeRecord = {
    id: createIdentifier('signin_2fa'),
    userId,
    primaryMethod,
    expiresAt: new Date(now.getTime() + ((pluginConfig.challengeTtlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS) * 1000)),
    consumedAt: null,
    createdAt: now,
    updatedAt: now
  };

  await config.database.create<AuthFnTwoFactorChallengeRecord>({
    model: 'two_factor_challenges',
    data: challenge,
    namespace: namespace(config)
  });

  return {
    challenge,
    user
  };
}

export async function beginTwoFactorChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  user: AuthFnUserRecord,
  primaryMethod: Exclude<AuthFnAuthMethod, 'two-factor' | 'api-key'>,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<CreatedTwoFactorChallenge | null> {
  return createTwoFactorChallenge(config, user, primaryMethod, pluginConfig);
}

export async function satisfyTwoFactorChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  challengeId: string,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<SatisfiedTwoFactorChallenge> {
  if (!CANONICAL_CHALLENGE_ID.test(challengeId)) {
    throw new AuthFnTwoFactorInvalidCodeError('Two-factor challenge is invalid or expired', {
      challengeId
    });
  }
  const challenge = await config.database.findOne<AuthFnTwoFactorChallengeRecord>({
    model: 'two_factor_challenges',
    where: [{ field: 'id', operator: 'eq', value: challengeId }],
    namespace: namespace(config)
  });
  if (!challenge) {
    throw new AuthFnNotFoundError('Two-factor challenge not found', { challengeId });
  }

  const now = resolveNow(pluginConfig);
  if (challenge.consumedAt || challenge.expiresAt.getTime() <= now.getTime()) {
    throw new AuthFnTwoFactorInvalidCodeError('Two-factor challenge is invalid or expired', {
      challengeId
    });
  }

  const user = await findUserById(config as AuthFnRuntimeConfig, challenge.userId);
  if (!user) {
    throw new AuthFnNotFoundError('User not found for two-factor challenge', {
      challengeId,
      userId: challenge.userId
    });
  }

  const enrollment = await requireConfirmedEnrollment(config, challenge.userId);
  if (!enrollment) {
    throw new AuthFnNotFoundError('Two-factor enrollment not found', {
      challengeId,
      userId: challenge.userId
    });
  }

  // Only one request can finish a challenge: the write is conditional on the
  // challenge still being open.
  const claimChallenge = () => updateRowIfMatches(
    config,
    'two_factor_challenges',
    challenge.id,
    [{ field: 'consumedAt', operator: 'eq', value: null }],
    { consumedAt: now, updatedAt: now }
  );
  const challengeGone = () => new AuthFnTwoFactorInvalidCodeError('Two-factor challenge is invalid or expired', {
    challengeId
  });

  // The credential (a TOTP step or a recovery code) is spent only after
  // this request holds the challenge, so a request that loses the challenge
  // to another one keeps its code; if spending then fails, the challenge is
  // given back so a valid code can still finish it.
  const reopenChallenge = async () => {
    try {
      await updateRowIfMatches(config, 'two_factor_challenges', challenge.id, [], {
        consumedAt: null,
        updatedAt: now
      });
    } catch {
      // The challenge stays used; the user signs in again.
    }
  };

  let usedRecoveryCode = false;
  const submitted = await resolveSubmittedCode(config, enrollment.id, code, pluginConfig);
  if (submitted.kind === 'totp') {
    const attempt = await reserveTotpCheck(config, enrollment.id, pluginConfig);
    await assertTotpMatches(config, enrollment, code, pluginConfig);
    if (!(await claimChallenge())) {
      throw challengeGone();
    }
    try {
      await verifyTwoFactorTotp(config, enrollment, code, pluginConfig);
    } catch (error) {
      await reopenChallenge();
      throw error;
    }
    // Only a code that finished the challenge ends the run of attempts.
    await attempt.succeeded();
  } else {
    if (!submitted.recoveryCode) {
      throw invalidSecondFactorCode(enrollment.userId);
    }
    if (!(await claimChallenge())) {
      throw challengeGone();
    }
    let spent: boolean;
    try {
      spent = await spendRecoveryCode(config, submitted.recoveryCode.id, now);
    } catch (error) {
      await reopenChallenge();
      throw error;
    }
    if (!spent) {
      await reopenChallenge();
      throw invalidSecondFactorCode(enrollment.userId);
    }
    usedRecoveryCode = true;
  }
  const consumed: AuthFnTwoFactorChallengeRecord = { ...challenge, consumedAt: now, updatedAt: now };

  return {
    challenge: consumed,
    user,
    methods: [challenge.primaryMethod, 'two-factor'] as AuthFnAuthMethod[],
    usedRecoveryCode
  };
}

export async function disableTwoFactorEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<void> {
  const enrollment = await requireConfirmedEnrollment(config, userId);
  if (!enrollment) {
    throw new AuthFnNotFoundError('Two-factor enrollment not found', { userId });
  }

  await checkSecondFactor(config, enrollment, code, pluginConfig);

  await config.database.delete({
    model: 'two_factor_enrollments',
    where: [{ field: 'id', operator: 'eq', value: enrollment.id }],
    namespace: namespace(config)
  });
  await config.database.deleteMany({
    model: 'two_factor_recovery_codes',
    where: [{ field: 'enrollmentId', operator: 'eq', value: enrollment.id }],
    namespace: namespace(config)
  });
  await config.database.deleteMany({
    model: 'two_factor_challenges',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });
}

export async function verifyTwoFactorCode(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig = {}
): Promise<{ usedRecoveryCode: boolean }> {
  const enrollment = await requireConfirmedEnrollment(config, userId);
  if (!enrollment) {
    throw new AuthFnNotFoundError('Two-factor enrollment not found', { userId });
  }

  const { usedRecoveryCode } = await checkSecondFactor(config, enrollment, code, pluginConfig);

  return { usedRecoveryCode };
}

export async function appendTwoFactorMethodToSession(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  sessionId: string
): Promise<AuthFnSession['methods']> {
  const record = await config.database.findOne<{ methods: AuthFnAuthMethod[]; id: string }>({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: sessionId }],
    namespace: namespace(config)
  });
  if (!record) {
    throw new AuthFnNotFoundError('Session not found', { sessionId });
  }

  const nextMethods: AuthFnAuthMethod[] = record.methods.includes('two-factor')
    ? record.methods
    : [...record.methods, 'two-factor'];

  await config.database.update({
    model: 'sessions',
    where: [{ field: 'id', operator: 'eq', value: sessionId }],
    data: {
      methods: nextMethods,
      updatedAt: new Date()
    },
    namespace: namespace(config)
  });

  return nextMethods;
}

export function createPendingTwoFactorResponse(
  challenge: Pick<AuthFnTwoFactorChallengeRecord, 'id' | 'primaryMethod' | 'expiresAt'>
): AuthFnTwoFactorRequiredError {
  return new AuthFnTwoFactorRequiredError('Two-factor authentication required', {
    challengeId: challenge.id,
    primaryMethod: challenge.primaryMethod,
    expiresAt: challenge.expiresAt.toISOString(),
    availableMethods: ['totp', 'recovery-code']
  });
}

async function requireTwoFactorEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<AuthFnTwoFactorEnrollmentRecord> {
  const enrollment = await config.database.findOne<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });
  if (!enrollment) {
    throw new AuthFnNotFoundError('Two-factor enrollment not found', { userId });
  }

  return enrollment;
}

async function requireConfirmedEnrollment(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  userId: string
): Promise<AuthFnTwoFactorEnrollmentRecord | null> {
  const enrollment = await config.database.findOne<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });
  if (!enrollment?.confirmedAt) {
    return null;
  }

  return enrollment;
}

/** Lengths of recovery codes once normalized: 20 now, 10 before AUTH-32. */
const RECOVERY_CODE_LENGTHS = new Set([10, 20]);

/**
 * Decides how a submitted code is checked. A code with the TOTP shape
 * (`digits` decimal digits) is a TOTP code, unless its length is also a
 * recovery code's and it matches an unused recovery code (an all-digit legacy
 * code with `digits: 10`). Anything else is a recovery code.
 */
async function resolveSubmittedCode(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollmentId: string,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig
): Promise<{ kind: 'totp' } | { kind: 'recovery'; recoveryCode: AuthFnTwoFactorRecoveryCodeRecord | null }> {
  const normalized = normalizeTwoFactorCode(code);
  const totpShaped = normalized.length === (pluginConfig.digits ?? DEFAULT_DIGITS) && /^[0-9]+$/.test(normalized);
  if (totpShaped && !RECOVERY_CODE_LENGTHS.has(normalized.length)) {
    return { kind: 'totp' };
  }
  const recoveryCode = await findUnusedRecoveryCode(config, enrollmentId, code);
  return totpShaped && !recoveryCode ? { kind: 'totp' } : { kind: 'recovery', recoveryCode };
}

/**
 * Checks a second-factor code: a TOTP code under the enrollment's limit on
 * wrong codes, or a recovery code.
 *
 * Recovery codes are outside that limit and still work while TOTP is locked.
 * They are 80 random bits (40 for codes issued before AUTH-32), far beyond
 * guessing, and keeping them usable means someone who knows the password
 * cannot lock the owner out of every second factor.
 */
async function checkSecondFactor(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollment: AuthFnTwoFactorEnrollmentRecord,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig
): Promise<{ usedRecoveryCode: boolean }> {
  const submitted = await resolveSubmittedCode(config, enrollment.id, code, pluginConfig);
  if (submitted.kind === 'totp') {
    const attempt = await reserveTotpCheck(config, enrollment.id, pluginConfig);
    await verifyTwoFactorTotp(config, enrollment, code, pluginConfig);
    await attempt.succeeded();
    return { usedRecoveryCode: false };
  }

  if (!submitted.recoveryCode || !(await spendRecoveryCode(config, submitted.recoveryCode.id, resolveNow(pluginConfig)))) {
    throw invalidSecondFactorCode(enrollment.userId);
  }
  return { usedRecoveryCode: true };
}

function invalidSecondFactorCode(userId: string): AuthFnTwoFactorInvalidCodeError {
  return new AuthFnTwoFactorInvalidCodeError('Two-factor authentication code is invalid', { userId });
}

/**
 * Counts one TOTP check against the enrollment's limit on wrong codes, which
 * holds across challenges and routes and does not depend on the HTTP rate
 * limiter. Call it before the code is compared, and `succeeded()` once the
 * code has been accepted and its use recorded.
 *
 * `failedAttemptCount` only ever goes up: every check adds one before the
 * code is compared, and every `maxFailedAttempts`-th check also locks the
 * enrollment for `lockoutSeconds`. Because the value never repeats, a request
 * that read it before other requests moved it on cannot write its attempt
 * (no ABA), so concurrent requests cannot check more codes than the limit.
 *
 * - While the enrollment is locked, no code is checked: `AUTHFN_RATE_LIMITED`
 *   with the time the lock ends.
 * - `succeeded()` moves the count to the end of the current run of
 *   `maxFailedAttempts` and lifts a lock this check set, so the next wrong
 *   code starts a new run. It does so only if no other check was counted
 *   after this one; otherwise those checks, and any lock they set, stand.
 */
async function reserveTotpCheck(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollmentId: string,
  pluginConfig: TwoFactorPluginRuntimeConfig
): Promise<{ succeeded: () => Promise<void> }> {
  const limits = resolveTwoFactorAttemptLimits(pluginConfig);
  const reserved = await reserveSecondFactorAttempt(config, enrollmentId, pluginConfig, limits);
  return {
    succeeded: async () => {
      try {
        await updateRowIfMatches(
          config,
          'two_factor_enrollments',
          enrollmentId,
          [{ field: 'failedAttemptCount', operator: 'eq', value: reserved }],
          {
            failedAttemptCount: Math.ceil(reserved / limits.maxFailedAttempts) * limits.maxFailedAttempts,
            lockedUntil: null,
            updatedAt: resolveNow(pluginConfig)
          }
        );
      } catch {
        // The code was right; a count that could not be moved on only makes
        // a later lock come sooner.
      }
    }
  };
}

/** Reserves one TOTP check and returns the count this request wrote. */
async function reserveSecondFactorAttempt(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollmentId: string,
  pluginConfig: TwoFactorPluginRuntimeConfig,
  limits: TwoFactorAttemptLimits
): Promise<number> {
  let now = resolveNow(pluginConfig);
  for (let round = 0; round < ATTEMPT_RESERVATION_ROUNDS; round += 1) {
    const current = await config.database.findOne<AuthFnTwoFactorEnrollmentRecord>({
      model: 'two_factor_enrollments',
      where: [{ field: 'id', operator: 'eq', value: enrollmentId }],
      namespace: namespace(config)
    });
    if (!current) {
      throw new AuthFnNotFoundError('Two-factor enrollment not found', { enrollmentId });
    }
    // Read the clock on every round, next to the write, so a lock written
    // after a slow round does not start out already expired.
    now = resolveNow(pluginConfig);
    const lockedUntil = current.lockedUntil ? new Date(current.lockedUntil) : null;
    if (lockedUntil && lockedUntil.getTime() > now.getTime()) {
      throw twoFactorLockedError(lockedUntil);
    }

    const next = readAttemptCount(current.failedAttemptCount) + 1;
    // The check that completes a run is still made; the lock applies to the
    // ones after it.
    const data: Record<string, unknown> = next % limits.maxFailedAttempts === 0
      ? { failedAttemptCount: next, lockedUntil: new Date(now.getTime() + limits.lockoutMs), updatedAt: now }
      : { failedAttemptCount: next, updatedAt: now };
    const reserved = await updateRowIfMatches(
      config,
      'two_factor_enrollments',
      enrollmentId,
      [{ field: 'failedAttemptCount', operator: 'eq', value: current.failedAttemptCount ?? null }],
      data
    );
    if (reserved) {
      return next;
    }
  }
  // Lost every round to concurrent requests: treat as over the limit.
  throw twoFactorLockedError(new Date(now.getTime() + 1000));
}

function readAttemptCount(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function twoFactorLockedError(lockedUntil: Date): AuthFnRateLimitedError {
  return new AuthFnRateLimitedError('Too many incorrect two-factor codes; try again later', {
    scope: 'two-factor',
    resetAt: lockedUntil.toISOString()
  });
}

interface TwoFactorAttemptLimits {
  maxFailedAttempts: number;
  lockoutMs: number;
}

/**
 * Reads `maxFailedAttempts` and `lockoutSeconds`, throwing
 * `AUTHFN_CONFIG_INVALID` for a value that is not a whole number in range.
 * The two-factor plugin calls it when the server is set up.
 */
export function resolveTwoFactorAttemptLimits(pluginConfig: TwoFactorPluginRuntimeConfig): TwoFactorAttemptLimits {
  return {
    maxFailedAttempts: readBoundedInteger(
      pluginConfig.maxFailedAttempts,
      DEFAULT_MAX_FAILED_ATTEMPTS,
      1,
      MAX_FAILED_ATTEMPTS_LIMIT,
      'maxFailedAttempts'
    ),
    lockoutMs: readBoundedInteger(
      pluginConfig.lockoutSeconds,
      DEFAULT_LOCKOUT_SECONDS,
      MIN_LOCKOUT_SECONDS,
      MAX_LOCKOUT_SECONDS,
      'lockoutSeconds'
    ) * 1000
  };
}

function readBoundedInteger(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AuthFnConfigError(`Two-factor ${field} must be a whole number from ${min} to ${max}`, { field });
  }
  return value;
}

async function findUnusedRecoveryCode(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollmentId: string,
  code: string
): Promise<AuthFnTwoFactorRecoveryCodeRecord | null> {
  const recoveryCodes = await config.database.findMany<AuthFnTwoFactorRecoveryCodeRecord>({
    model: 'two_factor_recovery_codes',
    where: [{ field: 'enrollmentId', operator: 'eq', value: enrollmentId }],
    namespace: namespace(config)
  });
  const normalized = normalizeTwoFactorCode(code);
  // Codes created since AUTH-32 are hashed with their enrollment id; older
  // ones with the code alone.
  const candidates = [hashRecoveryCode(enrollmentId, normalized), hashSecret(normalized)];
  return recoveryCodes.find((entry) =>
    !entry.usedAt && candidates.some((candidate) => safeCompareHex(entry.codeHash, candidate))
  ) ?? null;
}

/**
 * Marks a recovery code used, conditional on it still being unused, so
 * concurrent requests with the same code cannot both spend it.
 */
function spendRecoveryCode(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  recoveryCodeId: string,
  now: Date
): Promise<boolean> {
  return updateRowIfMatches(
    config,
    'two_factor_recovery_codes',
    recoveryCodeId,
    [{ field: 'usedAt', operator: 'eq', value: null }],
    { usedAt: now }
  );
}

function hashRecoveryCode(enrollmentId: string, normalizedCode: string): string {
  return hashSecret(`authfn-recovery:${enrollmentId}:${normalizedCode}`);
}

/**
 * Checks a TOTP code against the enrollment without recording its use; the
 * use is recorded (and replays refused) by verifyTwoFactorTotp.
 */
async function assertTotpMatches(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollment: AuthFnTwoFactorEnrollmentRecord,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig
): Promise<void> {
  const secret = await decryptSecret(config, pluginConfig, enrollment.secretEncrypted);
  const matched = verifyTotpCode(
    secret,
    normalizeTwoFactorCode(code),
    pluginConfig,
    resolveNow(pluginConfig),
    enrollment.lastUsedCounter ?? null
  );
  if (matched === null) {
    throw invalidSecondFactorCode(enrollment.userId);
  }
}

async function verifyTwoFactorTotp(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  enrollment: AuthFnTwoFactorEnrollmentRecord,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig
): Promise<void> {
  const now = resolveNow(pluginConfig);
  const secret = await decryptSecret(config, pluginConfig, enrollment.secretEncrypted);
  const normalizedCode = normalizeTwoFactorCode(code);
  let currentEnrollment: AuthFnTwoFactorEnrollmentRecord = enrollment;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const matchedCounter = verifyTotpCode(
      secret,
      normalizedCode,
      pluginConfig,
      now,
      currentEnrollment.lastUsedCounter ?? null
    );
    if (matchedCounter === null) {
      break;
    }

    const recorded = await updateRowIfMatches(
      config,
      'two_factor_enrollments',
      currentEnrollment.id,
      [{ field: 'lastUsedCounter', operator: 'eq', value: currentEnrollment.lastUsedCounter ?? null }],
      { lastUsedCounter: matchedCounter, updatedAt: now }
    );
    if (recorded) {
      return;
    }
    // Another request used a code first: check this one against the newer
    // counter.
    currentEnrollment = await requireTwoFactorEnrollment(config, enrollment.userId);
  }

  throw new AuthFnTwoFactorInvalidCodeError('Two-factor authentication code is invalid', {
    userId: enrollment.userId
  });
}

async function encryptSecret(
  config: Pick<AuthFnRuntimeConfig, 'namespace'>,
  pluginConfig: TwoFactorPluginRuntimeConfig,
  secret: string
): Promise<string> {
  const cipher = createSecretCipher(config, pluginConfig);
  return cipher.encrypt(secret, pluginConfig.encryptionKeyRef ?? DEFAULT_ENCRYPTION_KEY_REF);
}

async function decryptSecret(
  config: Pick<AuthFnRuntimeConfig, 'namespace'>,
  pluginConfig: TwoFactorPluginRuntimeConfig,
  encrypted: string
): Promise<string> {
  const cipher = createSecretCipher(config, pluginConfig);
  return cipher.decrypt(encrypted, pluginConfig.encryptionKeyRef ?? DEFAULT_ENCRYPTION_KEY_REF);
}

function createSecretCipher(
  config: Pick<AuthFnRuntimeConfig, 'namespace'>,
  pluginConfig: TwoFactorPluginRuntimeConfig
): AesGcmTokenCipher {
  const resolver = pluginConfig.encryptionKeyResolver;
  if (!resolver) {
    throw new AuthFnConfigError('Two-factor encryptionKeyResolver must be configured', {
      keyRef: pluginConfig.encryptionKeyRef ?? DEFAULT_ENCRYPTION_KEY_REF,
      namespace: namespace(config)
    });
  }

  return new AesGcmTokenCipher(async (keyRef) => {
    const resolved = await resolver(keyRef);
    if (resolved) {
      return resolved;
    }

    throw new AuthFnConfigError('Two-factor encryptionKeyResolver must be configured', {
      keyRef,
      namespace: namespace(config)
    });
  });
}

function buildOtpAuthUri(
  pluginConfig: TwoFactorPluginRuntimeConfig,
  user: Pick<AuthFnUserRecord, 'id' | 'primaryEmail'>,
  secret: string
): string {
  const issuer = encodeURIComponent(pluginConfig.issuer ?? DEFAULT_ISSUER);
  const label = encodeURIComponent(user.primaryEmail ?? user.id);
  const digits = pluginConfig.digits ?? DEFAULT_DIGITS;
  const period = pluginConfig.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  return `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&digits=${digits}&period=${period}`;
}

function generateBase32Secret(): string {
  const bytes = randomBytes(20);
  let output = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }

  return output;
}

function generateRecoveryCodes(count: number): string[] {
  return Array.from({ length: count }, () => {
    const value = randomBytes(RECOVERY_CODE_BYTES).toString('hex').toUpperCase();
    return [0, 5, 10, 15].map((start) => value.slice(start, start + 5)).join('-');
  });
}

function verifyTotpCode(
  secret: string,
  code: string,
  pluginConfig: TwoFactorPluginRuntimeConfig,
  now: Date,
  lastUsedCounter: number | null
): number | null {
  const digits = pluginConfig.digits ?? DEFAULT_DIGITS;
  const periodSeconds = pluginConfig.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const window = pluginConfig.window ?? DEFAULT_WINDOW;
  const counter = Math.floor(now.getTime() / 1000 / periodSeconds);
  const key = decodeBase32(secret);

  for (let offset = -window; offset <= window; offset += 1) {
    const candidateCounter = counter + offset;
    if (lastUsedCounter !== null && candidateCounter <= lastUsedCounter) {
      continue;
    }

    const generated = generateTotp(key, candidateCounter, digits);
    if (safeCompareString(generated, code)) {
      return candidateCounter;
    }
  }

  return null;
}

function generateTotp(key: Buffer, counter: number, digits: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  const token = String(binary % (10 ** digits));
  return token.padStart(digits, '0');
}

function decodeBase32(secret: string): Buffer {
  const normalized = secret.replace(/=+$/g, '').toUpperCase();
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      continue;
    }

    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

function normalizeTwoFactorCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

function safeCompareString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeCompareHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function resolveNow(pluginConfig: TwoFactorPluginRuntimeConfig): Date {
  return pluginConfig.now?.() ?? new Date();
}

function createIdentifier(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}
