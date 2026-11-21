import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './test-server.js';
import type { Adapter } from '@superfunctions/db';
import type { TwoFactorPluginRuntimeConfig } from '../plugin-types.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnPasswordPlugin } from '@authfn/password';
import { authFnTwoFactorPlugin } from '@authfn/two-factor';
import type { AuthFnRuntimeConfig } from '../index.js';
import { issueSessionCookies } from '../core/cookies.js';
import { issueSession } from '../core/sessions.js';
import {
  confirmTwoFactorEnrollment,
  createTwoFactorChallenge,
  createTwoFactorEnrollment,
  satisfyTwoFactorChallenge,
  verifyTwoFactorCode
} from '../core/two-factor.js';
import { getSchema } from '../schema.js';
import { createUser } from '../core/users.js';

const TEST_NOW = new Date('2026-03-22T00:00:00.000Z');
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TEST_2FA_KEY = Buffer.alloc(32, 7);

function createClock(start: Date = TEST_NOW) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advanceSeconds: (seconds: number) => {
      current = new Date(current.getTime() + (seconds * 1000));
    }
  };
}

function createConfig(clock = createClock()): AuthFnRuntimeConfig {
  const twoFactorConfig = createTwoFactorPluginConfig(clock);
  return {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [
      authFnPasswordPlugin(),
      authFnTwoFactorPlugin()
    ],
    pluginRuntime: {
      twoFactor: twoFactorConfig
    }
  };
}

describe('two-factor persistence bounds', () => {
  it('rejects oversized user IDs in direct enrollment and challenge helpers', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'bounds@example.com' });
    const oversizedUser = { ...user, id: 'u'.repeat(256) };

    await expect(createTwoFactorEnrollment(
      config,
      oversizedUser,
      config.pluginRuntime?.twoFactor
    )).rejects.toMatchObject({
      code: 'AUTHFN_VALIDATION_ERROR',
      details: { fieldName: 'userId', maxLength: 255 }
    });
    await expect(createTwoFactorChallenge(
      config,
      oversizedUser,
      'password',
      config.pluginRuntime?.twoFactor
    )).rejects.toMatchObject({
      code: 'AUTHFN_VALIDATION_ERROR',
      details: { fieldName: 'userId', maxLength: 255 }
    });
    await expect(config.database.count({
      model: 'two_factor_enrollments',
      namespace: 'authfn'
    })).resolves.toBe(0);
    await expect(config.database.count({
      model: 'two_factor_challenges',
      namespace: 'authfn'
    })).resolves.toBe(0);
  });

  it('creates a persisted challenge for a confirmed legacy oversized user ID', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'legacy-2fa@example.com' });
    const oversizedUser = { ...user, id: 'legacy-user-'.padEnd(300, 'x') };
    const now = new Date();
    await config.database.create({
      model: 'users',
      namespace: 'authfn',
      data: {
        ...oversizedUser,
        createdAt: now,
        updatedAt: now
      }
    });
    await config.database.create({
      model: 'two_factor_enrollments',
      namespace: 'authfn',
      data: {
        id: 'tfa_legacy',
        userId: oversizedUser.id,
        secretEncrypted: 'legacy-secret',
        lastUsedCounter: null,
        confirmedAt: now,
        createdAt: now,
        updatedAt: now
      }
    });

    const challenge = await createTwoFactorChallenge(
      config,
      oversizedUser,
      'password',
      config.pluginRuntime?.twoFactor
    );
    expect(challenge?.challenge.userId).toBe(oversizedUser.id);
    await expect(config.database.count({
      model: 'two_factor_challenges',
      namespace: 'authfn'
    })).resolves.toBe(1);
    await expect(config.database.findOne({
      model: 'two_factor_challenges',
      namespace: 'authfn',
      where: [{ field: 'id', operator: 'eq', value: challenge?.challenge.id }]
    })).resolves.toMatchObject({ userId: oversizedUser.id });
  });

  it('creates an enrollment for a persisted legacy oversized user ID', async () => {
    const config = createConfig();
    const user = await createUser(config, { primaryEmail: 'legacy-enroll@example.com' });
    const legacyUser = { ...user, id: 'legacy-user-'.padEnd(300, 'x') };
    await config.database.create({
      model: 'users',
      namespace: 'authfn',
      data: legacyUser
    });

    const enrollment = await createTwoFactorEnrollment(
      config,
      legacyUser,
      config.pluginRuntime?.twoFactor
    );

    expect(enrollment.enrollment.userId).toBe(legacyUser.id);
    await expect(config.database.count({
      model: 'two_factor_enrollments',
      namespace: 'authfn'
    })).resolves.toBe(1);
    await expect(config.database.findOne({
      model: 'two_factor_enrollments',
      namespace: 'authfn',
      where: [{ field: 'id', operator: 'eq', value: enrollment.enrollment.id }]
    })).resolves.toMatchObject({ userId: legacyUser.id });
  });
});

function createTwoFactorPluginConfig(clock: ReturnType<typeof createClock>) {
  return {
    issuer: 'authfn-tests',
    now: clock.now,
    recoveryCodeCount: 3,
    encryptionKeyResolver: () => TEST_2FA_KEY
  };
}

