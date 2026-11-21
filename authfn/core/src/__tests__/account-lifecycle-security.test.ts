// Regression tests for the account lifecycle findings of the AuthFn security
// audit of 2026-11-21 (AF-05, AF-06, AF-08, AF-09). Every value is an obviously
// fake test value.
import { describe, expect, it } from 'vitest';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnPasswordPlugin } from '@authfn/password';
import { authFnEmailOtpPlugin } from '@authfn/email-otp';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnTwoFactorPlugin } from '@authfn/two-factor';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import type { AuthFnRuntimeConfig } from '../index.js';

const BASE = 'https://account.example.com/auth';
const OWNER = 'owner@example.com';

function createContext(extra: Partial<AuthFnRuntimeConfig> = {}) {
  const codes = new Map<string, string>();
  const delivery = {
    async send(input: { purpose: string; email: string; code: string }) {
      codes.set(`${input.purpose}:${input.email}`, input.code);
      return { sent: true };
    }
  };
  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [authFnPasswordPlugin(), authFnEmailOtpPlugin()],
    pluginRuntime: {
      emailOtp: { delivery },
      password: { otp: { delivery } }
    },
    ...extra
  };
  const auth = createTestServer(config);
  return {
    config,
    handle: (request: Request) => auth.router.handle(request),
    codeFor: (purpose: string, email: string) => codes.get(`${purpose}:${email}`)!
  };
}

function json(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}

function csrfToken(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => /csrf=/.test(value.split(';')[0]!));
  return decodeURIComponent(cookie!.split(';')[0]!.split('=').slice(1).join('='));
}

function account(ctx: ReturnType<typeof createContext>, headers: Record<string, string>) {
  return ctx.handle(new Request(`${BASE}/account`, { headers }));
}

async function signInByOtp(ctx: ReturnType<typeof createContext>, purpose: 'sign-in' | 'sign-up', email: string) {
  await ctx.handle(json('/otp/send', { purpose, email }));
  return ctx.handle(json('/otp/verify', { purpose, email, code: ctx.codeFor(purpose, email) }));
}

describe('AF-05: a password set before the owner proves the mailbox does not survive it', () => {
  it('removes the pre-verification password and revokes its sessions when the owner signs in by email code', async () => {
    const ctx = createContext();
    const password = 'attacker-test-password';
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password }));
    expect(signUp.status).toBe(200);
    const attackerCookies = cookieHeader(signUp);

    const owner = await signInByOtp(ctx, 'sign-in', OWNER);
    expect(owner.status).toBe(200);

    expect((await account(ctx, { cookie: attackerCookies })).status).toBe(401);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password }))).status).toBe(401);
    expect((await account(ctx, { cookie: cookieHeader(owner) })).status).toBe(200);
  });

  it('does the same when the owner signs up by email code and linking to the existing user is allowed', async () => {
    const ctx = createContext({ accountLinking: { otpSignUpExistingUser: true } });
    const password = 'attacker-test-password';
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password }));
    const attackerCookies = cookieHeader(signUp);

    const owner = await signInByOtp(ctx, 'sign-up', OWNER);
    expect(owner.status).toBe(200);
    expect((await account(ctx, { cookie: attackerCookies })).status).toBe(401);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password }))).status).toBe(401);
  });

  it('keeps the password of an account whose email was already verified', async () => {
    const ctx = createContext({ accountLinking: { passwordForAuthenticatedUser: true } });
    const signedUp = await signInByOtp(ctx, 'sign-up', OWNER);
    const linked = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }, {
      cookie: cookieHeader(signedUp),
      'x-authfn-csrf': csrfToken(signedUp)
    }));
    expect(linked.status).toBe(200);

    expect((await signInByOtp(ctx, 'sign-in', OWNER)).status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);
    expect((await account(ctx, { cookie: cookieHeader(signedUp) })).status).toBe(200);
  });
});

