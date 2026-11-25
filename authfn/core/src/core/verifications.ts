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
  AuthFnConfigError,
  AuthFnConflictError,
  AuthFnOtpExpiredError,
  AuthFnOtpInvalidError,
  AuthFnOtpReplayedError,
  AuthFnPluginAbortedError,
  AuthFnRateLimitedError,
  AuthFnSessionRevokedError,
  AuthFnUnauthenticatedError,
  AuthFnValidationError
} from './errors.js';
import { assertAuthFnDatabaseKeyLength } from './limits.js';
import { emitOtpEvent, deliverChallenge } from './delivery.js';
import { emitAuthEvent, eventRequestId } from './observability.js';
import {
  assertValidCsrf,
  authenticateAccountRequest,
  getCookieSessionState,
  hashSecret,
  revokeSessionsForUser
} from './sessions.js';
import { removePendingTwoFactorChallenges, removePreVerificationAccess } from './account-claim.js';
import {
  createUser,
  findUserByPrimaryEmail,
  isAuthFnUserDisabled,
  markUserEmailVerified,
  readSignUpProfile
} from './users.js';
import { readPluginRuntimeConfig } from './plugin-runtime.js';
import { assertPasswordWithinLimits, type PasswordPolicyOptions, preparePasswordCredentialUpdate } from './passwords.js';
import { resolveEnvironment } from './environment.js';
import {
  allowsOtpSignUpExistingUser,
  emitAccountLinkingConflictEvent
} from './account-linking.js';

const DEFAULT_OTP_TTL_SECONDS = 60 * 10;
const DEFAULT_OTP_MAX_ATTEMPTS = 5;
const DEFAULT_OTP_MAX_FAILED_ATTEMPTS_PER_EMAIL = 10;
const DEFAULT_OTP_MAX_CHALLENGES_PER_EMAIL = 20;
const DEFAULT_OTP_EMAIL_WINDOW_SECONDS = 60 * 60;
/** Upper bound for every per-email limit: one year in seconds keeps dates valid. */
const OTP_EMAIL_LIMIT_MAX = 365 * 24 * 60 * 60;

export interface OtpRuntimeOptions {
  delivery?: AuthFnDeliveryProvider;
  message?: AuthFnDeliveryMessageResolver;
  codeGenerator?: () => string;
  now?: () => Date;
  challengeTtlSeconds?: number;
  maxAttempts?: number;
  maxFailedAttemptsPerEmail?: number;
  maxChallengesPerEmail?: number;
  emailAttemptWindowSeconds?: number;
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
  /**
   * For `verify-email`: only verify as the signed-in holder of the account.
   * When the request is not that account's live session, it is refused with
   * `AUTHFN_UNAUTHENTICATED` before the code is used, instead of being taken
   * as someone else proving the mailbox (which claims the account).
   */
  requireAccountHolder?: boolean;
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

  const challengeEmail = assertAuthFnDatabaseKeyLength(
    normalizeEmail(readString(challengeInput.email) ?? email),
    'email'
  );
  await assertOtpChallengeBudget(config, runtimeOptions, challengeEmail, now);

  const challengeCode = resolveCodeGenerator(runtimeOptions)();
  assertValidCode(challengeCode);
  let challenge = await config.database.create<AuthFnOtpChallengeRecord>({
    model: 'otp_challenges',
    data: {
      id: createChallengeId(),
      purpose: readPurpose(challengeInput.purpose, input.purpose),
      email: challengeEmail,
      codeHash: hashSecret(challengeCode),
      attemptCount: 0,
      deliveryMetadata: readRecord(challengeInput.metadata),
      // Created not admitted (expiring as it is created) so that no code can
      // be checked against it until admitOtpChallenge has counted it.
      expiresAt: now,
      consumedAt: null,
      createdAt: now,
      updatedAt: now
    },
    namespace: namespace(config)
  });

  challenge = await admitOtpChallenge(config, runtimeOptions, challenge, now);

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
  return verifyOtpChallengeBeforeConsume(config, hooks, runtimeOptions, input);
}

