import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { NotFoundError, type WhereClause } from '@superfunctions/db';
import type {
  AuthFnRuntimeConfig,
  AuthFnDeliveryMessageResolver,
  AuthFnDeliveryProvider,
  AuthFnDeliveryRequest,
  AuthFnHookContext,
  AuthFnHooks,
  AuthFnOtpChallengeRecord,
  AuthFnOtpPurpose,
  AuthFnUserRecord
} from '../types.js';
import {
  AuthFnError,
  AuthFnConflictError,
  AuthFnOtpExpiredError,
  AuthFnOtpInvalidError,
  AuthFnOtpReplayedError,
  AuthFnPluginAbortedError,
  AuthFnValidationError
} from './errors.js';
import { assertAuthFnDatabaseKeyLength } from './limits.js';
import { emitOtpEvent, deliverChallenge } from './delivery.js';
import { emitAuthEvent, eventRequestId } from './observability.js';
import { hashSecret } from './sessions.js';
import { createUser, findUserByPrimaryEmail, markUserEmailVerified } from './users.js';
import { type PasswordPolicyOptions, updatePasswordCredential } from './passwords.js';
import { resolveEnvironment } from './environment.js';
import {
  allowsOtpSignUpExistingUser,
  emitAccountLinkingConflictEvent
} from './account-linking.js';

const DEFAULT_OTP_TTL_SECONDS = 60 * 10;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;

export interface OtpRuntimeOptions {
  delivery?: AuthFnDeliveryProvider;
  message?: AuthFnDeliveryMessageResolver;
  codeGenerator?: () => string;
  now?: () => Date;
  challengeTtlSeconds?: number;
  maxAttempts?: number;
  passwordPolicy?: PasswordPolicyOptions;
}

export interface SendOtpInput {
  request?: Request;
  purpose: AuthFnOtpPurpose;
  email: string;
  metadata?: Record<string, unknown>;
}

export interface VerifyOtpInput {
  request?: Request;
  purpose: AuthFnOtpPurpose;
  email: string;
  code: string;
  profile?: Record<string, unknown>;
}

export interface CompleteResetPasswordInput {
  purpose: 'reset-password';
  email: string;
  code: string;
  newPassword: string;
  request?: Request;
}

export interface SendOtpResult {
  challenge: AuthFnOtpChallengeRecord;
  delivery: { sent: boolean; metadata?: Record<string, unknown> };
}

export interface VerifyOtpResult {
  verified: boolean;
  challenge: AuthFnOtpChallengeRecord;
  user?: AuthFnUserRecord;
  createdUser?: boolean;
  linkedExistingUser?: boolean;
}