describe('AF-05: everything set up before the mailbox was proven is removed when it is claimed', () => {
  function createFullContext(extra: Partial<AuthFnRuntimeConfig> = {}) {
    const ctx = createContext({
      plugins: [
        authFnPasswordPlugin(),
        authFnEmailOtpPlugin(),
        authFnApiKeyPlugin(),
        authFnTwoFactorPlugin(),
        authFnSocialOAuthPlugin()
      ],
      ...extra
    });
    return ctx;
  }

  async function plantAccess(ctx: ReturnType<typeof createContext>, userId: string) {
    const now = new Date();
    const create = (model: string, data: Record<string, unknown>) =>
      ctx.config.database.create({ model, data, namespace: 'authfn' });
    await create('api_keys', {
      id: 'key_test_planted', userId, name: 'planted', secretHash: 'test-planted-key-hash', scopes: ['*'],
      metadata: {}, createdAt: now, updatedAt: now
    });
    await create('two_factor_enrollments', {
      id: 'tfe_test_planted', userId, secretEncrypted: 'test-planted-secret', lastUsedCounter: null,
      confirmedAt: now, createdAt: now, updatedAt: now
    });
    await create('two_factor_recovery_codes', {
      id: 'tfr_test_planted', enrollmentId: 'tfe_test_planted', codeHash: 'test-planted-code-hash', usedAt: null, createdAt: now
    });
    await create('two_factor_challenges', {
      id: 'tfc_test_planted', userId, primaryMethod: 'password', expiresAt: new Date(now.getTime() + 300_000),
      consumedAt: null, createdAt: now, updatedAt: now
    });
    await create('oauth_accounts', {
      id: 'oa_test_planted', userId, provider: 'google', providerAccountId: 'test-planted-google-account',
      email: OWNER, createdAt: now, updatedAt: now
    });
  }

  async function remaining(ctx: ReturnType<typeof createContext>, userId: string) {
    const count = async (model: string, field: string, value: string) =>
      (await ctx.config.database.findMany({ model, where: [{ field, operator: 'eq', value }], namespace: 'authfn' })).length;
    return {
      apiKeys: await count('api_keys', 'userId', userId),
      enrollments: await count('two_factor_enrollments', 'userId', userId),
      recoveryCodes: await count('two_factor_recovery_codes', 'enrollmentId', 'tfe_test_planted'),
      challenges: await count('two_factor_challenges', 'userId', userId),
      oauthAccounts: await count('oauth_accounts', 'userId', userId)
    };
  }

  const none = { apiKeys: 0, enrollments: 0, recoveryCodes: 0, challenges: 0, oauthAccounts: 0 };

  it('removes API keys, second factors, pending challenges and linked accounts on the owner\'s first email-code sign-in', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'attacker-test-password' }));
    const userId = (await signUp.json()).data.session.actorId as string;
    await plantAccess(ctx, userId);

    const owner = await signInByOtp(ctx, 'sign-in', OWNER);
    expect(owner.status).toBe(200);
    expect(await remaining(ctx, userId)).toEqual(none);
  });

  it('claims the account when someone other than a signed-in holder enters a verify-email code', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'attacker-test-password' }));
    const attackerCookies = cookieHeader(signUp);
    const userId = (await signUp.json()).data.session.actorId as string;
    await plantAccess(ctx, userId);

    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const verified = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code: ctx.codeFor('verify-email', OWNER) }));
    expect(verified.status).toBe(200);
    expect(await remaining(ctx, userId)).toEqual(none);
    expect((await account(ctx, { cookie: attackerCookies })).status).toBe(401);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'attacker-test-password' }))).status).toBe(401);
  });

  it('only verifies the email when the signed-in holder enters the verify-email code', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }));
    const cookies = cookieHeader(signUp);
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const verified = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code: ctx.codeFor('verify-email', OWNER) }, {
      cookie: cookies,
      'x-authfn-csrf': csrfToken(signUp)
    }));
    expect(verified.status).toBe(200);
    expect((await account(ctx, { cookie: cookies })).status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);
  });

  it('refuses, without using the code, a verify-email from the holder\'s own session that lacks the CSRF token', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }));
    const cookies = cookieHeader(signUp);
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const code = ctx.codeFor('verify-email', OWNER);
    // The CSRF cookie ran out before the session cookie: only the session
    // cookie is sent, and no CSRF header.
    const sessionOnly = cookies.split('; ').filter((cookie) => !/csrf=/.test(cookie)).join('; ');
    const refused = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, { cookie: sessionOnly }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('AUTHFN_CSRF_INVALID');
    // Nothing was wiped, and the code still works with the token.
    expect((await account(ctx, { cookie: cookies })).status).toBe(200);
    const verified = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, {
      cookie: cookies,
      'x-authfn-csrf': csrfToken(signUp)
    }));
    expect(verified.status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);
  });

  it('refuses, without using the code, a verify-email whose session cookie is duplicated', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }));
    const cookies = cookieHeader(signUp);
    const sessionCookie = cookies.split('; ').find((cookie) => /session=/.test(cookie))!;
    const sessionName = sessionCookie.split('=')[0]!;
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const code = ctx.codeFor('verify-email', OWNER);
    const refused = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, {
      cookie: `${cookies}; ${sessionName}=`,
      'x-authfn-csrf': csrfToken(signUp)
    }));
    expect(refused.status).toBe(400);
    expect((await account(ctx, { cookie: cookies })).status).toBe(200);
    const verified = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, {
      cookie: cookies,
      'x-authfn-csrf': csrfToken(signUp)
    }));
    expect(verified.status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);
  });

  it('refuses, without using the code, a verify-email with a stale session cookie next to the holder\'s bearer token', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password', sessionMode: 'hybrid' }));
    const body = await signUp.clone().json();
    const token = body.data.token as string;
    const sessionName = cookieHeader(signUp).split('; ').find((cookie) => /session=/.test(cookie))!.split('=')[0]!;
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const code = ctx.codeFor('verify-email', OWNER);
    const refused = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, {
      cookie: `${sessionName}=test-stale-session-token`,
      authorization: `Bearer ${token}`
    }));
    expect(refused.status).toBe(400);
    // The same with another account's live cookie session and its CSRF token.
    const other = await ctx.handle(json('/sign-up/password', { email: 'other@example.com', password: 'other-test-password' }));
    const otherVerify = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, {
      cookie: cookieHeader(other),
      'x-authfn-csrf': csrfToken(other),
      authorization: `Bearer ${token}`
    }));
    expect(otherVerify.status).toBe(400);
    expect((await account(ctx, { authorization: `Bearer ${token}` })).status).toBe(200);
    const verified = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, {
      authorization: `Bearer ${token}`
    }));
    expect(verified.status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);
  });

  it('refuses, without using the code, a verify-email that requires the holder but has no live session', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password', sessionMode: 'hybrid' }));
    const token = (await signUp.clone().json()).data.token as string;
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const code = ctx.codeFor('verify-email', OWNER);
    const refused = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code, requireAccountHolder: true }, {
      authorization: 'Bearer test-expired-session-token'
    }));
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe('AUTHFN_UNAUTHENTICATED');
    // Nothing was claimed, and the code still works with the live session.
    const verified = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code, requireAccountHolder: true }, {
      authorization: `Bearer ${token}`
    }));
    expect(verified.status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);

    // An address without an account is refused the same way.
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: 'nobody@example.com' }));
    const missing = await ctx.handle(json('/otp/verify', {
      purpose: 'verify-email',
      email: 'nobody@example.com',
      code: ctx.codeFor('verify-email', 'nobody@example.com'),
      requireAccountHolder: true
    }, { authorization: `Bearer ${token}` }));
    expect(missing.status).toBe(401);
  });

  it('neither verifies nor claims a disabled account, so its holder keeps their credentials', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }));
    const cookies = cookieHeader(signUp);
    const userId = (await signUp.clone().json()).data.session.actorId as string;
    await ctx.handle(json('/otp/send', { purpose: 'verify-email', email: OWNER }));
    const code = ctx.codeFor('verify-email', OWNER);
    await ctx.config.database.update({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: userId }],
      data: { metadata: { disabled: true } },
      namespace: 'authfn'
    });
    for (const headers of [{ cookie: cookies, 'x-authfn-csrf': csrfToken(signUp) }, {}]) {
      const refused = await ctx.handle(json('/otp/verify', { purpose: 'verify-email', email: OWNER, code }, headers));
      expect(refused.status).toBe(401);
      expect((await refused.json()).error.code).toBe('AUTHFN_SESSION_REVOKED');
    }
    const credentials = await ctx.config.database.findMany({
      model: 'password_credentials',
      where: [{ field: 'userId', operator: 'eq', value: userId }],
      namespace: 'authfn'
    });
    expect(credentials).toHaveLength(1);
  });

  it.each(['sign-in', 'sign-up'] as const)('refuses an email-code %s to a disabled account without wiping it', async (purpose) => {
    const ctx = createFullContext({
      accountLinking: { otpSignUpExistingUser: true }
    } as Partial<AuthFnRuntimeConfig>);
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }));
    const userId = (await signUp.clone().json()).data.session.actorId as string;
    await ctx.config.database.update({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: userId }],
      data: { metadata: { disabled: true } },
      namespace: 'authfn'
    });
    const refused = await signInByOtp(ctx, purpose, OWNER);
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe('AUTHFN_SESSION_REVOKED');
    const credentials = await ctx.config.database.findMany({
      model: 'password_credentials',
      where: [{ field: 'userId', operator: 'eq', value: userId }],
      namespace: 'authfn'
    });
    expect(credentials).toHaveLength(1);
  });

  it('refuses a password reset of a disabled, unverified account without claiming it', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }));
    const userId = (await signUp.clone().json()).data.session.actorId as string;
    await plantAccess(ctx, userId);
    await ctx.config.database.update({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: userId }],
      data: { metadata: { disabled: true } },
      namespace: 'authfn'
    });
    await ctx.handle(json('/password/reset/start', { email: OWNER }));
    const refused = await ctx.handle(json('/password/reset/complete', {
      email: OWNER,
      code: ctx.codeFor('reset-password', OWNER),
      newPassword: 'new-owner-test-password'
    }));
    expect(refused.status).toBe(401);
    expect((await remaining(ctx, userId)).apiKeys).toBe(1);
  });

  it('removes a credential added by a session minted while the claim was running', async () => {
    let injected = false;
    const base = memoryAdapter({ debug: false });
    const database = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'deleteMany' && typeof value === 'function') {
          return async (params: { model: string; where: Array<{ value: unknown }> }) => {
            const count = await value.call(target, params);
            if (!injected && params.model === 'api_keys') {
              injected = true;
              // As if a session minted during the claim added a key right
              // after the keys were cleared.
              const now = new Date();
              await target.create({
                model: 'api_keys',
                data: {
                  id: 'key_test_during_claim', userId: params.where[0]!.value, name: 'during-claim',
                  secretHash: 'test-during-claim-key-hash', scopes: ['*'], metadata: {}, createdAt: now, updatedAt: now
                },
                namespace: 'authfn'
              });
            }
            return count;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const ctx = createFullContext({ database });
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'attacker-test-password' }));
    const userId = (await signUp.json()).data.session.actorId as string;
    await plantAccess(ctx, userId);
    expect((await signInByOtp(ctx, 'sign-in', OWNER)).status).toBe(200);
    expect(injected).toBe(true);
    expect(await remaining(ctx, userId)).toEqual(none);
  });

  it('revokes the account\'s sessions before removing anything else when it is claimed', async () => {
    const writes: string[] = [];
    const base = memoryAdapter({ debug: false });
    const database = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        if (['update', 'updateMany', 'delete', 'deleteMany'].includes(property as string)) {
          return async (params: { model: string }) => {
            writes.push(params.model);
            return value.call(target, params);
          };
        }
        return value.bind(target);
      }
    });
    const ctx = createFullContext({ database });
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'attacker-test-password' }));
    const userId = (await signUp.json()).data.session.actorId as string;
    await plantAccess(ctx, userId);
    writes.length = 0;
    expect((await signInByOtp(ctx, 'sign-in', OWNER)).status).toBe(200);
    const firstSessionWrite = writes.indexOf('sessions');
    expect(firstSessionWrite).toBeGreaterThanOrEqual(0);
    expect(firstSessionWrite).toBeLessThan(writes.indexOf('password_credentials'));
    expect(firstSessionWrite).toBeLessThan(writes.indexOf('api_keys'));
  });

  it('treats a password reset on an unverified account as its claim, keeping the new password', async () => {
    const ctx = createFullContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'attacker-test-password' }));
    const userId = (await signUp.json()).data.session.actorId as string;
    await plantAccess(ctx, userId);

    await ctx.handle(json('/password/reset/start', { email: OWNER }));
    const reset = await ctx.handle(json('/password/reset/complete', {
      email: OWNER, code: ctx.codeFor('reset-password', OWNER), newPassword: 'owner-new-test-password'
    }));
    expect(reset.status).toBe(200);
    expect(await remaining(ctx, userId)).toEqual(none);

    // The email is now verified, so a later email-code sign-in keeps the
    // password the owner just chose.
    expect((await signInByOtp(ctx, 'sign-in', OWNER)).status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-new-test-password' }))).status).toBe(200);
  });

  it('ends unfinished two-factor sign-ins on a password reset of a verified account', async () => {
    const ctx = createFullContext();
    const signedUp = await signInByOtp(ctx, 'sign-up', OWNER);
    const userId = (await signedUp.json()).data.session.actorId as string;
    const now = new Date();
    await ctx.config.database.create({
      model: 'two_factor_challenges',
      data: { id: 'tfc_test_pending', userId, primaryMethod: 'password', expiresAt: new Date(now.getTime() + 300_000), consumedAt: null, createdAt: now, updatedAt: now },
      namespace: 'authfn'
    });
    await ctx.handle(json('/password/reset/start', { email: OWNER }));
    await ctx.handle(json('/password/reset/complete', {
      email: OWNER, code: ctx.codeFor('reset-password', OWNER), newPassword: 'owner-new-test-password'
    }));
    expect((await remaining(ctx, userId)).challenges).toBe(0);
  });
});

