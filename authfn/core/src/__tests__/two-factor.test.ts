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
  verifyTwoFactorCode
} from '../core/two-factor.js';
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
    // A code that no accepted time step (the current one and one on either
    // side) produces.
    const wrongCode = (now: Date) => {
      const accepted = [-30, 0, 30].map((offset) => generateTotp(secret, new Date(now.getTime() + offset * 1000)));
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