export async function sendOtpChallenge(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  runtimeOptions: OtpRuntimeOptions,
  input: SendOtpInput
): Promise<SendOtpResult> {
  const email = normalizeEmail(input.email);
  const now = resolveNow(runtimeOptions);
  const hookContext = await buildChallengeHookContext(config, input.request);
  const challengeInput = await runBeforeChallengeSendHook(hooks, hookContext, {
    purpose: input.purpose,
    email,
    metadata: input.metadata ?? {}
  });

  const challengeCode = resolveCodeGenerator(runtimeOptions)();
  assertValidCode(challengeCode);
  const challenge = await config.database.create<AuthFnOtpChallengeRecord>({
    model: 'otp_challenges',
    data: {
      id: createChallengeId(),
      purpose: readPurpose(challengeInput.purpose, input.purpose),
      email: assertAuthFnDatabaseKeyLength(
        normalizeEmail(readString(challengeInput.email) ?? email),
        'email'
      ),
      codeHash: hashSecret(challengeCode),
      attemptCount: 0,
      deliveryMetadata: readRecord(challengeInput.metadata),
      expiresAt: new Date(now.getTime() + resolveTtlMs(runtimeOptions)),
      consumedAt: null,
      createdAt: now,
      updatedAt: now
    },
    namespace: namespace(config)
  });

  const deliveryInput = await resolveDeliveryRequest(runtimeOptions, {
    channel: 'email',
    kind: 'authfn.otp',
    to: challenge.email,
    userId: challenge.id,
    challengeId: challenge.id,
    purpose: challenge.purpose,
    email: challenge.email,
    code: challengeCode,
    metadata: challenge.deliveryMetadata,
    ...defaultDeliveryMessage(challenge.purpose, challengeCode)
  });
  const delivery = await deliverChallenge(runtimeOptions.delivery, deliveryInput);

  const challengeWithDelivery = delivery.metadata
    ? await config.database.update<AuthFnOtpChallengeRecord>({
      model: 'otp_challenges',
      where: [{ field: 'id', operator: 'eq', value: challenge.id }],
      data: {
        deliveryMetadata: {
          ...(challenge.deliveryMetadata ?? {}),
          ...delivery.metadata
        },
        updatedAt: resolveNow(runtimeOptions)
      },
      namespace: namespace(config)
    })
    : challenge;

  try {
    await hooks.afterChallengeSend?.(hookContext, {
      challengeId: challenge.id,
      purpose: challenge.purpose,
      email: challenge.email,
      sent: true,
      deliveryMetadata: challengeWithDelivery.deliveryMetadata ?? {}
    });
  } catch {
    // Fail-open by hook contract.
  }

  await emitOtpEvent(runtimeOptions.delivery, {
    type: 'authfn.otp.sent',
    challengeId: challenge.id,
    purpose: challenge.purpose,
    email: challenge.email,
    outcome: 'sent',
    metadata: {
      deliveryMetadata: challengeWithDelivery.deliveryMetadata ?? {}
    }
  });

  await emitAuthEvent(config, {
    type: 'authfn.otp.sent',
    requestId: eventRequestId(input.request),
    outcome: 'sent',
    metadata: {
      challengeId: challenge.id,
      purpose: challenge.purpose,
      email: challenge.email
    }
  });

  return {
    challenge: challengeWithDelivery,
    delivery: {
      sent: true,
      metadata: challengeWithDelivery.deliveryMetadata
    }
  };
}

async function resolveDeliveryRequest(
  runtimeOptions: OtpRuntimeOptions,
  input: AuthFnDeliveryRequest
): Promise<AuthFnDeliveryRequest> {
  const message = await runtimeOptions.message?.(input);
  if (!message) {
    return input;
  }
  return {
    ...input,
    ...message,
    metadata: {
      ...(input.metadata ?? {}),
      ...(message.metadata ?? {})
    }
  };
}

function defaultDeliveryMessage(
  purpose: AuthFnOtpPurpose,
  code: string
): Pick<AuthFnDeliveryRequest, 'subject' | 'text' | 'html'> {
  const subject = defaultDeliverySubject(purpose);
  const escapedCode = escapeHtml(code);
  return {
    subject,
    text: `Your verification code is ${code}. It expires shortly.`,
    html: `<p>Your verification code is <strong>${escapedCode}</strong>.</p><p>It expires shortly.</p>`
  };
}