describe('AF-06: sessions end on password reset and while the user is disabled', () => {
  it('revokes sessions issued before a password reset', async () => {
    const ctx = createContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'original-test-password', sessionMode: 'hybrid' }));
    const oldCookies = cookieHeader(signUp);
    const oldToken = (await signUp.clone().json()).data.token as string;

    await ctx.handle(json('/password/reset/start', { email: OWNER }));
    const reset = await ctx.handle(json('/password/reset/complete', {
      email: OWNER,
      code: ctx.codeFor('reset-password', OWNER),
      newPassword: 'replaced-test-password'
    }));
    expect(reset.status).toBe(200);

    expect((await account(ctx, { cookie: oldCookies })).status).toBe(401);
    expect((await account(ctx, { authorization: `Bearer ${oldToken}` })).status).toBe(401);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'replaced-test-password' }))).status).toBe(200);
  });

  it('refuses cookie and bearer sessions while metadata.disabled is set, and accepts them again once cleared', async () => {
    const ctx = createContext();
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'original-test-password', sessionMode: 'hybrid' }));
    const body = await signUp.clone().json();
    const cookies = cookieHeader(signUp);
    const token = body.data.token as string;
    const userId = body.data.session.actorId as string;
    const setDisabled = (disabled: boolean) => ctx.config.database.update({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: userId }],
      data: { metadata: { disabled } },
      namespace: 'authfn'
    });

    await setDisabled(true);
    expect((await account(ctx, { cookie: cookies })).status).toBe(401);
    expect((await account(ctx, { authorization: `Bearer ${token}` })).status).toBe(401);

    await setDisabled(false);
    expect((await account(ctx, { cookie: cookies })).status).toBe(200);
    expect((await account(ctx, { authorization: `Bearer ${token}` })).status).toBe(200);
  });
});

