import { describe, expect, it } from 'vitest';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnPasswordPlugin } from '@authfn/password';
import type { AuthFnEvent, AuthFnRuntimeConfig } from '../index.js';
import { issueSession } from '../core/sessions.js';
import { createUser } from '../core/users.js';
import { completeResetPassword, sendOtpChallenge } from '../core/verifications.js';
import { buildLookupResult } from '../core/regions.js';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  createPasswordCredential,
  getPasswordCredentialByUserId,
  signInWithPassword,
  updatePasswordCredential,
  verifyPassword
} from '../core/passwords.js';

function createConfig(): AuthFnRuntimeConfig {
  return {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [authFnPasswordPlugin()]
  };
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.slice(0, cookie.indexOf(';')))
    .join('; ');
}

describe('authfn password plugin', () => {
  it('rejects oversized user IDs in direct credential helpers', async () => {
    const config = createConfig();
    const userId = 'u'.repeat(256);

    await expect(createPasswordCredential(config, {
      userId,
      passwordHash: 'already-hashed'
    })).rejects.toMatchObject({
      code: 'AUTHFN_VALIDATION_ERROR',
      details: { fieldName: 'userId', maxLength: 255 }
    });
    await expect(updatePasswordCredential(config, {
      userId,
      password: 'CorrectHorseBatteryStaple!'
    })).rejects.toMatchObject({
      code: 'AUTHFN_VALIDATION_ERROR',
      details: { fieldName: 'userId', maxLength: 255 }
    });
    await expect(config.database.count({
      model: 'password_credentials',
      namespace: 'authfn'
    })).resolves.toBe(0);
  });

  it('updates an existing password credential for a legacy oversized user ID', async () => {
    const config = createConfig();
    const userId = 'legacy-user-'.padEnd(300, 'x');
    const now = new Date();
    await config.database.create({
      model: 'password_credentials',
      namespace: 'authfn',
      data: {
        id: 'pwd_legacy',
        userId,
        passwordHash: 'old-hash',
        createdAt: now,
        updatedAt: now
      }
    });

    const updated = await updatePasswordCredential(config, {
      userId,
      password: 'An0therSecurePassphrase!'
    });

    expect(updated.userId).toBe(userId);
    expect(updated.passwordHash).not.toBe('old-hash');
    await expect(config.database.count({
      model: 'password_credentials',
      namespace: 'authfn'
    })).resolves.toBe(1);
  });

  it('creates a password credential for a persisted legacy oversized user ID', async () => {
    const config = createConfig();
    const userId = 'legacy-user-'.padEnd(300, 'x');
    const now = new Date();
    await config.database.create({
      model: 'users',
      namespace: 'authfn',
      data: {
        id: userId,
        primaryEmail: 'legacy-password@example.com',
        createdAt: now,
        updatedAt: now
      }
    });

    const credential = await createPasswordCredential(config, {
      userId,
      passwordHash: 'already-hashed'
    });

    expect(credential.userId).toBe(userId);
    await expect(config.database.findOne({
      model: 'password_credentials',
      namespace: 'authfn',
      where: [{ field: 'id', operator: 'eq', value: credential.id }]
    })).resolves.toMatchObject({ userId });
  });

  it('updates a password for a persisted legacy user without a credential', async () => {
    const config = createConfig();
    const userId = 'legacy-user-'.padEnd(300, 'x');
    const now = new Date();
    await config.database.create({
      model: 'users',
      namespace: 'authfn',
      data: {
        id: userId,
        primaryEmail: 'legacy-password-update@example.com',
        createdAt: now,
        updatedAt: now
      }
    });

    const credential = await updatePasswordCredential(config, {
      userId,
      password: 'An0therSecurePassphrase!'
    });

    expect(credential.userId).toBe(userId);
    await expect(getPasswordCredentialByUserId(config, userId)).resolves.toMatchObject({
      userId
    });
  });

  it('keeps the documented inline OTP delivery configuration compatible', async () => {
    const delivered: unknown[] = [];
    const auth = createTestServer({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnPasswordPlugin({
          otp: {
            codeGenerator: () => '123456',
            delivery: {
              async send(message) {
                delivered.push(message);
                return { sent: true };
              }
            }
          }
        })
      ]
    });

    const response = await auth.router.handle(
      new Request('https://account.example.com/auth/password/reset/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ada@example.com' })
      })
    );

    expect(response.status).toBe(200);
    expect(delivered).toHaveLength(1);
  });

  it('signs up with password, stores a hash, and issues a session cookie pair', async () => {
    const config = createConfig();
    const auth = createTestServer(config);

    const response = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'Ada@Example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.session.type).toBe('session');
    expect(body.data.session.actorType).toBe('user');
    expect(body.data.session.primaryEmail).toBe('ada@example.com');
    expect(body.data.session.methods).toEqual(['password']);

    const setCookies = response.headers.getSetCookie();
    expect(setCookies.some((value) => value.startsWith('__Secure-authfn.session='))).toBe(true);
    expect(setCookies.some((value) => value.startsWith('authfn.csrf='))).toBe(true);

    const credential = await getPasswordCredentialByUserId(config, body.data.session.actorId);
    expect(credential?.passwordHash).toContain('scrypt$');
    expect(credential?.passwordHash).not.toContain('Sup3rSecurePassphrase!');

    const currentSession = await auth.router.handle(
      new Request('https://account.example.com/auth/session', {
        headers: {
          cookie: cookieHeaderFromSetCookies(setCookies)
        }
      })
    );
    expect(currentSession.status).toBe(200);
    expect((await currentSession.json()).data.session.primaryEmail).toBe('ada@example.com');
  });

  it('rejects wrong passwords with the canonical credentials error and no session cookie', async () => {
    const config = createConfig();
    const auth = createTestServer(config);

    await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );

    const wrongPassword = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'wrong-password'
        })
      })
    );

    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.headers.getSetCookie()).toHaveLength(0);
    expect(await wrongPassword.json()).toEqual({
      ok: false,
      error: {
        code: 'AUTHFN_INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        retryable: false,
        details: undefined
      },
      requestId: expect.any(String)
    });
  });

  it('supports email-verification gating and compromised-password screening when configured', async () => {
    const auth = createTestServer({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnPasswordPlugin({
          compromisedPasswordChecker: async ({ password }) => password === 'Sup3rSecurePassphrase!',
          requireEmailVerifiedForSignIn: true
        })
      ]
    });

    const rejected = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe('AUTHFN_VALIDATION_ERROR');

    const accepted = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'bea@example.com',
          password: 'An0therSecurePassphrase!'
        })
      })
    );
    expect(accepted.status).toBe(200);

    const signIn = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          email: 'bea@example.com',
          password: 'An0therSecurePassphrase!'
        })
      })
    );
    expect(signIn.status).toBe(403);
    expect((await signIn.json()).error.code).toBe('AUTHFN_EMAIL_NOT_VERIFIED');
  });

  it('updates stored passwords for later reset-otp completion compatibility', async () => {
    const config = createConfig();
    const user = await createUser(config, {
      primaryEmail: 'ada@example.com'
    });

    await updatePasswordCredential(config, {
      userId: user.id,
      password: 'Sup3rSecurePassphrase!'
    });

    await expect(
      signInWithPassword(config, {
        email: 'ada@example.com',
        password: 'Sup3rSecurePassphrase!'
      })
    ).resolves.toMatchObject({
      user: {
        id: user.id
      }
    });

    await updatePasswordCredential(config, {
      userId: user.id,
      password: 'An0therSecurePassphrase!'
    });

    await expect(
      signInWithPassword(config, {
        email: 'ada@example.com',
        password: 'Sup3rSecurePassphrase!'
      })
    ).rejects.toMatchObject({
      code: 'AUTHFN_INVALID_CREDENTIALS'
    });

    await expect(
      signInWithPassword(config, {
        email: 'ada@example.com',
        password: 'An0therSecurePassphrase!'
      })
    ).resolves.toMatchObject({
      user: {
        id: user.id
      }
    });
  });

  it('links a password credential only for the authenticated same verified user', async () => {
    const events: AuthFnEvent[] = [];
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      accountLinking: {
        passwordForAuthenticatedUser: true
      },
      observability: {
        events: {
          emit: (event) => events.push(event)
        }
      },
      plugins: [authFnPasswordPlugin()]
    };
    const auth = createTestServer(config);
    const user = await createUser(config, {
      primaryEmail: 'ada@example.com',
      emailVerifiedAt: new Date('2026-03-22T00:00:00.000Z')
    });

    const unauthenticated = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    expect(unauthenticated.status).toBe(409);
    expect((await unauthenticated.json()).error.details.linking.required).toBe('authenticated-session');

    const issued = await issueSession(config, {}, {
      userId: user.id,
      primaryEmail: user.primaryEmail,
      methods: ['email-otp']
    });
    const linked = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${issued.sessionToken}`
        },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );

    expect(linked.status).toBe(200);
    const body = await linked.json();
    expect(body.data.session.actorId).toBe(user.id);
    expect(body.data.session.methods).toEqual(['password']);
    await expect(
      signInWithPassword(config, {
        email: 'ada@example.com',
        password: 'Sup3rSecurePassphrase!'
      })
    ).resolves.toMatchObject({
      user: {
        id: user.id
      }
    });
    expect(events.some((event) => event.type === 'authfn.account_linked')).toBe(true);
    expect(events.some((event) => event.type === 'authfn.account_linking.conflict')).toBe(true);
  });
});

describe('password storage and sign-in answers (AF-13, AF-10)', () => {
  const post = (auth: ReturnType<typeof createTestServer>, path: string, body: unknown) => auth.router.handle(
    new Request(`https://account.example.com/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  );

  function legacyHash(password: string): string {
    // The format written before AUTH-32: scrypt N = 2^14, r = 8, p = 1.
    const salt = randomBytes(16).toString('base64url');
    const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
    return ['scrypt', '16384', '8', '1', salt, digest].join('$');
  }

  it('hashes new passwords with scrypt N = 2^15, r = 8, p = 3', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await updatePasswordCredential(config, { userId: user.id, password: 'test-password-strong' });
    const stored = await getPasswordCredentialByUserId(config, user.id);
    expect(stored!.passwordHash.split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '3']);
  });

  it('accepts a hash stored with the old cost and upgrades it on sign-in', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash('test-password-legacy') });
    await signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-legacy' });
    const stored = await getPasswordCredentialByUserId(config, user.id);
    expect(stored!.passwordHash.split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '3']);
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-legacy' })).resolves.toBeTruthy();
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-wrong' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
  });

  it('refuses passwords longer than 1024 characters', async () => {
    const auth = createTestServer(createConfig());
    const long = 'x'.repeat(1025);
    const signUp = await post(auth, '/sign-up/password', { email: 'ada@example.com', password: long });
    expect(signUp.status).toBe(400);
    expect((await signUp.json()).error.code).toBe('AUTHFN_VALIDATION_ERROR');
  });

  it('does not evaluate a stored hash that asks for too much memory', async () => {
    const huge = ['scrypt', String(1 << 22), '8', '1', 'test-salt', 'test-digest'].join('$');
    await expect(verifyPassword('test-password-strong', huge)).rejects.toMatchObject({ code: 'AUTHFN_INTERNAL_ERROR' });
    const notPowerOfTwo = ['scrypt', '30000', '8', '1', 'test-salt', 'test-digest'].join('$');
    await expect(verifyPassword('test-password-strong', notPowerOfTwo)).rejects.toMatchObject({ code: 'AUTHFN_INTERNAL_ERROR' });
  });

  it('refuses a legacy hash on a wrong password without upgrading it', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    const stored = legacyHash('test-password-legacy');
    await createPasswordCredential(config, { userId: user.id, passwordHash: stored });
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-wrong' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
    expect((await getPasswordCredentialByUserId(config, user.id))!.passwordHash).toBe(stored);
  });

  it('still accepts an existing password longer than the limit for new ones', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    const long = 'test-password-'.padEnd(5000, 'x');
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash(long) });
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: long })).resolves.toBeTruthy();
  });

  it('only evaluates stored parameter sets AuthFn has written', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    const salt = randomBytes(16).toString('base64url');
    const expensive = ['scrypt', '65536', '8', '16', salt, 'test-digest'].join('$');
    await createPasswordCredential(config, { userId: user.id, passwordHash: expensive });
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-strong' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INTERNAL_ERROR' });
  });

  it('accepts both of two simultaneous sign-ins to an account still on the older cost', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash('test-password-legacy') });
    const results = await Promise.allSettled([1, 2].map(() =>
      signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-legacy' })));
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('refuses a sign-in whose password was reset while it was being checked', async () => {
    const base = memoryAdapter({ debug: false });
    let reads = 0;
    let resetNow: (() => Promise<void>) | undefined;
    const database = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'findOne' && typeof value === 'function') {
          return async (params: { model: string }) => {
            // The second credential read is the re-check after the hash: the
            // reset lands just before it.
            if (params.model === 'password_credentials' && (reads += 1) === 2 && resetNow) {
              await resetNow();
            }
            return value.call(target, params);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const config: AuthFnRuntimeConfig = { ...createConfig(), database };
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await updatePasswordCredential(config, { userId: user.id, password: 'test-password-current' });
    reads = 0;
    resetNow = () => updatePasswordCredential(config, { userId: user.id, password: 'test-password-after-reset' }).then(() => undefined);
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-current' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
  });

  it('refuses a submitted password longer than 64 KiB of UTF-8 without hashing it', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    // 25,000 characters, but 75,000 bytes of UTF-8.
    const huge = '€'.repeat(25_000);
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash(huge) });
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: huge }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
  });

  it('checks the email is verified only after the current password matched', async () => {
    const auth = createTestServer({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin({ requireEmailVerifiedForSignIn: true })]
    });
    await post(auth, '/sign-up/password', { email: 'bea@example.com', password: 'test-password-strong' });
    const wrong = await post(auth, '/sign-in/password', { email: 'bea@example.com', password: 'test-password-other' });
    expect((await wrong.json()).error.code).toBe('AUTHFN_INVALID_CREDENTIALS');
  });

  it('refuses a stored hash whose digest is not the full length', async () => {
    const empty = ['scrypt', '32768', '8', '3', 'test-salt', ''].join('$');
    await expect(verifyPassword('test-password-anything', empty)).rejects.toMatchObject({ code: 'AUTHFN_INTERNAL_ERROR' });
  });

  it('refuses a sign-in whose old password was replaced while its hash was being upgraded', async () => {
    const base = memoryAdapter({ debug: false });
    let replaced = false;
    const database = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'updateMany' && typeof value === 'function') {
          return async (params: { model: string; data: Record<string, unknown> }) => {
            if (!replaced && params.model === 'password_credentials') {
              replaced = true;
              // A reset lands between the password check and the upgrade.
              await value.call(target, { ...params, data: { passwordHash: legacyHash('test-password-new'), updatedAt: new Date() } });
            }
            return value.call(target, params);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const config: AuthFnRuntimeConfig = { ...createConfig(), database };
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash('test-password-legacy') });
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-legacy' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
  });

  it('checks a reset\'s new password length before using its code', async () => {
    const config = createConfig();
    await createUser(config, { primaryEmail: 'ada@example.com' });
    const options = {
      delivery: { send: async () => ({ sent: true }) },
      codeGenerator: () => '731942'
    };
    await sendOtpChallenge(config, {}, options, { purpose: 'reset-password', email: 'ada@example.com' });
    const reset = (newPassword: string) => completeResetPassword(config, options, {
      purpose: 'reset-password',
      email: 'ada@example.com',
      code: '731942',
      newPassword
    });
    await expect(reset('x'.repeat(1025))).rejects.toMatchObject({ code: 'AUTHFN_VALIDATION_ERROR' });
    await expect(reset('short')).rejects.toMatchObject({ code: 'AUTHFN_VALIDATION_ERROR' });
    // A password the policy refuses also leaves the code for another try.
    const policyOptions = { ...options, passwordPolicy: { compromisedPasswordChecker: async ({ password }: { password: string }) => password === 'test-password-breached' } };
    await expect(completeResetPassword(config, policyOptions, {
      purpose: 'reset-password',
      email: 'ada@example.com',
      code: '731942',
      newPassword: 'test-password-breached'
    })).rejects.toMatchObject({ code: 'AUTHFN_VALIDATION_ERROR' });
    await expect(reset('test-password-corrected')).resolves.toEqual({ passwordUpdated: true });
  });

  it('does no password work for a reset whose code is wrong', async () => {
    const config = createConfig();
    await createUser(config, { primaryEmail: 'ada@example.com' });
    let checks = 0;
    const options = {
      delivery: { send: async () => ({ sent: true }) },
      codeGenerator: () => '731942',
      passwordPolicy: { compromisedPasswordChecker: async () => { checks += 1; return false; } }
    };
    await sendOtpChallenge(config, {}, options, { purpose: 'reset-password', email: 'ada@example.com' });
    await expect(completeResetPassword(config, options, {
      purpose: 'reset-password', email: 'ada@example.com', code: '000000', newPassword: 'test-password-new-one'
    })).rejects.toMatchObject({ code: 'AUTHFN_OTP_INVALID' });
    expect(checks).toBe(0);
  });

  it('answers a reset with no attempts left the same way, whatever the code and new password', async () => {
    const config = createConfig();
    await createUser(config, { primaryEmail: 'ada@example.com' });
    const options = {
      delivery: { send: async () => ({ sent: true }) },
      codeGenerator: () => '731942',
      maxAttempts: 2
    };
    await sendOtpChallenge(config, {}, options, { purpose: 'reset-password', email: 'ada@example.com' });
    const reset = (code: string, newPassword: string) => completeResetPassword(config, options, {
      purpose: 'reset-password', email: 'ada@example.com', code, newPassword
    });
    // A refused password with the right code hands its attempt back.
    await expect(reset('731942', 'short')).rejects.toMatchObject({ code: 'AUTHFN_VALIDATION_ERROR' });
    await expect(reset('000000', 'test-password-new-one')).rejects.toMatchObject({ code: 'AUTHFN_OTP_INVALID' });
    await expect(reset('000001', 'test-password-new-one')).rejects.toMatchObject({ code: 'AUTHFN_OTP_INVALID' });
    // No attempts left: the right code with a password the policy refuses
    // gets the same answer as a wrong code, so it does not confirm the code.
    for (const [code, newPassword] of [['731942', 'short'], ['731942', 'test-password-new-one'], ['000002', 'short']]) {
      await expect(reset(code, newPassword)).rejects.toMatchObject({ code: 'AUTHFN_OTP_INVALID' });
    }
  });

  it('refuses a password that is not a string, even against a stored hash of an empty password', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    // An imported credential whose password is ''.
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash('') });
    for (const password of [123, ['x'], { length: 1 }, true]) {
      await expect(signInWithPassword(config, { email: 'ada@example.com', password: password as unknown as string }))
        .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
    }
  });

  it('returns the upgraded credential after a sign-in rewrites an old-cost hash', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash('test-password-legacy') });
    const result = await signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-legacy' });
    const stored = await getPasswordCredentialByUserId(config, user.id);
    expect(result.credential.passwordHash).toBe(stored!.passwordHash);
    expect(result.credential.passwordHash.split('$').slice(0, 4)).toEqual(['scrypt', '32768', '8', '3']);
    expect(new Date(result.credential.updatedAt).getTime()).toBe(new Date(stored!.updatedAt).getTime());
  });

  it('writes old-cost hashes and skips upgrades with passwordHashCost legacy (rolling deploys)', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin({ passwordHashCost: 'legacy' })]
    };
    const auth = createTestServer(config);
    const signedUp = await post(auth, '/sign-up/password', { email: 'bea@example.com', password: 'test-password-strong' });
    expect(signedUp.status).toBeLessThan(300);
    const user = (await config.database.findOne<{ id: string }>({
      model: 'users', where: [{ field: 'primaryEmail', operator: 'eq', value: 'bea@example.com' }], namespace: 'authfn'
    }))!;
    const written = await getPasswordCredentialByUserId(config, user.id);
    expect(written!.passwordHash.split('$').slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
    // An earlier version verifies it: N = 2^14 fits Node's default memory cap.
    const [, , , , salt, digest] = written!.passwordHash.split('$');
    expect(scryptSync('test-password-strong', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')).toBe(digest);

    await updatePasswordCredential(config, { userId: user.id, password: 'test-password-legacy' }, { hashCost: 'legacy' });
    const before = await getPasswordCredentialByUserId(config, user.id);
    const signedIn = await post(auth, '/sign-in/password', { email: 'bea@example.com', password: 'test-password-legacy' });
    expect(signedIn.status).toBe(200);
    expect((await getPasswordCredentialByUserId(config, user.id))!.passwordHash).toBe(before!.passwordHash);
  });

  it('refuses a sign-in whose upgrade write went unconfirmed while a reset replaced the password', async () => {
    const base = memoryAdapter({ debug: false });
    const database = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === 'updateMany' && typeof value === 'function') {
          return async (params: { model: string; where: unknown[] }) => {
            if (params.model === 'password_credentials') {
              // A reset lands first; the adapter then cannot report a count.
              await value.call(target, { ...params, where: (params.where as unknown[]).slice(0, 1), data: { passwordHash: legacyHash('test-password-new'), updatedAt: new Date() } });
              return Number.NaN;
            }
            return value.call(target, params);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const config: AuthFnRuntimeConfig = { ...createConfig(), database };
    const user = await createUser(config, { primaryEmail: 'ada@example.com' });
    await createPasswordCredential(config, { userId: user.id, passwordHash: legacyHash('test-password-legacy') });
    await expect(signInWithPassword(config, { email: 'ada@example.com', password: 'test-password-legacy' }))
      .rejects.toMatchObject({ code: 'AUTHFN_INVALID_CREDENTIALS' });
  });

  it('answers a region lookup for a local account like one for an unknown identifier', async () => {
    const config = createConfig();
    const record = {
      identifier: 'ada@example.com',
      userId: 'user_test_local',
      regionId: 'us-east-1',
      authority: 'https://us.account.example.com',
      domain: '.example.com',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z'
    };
    const lookupStore = {
      get: async (key: string) => (key.endsWith('ada@example.com') ? JSON.stringify(record) : null),
      setIfAbsent: async () => ({ inserted: false }),
      delete: async () => {}
    };
    const environment = { issuer: 'https://us.account.example.com', baseUrl: 'https://us.account.example.com', regionId: 'us-east-1' };
    const pluginConfig = { lookupStore } as never;
    const known = await buildLookupResult(config, pluginConfig, { identifier: 'ada@example.com', environment });
    const unknown = await buildLookupResult(config, pluginConfig, { identifier: 'nobody@example.com', environment });
    // The user id is kept for the lookup event only; the route drops it.
    expect({ ...known, identifier: undefined, userId: undefined }).toEqual({ ...unknown, identifier: undefined, userId: undefined });
  });

  it('flags an account owned by another region, and only that one', async () => {
    const config = createConfig();
    const records: Record<string, unknown> = {
      'ada@example.com': { identifier: 'ada@example.com', userId: 'user_test_local', regionId: 'us-east-1', authority: 'https://us.account.example.com' },
      'eve@example.com': { identifier: 'eve@example.com', userId: 'user_test_remote', regionId: 'eu-west-1', authority: 'https://us.account.example.com' }
    };
    const lookupStore = {
      get: async (key: string) => {
        const match = Object.keys(records).find((identifier) => key.endsWith(identifier));
        return match ? JSON.stringify({ ...(records[match] as object), createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z' }) : null;
      },
      setIfAbsent: async () => ({ inserted: false }),
      delete: async () => {}
    };
    const environment = { issuer: 'https://us.account.example.com', baseUrl: 'https://us.account.example.com', regionId: 'us-east-1' };
    const pluginConfig = { lookupStore } as never;
    const lookup = (identifier: string) => buildLookupResult(config, pluginConfig, { identifier, environment });
    // Same authority, other region: still reported, so the client can refuse
    // a duplicate sign-up.
    expect(await lookup('eve@example.com')).toMatchObject({ regionId: 'eu-west-1', continueLocally: true, ownedElsewhere: true });
    expect((await lookup('ada@example.com')).ownedElsewhere).toBeUndefined();
    expect((await lookup('nobody@example.com')).ownedElsewhere).toBeUndefined();
  });

  it('says an email is unverified only to someone who knows the password, and names no user', async () => {
    const auth = createTestServer({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin({ requireEmailVerifiedForSignIn: true })]
    });
    await post(auth, '/sign-up/password', { email: 'bea@example.com', password: 'test-password-strong' });
    const wrong = await post(auth, '/sign-in/password', { email: 'bea@example.com', password: 'test-password-wrong' });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.code).toBe('AUTHFN_INVALID_CREDENTIALS');
    const unknown = await post(auth, '/sign-in/password', { email: 'nobody@example.com', password: 'test-password-wrong' });
    expect(unknown.status).toBe(401);
    const right = await post(auth, '/sign-in/password', { email: 'bea@example.com', password: 'test-password-strong' });
    expect(right.status).toBe(403);
    const body = await right.json();
    expect(body.error.code).toBe('AUTHFN_EMAIL_NOT_VERIFIED');
    expect(body.error.details?.userId).toBeUndefined();
  });
});