function defaultDeliverySubject(purpose: AuthFnOtpPurpose): string {
  switch (purpose) {
    case 'reset-password':
      return 'Reset your password';
    case 'sign-in':
      return 'Your sign-in code';
    case 'sign-up':
      return 'Your sign-up code';
    case 'verify-email':
      return 'Verify your email';
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export async function verifyOtpChallenge(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  runtimeOptions: OtpRuntimeOptions,
  input: VerifyOtpInput
): Promise<VerifyOtpResult> {
  const email = normalizeEmail(input.email);
  const challenge = await findLatestChallenge(config, input.purpose, email);
  if (!challenge) {
    throw new AuthFnOtpInvalidError('OTP code is invalid', {
      purpose: input.purpose,
      email
    });
  }

  if (challenge.purpose !== input.purpose) {
    throw new AuthFnOtpInvalidError('OTP purpose is invalid', {
      challengeId: challenge.id,
      expectedPurpose: input.purpose,
      actualPurpose: challenge.purpose
    });
  }

  if (challenge.consumedAt) {
    throw new AuthFnOtpReplayedError('OTP code has already been used', {
      challengeId: challenge.id
    });
  }

  const now = resolveNow(runtimeOptions);
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    throw new AuthFnOtpExpiredError('OTP code has expired', {
      challengeId: challenge.id
    });
  }

  const maxAttempts = runtimeOptions.maxAttempts ?? DEFAULT_OTP_MAX_ATTEMPTS;
  const reserved = await reserveOtpAttempt(config, challenge, maxAttempts, now);

  if (!safeCompareHex(challenge.codeHash, hashSecret(input.code))) {
    throw new AuthFnOtpInvalidError('OTP code is invalid', {
      challengeId: challenge.id,
      attemptCount: reserved.attemptCount
    });
  }

  let consumed: AuthFnOtpChallengeRecord;
  let createdUser = false;
  let linkedExistingUser = false;
  let user: AuthFnUserRecord | null;
  let pendingSignUp: OtpSignUpUserInput | undefined;
  // The code matched, so this attempt was not a wrong guess. When the request
  // ends before consuming the challenge (missing user, conflict, hook
  // rejection), hand the reserved attempt back unless another request has
  // reserved one since; only wrong codes then count towards maxAttempts.
  try {
    user = await findUserByPrimaryEmail(config, email);

    if (input.purpose === 'sign-in') {
      if (!user) {
        throw new AuthFnOtpInvalidError('OTP sign-in requires an existing user', {
          email
        });
      }
    } else if (input.purpose === 'sign-up') {
      pendingSignUp = await resolveOtpSignUpUserInput(config, hooks, input, now);
      user = await findUserByPrimaryEmail(config, pendingSignUp.primaryEmail);
      if (user) {
        if (!allowsOtpSignUpExistingUser(config)) {
          await emitAccountLinkingConflictEvent(config, {
            request: input.request,
            user,
            regionId: pendingSignUp.environment?.regionId,
            method: 'email-otp',
            reason: 'otp_sign_up_existing_user_disabled'
          });
          throw new AuthFnConflictError('A user with this email already exists', {
            primaryEmail: pendingSignUp.primaryEmail,
            linking: {
              method: 'email-otp',
              reason: 'existing_user'
            }
          });
        }
        linkedExistingUser = true;
      }
    } else if (input.purpose === 'reset-password') {
      if (!user) {
        throw new AuthFnOtpInvalidError('Password reset requires an existing user', {
          email
        });
      }
    }

    consumed = await consumeOtpChallenge(config, challenge, now);
  } catch (error) {
    await releaseOtpAttempt(config, reserved, now);
    throw error;
  }

  if (input.purpose === 'verify-email') {
    if (user) {
      user = await markUserEmailVerified(config, user.id, now);
    }
  } else if (input.purpose === 'sign-up' && linkedExistingUser && user) {
    if (!user.emailVerifiedAt) {
      user = await markUserEmailVerified(config, user.id, now);
    }
  } else if (input.purpose === 'sign-up' && pendingSignUp && !user) {
    user = await createUser(config, {
      primaryEmail: pendingSignUp.primaryEmail,
      emailVerifiedAt: now,
      metadata: pendingSignUp.metadata
    });
    createdUser = true;
    try {
      await hooks.afterUserCreate?.(
        {
          config,
          request: input.request,
          environment: pendingSignUp.environment,
          actorId: user.id
        },
        {
          id: user.id,
          primaryEmail: user.primaryEmail,
          metadata: user.metadata ?? {}
        }
      );
    } catch (afterHookError) {
      if (afterHookError instanceof AuthFnError) {
        await rollbackOtpSignUpUser(config, user.id);
        throw afterHookError;
      }
      // Fail-open by public hook contract.
    }
  }

  await emitOtpEvent(runtimeOptions.delivery, {
    type: 'authfn.otp.verified',
    challengeId: challenge.id,
    purpose: challenge.purpose,
    email: challenge.email,
    outcome: 'verified'
  });

  await emitAuthEvent(config, {
    type: 'authfn.otp.verified',
    requestId: eventRequestId(input.request),
    actorId: user?.id,
    userId: user?.id,
    outcome: 'verified',
    metadata: {
      challengeId: challenge.id,
      purpose: challenge.purpose,
      email: challenge.email
    }
  });

  return {
    verified: true,
    challenge: consumed,
    user: user ?? undefined,
    createdUser,
    linkedExistingUser
  };
}

async function consumeOtpChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  challenge: AuthFnOtpChallengeRecord,
  consumedAt: Date
): Promise<AuthFnOtpChallengeRecord> {
  // attemptCount is not written here: the reservation already counted this
  // attempt, and an absolute write could undo concurrent reservations.
  const applied = await updateOtpChallengeIfMatches(
    config,
    challenge.id,
    [{ field: 'consumedAt', operator: 'eq', value: null }],
    {
      consumedAt,
      updatedAt: consumedAt
    }
  );
  if (!applied) {
    throw new AuthFnOtpReplayedError('OTP code has already been used', {
      challengeId: challenge.id
    });
  }

  const consumed = await config.database.findOne<AuthFnOtpChallengeRecord>({
    model: 'otp_challenges',
    where: [{ field: 'id', operator: 'eq', value: challenge.id }],
    namespace: namespace(config)
  });
  return consumed ?? { ...challenge, consumedAt, updatedAt: consumedAt };
}

