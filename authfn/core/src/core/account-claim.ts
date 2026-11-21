import type { AuthFnRuntimeConfig, AuthFnTwoFactorEnrollmentRecord } from '../types.js';
import { revokeSessionsForUser } from './sessions.js';

/**
 * Removes every way into an account that was set up before its email was
 * proven, so that whoever proves control of the mailbox first gets the account
 * to themselves.
 *
 * Anyone can sign up with a password for an address they do not own. Until the
 * real owner proves the mailbox, that person holds sessions and can add more
 * ways back in: a password, API keys, a second factor, linked social
 * accounts, native handoff codes and grants to OAuth clients. All of them are
 * removed or revoked here, before the email is marked verified and the
 * owner's own session is issued.
 *
 * Only tables of plugins that are installed are touched.
 */
export async function removePreVerificationAccess(
  config: AuthFnRuntimeConfig,
  userId: string,
  now: Date,
  options: {
    /** Keep the password credential: a password reset has just replaced it. */
    keepPassword?: boolean;
  } = {}
): Promise<void> {
  // Sessions go first, so the holder being locked out cannot use one to add
  // a credential after its table has been cleared. A sign-in method still
  // present can mint a fresh session while the first pass runs, and that
  // session can add a credential after its table was cleared; the second
  // pass, after another session sweep, removes what it added. (A request
  // already past authentication can still finish; see AUTH-32.)
  for (let pass = 0; pass < 2; pass += 1) {
    await revokeSessionsForUser(config, userId);
    await removeAccessOnce(config, userId, now, options);
  }
  // Again at the end, for sessions issued while the second pass ran.
  await revokeSessionsForUser(config, userId);
}

async function removeAccessOnce(
  config: AuthFnRuntimeConfig,
  userId: string,
  now: Date,
  options: { keepPassword?: boolean }
): Promise<void> {
  // Ways to sign in first, then what a session can create.
  if (hasPlugin(config, 'password') && !options.keepPassword) {
    await deleteMany(config, 'password_credentials', 'userId', userId);
  }
  if (hasPlugin(config, 'socialOAuth')) {
    await deleteMany(config, 'oauth_accounts', 'userId', userId);
  }
  if (hasPlugin(config, 'nativeHandoff')) {
    await deleteMany(config, 'native_handoff_codes', 'userId', userId);
  }
  if (hasPlugin(config, 'twoFactor')) {
    await removeTwoFactor(config, userId);
  }
  if (hasPlugin(config, 'apiKey')) {
    await deleteMany(config, 'api_keys', 'userId', userId);
  }
  if (hasPlugin(config, 'oauthProvider')) {
    // Every code and token issued under a grant stops working once the grant
    // is revoked.
    await config.database.updateMany({
      model: 'oauth_provider_grants',
      where: [
        { field: 'userId', operator: 'eq', value: userId },
        { field: 'revokedAt', operator: 'eq', value: null }
      ],
      data: { revokedAt: now, revokedReason: 'account_claimed', updatedAt: now },
      namespace: namespace(config)
    });
    // Remembered consent would let a client get a new grant without asking.
    await deleteMany(config, 'oauth_provider_consents', 'userId', userId);
  }
}

/**
 * Deletes the user's unfinished two-factor sign-in challenges. A challenge is
 * proof that someone passed the first factor; after a password reset or an
 * account claim that proof no longer stands.
 */
export async function removePendingTwoFactorChallenges(
  config: AuthFnRuntimeConfig,
  userId: string
): Promise<void> {
  if (hasPlugin(config, 'twoFactor')) {
    await deleteMany(config, 'two_factor_challenges', 'userId', userId);
  }
}

async function removeTwoFactor(config: AuthFnRuntimeConfig, userId: string): Promise<void> {
  const enrollments = await config.database.findMany<AuthFnTwoFactorEnrollmentRecord>({
    model: 'two_factor_enrollments',
    where: [{ field: 'userId', operator: 'eq', value: userId }],
    namespace: namespace(config)
  });
  for (const enrollment of enrollments) {
    await deleteMany(config, 'two_factor_recovery_codes', 'enrollmentId', enrollment.id);
  }
  await deleteMany(config, 'two_factor_challenges', 'userId', userId);
  await deleteMany(config, 'two_factor_enrollments', 'userId', userId);
}

function hasPlugin(config: Pick<AuthFnRuntimeConfig, 'plugins'>, name: string): boolean {
  return config.plugins?.some((plugin) => plugin.name === name) ?? false;
}

async function deleteMany(
  config: Pick<AuthFnRuntimeConfig, 'database' | 'namespace'>,
  model: string,
  field: string,
  value: unknown
): Promise<number> {
  return config.database.deleteMany({
    model,
    where: [{ field, operator: 'eq', value }],
    namespace: namespace(config)
  });
}

function namespace(config: Pick<AuthFnRuntimeConfig, 'namespace'>): string {
  return config.namespace ?? 'authfn';
}
