import { describe, expect, it, vi } from 'vitest';
import { createTestServer } from './test-server.js';
import { NotFoundError } from '@superfunctions/db';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnEmailOtpPlugin } from '@authfn/email-otp';
import { authFnPasswordPlugin } from '@authfn/password';
import type {
  AuthFnDeliveryRequest,
  AuthFnEvent,
  AuthFnOtpChallengeLifecycleEvent,
  AuthFnRuntimeConfig
} from '../index.js';
import { signInWithPassword } from '../core/passwords.js';
import { createUser } from '../core/users.js';
import { getLatestOtpChallenge } from '../core/verifications.js';

// Counts constant-time comparisons: in the verify-email flow the only caller
// is the OTP code check, so this is the number of codes compared.
const codeComparisons = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (left: NodeJS.ArrayBufferView, right: NodeJS.ArrayBufferView) => {
      codeComparisons.count += 1;
      return actual.timingSafeEqual(left, right);
    }
  };
});

type AuthFnDatabase = AuthFnRuntimeConfig['database'];

/**
 * Wraps an adapter so the next `count` OTP challenge lookups all return before
 * any of them continues: every request reads the same stored attempt count
 * and then races on the write, the interleaving the attempt cap must survive.
 */
function holdOtpChallengeReads(adapter: AuthFnDatabase) {
  let expected = 0;
  let waiting: Array<() => void> = [];
  const held = new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (property !== 'findMany') {
        return value.bind(target);
      }
      return async (params: { model: string }) => {
        const rows = await value.call(target, params);
        if (expected > 0 && params.model === 'otp_challenges') {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === expected) {
              const release = waiting;
              expected = 0;
              waiting = [];
              release.forEach((resume) => resume());
            }
          });
        }
        return rows;
      };
    }
  });
  return {
    adapter: held,
    holdNextReads(count: number) {
      expected = count;
    }
  };
}

/**
 * Wraps an adapter so `update` behaves like the Prisma adapter and the MySQL
 * drizzle and kysely adapters: it writes, then re-selects with the original
 * where and reports NotFound when that where no longer matches the written row.
 */
function reselectUpdatesWithOriginalWhere(adapter: AuthFnDatabase): AuthFnDatabase {
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'update') {
        return async (params: Parameters<AuthFnDatabase['update']>[0]) => {
          await target.updateMany({
            model: params.model,
            where: params.where,
            data: params.data,
            namespace: params.namespace
          });
          const row = await target.findOne({
            model: params.model,
            where: params.where,
            namespace: params.namespace
          });
          if (!row) {
            throw new NotFoundError(params.model, params.where);
          }
          return row;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function createClock(start: Date = new Date('2026-03-22T00:00:00.000Z')) {
  let current = start;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    }
  };
}

function createDeliveryRecorder() {
  const codes = new Map<string, string>();
  const deliveries: AuthFnDeliveryRequest[] = [];
  const events: AuthFnOtpChallengeLifecycleEvent[] = [];

  return {
    provider: {
      async send(input: AuthFnDeliveryRequest) {
        codes.set(`${input.purpose}:${input.email}`, input.code);
        deliveries.push(input);
        return {
          sent: true,
          metadata: {
            channel: input.channel
          }
        };
      },
      async emit(event: AuthFnOtpChallengeLifecycleEvent) {
        events.push(event);
      }
    },
    codeFor(purpose: string, email: string) {
      return codes.get(`${purpose}:${email}`);
    },
    deliveries,
    events
  };
}

function createConfig(overrides?: Partial<AuthFnRuntimeConfig>): AuthFnRuntimeConfig {
  const clock = createClock();
  const delivery = createDeliveryRecorder();

  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [
      authFnPasswordPlugin(),
      authFnEmailOtpPlugin()
    ],
    pluginRuntime: {
      password: {
        otp: {
          delivery: delivery.provider,
          now: clock.now,
          codeGenerator: () => '731942'
        }
      },
      emailOtp: {
        delivery: delivery.provider,
        now: clock.now,
        codeGenerator: () => '731942'
      }
    },
    ...(overrides ?? {})
  };

  return Object.assign(config, {
    __clock: clock,
    __delivery: delivery
  }) as AuthFnRuntimeConfig & {
    __clock: ReturnType<typeof createClock>;
    __delivery: ReturnType<typeof createDeliveryRecorder>;
  };
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.slice(0, cookie.indexOf(';')))
    .join('; ');
}