export async function completeResetPassword(
  config: AuthFnRuntimeConfig,
  runtimeOptions: OtpRuntimeOptions,
  input: CompleteResetPasswordInput
): Promise<{ passwordUpdated: true }> {
  const email = normalizeEmail(input.email);
  const runtime = input.request ? await resolveEnvironment(config, input.request) : undefined;
  const challenge = await verifyOtpChallenge(config, {}, runtimeOptions, {
    request: input.request,
    purpose: input.purpose,
    email,
    code: input.code
  });

  const user = challenge.user ?? await findUserByPrimaryEmail(config, email);
  if (!user) {
    throw new AuthFnOtpInvalidError('Password reset requires an existing user', {
      email
    });
  }

  await updatePasswordCredential(config, {
    userId: user.id,
    password: input.newPassword
  }, {
    ...runtimeOptions.passwordPolicy,
    request: input.request,
    environment: runtime,
    email,
    purpose: 'reset-password'
  });

  return {
    passwordUpdated: true
  };
}

export async function getLatestOtpChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  purpose: AuthFnOtpPurpose,
  email: string
): Promise<AuthFnOtpChallengeRecord | null> {
  return findLatestChallenge(config, purpose, email);
}

async function findLatestChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  purpose: AuthFnOtpPurpose,
  email: string
): Promise<AuthFnOtpChallengeRecord | null> {
  const rows = await config.database.findMany<AuthFnOtpChallengeRecord>({
    model: 'otp_challenges',
    where: [
      { field: 'purpose', operator: 'eq', value: purpose },
      { field: 'email', operator: 'eq', value: email }
    ],
    orderBy: [
      { field: 'createdAt', direction: 'desc' },
      { field: 'id', direction: 'desc' }
    ],
    namespace: namespace(config)
  });

  return rows[0] ?? null;
}

/**
 * Upper bound on compare-and-set rounds for one reservation. A round is lost
 * only when another request reserved an attempt first, so with the default cap
 * of 5 a request sees the cap long before this bound. A request that runs out
 * of rounds is treated as over the limit.
 */
const OTP_ATTEMPT_RESERVATION_ROUNDS = 16;