async function verifyOtpChallengeBeforeConsume(
  config: AuthFnRuntimeConfig,
  hooks: Partial<AuthFnHooks>,
  runtimeOptions: OtpRuntimeOptions,
  input: VerifyOtpInput,
  beforeConsume?: (user: AuthFnUserRecord) => Promise<void>
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

  await assertOtpGuessBudget(config, runtimeOptions, email, now, challenge.id);
  const maxAttempts = runtimeOptions.maxAttempts ?? DEFAULT_OTP_MAX_ATTEMPTS;
  const reserved = await reserveOtpAttempt(config, challenge, maxAttempts, now);
  try {
    await assertOtpGuessBudget(config, runtimeOptions, email, now, challenge.id, reserved);
  } catch (error) {
    await handBackOtpAttempt(config, reserved.challengeId, now);
    throw error;
  }

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
  let verifiedByHolder = false;
  let consuming = false;
  // The code matched, so this attempt was not a wrong guess. When the request
  // ends before consuming the challenge (missing user, conflict, hook
  // rejection), the reserved attempt is handed back only if no other request
  // has reserved an attempt or consumed the challenge since and the
  // conditional write succeeds; otherwise it stays counted, which errs
  // towards the limit. A consumed correct code keeps its attempt.
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
        if (normalizeEmail(pendingSignUp.primaryEmail) !== email) {
          // A hook changed the address: the code proves the submitted one,
          // not this account's, so it neither links nor claims it.
          throw new AuthFnConflictError('A user with this email already exists', {
            primaryEmail: pendingSignUp.primaryEmail,
            linking: {
              method: 'email-otp',
              reason: 'email_not_proved'
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

    // Checked before the code is used, so a refused request leaves it unused.
    // A disabled account is not signed in to, linked, verified or claimed by
    // an email code: its holder's own session no longer authenticates, so
    // their request could not be told apart from someone else's, and a claim
    // would wipe their credentials for a session that is refused anyway.
    if (
      user
      && isAuthFnUserDisabled(user)
      && (
        input.purpose === 'sign-in'
        || input.purpose === 'verify-email'
        || (input.purpose === 'sign-up' && linkedExistingUser)
        // A reset of an unverified account would claim it.
        || (input.purpose === 'reset-password' && !user.emailVerifiedAt)
      )
    ) {
      throw new AuthFnSessionRevokedError('User is disabled', { userId: user.id });
    }
    if (input.purpose === 'verify-email' && input.requireAccountHolder) {
      // No account, or not its live session: refused before the code is used.
      verifiedByHolder = user ? await isAccountHolderRequest(config, input.request, user.id) : false;
      if (!verifiedByHolder) {
        throw new AuthFnUnauthenticatedError('Verifying this email requires the account\'s own signed-in session');
      }
    } else if (input.purpose === 'verify-email' && user && !user.emailVerifiedAt) {
      verifiedByHolder = await isAccountHolderRequest(config, input.request, user.id);
    }

    if (user && beforeConsume) await beforeConsume(user);
    consuming = true;
    consumed = await consumeOtpChallenge(config, challenge, now);
  } catch (error) {
    if (consuming && !(error instanceof AuthFnOtpReplayedError)) {
      // The consume write's outcome is unknown (it threw, or could not be
      // confirmed), so it may still commit: the attempt stays counted.
      throw error;
    }
    const released = await releaseOtpAttempt(config, reserved, now);
    // Only after a confirmed no-op: an unknown outcome may already have
    // released the attempt, and a second decrement could erase a wrong code.
    if (released === 'not-applied' && error instanceof AuthFnOtpReplayedError) {
      // Another request consumed the challenge with the same correct code;
      // this attempt matched too, so it is not a wrong guess. The challenge
      // is spent, so handing the attempt back allows no further comparison.
      await handBackOtpAttempt(config, reserved.challengeId, now);
    }
    throw error;
  }

  if (input.purpose === 'verify-email') {
    if (user && !user.emailVerifiedAt && !verifiedByHolder) {
      // The code was entered by someone other than a signed-in holder of
      // this account, so it is the first proof of the mailbox: claim it.
      user = await claimUnverifiedAccount(config, user, now);
    } else if (user) {
      user = await markUserEmailVerified(config, user.id, now);
    }
  } else if ((input.purpose === 'sign-in' || (input.purpose === 'sign-up' && linkedExistingUser)) && user) {
    if (!user.emailVerifiedAt) {
      user = await claimUnverifiedAccount(config, user, now);
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
  const outcome = await updateOtpChallengeOutcome(
    config,
    challenge.id,
    [{ field: 'consumedAt', operator: 'eq', value: null }],
    {
      consumedAt,
      updatedAt: consumedAt
    }
  );
  if (outcome === 'not-applied') {
    throw new AuthFnOtpReplayedError('OTP code has already been used', {
      challengeId: challenge.id
    });
  }
  if (outcome === 'unknown') {
    // This request's own write may have consumed the challenge. Not a replay,
    // so its attempt is not handed back.
    throw new AuthFnOtpInvalidError('OTP code could not be confirmed; request a new code', {
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

/**
 * The first time someone proves control of an unverified account's mailbox by
 * signing in or up with an email code, whatever was set up on the account
 * before that proof may belong to someone else: anyone can sign up with a
 * password for an address they do not own and keep the session it returns.
 * So the account's password is removed and its sessions are revoked before
 * the email is marked verified and the caller's session is issued. The owner
 * can set a password again afterwards.
 */
async function claimUnverifiedAccount(
  config: AuthFnRuntimeConfig,
  user: AuthFnUserRecord,
  now: Date
): Promise<AuthFnUserRecord> {
  await removePreVerificationAccess(config, user.id, now);
  return markUserEmailVerified(config, user.id, now);
}

/**
 * Whether the request is made by a signed-in holder of the account (a session
 * cookie with its CSRF token, or a bearer session token). Such a holder who
 * also has the emailed code controls both, as when someone who signed up with
 * a password verifies their own address.
 */
async function isAccountHolderRequest(
  config: AuthFnRuntimeConfig,
  request: Request | undefined,
  userId: string
): Promise<boolean> {
  if (!request) {
    return false;
  }
  const cookieState = await getCookieSessionState(config, request, { touch: false });
  if (countCookiesNamed(request, cookieState.cookiePolicy.sessionCookieName) > 1) {
    // Only one value is read, and an empty or stale duplicate could hide the
    // holder's live session and turn their own verification into a claim.
    throw new AuthFnValidationError('Request carries more than one session cookie', {
      cookie: cookieState.cookiePolicy.sessionCookieName
    });
  }
  if (cookieState.session?.type === 'session' && cookieState.session.actorId === userId) {
    // A live session of this very account must come with its CSRF token.
    // Without it the request may be cross-site, or come from a browser whose
    // CSRF cookie ran out before its session cookie; either way it must not
    // count as someone else proving the mailbox, which would wipe the
    // holder's own password. AUTHFN_CSRF_INVALID; the code stays unused.
    assertValidCsrf(request, cookieState);
    return true;
  }
  if (
    countCookiesNamed(request, cookieState.cookiePolicy.sessionCookieName) > 0
    && request.headers.get('authorization')
  ) {
    // Any other session cookie (stale, or another account's) hides the
    // bearer token next to it, so a holder signed in by bearer would look
    // anonymous and their verification would wipe their account. They can
    // retry with one credential.
    throw new AuthFnValidationError('Request carries both a session cookie and an Authorization header', {
      cookie: cookieState.cookiePolicy.sessionCookieName
    });
  }
  const session = await authenticateAccountRequest(config, request);
  return session?.actorId === userId;
}

function countCookiesNamed(request: Request, name: string): number {
  const header = request.headers.get('cookie');
  if (!header) {
    return 0;
  }
  return header.split(';').filter((part) => part.split('=')[0]?.trim() === name).length;
}

export async function completeResetPassword(
  config: AuthFnRuntimeConfig,
  runtimeOptions: OtpRuntimeOptions,
  input: CompleteResetPasswordInput
): Promise<{ passwordUpdated: true }> {
  // Refuse an unacceptable password before the OTP is read or spent.
  assertPasswordWithinLimits(input.newPassword);
  const email = normalizeEmail(input.email);
  const runtime = input.request ? await resolveEnvironment(config, input.request) : undefined;
  let updatePassword: Awaited<ReturnType<typeof preparePasswordCredentialUpdate>> | undefined;
  const challenge = await verifyOtpChallengeBeforeConsume(config, {}, runtimeOptions, {
    request: input.request,
    purpose: input.purpose,
    email,
    code: input.code
  }, async (user) => {
    updatePassword = await preparePasswordCredentialUpdate(config, {
      userId: user.id,
      password: input.newPassword
    }, {
      ...runtimeOptions.passwordPolicy,
      request: input.request,
      environment: runtime,
      email,
      purpose: 'reset-password'
    });
  });

  const user = challenge.user;
  if (!user || !updatePassword) {
    throw new AuthFnOtpInvalidError('Password reset requires an existing user', {
      email
    });
  }

  await updatePassword();
  // Whoever reset the password proved control of the mailbox. Sessions and
  // unfinished two-factor sign-ins that began before the reset (possibly by
  // someone who knew the old password) stop working. On an account whose
  // email was not verified yet, the reset is also its first proof of the
  // mailbox, so everything set up before it is removed (the new password is
  // kept) and the email is marked verified.
  if (user.emailVerifiedAt) {
    await removePendingTwoFactorChallenges(config, user.id);
    await revokeSessionsForUser(config, user.id);
  } else {
    const now = resolveNow(runtimeOptions);
    await removePreVerificationAccess(config, user.id, now, { keepPassword: true });
    await markUserEmailVerified(config, user.id, now);
  }

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

  return rows.find((row) => isAdmittedChallenge(row)) ?? null;
}

/**
 * A challenge is created expiring at its creation time and only gets its real
 * expiry once admitOtpChallenge has counted it, so a challenge whose send was
 * refused (or is still being counted) is never the one a code is checked
 * against, and never displaces a code that was delivered.
 */
function isAdmittedChallenge(row: AuthFnOtpChallengeRecord): boolean {
  return new Date(row.expiresAt).getTime() > new Date(row.createdAt).getTime();
}

export interface OtpEmailBudget {
  maxFailedAttempts: number;
  maxChallenges: number;
  windowMs: number;
  /** Rows read per count; see readOtpEmailUsage. */
  scanLimit: number;
  /** The longest challenge lifetime configured for either OTP plugin. */
  longestTtlMs: number;
}

/**
 * Rows read when counting an email's challenges, at least. The scan reads
 * enough rows to cover every challenge that can still be live: the cap allows
 * `maxChallenges` new challenges per window, and a challenge lives at most the
 * longest configured lifetime.
 */
const OTP_EMAIL_SCAN_FLOOR = 100;

/**
 * Both OTP plugins (email OTP and password reset) count the same challenge
 * rows, so every route uses one email-wide policy: the strictest of the
 * limits set in `pluginRuntime.emailOtp` and `pluginRuntime.password.otp`
 * (the defaults without either).
 *
 * Two other sources can only tighten that policy, never loosen it: the
 * deprecated `authFnPasswordPlugin({ otp })` limits, which every plugin that
 * publishes `otpEmailLimits` contributes on every route, and the `options`
 * of this call, which apply to this call only.
 */
/** @internal Exported for tests. */
export function resolveOtpEmailBudget(
  config: OtpBudgetConfig,
  options: OtpRuntimeOptions
): OtpEmailBudget {
  const sources: OtpRuntimeOptions[] = [];
  const emailOtp = readPluginRuntimeConfig<OtpRuntimeOptions>(config as AuthFnRuntimeConfig, 'emailOtp');
  const password = readPluginRuntimeConfig<{ otp?: OtpRuntimeOptions }>(config as AuthFnRuntimeConfig, 'password');
  if (config.pluginRuntime?.emailOtp) {
    sources.push(emailOtp);
  }
  if (password.otp && typeof password.otp === 'object') {
    // Read as the password route reads it: through an object spread.
    sources.push({ ...password.otp });
  }
  if (sources.length === 0) {
    // Neither plugin has runtime config: every route uses the defaults, so
    // the routes still agree.
    sources.push({});
  }

  // Limits set outside pluginRuntime can only tighten the budget: a count is
  // lowered and the window lengthened, never the reverse. The deprecated
  // authFnPasswordPlugin({ otp }) limits apply on every route; limits passed
  // to a direct sendOtpChallenge/verifyOtpChallenge call apply to that call.
  const published = readDeprecatedPasswordOtpLimits(config);
  const tighteners = [...published, options];
  const fromCaller = (field: OtpEmailBudgetField): number[] => tighteners
    .filter((source) => source[field] !== undefined)
    .map((source) => readPositiveInteger(source[field], 0, field));
  // Only values a plugin actually sets compete; the default applies when
  // neither sets the field. (A plugin config that only supplies `delivery`
  // must not pull the other plugin's explicit value back to the default.)
  const configured = (field: OtpEmailBudgetField, fallback: number): number[] => {
    const explicit = sources
      .filter((source) => source[field] !== undefined)
      .map((source) => readPositiveInteger(source[field], fallback, field));
    return explicit.length > 0 ? explicit : [fallback];
  };
  const strictest = (field: 'maxFailedAttemptsPerEmail' | 'maxChallengesPerEmail', fallback: number) =>
    Math.min(...configured(field, fallback), ...fromCaller(field));
  const windowMs = Math.max(
    ...configured('emailAttemptWindowSeconds', DEFAULT_OTP_EMAIL_WINDOW_SECONDS),
    ...fromCaller('emailAttemptWindowSeconds')
  ) * 1000;
  // The scan must reach every challenge any route may have admitted.
  const maxChallenges = Math.max(
    ...configured('maxChallengesPerEmail', DEFAULT_OTP_MAX_CHALLENGES_PER_EMAIL),
    ...fromCaller('maxChallengesPerEmail')
  );
  // The calling route's lifetime counts too: it may come from the deprecated
  // factory options.
  // A factory lifetime may be the one the password route uses, so the scan
  // reaches that far too. Scanning further than needed is harmless, so every
  // valid factory lifetime counts whether or not runtime config overrides
  // it; the password plugin checks its effective lifetime at setup.
  const factoryTtlsMs = published
    .map((source) => source.challengeTtlSeconds)
    .filter((value): value is number => isValidOtpLimit(value))
    .map((value) => value * 1000);
  const longestTtlMs = Math.max(
    resolveTtlMs(options),
    ...sources.map((source) => resolveTtlMs(source)),
    ...factoryTtlsMs
  );
  const windowsPerLifetime = Math.ceil(longestTtlMs / windowMs) + 1;

  return {
    maxFailedAttempts: strictest('maxFailedAttemptsPerEmail', DEFAULT_OTP_MAX_FAILED_ATTEMPTS_PER_EMAIL),
    maxChallenges: strictest('maxChallengesPerEmail', DEFAULT_OTP_MAX_CHALLENGES_PER_EMAIL),
    windowMs,
    scanLimit: Math.max(OTP_EMAIL_SCAN_FLOOR, maxChallenges * windowsPerLifetime) + 1,
    longestTtlMs
  };
}

/** Callers narrow the config type; the object they pass is the full config. */
type OtpBudgetConfig = Pick<AuthFnRuntimeConfig, 'pluginRuntime'> & { plugins?: AuthFnRuntimeConfig['plugins'] };

type OtpEmailBudgetField = 'maxFailedAttemptsPerEmail' | 'maxChallengesPerEmail' | 'emailAttemptWindowSeconds';

/**
 * The per-email limits from the deprecated `authFnPasswordPlugin({ otp })`
 * options, which the password plugin publishes as `otpEmailLimits` so that
 * every OTP route, not only the password ones, applies them. Every plugin
 * that publishes limits counts (they only tighten), so another plugin with
 * the same name cannot hide them.
 */
function readDeprecatedPasswordOtpLimits(config: OtpBudgetConfig): OtpRuntimeOptions[] {
  return (config.plugins ?? [])
    .map((plugin) => (plugin as { otpEmailLimits?: unknown }).otpEmailLimits)
    .filter((limits): limits is OtpRuntimeOptions => Boolean(limits) && typeof limits === 'object');
}

/**
 * Checks the per-email OTP limits when the server is set up, so a bad value
 * fails at startup instead of on every send and verify. `routeOptions` is a
 * route's own merged options (for the password plugin, its factory `otp`
 * under its runtime `otp`), whose lifetime is checked too.
 */
export function assertOtpEmailBudgetConfig(config: OtpBudgetConfig, routeOptions: OtpRuntimeOptions = {}): void {
  resolveOtpEmailBudget(config, {});
  resolveTtlMs(routeOptions);
}

function isValidOtpLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= OTP_EMAIL_LIMIT_MAX;
}

function readPositiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > OTP_EMAIL_LIMIT_MAX) {
    throw new AuthFnConfigError(`OTP ${field} must be a whole number from 1 to ${OTP_EMAIL_LIMIT_MAX}`, { field });
  }
  return value;
}

interface CountedOtpChallenge {
  id: string;
  /** When this challenge stops counting: the later of its window end and its expiry. */
  countedUntilMs: number;
  attemptCount: number;
  consumed: boolean;
}

interface OtpEmailUsage {
  counted: CountedOtpChallenge[];
  /** The scan hit its row limit while rows were still counted, so the count may be low. */
  incomplete: boolean;
  /** Until when an incomplete scan stays incomplete (older rows may still count). */
  incompleteUntil: Date | null;
  /** Ids of every row the scan read. */
  scannedIds: Set<string>;
}

/**
 * Reads the challenges that count against an email (every purpose): those
 * created within the window, and any older one that has not expired yet, so a
 * challenge is counted for as long as a code can still be checked against it.
 * Rows are read newest first with a bounded limit. The window is applied here
 * rather than in the query because adapters differ in how they compare
 * stored dates.
 */
async function readOtpEmailUsage(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  email: string,
  budget: OtpEmailBudget,
  now: Date
): Promise<OtpEmailUsage> {
  const rows = await config.database.findMany<AuthFnOtpChallengeRecord>({
    model: 'otp_challenges',
    where: [{ field: 'email', operator: 'eq', value: email }],
    orderBy: [
      { field: 'createdAt', direction: 'desc' },
      { field: 'id', direction: 'desc' }
    ],
    limit: budget.scanLimit,
    namespace: namespace(config)
  });
  const nowMs = now.getTime();
  const counted: CountedOtpChallenge[] = [];
  for (const row of rows) {
    const countedUntilMs = Math.max(
      new Date(row.createdAt).getTime() + budget.windowMs,
      new Date(row.expiresAt).getTime()
    );
    if (countedUntilMs > nowMs) {
      counted.push({
        id: row.id,
        countedUntilMs,
        attemptCount: Number(row.attemptCount) || 0,
        // Consumed by a matching code. A row that was never admitted (a
        // refused or retired send) can carry consumedAt without a match.
        consumed: Boolean(row.consumedAt) && isAdmittedChallenge(row)
      });
    }
  }
  // A full scan may have left out older rows. Any of them can still count
  // only while the oldest row read is within the window plus the longest
  // lifetime, since older rows were created no later than it.
  const last = rows[rows.length - 1];
  const incompleteUntilMs = last === undefined
    ? 0
    : new Date(last.createdAt).getTime() + Math.max(budget.windowMs, budget.longestTtlMs);
  const incomplete = rows.length >= budget.scanLimit && incompleteUntilMs > nowMs;
  return {
    counted,
    incomplete,
    incompleteUntil: incomplete ? new Date(incompleteUntilMs) : null,
    scannedIds: new Set(rows.map((row) => row.id))
  };
}

function failedAttempts(row: CountedOtpChallenge): number {
  // A consumed challenge's last attempt was the correct code.
  return Math.max(0, row.attemptCount - (row.consumed ? 1 : 0));
}

/**
 * When the email's count drops below `cap`: rows stop counting in order of
 * `countedUntilMs`, so walking them from the longest-lived down, the row at
 * which the running total reaches the cap is the one whose departure brings
 * the total under it. Returns null when the total is already under the cap.
 */
function capResetAt(
  counted: readonly CountedOtpChallenge[],
  weight: (row: CountedOtpChallenge) => number,
  cap: number
): Date | null {
  const byDeparture = [...counted].sort((left, right) => right.countedUntilMs - left.countedUntilMs);
  let total = 0;
  for (const row of byDeparture) {
    total += weight(row);
    if (total >= cap) {
      return new Date(row.countedUntilMs);
    }
  }
  return null;
}

function laterOf(left: Date | null, right: Date): Date {
  return left && left.getTime() > right.getTime() ? left : right;
}

/**
 * Refuses a new challenge once the email already has `maxChallengesPerEmail`
 * counted challenges. Without this cap a caller could request a fresh
 * challenge after every few wrong guesses; with it, the number of codes that
 * can be tried for one email is bounded even when the HTTP rate limiter is
 * off.
 */
async function assertOtpChallengeBudget(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace' | 'pluginRuntime'>,
  runtimeOptions: OtpRuntimeOptions,
  email: string,
  now: Date
): Promise<void> {
  const budget = resolveOtpEmailBudget(config, runtimeOptions);
  const usage = await readOtpEmailUsage(config, email, budget, now);
  const resetAt = capResetAt(usage.counted, () => 1, budget.maxChallenges);
  if (resetAt || usage.incomplete) {
    throw otpEmailLimitError(
      'challenges',
      usage.incomplete ? laterOf(resetAt, usage.incompleteUntil!) : resetAt!
    );
  }
}

/**
 * Counts the email's challenges again now that this request's challenge row
 * exists, and only then gives it its real expiry. Concurrent sends can all
 * pass the first check; each counts again after its own row exists, so one
 * that finds the email over the cap is refused and its row is left not
 * admitted: it never accepts a code, is never chosen as the latest challenge,
 * and keeps counting towards the challenge cap until it leaves the window.
 * Concurrent senders may all be refused, which errs towards the cap.
 */
async function admitOtpChallenge(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace' | 'pluginRuntime'>,
  runtimeOptions: OtpRuntimeOptions,
  challenge: AuthFnOtpChallengeRecord,
  now: Date
): Promise<AuthFnOtpChallengeRecord> {
  const budget = resolveOtpEmailBudget(config, runtimeOptions);
  const usage = await readOtpEmailUsage(config, challenge.email, budget, now);
  const overCap = capResetAt(usage.counted, () => 1, budget.maxChallenges + 1);
  if (overCap || usage.incomplete) {
    const resetAt = capResetAt(usage.counted, () => 1, budget.maxChallenges);
    throw otpEmailLimitError(
      'challenges',
      usage.incomplete ? laterOf(resetAt, usage.incompleteUntil!) : resetAt!
    );
  }

  const expiresAt = new Date(now.getTime() + resolveTtlMs(runtimeOptions));
  let admitted = false;
  try {
    admitted = await updateOtpChallengeIfMatches(
      config,
      challenge.id,
      [{ field: 'consumedAt', operator: 'eq', value: null }],
      { expiresAt, updatedAt: now }
    );
  } catch {
    // The write may have committed before the error; read back below.
  }
  if (!admitted) {
    // The write may have applied without an acknowledgement; the stored row
    // says whether it was admitted.
    let stored: AuthFnOtpChallengeRecord | null = null;
    try {
      stored = await config.database.findOne<AuthFnOtpChallengeRecord>({
        model: 'otp_challenges',
        where: [{ field: 'id', operator: 'eq', value: challenge.id }],
        namespace: namespace(config)
      });
    } catch {
      // Unknown: retire it like an unconfirmed admission.
    }
    if (!stored || !isAdmittedChallenge(stored) || stored.consumedAt) {
      // Retire the row before giving up, so an admission write still in
      // flight cannot make it the challenge codes are checked against: the
      // admission is guarded on consumedAt being null, and a retired row is
      // never admitted (it expires as it was created).
      await updateOtpChallengeOutcome(
        config,
        challenge.id,
        [{ field: 'consumedAt', operator: 'eq', value: null }],
        { consumedAt: now, expiresAt: challenge.createdAt, updatedAt: now }
      ).catch(() => 'unknown' as const);
      throw new AuthFnOtpInvalidError('OTP challenge could not be created', {
        challengeId: challenge.id
      });
    }
  }
  return { ...challenge, expiresAt, updatedAt: now };
}

/**
 * Checks the email's budget of wrong codes across all of its challenges, so
 * requesting a new challenge does not reset the count.
 *
 * - Without a reservation, the request is refused when the email already has
 *   `maxFailedAttemptsPerEmail` failures.
 * - After this request reserved an attempt, the count includes that attempt
 *   and every attempt reserved before it, so concurrent requests that all
 *   passed the first check are refused once the total goes over the cap. The
 *   caller hands the reservation back, since no code was compared.
 *
 * A count the scan could not complete is treated as over the cap. The reset
 * time is when a new request would pass the first check.
 */
async function assertOtpGuessBudget(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace' | 'pluginRuntime'>,
  runtimeOptions: OtpRuntimeOptions,
  email: string,
  now: Date,
  challengeId: string,
  reservation?: OtpAttemptReservation
): Promise<void> {
  const budget = resolveOtpEmailBudget(config, runtimeOptions);
  const usage = await readOtpEmailUsage(config, email, budget, now);
  const cap = reservation ? budget.maxFailedAttempts + 1 : budget.maxFailedAttempts;
  if (capResetAt(usage.counted, failedAttempts, cap) || usage.incomplete) {
    // Refused after its own reservation, this request passed the first check,
    // so it lost a race with concurrent requests whose reservations may also
    // be handed back. A fresh request's first check gives the real answer,
    // so it is told to retry shortly.
    const resetAt = reservation
      ? new Date(now.getTime() + 1000)
      : capResetAt(usage.counted, failedAttempts, budget.maxFailedAttempts) ?? new Date(now.getTime() + 1000);
    throw otpEmailLimitError(
      'failed-attempts',
      usage.incomplete ? laterOf(resetAt, usage.incompleteUntil!) : resetAt
    );
  }
  if (!usage.scannedIds.has(challengeId)) {
    // A live challenge outside the rows read (pushed out by many newer rows)
    // would be guessed without its count being seen. Waiting does not bring
    // it back into the scan, so the caller is told to request a new code.
    throw new AuthFnOtpExpiredError('OTP code has expired; request a new code', {
      challengeId
    });
  }
}

function otpEmailLimitError(
  limit: 'challenges' | 'failed-attempts',
  resetAt: Date
): AuthFnRateLimitedError {
  return new AuthFnRateLimitedError(
    limit === 'challenges'
      ? 'Too many codes were requested for this email; try again later'
      : 'Too many incorrect codes for this email; try again later',
    {
      scope: 'otp-email',
      limit,
      resetAt: resetAt.toISOString()
    }
  );
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
 * Hands back one attempt that was reserved but never compared. Unlike
 * releaseOtpAttempt, it does not need this request's reservation to be the
 * latest: it lowers the stored count by one from whatever it is, so
 * concurrent hand-backs succeed in any order, including after another
 * request consumed the challenge (its matching attempt is kept). The count
 * stays at least the number of codes actually compared. It gives up, leaving
 * the attempt counted, after a few lost rounds.
 */
async function handBackOtpAttempt(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  challengeId: string,
  updatedAt: Date
): Promise<void> {
  try {
    for (let round = 0; round < OTP_ATTEMPT_RESERVATION_ROUNDS; round += 1) {
      const current = await config.database.findOne<AuthFnOtpChallengeRecord>({
        model: 'otp_challenges',
        where: [{ field: 'id', operator: 'eq', value: challengeId }],
        namespace: namespace(config)
      });
      // A consumed challenge keeps the attempt that matched.
      const floor = current?.consumedAt ? 2 : 1;
      if (!current || current.attemptCount < floor) {
        return;
      }
      const outcome = await updateOtpChallengeOutcome(
        config,
        challengeId,
        current.consumedAt
          // Consumption never reverts, so only the count needs guarding.
          ? [{ field: 'attemptCount', operator: 'eq', value: current.attemptCount }]
          : [
              { field: 'attemptCount', operator: 'eq', value: current.attemptCount },
              { field: 'consumedAt', operator: 'eq', value: null }
            ],
        { attemptCount: current.attemptCount - 1, updatedAt }
      );
      // Retry only after a confirmed no-op; an unknown outcome may already
      // have lowered the count.
      if (outcome !== 'not-applied') {
        return;
      }
    }
  } catch {
    // Keeping the attempt counted is the safe outcome.
  }
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
): Promise<'applied' | 'not-applied' | 'unknown'> {
  try {
    return await updateOtpChallengeOutcome(
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
    // The write may or may not have applied. Keeping the reservation is the
    // safe outcome; the caller rethrows the error that ended the request.
    return 'unknown';
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
  return (await updateOtpChallengeOutcome(config, challengeId, guards, data)) === 'applied';
}

/**
 * The same conditional write, reporting `unknown` when the adapter could not
 * say whether it applied (an affected-row count that is not a finite
 * number). Callers that undo a reservation must not write again after an
 * unknown outcome, since the first write may already have applied.
 */
async function updateOtpChallengeOutcome(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  challengeId: string,
  guards: WhereClause[],
  data: Record<string, unknown>
): Promise<'applied' | 'not-applied' | 'unknown'> {
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
      return row?.id === challengeId ? 'applied' : 'unknown';
    } catch (error) {
      if (isNotFoundError(error)) {
        return 'not-applied';
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
  if (!Number.isFinite(affected)) {
    return 'unknown';
  }
  return affected > 0 ? 'applied' : 'not-applied';
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
  return readPositiveInteger(options.challengeTtlSeconds, DEFAULT_OTP_TTL_SECONDS, 'challengeTtlSeconds') * 1000;
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
  const profile = readSignUpProfile(input.profile);
  const beforeUserInput = await runBeforeUserCreateHook(hooks, hookContext, {
    primaryEmail: normalizeEmail(input.email),
    emailVerifiedAt: verifiedAt,
    metadata: profile
  });

  return {
    primaryEmail: normalizeEmail(readString(beforeUserInput.primaryEmail) ?? input.email),
    metadata: readRecord(beforeUserInput.metadata) ?? profile,
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