function createPrismaStyleUpdateWrapper(base: Adapter): Adapter {
  return {
    ...base,
    // Like the Prisma adapter, it reports no RETURNING support, so conditional
    // writes go through updateMany.
    capabilities: {
      ...base.capabilities,
      operations: { ...base.capabilities.operations, returning: false }
    },
    async update(params) {
      if (
        params.model === 'two_factor_enrollments'
        && 'lastUsedCounter' in params.data
      ) {
        throw new Error('two-factor replay protection must not rely on adapter.update re-read semantics');
      }

      return base.update(params);
    }
  };
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

function decodeBase32(secret: string): Buffer {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of secret.replace(/=+$/g, '').toUpperCase()) {
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

function generateTotp(secret: string, now: Date = TEST_NOW, digits = 6, periodSeconds = 30): string {
  const counter = Math.floor(now.getTime() / 1000 / periodSeconds);
  const key = decodeBase32(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

describe('authfn two factor plugin', () => {
  it('enrolls, confirms, gates password sign-in, satisfies challenges, and supports disable', async () => {
    const clock = createClock();
    const config = createConfig(clock);
    const auth = createTestServer(config);

    const signUp = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    expect(signUp.status).toBe(200);
    const signUpCookies = signUp.headers.getSetCookie();
    const signUpCookieHeader = cookieHeaderFromSetCookies(signUpCookies);
    const csrfToken = signUpCookies
      .find((cookie) => cookie.startsWith('authfn.csrf='))
      ?.slice('authfn.csrf='.length, signUpCookies.find((cookie) => cookie.startsWith('authfn.csrf='))?.indexOf(';') ?? -1);
    expect(csrfToken).toBeDefined();

    const enroll = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/enroll', {
        method: 'POST',
        headers: {
          cookie: signUpCookieHeader,
          'x-authfn-csrf': csrfToken!
        }
      })
    );
    expect(enroll.status).toBe(200);
    const enrollBody = await enroll.json();
    expect(enrollBody.data.secret).toEqual(expect.any(String));
    expect(enrollBody.data.recoveryCodes).toHaveLength(3);

    const confirm = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/confirm', {
        method: 'POST',
        headers: {
          cookie: signUpCookieHeader,
          'content-type': 'application/json',
          'x-authfn-csrf': csrfToken!
        },
        body: JSON.stringify({
          code: generateTotp(enrollBody.data.secret, clock.now())
        })
      })
    );
    expect(confirm.status).toBe(200);
    const confirmBody = await confirm.json();
    expect(confirmBody.data.enabled).toBe(true);
    expect(confirmBody.data.sessionMethods).toContain('two-factor');

    const gated = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    expect(gated.status).toBe(401);
    const gatedBody = await gated.json();
    expect(gatedBody.error.code).toBe('AUTHFN_2FA_REQUIRED');
    expect(gated.headers.getSetCookie()).toHaveLength(0);

    clock.advanceSeconds(30);
    const challenge = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: gatedBody.error.details.challengeId,
          code: generateTotp(enrollBody.data.secret, clock.now())
        })
      })
    );
    expect(challenge.status).toBe(200);
    expect(challenge.headers.getSetCookie()).toHaveLength(2);
    const challengeBody = await challenge.json();
    expect(challengeBody.data.twoFactorSatisfied).toBe(true);
    expect(challengeBody.data.session.methods).toEqual(['password', 'two-factor']);

    const replayedChallenge = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: gatedBody.error.details.challengeId,
          code: generateTotp(enrollBody.data.secret, clock.now())
        })
      })
    );
    expect(replayedChallenge.status).toBe(400);
    expect((await replayedChallenge.json()).error.code).toBe('AUTHFN_2FA_INVALID_CODE');

    const gatedForRecovery = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    const gatedForRecoveryBody = await gatedForRecovery.json();
    const recoveryCode = enrollBody.data.recoveryCodes[0];
    const recoverySuccess = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: gatedForRecoveryBody.error.details.challengeId,
          code: recoveryCode
        })
      })
    );
    expect(recoverySuccess.status).toBe(200);

    const gatedForReuse = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    const gatedForReuseBody = await gatedForReuse.json();
    const recoveryReuse = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          challengeId: gatedForReuseBody.error.details.challengeId,
          code: recoveryCode
        })
      })
    );
    expect(recoveryReuse.status).toBe(400);
    expect((await recoveryReuse.json()).error.code).toBe('AUTHFN_2FA_INVALID_CODE');

    clock.advanceSeconds(30);
    const currentCookieHeader = cookieHeaderFromSetCookies(challenge.headers.getSetCookie());
    const currentCsrf = challenge.headers.getSetCookie()
      .find((cookie) => cookie.startsWith('authfn.csrf='))
      ?.slice('authfn.csrf='.length, challenge.headers.getSetCookie().find((cookie) => cookie.startsWith('authfn.csrf='))?.indexOf(';') ?? -1);
    const disable = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/disable', {
        method: 'POST',
        headers: {
          cookie: currentCookieHeader,
          'content-type': 'application/json',
          'x-authfn-csrf': currentCsrf!
        },
        body: JSON.stringify({
          code: generateTotp(enrollBody.data.secret, clock.now())
        })
      })
    );
    expect(disable.status).toBe(200);
    expect((await disable.json()).data).toEqual({ disabled: true });

    const postDisable = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    expect(postDisable.status).toBe(200);
    expect((await postDisable.json()).data.session.methods).toEqual(['password']);
  });

  it('accepts valid TOTP codes without relying on adapter update re-read semantics', async () => {
    const clock = createClock();
    const twoFactorConfig = createTwoFactorPluginConfig(clock);
    const config: AuthFnRuntimeConfig = {
      database: createPrismaStyleUpdateWrapper(memoryAdapter({ debug: false })),
      namespace: 'authfn',
      plugins: [
        authFnPasswordPlugin(),
        authFnTwoFactorPlugin()
      ],
      pluginRuntime: {
        twoFactor: twoFactorConfig
      }
    };

    const user = await createUser(config, {
      primaryEmail: 'adapter-compat@example.com'
    });
    const created = await createTwoFactorEnrollment(config, user, twoFactorConfig);

    await expect(
      confirmTwoFactorEnrollment(
        config,
        user.id,
        generateTotp(created.secret, clock.now()),
        twoFactorConfig
      )
    ).resolves.toMatchObject({
      userId: user.id
    });

    clock.advanceSeconds(30);
    await expect(
      verifyTwoFactorCode(
        config,
        user.id,
        generateTotp(created.secret, clock.now()),
        twoFactorConfig
      )
    ).resolves.toEqual({
      usedRecoveryCode: false
    });
  });

  it('supports confirming and satisfying 2fa with deterministic recovery/session helpers', async () => {
    const clock = createClock();
    const config = createConfig(clock);
    const auth = createTestServer(config);
    const user = await createUser(config, {
      primaryEmail: 'bea@example.com'
    });
    const issued = await issueSession(config, {}, {
      request: new Request('https://account.example.com/auth/session'),
      userId: user.id,
      primaryEmail: user.primaryEmail,
      methods: ['password']
    });
    const cookieHeader = cookieHeaderFromSetCookies(
      Object.values(issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken))
    );

    const enroll = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/enroll', {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'x-authfn-csrf': issued.csrfToken
        }
      })
    );
    const enrollBody = await enroll.json();

    const confirm = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/confirm', {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'content-type': 'application/json',
          'x-authfn-csrf': issued.csrfToken
        },
        body: JSON.stringify({
          code: generateTotp(enrollBody.data.secret, clock.now())
        })
      })
    );
    expect(confirm.status).toBe(200);
  });

  it('defaults to ten recovery codes when no override is provided', async () => {
    const auth = createTestServer({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnPasswordPlugin(),
        authFnTwoFactorPlugin()
      ],
      pluginRuntime: {
        twoFactor: {
          issuer: 'authfn-tests',
          now: createClock().now,
          encryptionKeyResolver: () => TEST_2FA_KEY
        }
      }
    });

    const signUp = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ten@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    const signUpCookies = signUp.headers.getSetCookie();
    const cookieHeader = cookieHeaderFromSetCookies(signUpCookies);
    const csrfCookie = signUpCookies.find((cookie) => cookie.startsWith('authfn.csrf='));
    const csrfToken = csrfCookie?.slice('authfn.csrf='.length, csrfCookie.indexOf(';'));

    const enroll = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/enroll', {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'x-authfn-csrf': csrfToken!
        }
      })
    );
    expect(enroll.status).toBe(200);
    expect((await enroll.json()).data.recoveryCodes).toHaveLength(10);
  });

  it('requires an explicit two-factor encryption key resolver', async () => {
    const auth = createTestServer({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnPasswordPlugin(),
        authFnTwoFactorPlugin()
      ],
      pluginRuntime: {
        twoFactor: {
          issuer: 'authfn-tests',
          now: () => TEST_NOW
        }
      }
    });

    const signUp = await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );
    const signUpCookies = signUp.headers.getSetCookie();
    const cookieHeader = cookieHeaderFromSetCookies(signUpCookies);
    const csrfToken = signUpCookies
      .find((cookie) => cookie.startsWith('authfn.csrf='))
      ?.slice('authfn.csrf='.length, signUpCookies.find((cookie) => cookie.startsWith('authfn.csrf='))?.indexOf(';') ?? -1);

    const enroll = await auth.router.handle(
      new Request('https://account.example.com/auth/2fa/enroll', {
        method: 'POST',
        headers: {
          cookie: cookieHeader,
          'x-authfn-csrf': csrfToken!
        }
      })
    );

    expect(enroll.status).toBe(400);
    expect(await enroll.json()).toMatchObject({
      error: {
        code: 'AUTHFN_CONFIG_INVALID'
      }
    });
  });
});