interface OtpAttemptReservation {
  challengeId: string;
  /** The attempt count this request stored; its attempt is number attemptCount. */
  attemptCount: number;
}

/**
 * Reserves one attempt on the challenge before its code is compared, so the
 * number of comparisons never exceeds maxAttempts. The update only applies
 * while the stored count still equals the count this request read and the
 * challenge is unconsumed; concurrent requests that read the same count lose
 * the write, re-read the challenge and try the next count.
 */
async function reserveOtpAttempt(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  challenge: AuthFnOtpChallengeRecord,
  maxAttempts: number,
  now: Date
): Promise<OtpAttemptReservation> {
  let current = challenge;
  for (let round = 0; round < OTP_ATTEMPT_RESERVATION_ROUNDS; round += 1) {
    const attemptCount = current.attemptCount + 1;
    if (attemptCount > maxAttempts) {
      throw otpAttemptLimitError(challenge.id, attemptCount);
    }

    const reserved = await updateOtpChallengeIfMatches(
      config,
      challenge.id,
      [
        { field: 'attemptCount', operator: 'eq', value: current.attemptCount },
        { field: 'consumedAt', operator: 'eq', value: null }
      ],
      {
        attemptCount,
        updatedAt: now
      }
    );
    if (reserved) {
      return { challengeId: challenge.id, attemptCount };
    }

    const latest = await config.database.findOne<AuthFnOtpChallengeRecord>({
      model: 'otp_challenges',
      where: [{ field: 'id', operator: 'eq', value: challenge.id }],
      namespace: namespace(config)
    });
    if (!latest) {
      throw new AuthFnOtpInvalidError('OTP code is invalid', {
        challengeId: challenge.id
      });
    }
    if (latest.consumedAt) {
      throw new AuthFnOtpReplayedError('OTP code has already been used', {
        challengeId: challenge.id
      });
    }
    current = latest;
  }

  throw otpAttemptLimitError(challenge.id, current.attemptCount + 1);
}

/**
 * Returns a reserved attempt after the code matched but the challenge was not
 * consumed. It only applies while no later reservation or consumption has
 * happened; otherwise the count stays as it is, which errs towards the limit.
 */
async function releaseOtpAttempt(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  reservation: OtpAttemptReservation,
  updatedAt: Date
): Promise<void> {
  try {
    await updateOtpChallengeIfMatches(
      config,
      reservation.challengeId,
      [
        { field: 'attemptCount', operator: 'eq', value: reservation.attemptCount },
        { field: 'consumedAt', operator: 'eq', value: null }
      ],
      {
        attemptCount: reservation.attemptCount - 1,
        updatedAt
      }
    );
  } catch {
    // Keeping the reservation is the safe outcome; the caller rethrows the
    // error that ended the request.
  }
}

/**
 * Applies a conditional write to one OTP challenge and reports whether this
 * call's write applied. The acknowledgement comes from the write itself, never
 * from a later read through the guarded fields, which the write changes:
 *
 * - Adapters whose `update` returns the row from the statement itself
 *   (`capabilities.operations.returning`: memory, Drizzle and Kysely on SQLite,
 *   D1 and Postgres) use `update`. A returned row acknowledges the write and
 *   NotFound means it matched nothing. Only `id` is selected, because the
 *   Kysely adapter compiles the default selection as `RETURNING "*"`, which
 *   SQLite and Postgres reject.
 * - Other adapters (Prisma, and MySQL on Drizzle or Kysely) re-select with the
 *   original where after `update`, which no longer matches once a guarded
 *   field changed. They use `updateMany`, and only a finite positive
 *   affected-row count acknowledges the write. Anything else, including a
 *   count the driver could not report, counts as not applied, which errs
 *   towards the attempt limit.
 */