describe('authfn otp plugin', () => {
  it('sends and verifies verify-email OTP challenges exactly once', async () => {
    const config = createConfig() as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);
    const user = await createUser(config, {
      primaryEmail: 'ada@example.com'
    });

    const sendResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: 'ada@example.com'
        })
      })
    );
    expect(sendResponse.status).toBe(200);
    const sendBody = await sendResponse.json();
    expect(sendBody.data.sent).toBe(true);
    const challenge = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(challenge?.codeHash).not.toBe('731942');
    expect(challenge?.attemptCount).toBe(0);

    const verifyResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: 'ada@example.com',
          code: config.__delivery.codeFor('verify-email', 'ada@example.com')
        })
      })
    );
    expect(verifyResponse.status).toBe(200);
    expect(await verifyResponse.json()).toEqual({
      ok: true,
      data: {
        verified: true
      },
      requestId: expect.any(String)
    });

    const verifiedUser = await config.database.findOne({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: user.id }],
      namespace: 'authfn'
    });
    expect(verifiedUser?.emailVerifiedAt).toBeInstanceOf(Date);

    const replayResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: 'ada@example.com',
          code: config.__delivery.codeFor('verify-email', 'ada@example.com')
        })
      })
    );
    expect(replayResponse.status).toBe(409);
    expect((await replayResponse.json()).error.code).toBe('AUTHFN_OTP_REPLAYED');

    expect(config.__delivery.events).toEqual([
      expect.objectContaining({
        type: 'authfn.otp.sent',
        challengeId: challenge?.id,
        purpose: 'verify-email',
        email: 'ada@example.com',
        outcome: 'sent'
      }),
      expect.objectContaining({
        type: 'authfn.otp.verified',
        challengeId: challenge?.id,
        purpose: 'verify-email',
        email: 'ada@example.com',
        outcome: 'verified'
      })
    ]);
    expect(JSON.stringify(config.__delivery.events)).not.toContain('731942');
  });

  it('expires OTP challenges and rejects purpose mismatches for reset completion', async () => {
    const config = createConfig() as AuthFnRuntimeConfig & {
      __clock: ReturnType<typeof createClock>;
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);

    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: 'ada@example.com'
        })
      })
    );

    const mismatch = await auth.router.handle(
      new Request('https://account.example.com/auth/password/reset/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          code: config.__delivery.codeFor('verify-email', 'ada@example.com'),
          newPassword: 'An0therSecurePassphrase!'
        })
      })
    );
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.code).toBe('AUTHFN_OTP_INVALID');

    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: 'bea@example.com'
        })
      })
    );

    config.__clock.advance(60 * 10 * 1000 + 1);
    const expired = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: 'bea@example.com',
          code: config.__delivery.codeFor('verify-email', 'bea@example.com')
        })
      })
    );
    expect(expired.status).toBe(400);
    expect((await expired.json()).error.code).toBe('AUTHFN_OTP_EXPIRED');
  });

  it('rejects malformed JSON bodies with a validation error instead of a 500', async () => {
    const config = createConfig();
    const auth = createTestServer(config);

    const response = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"purpose":'
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('AUTHFN_VALIDATION_ERROR');
  });

  it('supports otp sign-in and reset-password completion', async () => {
    const config = createConfig() as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);

    await auth.router.handle(
      new Request('https://account.example.com/auth/sign-up/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          password: 'Sup3rSecurePassphrase!'
        })
      })
    );

    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-in',
          email: 'ada@example.com'
        })
      })
    );

    const signInOtp = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-in',
          email: 'ada@example.com',
          code: config.__delivery.codeFor('sign-in', 'ada@example.com')
        })
      })
    );
    expect(signInOtp.status).toBe(200);
    const signInOtpBody = await signInOtp.json();
    expect(signInOtpBody.data.session.methods).toEqual(['email-otp']);
    expect(signInOtp.headers.getSetCookie().length).toBe(2);

    const sessionResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/session', {
        headers: {
          cookie: cookieHeaderFromSetCookies(signInOtp.headers.getSetCookie())
        }
      })
    );
    expect((await sessionResponse.json()).data.session.methods).toEqual(['email-otp']);

    await auth.router.handle(
      new Request('https://account.example.com/auth/password/reset/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com'
        })
      })
    );

    const resetComplete = await auth.router.handle(
      new Request('https://account.example.com/auth/password/reset/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ada@example.com',
          code: config.__delivery.codeFor('reset-password', 'ada@example.com'),
          newPassword: 'An0therSecurePassphrase!'
        })
      })
    );
    expect(resetComplete.status).toBe(200);
    expect(await resetComplete.json()).toEqual({
      ok: true,
      data: {
        passwordUpdated: true
      },
      requestId: expect.any(String)
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
        primaryEmail: 'ada@example.com'
      }
    });
  });

  it('supports otp sign-up and issues a session for the new verified user', async () => {
    const hookCalls: string[] = [];
    const config = createConfig({
      hooks: {
        beforeUserCreate: async (_ctx, input) => {
          hookCalls.push('beforeUserCreate');
          return {
            ...input,
            metadata: {
              ...(input.metadata as Record<string, unknown>),
              source: 'otp-sign-up'
            }
          };
        },
        afterUserCreate: async (_ctx, user) => {
          hookCalls.push(`afterUserCreate:${String(user.primaryEmail)}`);
        }
      }
    }) as AuthFnRuntimeConfig & {
      __clock: ReturnType<typeof createClock>;
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);

    const sendResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'new-user@example.com'
        })
      })
    );
    expect(sendResponse.status).toBe(200);

    const verifyResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'new-user@example.com',
          code: config.__delivery.codeFor('sign-up', 'new-user@example.com'),
          profile: {
            name: 'New User'
          },
          sessionMode: 'hybrid'
        })
      })
    );

    expect(verifyResponse.status).toBe(200);
    const verifyBody = await verifyResponse.json();
    expect(verifyBody.data.token).toEqual(expect.any(String));
    expect(verifyBody.data.session.methods).toEqual(['email-otp']);
    expect(verifyResponse.headers.getSetCookie().length).toBe(2);

    const user = await config.database.findOne({
      model: 'users',
      where: [{ field: 'primaryEmail', operator: 'eq', value: 'new-user@example.com' }],
      namespace: 'authfn'
    });
    expect(user).toMatchObject({
      primaryEmail: 'new-user@example.com',
      metadata: {
        name: 'New User',
        source: 'otp-sign-up'
      }
    });
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(hookCalls).toEqual([
      'beforeUserCreate',
      'afterUserCreate:new-user@example.com'
    ]);

    config.__clock.advance(1);
    const duplicateSendResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'new-user@example.com'
        })
      })
    );
    expect(duplicateSendResponse.status).toBe(200);

    const duplicateVerifyResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'new-user@example.com',
          code: config.__delivery.codeFor('sign-up', 'new-user@example.com')
        })
      })
    );
    expect(duplicateVerifyResponse.status).toBe(409);
    expect((await duplicateVerifyResponse.json()).error.code).toBe('AUTHFN_CONFLICT');
  });

  it('can treat otp sign-up for an existing email as verified-email account linking', async () => {
    const events: AuthFnEvent[] = [];
    const config = createConfig({
      accountLinking: {
        otpSignUpExistingUser: true
      },
      observability: {
        events: {
          emit: (event) => events.push(event)
        }
      }
    }) as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);
    const user = await createUser(config, {
      primaryEmail: 'ada@example.com'
    });

    const sendResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'ada@example.com'
        })
      })
    );
    expect(sendResponse.status).toBe(200);

    const verifyResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'ada@example.com',
          code: config.__delivery.codeFor('sign-up', 'ada@example.com'),
          sessionMode: 'hybrid'
        })
      })
    );

    expect(verifyResponse.status).toBe(200);
    const body = await verifyResponse.json();
    expect(body.data.session.actorId).toBe(user.id);
    expect(body.data.session.methods).toEqual(['email-otp']);
    const linkedUser = await config.database.findOne({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: user.id }],
      namespace: 'authfn'
    });
    expect(linkedUser?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(events.some((event) => event.type === 'authfn.account_linked')).toBe(true);
  });

  it('does not duplicate an already verified existing user during otp sign-up linking', async () => {
    const config = createConfig({
      accountLinking: {
        otpSignUpExistingUser: true
      }
    }) as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);
    const verifiedAt = new Date('2026-03-22T00:00:00.000Z');
    const user = await createUser(config, {
      primaryEmail: 'verified@example.com',
      emailVerifiedAt: verifiedAt
    });

    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'verified@example.com'
        })
      })
    );

    const verifyResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-up',
          email: 'verified@example.com',
          code: config.__delivery.codeFor('sign-up', 'verified@example.com'),
          sessionMode: 'hybrid'
        })
      })
    );

    expect(verifyResponse.status).toBe(200);
    const body = await verifyResponse.json();
    expect(body.data.session.actorId).toBe(user.id);
    const users = await config.database.findMany({
      model: 'users',
      where: [{ field: 'primaryEmail', operator: 'eq', value: 'verified@example.com' }],
      namespace: 'authfn'
    });
    expect(users).toHaveLength(1);
    expect(users[0]?.id).toBe(user.id);
  });

  it('rejects otp sign-in for missing users before consuming the challenge', async () => {
    const config = createConfig() as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);

    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-in',
          email: 'missing@example.com'
        })
      })
    );

    const response = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'sign-in',
          email: 'missing@example.com',
          code: config.__delivery.codeFor('sign-in', 'missing@example.com')
        })
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('AUTHFN_OTP_INVALID');

    const challenge = await getLatestOtpChallenge(config, 'sign-in', 'missing@example.com');
    expect(challenge?.consumedAt).toBeNull();
    expect(challenge?.attemptCount).toBe(0);
  });

  it('applies beforeChallengeSend transformations and keeps afterChallengeSend fail-open', async () => {
    const delivery = createDeliveryRecorder();
    const seenContexts: Array<{ hasConfig: boolean; requestUrl?: string; baseUrl?: string }> = [];
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      hooks: {
        beforeChallengeSend: async (ctx, input) => {
          seenContexts.push({
            hasConfig: Boolean(ctx.config),
            requestUrl: ctx.request?.url,
            baseUrl: ctx.environment?.baseUrl
          });
          return {
            ...input,
            email: 'transformed@example.com',
            metadata: {
              source: 'hook'
            }
          };
        },
        afterChallengeSend: async () => {
          throw new Error('ignore me');
        }
      },
      plugins: [
        authFnEmailOtpPlugin()
      ],
      pluginRuntime: {
        emailOtp: {
          delivery: delivery.provider,
          codeGenerator: () => '731942',
          now: () => new Date('2026-03-22T00:00:00.000Z')
        }
      }
    };

    const auth = createTestServer(config);
    const response = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'verify-email',
          email: `${'a'.repeat(256)}@example.com`
        })
      })
    );
    expect(response.status).toBe(200);

    const stored = await getLatestOtpChallenge(config, 'verify-email', 'transformed@example.com');
    expect(stored?.deliveryMetadata).toEqual({
      source: 'hook',
      channel: 'email'
    });
    expect(delivery.deliveries[0]?.email).toBe('transformed@example.com');
    expect(seenContexts).toEqual([
      {
        hasConfig: true,
        requestUrl: 'https://account.example.com/auth/otp/send',
        baseUrl: 'https://account.example.com'
      }
    ]);
  });
  it('compares at most maxAttempts codes when wrong codes for one challenge arrive concurrently', async () => {
    const reads = holdOtpChallengeReads(memoryAdapter({ debug: false }));
    const config = createConfig({ database: reads.adapter }) as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    Object.assign(config.pluginRuntime!.emailOtp as Record<string, unknown>, { maxAttempts: 5 });
    const auth = createTestServer(config);
    const verify = (code: string) => auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com', code })
      })
    );

    await createUser(config, { primaryEmail: 'ada@example.com' });
    const sendResponse = await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com' })
      })
    );
    expect(sendResponse.status).toBe(200);
    const code = config.__delivery.codeFor('verify-email', 'ada@example.com')!;
    const wrongCode = code === '000000' ? '111111' : '000000';

    reads.holdNextReads(20);
    codeComparisons.count = 0;
    const responses = await Promise.all(Array.from({ length: 20 }, () => verify(wrongCode)));

    expect(codeComparisons.count).toBe(5);
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(400));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.map((body) => body.error.code)).toEqual(Array(20).fill('AUTHFN_OTP_INVALID'));
    const afterBurst = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(afterBurst?.attemptCount).toBeGreaterThanOrEqual(5);

    codeComparisons.count = 0;
    const correct = await verify(code);
    expect(correct.status).toBe(400);
    expect((await correct.json()).error.code).toBe('AUTHFN_OTP_INVALID');
    expect(codeComparisons.count).toBe(0);
    const afterCorrect = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(afterCorrect?.consumedAt).toBeNull();
  });
  it('verifies a correct code once when the same request is retried concurrently', async () => {
    const reads = holdOtpChallengeReads(memoryAdapter({ debug: false }));
    const config = createConfig({ database: reads.adapter }) as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);
    await createUser(config, { primaryEmail: 'ada@example.com' });
    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com' })
      })
    );
    const code = config.__delivery.codeFor('verify-email', 'ada@example.com')!;

    reads.holdNextReads(3);
    const responses = await Promise.all(Array.from({ length: 3 }, () => auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com', code })
      })
    )));

    const outcomes = await Promise.all(responses.map(async (response) => {
      const body = await response.json();
      return response.status === 200 ? 'verified' : body.error.code;
    }));
    expect(outcomes.sort()).toEqual(['AUTHFN_OTP_REPLAYED', 'AUTHFN_OTP_REPLAYED', 'verified']);
    const stored = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(stored?.consumedAt).not.toBeNull();
  });
  it('counts each verification once on adapters whose update re-selects with the original where', async () => {
    const config = createConfig({
      database: reselectUpdatesWithOriginalWhere(memoryAdapter({ debug: false }))
    }) as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    const auth = createTestServer(config);
    const verify = (code: string) => auth.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com', code })
      })
    );
    await createUser(config, { primaryEmail: 'ada@example.com' });
    await auth.router.handle(
      new Request('https://account.example.com/auth/otp/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com' })
      })
    );
    const code = config.__delivery.codeFor('verify-email', 'ada@example.com')!;
    const wrongCode = code === '000000' ? '111111' : '000000';

    codeComparisons.count = 0;
    const wrong = await verify(wrongCode);
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.code).toBe('AUTHFN_OTP_INVALID');
    expect(codeComparisons.count).toBe(1);
    const afterWrong = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(afterWrong?.attemptCount).toBe(1);

    codeComparisons.count = 0;
    const correct = await verify(code);
    expect(correct.status).toBe(200);
    const body = await correct.json();
    expect(body.data.verified).toBe(true);
    expect(codeComparisons.count).toBe(1);
    const afterCorrect = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(afterCorrect?.attemptCount).toBe(2);
    expect(afterCorrect?.consumedAt).not.toBeNull();
  });
});