describe('two-factor failed-attempt limit and recovery codes (AF-07)', () => {
  async function enrolledUser(extra: Record<string, unknown> = {}) {
    const clock = createClock();
    const config = createConfig(clock);
    Object.assign(config.pluginRuntime!.twoFactor as Record<string, unknown>, extra);
    const auth = createTestServer(config);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => auth.router.handle(
      new Request(`https://account.example.com/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
      })
    );
    const signUp = await post('/sign-up/password', { email: 'ada@example.com', password: 'Sup3rSecurePassphrase!' });
    const cookies = signUp.headers.getSetCookie();
    const cookie = cookieHeaderFromSetCookies(cookies);
    const csrfCookie = cookies.find((value) => value.startsWith('authfn.csrf='))!;
    const csrf = csrfCookie.slice('authfn.csrf='.length, csrfCookie.indexOf(';'));
    const enroll = await (await post('/2fa/enroll', {}, { cookie, 'x-authfn-csrf': csrf })).json();
    const secret = enroll.data.secret as string;
    await post('/2fa/confirm', { code: generateTotp(secret, clock.now()) }, { cookie, 'x-authfn-csrf': csrf });
    clock.advanceSeconds(30);
    const challenge = async () => {
      const gated = await post('/sign-in/password', { email: 'ada@example.com', password: 'Sup3rSecurePassphrase!' });
      return (await gated.json()).error.details.challengeId as string;
    };
    // A code that no time step from 30 seconds before to 3 minutes after
    // `now` produces, so it stays wrong even when a test moves the clock on.
    const wrongCode = (now: Date) => {
      const accepted = [-30, 0, 30, 60, 90, 120, 150, 180]
        .map((offset) => generateTotp(secret, new Date(now.getTime() + offset * 1000)));
      return ['000000', '111111', '222222', '333333'].find((candidate) => !accepted.includes(candidate))!;
    };
    const enrollment = await config.database.findOne<{ id: string; userId: string }>({
      model: 'two_factor_enrollments',
      where: [{ field: 'confirmedAt', operator: 'ne', value: null }],
      namespace: 'authfn'
    });
    return {
      config,
      clock,
      post,
      secret,
      recoveryCodes: enroll.data.recoveryCodes as string[],
      challenge,
      wrongCode,
      userId: enrollment!.userId,
      enrollmentId: enrollment!.id,
      pluginConfig: config.pluginRuntime!.twoFactor as TwoFactorPluginRuntimeConfig
    };
  }

  it('locks the enrollment after the limit of wrong codes, across new challenges', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 4, lockoutSeconds: 600 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // A new sign-in challenge each time: the count belongs to the enrollment.
      const response = await setup.post('/2fa/challenge', {
        challengeId: await setup.challenge(),
        code: setup.wrongCode(setup.clock.now())
      });
      expect(response.status).toBe(400);
    }
    const locked = await setup.post('/2fa/challenge', {
      challengeId: await setup.challenge(),
      code: generateTotp(setup.secret, setup.clock.now())
    });
    expect(locked.status).toBe(429);
    const body = await locked.json();
    expect(body.error.code).toBe('AUTHFN_RATE_LIMITED');
    expect(body.error.details).toMatchObject({ scope: 'two-factor', resetAt: '2026-03-22T00:10:30.000Z' });

    setup.clock.advanceSeconds(600);
    const unlocked = await setup.post('/2fa/challenge', {
      challengeId: await setup.challenge(),
      code: generateTotp(setup.secret, setup.clock.now())
    });
    expect(unlocked.status).toBe(200);
  });

  it('clears the count after a correct code', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 3 });
    for (let round = 0; round < 3; round += 1) {
      expect((await setup.post('/2fa/challenge', {
        challengeId: await setup.challenge(),
        code: setup.wrongCode(setup.clock.now())
      })).status).toBe(400);
      setup.clock.advanceSeconds(30);
      expect((await setup.post('/2fa/challenge', {
        challengeId: await setup.challenge(),
        code: generateTotp(setup.secret, setup.clock.now())
      })).status).toBe(200);
    }
  });

  it('compares at most the limit of codes when wrong codes arrive concurrently', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 3 });
    const challengeIds = await Promise.all(Array.from({ length: 10 }, () => setup.challenge()));
    const responses = await Promise.all(challengeIds.map((challengeId) => setup.post('/2fa/challenge', {
      challengeId,
      code: setup.wrongCode(setup.clock.now())
    })));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 400).length).toBeLessThanOrEqual(3);
    expect(statuses.every((status) => status === 400 || status === 429)).toBe(true);
  });

  it('lets one recovery code finish only one of two concurrent challenges', async () => {
    const setup = await enrolledUser();
    const [first, second] = await Promise.all([setup.challenge(), setup.challenge()]);
    const responses = await Promise.all([first, second].map((challengeId) => setup.post('/2fa/challenge', {
      challengeId,
      code: setup.recoveryCodes[0]
    })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    // The losing challenge was given back, so another valid code finishes it.
    const loser = responses[0].status === 400 ? first : second;
    setup.clock.advanceSeconds(30);
    expect((await setup.post('/2fa/challenge', {
      challengeId: loser,
      code: generateTotp(setup.secret, setup.clock.now())
    })).status).toBe(200);
  });

  it('issues 80-bit recovery codes and still accepts codes stored before them', async () => {
    const setup = await enrolledUser();
    expect(setup.recoveryCodes[0]).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}-[0-9A-F]{5}$/);

    const enrollment = await setup.config.database.findOne<{ id: string }>({
      model: 'two_factor_enrollments',
      where: [{ field: 'confirmedAt', operator: 'ne', value: null }],
      namespace: 'authfn'
    });
    const { createHash } = await import('node:crypto');
    await setup.config.database.create({
      model: 'two_factor_recovery_codes',
      data: {
        id: 'recovery_test_legacy',
        enrollmentId: enrollment!.id,
        codeHash: createHash('sha256').update('ABCDE12345').digest('hex'),
        usedAt: null,
        createdAt: new Date()
      },
      namespace: 'authfn'
    });
    const response = await setup.post('/2fa/challenge', { challengeId: await setup.challenge(), code: 'abcde-12345' });
    expect(response.status).toBe(200);
  });

  it.each([
    ['maxFailedAttempts', 0],
    ['maxFailedAttempts', -1],
    ['maxFailedAttempts', 2.5],
    ['maxFailedAttempts', 1001],
    ['lockoutSeconds', 0],
    ['lockoutSeconds', 59],
    ['lockoutSeconds', 1e12]
  ])('refuses %s = %s when the server is set up', (field, value) => {
    const config = createConfig();
    Object.assign(config.pluginRuntime!.twoFactor as Record<string, unknown>, { [field]: value });
    expect(() => createTestServer(config)).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
  });

  it('does not let a request that read the count before a lock check a code during it', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 3 });
    const paused = pausingAdapter(setup.config.database);
    const config = { ...setup.config, database: paused.adapter };
    const wrong = setup.wrongCode(setup.clock.now());
    const verify = (target: AuthFnRuntimeConfig, code: string) =>
      verifyTwoFactorCode(target, setup.userId, code, setup.pluginConfig).then(() => 'ok', (error) => error.code);

    // This request reads the count, then waits before writing its attempt.
    const reached = paused.pauseNext((params) =>
      params.model === 'two_factor_enrollments' && 'failedAttemptCount' in params.data);
    const stale = verify(config, wrong);
    await reached;
    // Meanwhile three wrong codes use the run and lock the enrollment.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await verify(setup.config, wrong)).toBe('AUTHFN_2FA_INVALID_CODE');
    }
    paused.release();
    expect(await stale).toBe('AUTHFN_RATE_LIMITED');
    expect(await verify(setup.config, generateTotp(setup.secret, setup.clock.now()))).toBe('AUTHFN_RATE_LIMITED');
  });

  it('keeps a lock set after a correct code was checked but before its count was reset', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 3 });
    const paused = pausingAdapter(setup.config.database);
    const config = { ...setup.config, database: paused.adapter };
    const verify = (target: AuthFnRuntimeConfig, code: string) =>
      verifyTwoFactorCode(target, setup.userId, code, setup.pluginConfig).then(() => 'ok', (error) => error.code);

    // The correct code is checked, then its reset waits.
    const reached = paused.pauseNext((params) =>
      params.model === 'two_factor_enrollments' && params.data.lockedUntil === null);
    const correct = verify(config, generateTotp(setup.secret, setup.clock.now()));
    await reached;
    const wrong = setup.wrongCode(setup.clock.now());
    expect(await verify(setup.config, wrong)).toBe('AUTHFN_2FA_INVALID_CODE');
    expect(await verify(setup.config, wrong)).toBe('AUTHFN_2FA_INVALID_CODE');
    paused.release();
    expect(await correct).toBe('ok');
    // The correct code's check and the two wrong ones after it make a run of
    // three and lock the enrollment; the late reset must not lift that lock.
    setup.clock.advanceSeconds(30);
    expect(await verify(setup.config, generateTotp(setup.secret, setup.clock.now()))).toBe('AUTHFN_RATE_LIMITED');
  });

  it('starts a fresh run when the limit is lowered after a success', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 10 });
    // The confirm ended a run under a limit of 10; the server now allows 3.
    Object.assign(setup.pluginConfig, { maxFailedAttempts: 3 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(verifyTwoFactorCode(setup.config, setup.userId, setup.wrongCode(setup.clock.now()), setup.pluginConfig))
        .rejects.toMatchObject({ code: 'AUTHFN_2FA_INVALID_CODE' });
    }
    await expect(verifyTwoFactorCode(setup.config, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .resolves.toEqual({ usedRecoveryCode: false });
  });

  it('does not count an attempt when the secret cannot be read', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 1 });
    const resolver = setup.pluginConfig.encryptionKeyResolver;
    Object.assign(setup.pluginConfig, {
      encryptionKeyResolver: () => {
        throw new Error('test key service unavailable');
      }
    });
    await expect(verifyTwoFactorCode(setup.config, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .rejects.toThrow(/Key material unavailable|test key service unavailable/);
    Object.assign(setup.pluginConfig, { encryptionKeyResolver: resolver });
    // With a limit of 1, a counted attempt would have locked the enrollment.
    await expect(verifyTwoFactorCode(setup.config, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .resolves.toEqual({ usedRecoveryCode: false });
  });

  it('does not finish a challenge that expires before it is claimed', async () => {
    const setup = await enrolledUser();
    const challengeId = await setup.challenge();
    // The request is slow after reading the challenge: it expires meanwhile.
    const slow: Adapter = {
      ...setup.config.database,
      async findOne(params) {
        const row = await setup.config.database.findOne(params);
        if (params.model === 'two_factor_enrollments') {
          setup.clock.advanceSeconds(3600);
        }
        return row;
      }
    } as Adapter;
    await expect(satisfyTwoFactorChallenge({ ...setup.config, database: slow }, challengeId, setup.recoveryCodes[0], setup.pluginConfig))
      .rejects.toMatchObject({ code: 'AUTHFN_2FA_INVALID_CODE' });
    // The recovery code was not spent on the expired challenge.
    expect((await setup.post('/2fa/challenge', {
      challengeId: await setup.challenge(),
      code: setup.recoveryCodes[0]
    })).status).toBe(200);
  });

  it('keeps the challenge used when the TOTP step write may have applied', async () => {
    const setup = await enrolledUser();
    let failStep = true;
    const lost = (params: { model: string; data: Record<string, unknown> }) =>
      failStep && params.model === 'two_factor_enrollments' && 'lastUsedCounter' in params.data;
    const failing: Adapter = {
      ...setup.config.database,
      async update(params) {
        const row = await setup.config.database.update(params);
        if (lost(params)) {
          failStep = false;
          throw new Error('test step write response lost');
        }
        return row;
      },
      async updateMany(params) {
        const count = await setup.config.database.updateMany(params);
        if (lost(params)) {
          failStep = false;
          throw new Error('test step write response lost');
        }
        return count;
      }
    } as Adapter;
    const challengeId = await setup.challenge();
    await expect(satisfyTwoFactorChallenge({ ...setup.config, database: failing }, challengeId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .rejects.toThrow('test step write response lost');
    // The step may have been used, so the challenge is not given back: a
    // recovery code cannot finish it.
    expect((await setup.post('/2fa/challenge', { challengeId, code: setup.recoveryCodes[0] })).status).toBe(400);
  });

  it('dates a lock from when it is written, not from when the request started', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 1, lockoutSeconds: 60 });
    // The request is slow between loading the enrollment and reserving its
    // attempt: two minutes pass.
    let reads = 0;
    const slow: Adapter = {
      ...setup.config.database,
      async findOne(params) {
        const row = await setup.config.database.findOne(params);
        if (params.model === 'two_factor_enrollments' && (reads += 1) === 2) {
          setup.clock.advanceSeconds(120);
        }
        return row;
      }
    } as Adapter;
    const config = { ...setup.config, database: slow };
    await expect(verifyTwoFactorCode(config, setup.userId, setup.wrongCode(setup.clock.now()), setup.pluginConfig))
      .rejects.toMatchObject({ code: 'AUTHFN_2FA_INVALID_CODE' });
    await expect(verifyTwoFactorCode(setup.config, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
  });

  it('accepts a correct code when updateMany reports no rows for writes it made', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 2 });
    const reportsZero: Adapter = {
      ...setup.config.database,
      async updateMany(params) {
        await setup.config.database.updateMany(params);
        return 0;
      }
    } as Adapter;
    const config = { ...setup.config, database: reportsZero };
    for (let round = 0; round < 3; round += 1) {
      setup.clock.advanceSeconds(30);
      await expect(verifyTwoFactorCode(config, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
        .resolves.toEqual({ usedRecoveryCode: false });
    }
    await expect(verifyTwoFactorCode(config, setup.userId, setup.recoveryCodes[0], setup.pluginConfig))
      .resolves.toEqual({ usedRecoveryCode: true });
  });

  it('checks no code when the adapter cannot confirm the attempt was counted', async () => {
    const setup = await enrolledUser();
    const unconfirmed: Adapter = {
      ...setup.config.database,
      capabilities: {
        ...setup.config.database.capabilities,
        operations: { ...setup.config.database.capabilities.operations, returning: false }
      },
      async updateMany() {
        return Number.NaN;
      }
    } as Adapter;
    const config = { ...setup.config, database: unconfirmed };
    setup.clock.advanceSeconds(30);
    await expect(verifyTwoFactorCode(config, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
  });

  it('keeps recovery codes working while TOTP codes are locked', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await setup.post('/2fa/challenge', {
        challengeId: await setup.challenge(),
        code: setup.wrongCode(setup.clock.now())
      })).status).toBe(400);
    }
    expect((await setup.post('/2fa/challenge', {
      challengeId: await setup.challenge(),
      code: generateTotp(setup.secret, setup.clock.now())
    })).status).toBe(429);
    expect((await setup.post('/2fa/challenge', {
      challengeId: await setup.challenge(),
      code: setup.recoveryCodes[0]
    })).status).toBe(200);
  });

  it('treats an all-digit legacy recovery code as a recovery code when TOTP codes have as many digits', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 1 });
    const { createHash } = await import('node:crypto');
    await setup.config.database.create({
      model: 'two_factor_recovery_codes',
      data: {
        id: 'recovery_test_numeric',
        enrollmentId: setup.enrollmentId,
        codeHash: createHash('sha256').update('1234509876').digest('hex'),
        usedAt: null,
        createdAt: new Date()
      },
      namespace: 'authfn'
    });
    const tenDigits = { ...setup.pluginConfig, digits: 10 };
    // Lock TOTP first: the recovery code must still work.
    await expect(verifyTwoFactorCode(setup.config, setup.userId, '0000000000', tenDigits))
      .rejects.toMatchObject({ code: 'AUTHFN_2FA_INVALID_CODE' });
    await expect(verifyTwoFactorCode(setup.config, setup.userId, '12345-09876', tenDigits))
      .resolves.toEqual({ usedRecoveryCode: true });
  });

  it('keeps a TOTP code usable when its request loses the challenge to another one', async () => {
    const setup = await enrolledUser();
    const paused = pausingAdapter(setup.config.database);
    const config = { ...setup.config, database: paused.adapter };
    const challengeId = await setup.challenge();
    const totp = generateTotp(setup.secret, setup.clock.now());

    // The TOTP request waits at its attempt reservation while a recovery
    // code finishes the same challenge.
    const reached = paused.pauseNext((params) =>
      params.model === 'two_factor_enrollments' && 'failedAttemptCount' in params.data);
    const slow = satisfyTwoFactorChallenge(config, challengeId, totp, setup.pluginConfig)
      .then(() => 'ok', (error) => error.code);
    await reached;
    expect((await setup.post('/2fa/challenge', { challengeId, code: setup.recoveryCodes[0] })).status).toBe(200);
    paused.release();
    expect(await slow).toBe('AUTHFN_2FA_INVALID_CODE');

    // The TOTP code was not spent, so it finishes a new sign-in.
    expect((await setup.post('/2fa/challenge', { challengeId: await setup.challenge(), code: totp })).status).toBe(200);
  });

  it('does not let a TOTP code replayed by a stale request end the run of attempts', async () => {
    const setup = await enrolledUser({ maxFailedAttempts: 3 });
    const wrong = setup.wrongCode(setup.clock.now());
    const verify = (code: string) =>
      verifyTwoFactorCode(setup.config, setup.userId, code, setup.pluginConfig).then(() => 'ok', (error) => error.code);
    expect(await verify(wrong)).toBe('AUTHFN_2FA_INVALID_CODE');
    expect(await verify(wrong)).toBe('AUTHFN_2FA_INVALID_CODE');

    // A sign-in with the current code waits at its attempt reservation while
    // the same code is used elsewhere.
    const paused = pausingAdapter(setup.config.database);
    const config = { ...setup.config, database: paused.adapter };
    const totp = generateTotp(setup.secret, setup.clock.now());
    const challengeId = await setup.challenge();
    const reached = paused.pauseNext((params) =>
      params.model === 'two_factor_enrollments' && 'failedAttemptCount' in params.data);
    const stale = satisfyTwoFactorChallenge(config, challengeId, totp, setup.pluginConfig)
      .then(() => 'ok', (error) => error.code);
    await reached;
    expect(await verify(totp)).toBe('ok');
    paused.release();
    expect(await stale).toBe('AUTHFN_2FA_INVALID_CODE');

    // The replay counted as an attempt and did not start a new run: two more
    // wrong codes complete the run and lock the enrollment.
    expect(await verify(wrong)).toBe('AUTHFN_2FA_INVALID_CODE');
    expect(await verify(wrong)).toBe('AUTHFN_2FA_INVALID_CODE');
    setup.clock.advanceSeconds(30);
    expect(await verify(generateTotp(setup.secret, setup.clock.now()))).toBe('AUTHFN_RATE_LIMITED');
  });

  it('keeps the challenge used when spending a recovery code throws', async () => {
    const setup = await enrolledUser();
    let failSpend = true;
    const failing: Adapter = {
      ...setup.config.database,
      async update(params) {
        if (failSpend && params.model === 'two_factor_recovery_codes') {
          failSpend = false;
          throw new Error('test recovery code write failed');
        }
        return setup.config.database.update(params);
      },
      async updateMany(params) {
        if (failSpend && params.model === 'two_factor_recovery_codes') {
          failSpend = false;
          throw new Error('test recovery code write failed');
        }
        return setup.config.database.updateMany(params);
      }
    } as Adapter;
    const challengeId = await setup.challenge();
    await expect(satisfyTwoFactorChallenge({ ...setup.config, database: failing }, challengeId, setup.recoveryCodes[0], setup.pluginConfig))
      .rejects.toThrow('test recovery code write failed');
    // The write's outcome was unknown, so the challenge is not given back;
    // the user signs in again.
    setup.clock.advanceSeconds(30);
    expect((await setup.post('/2fa/challenge', {
      challengeId,
      code: generateTotp(setup.secret, setup.clock.now())
    })).status).toBe(400);
    expect((await setup.post('/2fa/challenge', {
      challengeId: await setup.challenge(),
      code: setup.recoveryCodes[0]
    })).status).toBe(200);
  });

  it('keeps the challenge used when a failed recovery-code spend may have applied', async () => {
    const setup = await enrolledUser();
    let loseResponse = true;
    const lossy: Adapter = {
      ...setup.config.database,
      async update(params) {
        const row = await setup.config.database.update(params);
        if (loseResponse && params.model === 'two_factor_recovery_codes') {
          loseResponse = false;
          throw new Error('test response lost after the write');
        }
        return row;
      },
      async updateMany(params) {
        const count = await setup.config.database.updateMany(params);
        if (loseResponse && params.model === 'two_factor_recovery_codes') {
          loseResponse = false;
          throw new Error('test response lost after the write');
        }
        return count;
      }
    } as Adapter;
    const challengeId = await setup.challenge();
    await expect(satisfyTwoFactorChallenge({ ...setup.config, database: lossy }, challengeId, setup.recoveryCodes[0], setup.pluginConfig))
      .rejects.toThrow('test response lost after the write');
    // The code was spent, so a second code cannot be spent on this challenge.
    expect((await setup.post('/2fa/challenge', { challengeId, code: setup.recoveryCodes[1] })).status).toBe(400);
    const unused = await setup.config.database.findMany<{ usedAt: Date | null }>({
      model: 'two_factor_recovery_codes',
      where: [{ field: 'enrollmentId', operator: 'eq', value: setup.enrollmentId }],
      namespace: 'authfn'
    });
    expect(unused.filter((code) => code.usedAt).length).toBe(1);
  });

  it('keeps the challenge used when the adapter cannot report whether a recovery code was spent', async () => {
    const setup = await enrolledUser();
    const unreported: Adapter = {
      ...setup.config.database,
      capabilities: {
        ...setup.config.database.capabilities,
        operations: { ...setup.config.database.capabilities.operations, returning: false }
      },
      async updateMany(params) {
        const count = await setup.config.database.updateMany(params);
        return params.model === 'two_factor_recovery_codes' ? Number.NaN : count;
      }
    } as Adapter;
    const challengeId = await setup.challenge();
    await expect(satisfyTwoFactorChallenge({ ...setup.config, database: unreported }, challengeId, setup.recoveryCodes[0], setup.pluginConfig))
      .rejects.toMatchObject({ code: 'AUTHFN_2FA_INVALID_CODE' });
    expect((await setup.post('/2fa/challenge', { challengeId, code: setup.recoveryCodes[1] })).status).toBe(400);
  });

  it('counts at most one attempt when the adapter cannot report whether the attempt was counted', async () => {
    const setup = await enrolledUser();
    const unreported: Adapter = {
      ...setup.config.database,
      capabilities: {
        ...setup.config.database.capabilities,
        operations: { ...setup.config.database.capabilities.operations, returning: false }
      },
      async updateMany(params) {
        const count = await setup.config.database.updateMany(params);
        return params.model === 'two_factor_enrollments' && 'failedAttemptCount' in params.data ? Number.NaN : count;
      }
    } as Adapter;
    const readCount = async () => (await setup.config.database.findOne<{ failedAttemptCount: number | null }>({
      model: 'two_factor_enrollments',
      where: [{ field: 'id', operator: 'eq', value: setup.enrollmentId }],
      namespace: 'authfn'
    }))?.failedAttemptCount ?? 0;
    const before = await readCount();
    setup.clock.advanceSeconds(30);
    await expect(verifyTwoFactorCode({ ...setup.config, database: unreported }, setup.userId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig))
      .rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
    expect(await readCount()).toBe(before + 1);
  });

  it('accepts a TOTP code whose time step ends while its challenge is being claimed', async () => {
    const setup = await enrolledUser({ window: 0 });
    const paused = pausingAdapter(setup.config.database);
    const config = { ...setup.config, database: paused.adapter };
    setup.clock.advanceSeconds(30);
    const challengeId = await setup.challenge();
    const reached = paused.pauseNext((params) =>
      params.model === 'two_factor_challenges' && params.data.consumedAt instanceof Date);
    const finishing = satisfyTwoFactorChallenge(config, challengeId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig)
      .then(() => 'ok', (error) => error.code);
    await reached;
    setup.clock.advanceSeconds(30);
    paused.release();
    expect(await finishing).toBe('ok');
  });

  it('does not record a code from a secret that was replaced while the sign-in was in flight', async () => {
    const setup = await enrolledUser();
    const paused = pausingAdapter(setup.config.database);
    const config = { ...setup.config, database: paused.adapter };
    setup.clock.advanceSeconds(30);
    const challengeId = await setup.challenge();
    const reached = paused.pauseNext((params) =>
      params.model === 'two_factor_challenges' && params.data.consumedAt instanceof Date);
    const finishing = satisfyTwoFactorChallenge(config, challengeId, generateTotp(setup.secret, setup.clock.now()), setup.pluginConfig)
      .then(() => 'ok', (error) => error.code);
    await reached;
    // Meanwhile the user disables 2FA and enrolls again: a new enrollment
    // with a new secret.
    await setup.config.database.delete({
      model: 'two_factor_enrollments',
      where: [{ field: 'id', operator: 'eq', value: setup.enrollmentId }],
      namespace: 'authfn'
    });
    const now = setup.clock.now();
    await setup.config.database.create({
      model: 'two_factor_enrollments',
      data: {
        id: 'tfe_test_replacement', userId: setup.userId, secretEncrypted: 'test-replacement-secret',
        lastUsedCounter: null, failedAttemptCount: null, lockedUntil: null, confirmedAt: now, createdAt: now, updatedAt: now
      },
      namespace: 'authfn'
    });
    paused.release();
    expect(await finishing).toBe('AUTHFN_2FA_INVALID_CODE');
  });

  it('adds the attempt-limit columns to a schema override written for an earlier version', () => {
    const defaults = getSchema(createConfig()).schemas.find((table) => table.modelName === 'two_factor_enrollments')!;
    const { failedAttemptCount: _count, lockedUntil: _locked, ...older } = defaults.fields;
    const override = getSchema(createConfig()).schemas
      .filter((table) => table.modelName.startsWith('two_factor_'))
      .map((table) => table.modelName === 'two_factor_enrollments'
        ? { ...table, fields: { ...older, secretEncrypted: { ...older.secretEncrypted!, fieldName: 'test_custom_secret' } } }
        : table);
    const config = createConfig();
    config.plugins = [authFnPasswordPlugin(), authFnTwoFactorPlugin({ schema: override })];
    const enrollments = getSchema(config).schemas.find((table) => table.modelName === 'two_factor_enrollments')!;
    expect(enrollments.fields.failedAttemptCount).toMatchObject({ fieldName: 'failed_attempt_count', required: false });
    expect(enrollments.fields.lockedUntil).toMatchObject({ fieldName: 'locked_until', required: false });
    expect(enrollments.fields.secretEncrypted).toMatchObject({ fieldName: 'test_custom_secret' });
  });

  it('spends one recovery code when two arrive for the same challenge', async () => {
    const setup = await enrolledUser();
    const challengeId = await setup.challenge();
    const responses = await Promise.all(setup.recoveryCodes.slice(0, 2).map((code) =>
      setup.post('/2fa/challenge', { challengeId, code })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const used = await setup.config.database.findMany<{ usedAt: Date | null }>({
      model: 'two_factor_recovery_codes',
      where: [{ field: 'enrollmentId', operator: 'eq', value: setup.enrollmentId }],
      namespace: 'authfn'
    });
    expect(used.filter((code) => code.usedAt).length).toBe(1);
  });
});

/**
 * Wraps an adapter so one chosen write waits until the test releases it,
 * standing in for a request that is slow to reach the database.
 */
function pausingAdapter(base: Adapter) {
  type WriteParams = { model: string; data: Record<string, unknown> };
  let match: ((params: WriteParams) => boolean) | null = null;
  let arrived: () => void = () => {};
  let release: () => void = () => {};
  const wrap = <T>(write: (params: never) => Promise<T>) => async (params: WriteParams): Promise<T> => {
    if (match?.(params)) {
      match = null;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      arrived();
      await released;
    }
    return write(params as never);
  };
  return {
    adapter: {
      ...base,
      update: wrap(base.update.bind(base)),
      updateMany: wrap(base.updateMany.bind(base))
    } as Adapter,
    pauseNext(predicate: (params: WriteParams) => boolean): Promise<void> {
      match = predicate;
      return new Promise<void>((resolve) => {
        arrived = resolve;
      });
    },
    release: () => release()
  };
}