async function updateOtpChallengeIfMatches(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  challengeId: string,
  guards: WhereClause[],
  data: Record<string, unknown>
): Promise<boolean> {
  const where: WhereClause[] = [{ field: 'id', operator: 'eq', value: challengeId }, ...guards];
  if (config.database.capabilities?.operations?.returning === true) {
    try {
      const row = await config.database.update<{ id?: unknown }>({
        model: 'otp_challenges',
        where,
        data,
        select: ['id'],
        namespace: namespace(config)
      });
      return row?.id === challengeId;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  const affected = await config.database.updateMany({
    model: 'otp_challenges',
    where,
    data,
    namespace: namespace(config)
  });
  return Number.isFinite(affected) && affected > 0;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof NotFoundError
    || Boolean(
      error
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'NotFoundError'
    );
}

function otpAttemptLimitError(challengeId: string, attemptCount: number): AuthFnOtpInvalidError {
  return new AuthFnOtpInvalidError('OTP code is invalid', {
    challengeId,
    attemptCount
  });
}

async function runBeforeChallengeSendHook(
  hooks: Partial<AuthFnHooks>,
  ctx: AuthFnHookContext,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (!hooks.beforeChallengeSend) {
    return input;
  }

  try {
    const transformed = await hooks.beforeChallengeSend(ctx, input);
    return transformed ?? input;
  } catch (error) {
    if (error instanceof AuthFnError) {
      throw error;
    }
    throw new AuthFnPluginAbortedError('beforeChallengeSend hook aborted OTP send', {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function createChallengeId(): string {
  return `otp_${randomBytes(8).toString('hex')}`;
}

function resolveCodeGenerator(options: OtpRuntimeOptions): () => string {
  return options.codeGenerator ?? (() => String(randomInt(100000, 1000000)));
}

function safeCompareHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function resolveNow(options: OtpRuntimeOptions): Date {
  return options.now?.() ?? new Date();
}

function resolveTtlMs(options: OtpRuntimeOptions): number {
  return (options.challengeTtlSeconds ?? DEFAULT_OTP_TTL_SECONDS) * 1000;
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

function assertValidCode(code: string): void {
  if (!/^\d{6}$/.test(code)) {
    throw new AuthFnValidationError('OTP code generator must produce a 6 digit string');
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readPurpose(value: unknown, fallback: AuthFnOtpPurpose): AuthFnOtpPurpose {
  if (
    value === 'verify-email'
    || value === 'sign-in'
    || value === 'sign-up'
    || value === 'reset-password'
  ) {
    return value;
  }
  return fallback;
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}

async function rollbackOtpSignUpUser(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace' | 'observability'>,
  userId: string
): Promise<void> {
  const failures: string[] = [];
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
      type: 'authfn.otp.signup.rollback_failed',
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

async function buildChallengeHookContext(
  config: AuthFnRuntimeConfig,
  request?: Request
): Promise<AuthFnHookContext> {
  return {
    config,
    request,
    environment: request ? await resolveEnvironment(config, request) : undefined
  };
}

interface OtpSignUpUserInput {
  primaryEmail: string;
  metadata?: Record<string, unknown>;
  environment?: Awaited<ReturnType<typeof resolveEnvironment>>;
}

async function resolveOtpSignUpUserInput(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  input: VerifyOtpInput,
  verifiedAt: Date
): Promise<OtpSignUpUserInput> {
  const hookContext = await buildChallengeHookContext(config, input.request);
  const beforeUserInput = await runBeforeUserCreateHook(hooks, hookContext, {
    primaryEmail: normalizeEmail(input.email),
    emailVerifiedAt: verifiedAt,
    metadata: input.profile ?? {}
  });

  return {
    primaryEmail: normalizeEmail(readString(beforeUserInput.primaryEmail) ?? input.email),
    metadata: readRecord(beforeUserInput.metadata) ?? input.profile,
    environment: hookContext.environment
  };
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
    throw new AuthFnPluginAbortedError('beforeUserCreate hook aborted OTP sign-up', {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}