describe('AF-06: a disabled user can still sign out', () => {
  it('revokes the session on sign-out while disabled, so it stays dead once re-enabled', async () => {
    const events: Array<{ type: string; outcome?: string }> = [];
    const ctx = createContext({
      observability: { events: { emit: async (event: { type: string; outcome?: string }) => { events.push(event); } } } as never
    });
    const signUp = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'original-test-password', sessionMode: 'hybrid' }));
    const body = await signUp.clone().json();
    const cookies = cookieHeader(signUp);
    const token = body.data.token as string;
    const userId = body.data.session.actorId as string;
    const setDisabled = (disabled: boolean) => ctx.config.database.update({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: userId }],
      data: { metadata: { disabled } },
      namespace: 'authfn'
    });

    await setDisabled(true);
    const signOut = await ctx.handle(json('/sign-out', {}, { cookie: cookies, 'x-authfn-csrf': csrfToken(signUp) }));
    expect(signOut.status).toBe(200);
    expect((await signOut.json()).data.revoked).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: 'authfn.session.revoked', outcome: 'revoked-current' }));

    await setDisabled(false);
    expect((await account(ctx, { authorization: `Bearer ${token}` })).status).toBe(401);
  });
});

describe('AF-08: the sign-up profile is caller data', () => {
  it('drops the AuthFn-owned disabled key from a sign-up profile', async () => {
    const ctx = createContext();
    const signUp = await ctx.handle(json('/sign-up/password', {
      email: 'new-user@example.com',
      password: 'signup-test-password',
      profile: { name: 'New User', disabled: true }
    }));
    expect(signUp.status).toBe(200);
    const response = await account(ctx, { cookie: cookieHeader(signUp) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.user.metadata).toEqual({ name: 'New User' });
  });

  it.each([
    ['an array', ['admin']],
    ['a string', 'admin'],
    ['larger than 4 KB', { note: 'x'.repeat(5000) }]
  ])('refuses a profile that is %s', async (_label, profile) => {
    const ctx = createContext();
    const password = await ctx.handle(json('/sign-up/password', { email: 'new-user@example.com', password: 'signup-test-password', profile }));
    expect(password.status).toBe(400);
    expect((await password.json()).error.code).toBe('AUTHFN_VALIDATION_ERROR');

    await ctx.handle(json('/otp/send', { purpose: 'sign-up', email: 'otp-user@example.com' }));
    const otp = await ctx.handle(json('/otp/verify', {
      purpose: 'sign-up',
      email: 'otp-user@example.com',
      code: ctx.codeFor('sign-up', 'otp-user@example.com'),
      profile
    }));
    expect(otp.status).toBe(400);
  });
});

describe('AF-09: adding a password to the signed-in account needs the CSRF token', () => {
  it('does not treat a cookie-only request as authenticated', async () => {
    const ctx = createContext({ accountLinking: { passwordForAuthenticatedUser: true } });
    const owner = await signInByOtp(ctx, 'sign-up', OWNER);
    const planted = await ctx.handle(new Request(`${BASE}/sign-up/password`, {
      method: 'POST',
      // What a <form enctype="text/plain"> on a sibling site sends.
      headers: { 'content-type': 'text/plain', cookie: cookieHeader(owner) },
      body: JSON.stringify({ email: OWNER, password: 'attacker-chosen-test-password' })
    }));
    expect(planted.status).toBe(409);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'attacker-chosen-test-password' }))).status).toBe(401);

    const wrongToken = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'attacker-chosen-test-password' }, {
      cookie: cookieHeader(owner),
      'x-authfn-csrf': 'test-wrong-csrf-token'
    }));
    expect(wrongToken.status).toBe(409);

  });

  it('does not fall back to a bearer token when the request carries a session cookie, even an empty one', async () => {
    const ctx = createContext({ accountLinking: { passwordForAuthenticatedUser: true } });
    await ctx.handle(json('/otp/send', { purpose: 'sign-up', email: OWNER }));
    const owner = await ctx.handle(json('/otp/verify', {
      purpose: 'sign-up', email: OWNER, code: ctx.codeFor('sign-up', OWNER), sessionMode: 'hybrid'
    }));
    const token = (await owner.clone().json()).data.token as string;
    expect(token).toBeTruthy();
    const sessionCookieName = cookieHeader(owner).split('; ').find((part) => /session=/.test(part))!.split('=')[0]!;

    // A valid session cookie followed by an empty one of the same name is
    // still a cookie request, so the valid bearer token sent with it does
    // not count.
    const mixed = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }, {
      cookie: `${cookieHeader(owner)}; ${sessionCookieName}=`,
      authorization: `Bearer ${token}`
    }));
    expect(mixed.status).toBe(409);

    // The same bearer token alone does add the password.
    const bearerOnly = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }, {
      authorization: `Bearer ${token}`
    }));
    expect(bearerOnly.status).toBe(200);
  });

  it('adds the password with the CSRF token', async () => {
    const ctx = createContext({ accountLinking: { passwordForAuthenticatedUser: true } });
    const owner = await signInByOtp(ctx, 'sign-up', OWNER);
    const linked = await ctx.handle(json('/sign-up/password', { email: OWNER, password: 'owner-test-password' }, {
      cookie: cookieHeader(owner),
      'x-authfn-csrf': csrfToken(owner)
    }));
    expect(linked.status).toBe(200);
    expect((await ctx.handle(json('/sign-in/password', { email: OWNER, password: 'owner-test-password' }))).status).toBe(200);
  });
});
