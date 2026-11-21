import { describe, expect, it, vi } from 'vitest';
import { createTestServer } from './test-server.js';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { NotFoundError } from '@superfunctions/db';
import { kyselyAdapter } from '@superfunctions/db/adapters';
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
import { getLatestOtpChallenge, resolveOtpEmailBudget, sendOtpChallenge, verifyOtpChallenge } from '../core/verifications.js';
import { getSchema } from '../schema.js';
import { AuthFnOtpReplayedError } from '../core/errors.js';

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

/** Reports the adapter's `update` as unable to return rows from the statement. */
function withoutReturning(capabilities: AuthFnDatabase['capabilities']): AuthFnDatabase['capabilities'] {
  return { ...capabilities, operations: { ...capabilities.operations, returning: false } };
}

/**
 * Wraps an adapter so `update` behaves like the Prisma adapter and the MySQL
 * drizzle and kysely adapters: it writes, then re-selects with the original
 * where and reports NotFound when that where no longer matches the written row.
 * Like them, it reports no RETURNING support.
 */
function reselectUpdatesWithOriginalWhere(adapter: AuthFnDatabase): AuthFnDatabase {
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'capabilities') {
        return withoutReturning(value);
      }
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

/**
 * Wraps an adapter so `updateMany` writes but reports no affected rows, as the
 * shipped Kysely adapter does on every dialect: it reads the count from the
 * array that Kysely's `execute()` returns.
 */
function updateManyReportsNoRows(adapter: AuthFnDatabase): AuthFnDatabase {
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'updateMany') {
        return async (params: Parameters<AuthFnDatabase['updateMany']>[0]) => {
          await target.updateMany(params);
          return 0;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/**
 * Wraps an adapter so it reports no RETURNING support and its `updateMany`
 * writes nothing and returns a count the driver could not report (NaN), as
 * the drizzle adapter's count normalisation can for an unknown driver.
 */
function updateManyWithoutCount(adapter: AuthFnDatabase): AuthFnDatabase {
  return new Proxy(adapter, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'capabilities') {
        return withoutReturning(value);
      }
      if (property === 'updateMany') {
        return async () => Number.NaN;
      }
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/**
 * The shipped Kysely adapter on an in-memory SQLite database, one column per
 * schema field. better-sqlite3 binds neither dates, booleans nor objects, so
 * they are written as ISO text, 0/1 and JSON text. The adapter's `create`
 * and its `update` without a selection fail on SQLite (`selectAll` on an
 * insert, `RETURNING "*"`), packages/db defects outside this issue, so inserts
 * go through Kysely and `update` on other models (the user the code verifies)
 * runs as `updateMany` and `findOne`. Every OTP challenge write and read is the
 * adapter's own.
 */
function kyselySqliteAdapter(config: AuthFnRuntimeConfig): AuthFnDatabase {
  const sqlite = new Database(':memory:');
  for (const table of getSchema(config).schemas) {
    const columns = Object.keys(table.fields).map((field) => `"${field}"${field === 'id' ? ' PRIMARY KEY' : ''}`);
    sqlite.exec(`CREATE TABLE "${table.modelName}" (${columns.join(', ')})`);
  }
  const db = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
  const kysely = kyselyAdapter({
    db,
    dialect: 'sqlite',
    schema: new Proxy({}, { get: (_, model) => model }) as Record<string, string>
  }) as AuthFnDatabase;
  const encode = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).map(([name, value]) => [
    name,
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'boolean'
        ? Number(value)
        : value !== null && typeof value === 'object' ? JSON.stringify(value) : value
  ]));
  const decode = <T>(row: T): T => (row && Object.fromEntries(Object.entries(row).map(([name, value]) => [
    name,
    typeof value === 'string' && /^[[{]/.test(value) ? JSON.parse(value) : value
  ]))) as T;
  return {
    ...kysely,
    create: async (params) => {
      await db.insertInto(params.model).values(encode(params.data)).execute();
      return params.data;
    },
    findOne: async (params) => decode(await kysely.findOne(params)),
    findMany: async (params) => (await kysely.findMany(params)).map(decode),
    update: async (params) => {
      if (params.model === 'otp_challenges') {
        return decode(await kysely.update({ ...params, data: encode(params.data) }));
      }
      await kysely.updateMany({ ...params, data: encode(params.data) });
      return decode(await kysely.findOne(params));
    },
    updateMany: (params) => kysely.updateMany({ ...params, data: encode(params.data) })
  } as AuthFnDatabase;
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
  it.each([
    [
      'update re-selects with the original where (Prisma, MySQL)',
      () => reselectUpdatesWithOriginalWhere(memoryAdapter({ debug: false }))
    ],
    [
      'updateMany writes but reports no rows (Kysely)',
      () => updateManyReportsNoRows(memoryAdapter({ debug: false }))
    ],
    ['the database is the shipped Kysely adapter on SQLite', kyselySqliteAdapter]
  ] as Array<[string, (config: AuthFnRuntimeConfig) => AuthFnDatabase]>)(
    'counts each verification once when %s',
    async (_adapter, createDatabase) => {
    const config = createConfig() as AuthFnRuntimeConfig & {
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };
    config.database = createDatabase(config);
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
    }
  );

  it('does not compare a code when the reservation write cannot be acknowledged', async () => {
    const config = createConfig() as AuthFnRuntimeConfig & {
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
    // The server was created first, so it keeps the plain adapter for sending;
    // verifying goes through a server on the wrapped adapter.
    const verifier = createTestServer({ ...config, database: updateManyWithoutCount(config.database) });

    codeComparisons.count = 0;
    const response = await verifier.router.handle(
      new Request('https://account.example.com/auth/otp/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'verify-email', email: 'ada@example.com', code })
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('AUTHFN_OTP_INVALID');
    expect(codeComparisons.count).toBe(0);
    const stored = await getLatestOtpChallenge(config, 'verify-email', 'ada@example.com');
    expect(stored?.attemptCount).toBe(0);
    expect(stored?.consumedAt).toBeNull();
  });

  describe('per-email limits across challenges', () => {
    type LimitConfig = AuthFnRuntimeConfig & {
      __clock: ReturnType<typeof createClock>;
      __delivery: ReturnType<typeof createDeliveryRecorder>;
    };

    function setup(options: Record<string, unknown> = {}) {
      const config = createConfig() as LimitConfig;
      Object.assign(config.pluginRuntime!.emailOtp as Record<string, unknown>, options);
      Object.assign((config.pluginRuntime!.password as { otp: Record<string, unknown> }).otp, options);
      const auth = createTestServer(config);
      const post = (path: string, body: Record<string, unknown>) => auth.router.handle(
        new Request(`https://account.example.com/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      );
      return { config, auth, post };
    }

    it('stops evaluating guesses once the email has used its failed-attempt budget, whatever new challenges are sent', async () => {
      // Security audit AF-02: a new challenge every five guesses used to give
      // an unlimited number of guesses against one email.
      const { config, post } = setup();
      await createUser(config, { primaryEmail: 'ada@example.com' });
      let refused = 0;
      codeComparisons.count = 0;
      for (let round = 0; round < 6; round += 1) {
        config.__clock.advance(1000);
        const sent = await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
        expect(sent.status).toBe(200);
        for (let guess = 0; guess < 5; guess += 1) {
          const response = await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' });
          const body = await response.json();
          if (response.status === 429) {
            expect(body.error.code).toBe('AUTHFN_RATE_LIMITED');
            refused += 1;
          } else {
            expect(body.error.code).toBe('AUTHFN_OTP_INVALID');
          }
        }
      }
      expect(codeComparisons.count).toBe(10);
      expect(refused).toBe(20);

      // The correct code is refused too while the email is over its budget.
      config.__clock.advance(1000);
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      codeComparisons.count = 0;
      const locked = await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' });
      expect(locked.status).toBe(429);
      const lockedBody = await locked.json();
      expect(lockedBody.error.details).toMatchObject({ scope: 'otp-email', limit: 'failed-attempts' });
      expect(codeComparisons.count).toBe(0);

      // Once the window has passed the owner can sign in again.
      config.__clock.advance(60 * 60 * 1000);
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      const signedIn = await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' });
      expect(signedIn.status).toBe(200);
    });

    it('counts failed guesses for one email across purposes, including password reset', async () => {
      const { config, post } = setup({ maxFailedAttemptsPerEmail: 4 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      for (let guess = 0; guess < 2; guess += 1) {
        expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
      }
      config.__clock.advance(1000);
      await post('/password/reset/start', { email: 'ada@example.com' });
      for (let guess = 0; guess < 2; guess += 1) {
        const response = await post('/password/reset/complete', {
          email: 'ada@example.com',
          code: '100000',
          newPassword: 'An0therSecurePassphrase!'
        });
        expect(response.status).toBe(400);
      }
      const refused = await post('/password/reset/complete', {
        email: 'ada@example.com',
        code: '731942',
        newPassword: 'An0therSecurePassphrase!'
      });
      expect(refused.status).toBe(429);
      expect((await refused.json()).error.code).toBe('AUTHFN_RATE_LIMITED');

      // Another email is not affected.
      await createUser(config, { primaryEmail: 'bea@example.com' });
      await post('/otp/send', { purpose: 'sign-in', email: 'bea@example.com' });
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'bea@example.com', code: '731942' })).status).toBe(200);
    });

    it('does not count a correct code against the budget', async () => {
      const { config, post } = setup({ maxFailedAttemptsPerEmail: 2 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      for (let round = 0; round < 4; round += 1) {
        config.__clock.advance(1000);
        await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
        const response = await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' });
        expect(response.status).toBe(200);
      }
      config.__clock.advance(1000);
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' })).status).toBe(200);
    });

    it('refuses new challenges for an email once its challenge budget is used', async () => {
      const { config, post } = setup({ maxChallengesPerEmail: 3 });
      for (let round = 0; round < 3; round += 1) {
        expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).status).toBe(200);
      }
      const deliveriesBefore = config.__delivery.deliveries.length;
      const refused = await post('/otp/send', { purpose: 'reset-password', email: 'ADA@example.com' });
      expect(refused.status).toBe(429);
      const body = await refused.json();
      expect(body.error.code).toBe('AUTHFN_RATE_LIMITED');
      expect(body.error.details).toMatchObject({
        scope: 'otp-email',
        limit: 'challenges',
        resetAt: '2026-03-22T01:00:00.000Z'
      });
      expect((await post('/password/reset/start', { email: 'ada@example.com' })).status).toBe(429);
      expect(config.__delivery.deliveries.length).toBe(deliveriesBefore);

      expect((await post('/otp/send', { purpose: 'sign-in', email: 'bea@example.com' })).status).toBe(200);
      config.__clock.advance(60 * 60 * 1000);
      expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).status).toBe(200);
    });

    it('keeps counting guesses for as long as a challenge lives when the window is shorter', async () => {
      const { config, post } = setup({
        maxFailedAttemptsPerEmail: 3,
        emailAttemptWindowSeconds: 60,
        challengeTtlSeconds: 600
      });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      for (let guess = 0; guess < 3; guess += 1) {
        expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
        config.__clock.advance(2 * 60 * 1000);
      }
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' })).status).toBe(429);
    });

    it('compares at most the remaining budget when wrong codes for several challenges arrive concurrently', async () => {
      const { config, post } = setup();
      await createUser(config, { primaryEmail: 'ada@example.com' });
      config.__clock.advance(1000);
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      for (let guess = 0; guess < 5; guess += 1) {
        await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' });
      }
      config.__clock.advance(1000);
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      for (let guess = 0; guess < 4; guess += 1) {
        await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' });
      }
      // Nine failures so far; one guess is left. A fresh challenge per purpose
      // allows five attempts each, so only the per-email count can stop this.
      const purposes = ['sign-in', 'sign-up', 'verify-email', 'reset-password'];
      for (const purpose of purposes) {
        config.__clock.advance(1000);
        expect((await post('/otp/send', { purpose, email: 'ada@example.com' })).status).toBe(200);
      }
      codeComparisons.count = 0;
      const responses = await Promise.all(purposes.flatMap((purpose) => Array.from({ length: 5 }, () =>
        post('/otp/verify', { purpose, email: 'ada@example.com', code: '100000' })
      )));
      expect(codeComparisons.count).toBeLessThanOrEqual(1);
      expect(responses.every((response) => response.status === 400 || response.status === 429)).toBe(true);
    });

    it('keeps the challenge cap when sends arrive concurrently', async () => {
      const { config, post } = setup({ maxChallengesPerEmail: 5 });
      for (let round = 0; round < 4; round += 1) {
        config.__clock.advance(1000);
        expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).status).toBe(200);
      }
      config.__clock.advance(1000);
      const deliveriesBefore = config.__delivery.deliveries.length;
      const responses = await Promise.all(Array.from({ length: 6 }, () =>
        post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })
      ));
      expect(responses.filter((response) => response.status === 200).length).toBeLessThanOrEqual(1);
      expect(config.__delivery.deliveries.length - deliveriesBefore).toBeLessThanOrEqual(1);
      const rows = await config.database.findMany<{ createdAt: Date; expiresAt: Date }>({
        model: 'otp_challenges',
        where: [{ field: 'email', operator: 'eq', value: 'ada@example.com' }],
        namespace: 'authfn'
      });
      // Refused sends leave their rows not admitted: they expire as they are
      // created, so no code can be checked against them.
      const admitted = rows.filter((row) => row.expiresAt.getTime() > row.createdAt.getTime());
      expect(admitted.length).toBeLessThanOrEqual(5);
    });

    it('keeps the delivered code usable when a concurrent send is refused', async () => {
      const { config, post } = setup({ maxChallengesPerEmail: 2 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      config.__clock.advance(1000);
      expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).status).toBe(200);
      config.__clock.advance(1000);
      const responses = await Promise.all(Array.from({ length: 3 }, () =>
        post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })
      ));
      expect(responses.filter((response) => response.status === 200).length).toBeLessThanOrEqual(1);
      const latest = await getLatestOtpChallenge(config, 'sign-in', 'ada@example.com');
      expect(latest?.expiresAt.getTime()).toBeGreaterThan(latest!.createdAt.getTime());
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' })).status).toBe(200);
    });

    it('hands back attempts refused by the per-email count, so a retry with the right code still works', async () => {
      const { config, post } = setup({ maxFailedAttemptsPerEmail: 3 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      for (let guess = 0; guess < 2; guess += 1) {
        expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
      }
      // One attempt left; the same correct code is submitted twice at once.
      await Promise.all([
        post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' }),
        post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' })
      ]);
      const latest = await getLatestOtpChallenge(config, 'sign-in', 'ada@example.com');
      if (!latest?.consumedAt) {
        expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' })).status).toBe(200);
      }
      // Either way only the two wrong codes count: one more wrong code is
      // still compared on a new challenge.
      config.__clock.advance(1000);
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
    });

    it('hands back only the matching attempt when a hook ends a correct sign-up with a replay error', async () => {
      const { config } = setup();
      config.hooks = {
        beforeUserCreate: async () => {
          throw new AuthFnOtpReplayedError('test replay from a host hook');
        }
      };
      const auth = createTestServer(config);
      const send = (body: Record<string, unknown>, path: string) => auth.router.handle(new Request(`https://account.example.com/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }));
      await send({ purpose: 'sign-up', email: 'new@example.com' }, '/otp/send');
      expect((await send({ purpose: 'sign-up', email: 'new@example.com', code: '100000' }, '/otp/verify')).status).toBe(400);
      expect((await send({ purpose: 'sign-up', email: 'new@example.com', code: '731942' }, '/otp/verify')).status).toBe(409);
      const latest = await getLatestOtpChallenge(config, 'sign-up', 'new@example.com');
      // The wrong code stays counted; only the matching attempt was handed back.
      expect(latest?.attemptCount).toBe(1);
    });

    it.each([
      ['the consume write throws after committing', 'throw-after-commit'],
      ['the consume write throws without committing', 'throw-before-commit'],
      ['the consume write cannot be confirmed', 'unconfirmed']
    ] as const)('keeps every attempt counted when %s', async (_label, mode) => {
      const base = memoryAdapter({ debug: false });
      let consumeAttempted = false;
      // Writes to attemptCount after the consume: a release or a hand-back.
      const countWritesAfterConsume: Array<Record<string, unknown>> = [];
      const database = new Proxy(base, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if ((property !== 'update' && property !== 'updateMany') || typeof value !== 'function') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (params: { model: string; data: Record<string, unknown> }) => {
            if (params.model === 'otp_challenges' && consumeAttempted && 'attemptCount' in params.data) {
              countWritesAfterConsume.push(params.data);
            }
            if (property !== 'update' || params.model !== 'otp_challenges' || !params.data.consumedAt) {
              return value.call(target, params);
            }
            consumeAttempted = true;
            if (mode === 'throw-before-commit') {
              throw new Error('test consume write failed');
            }
            await value.call(target, params);
            if (mode === 'throw-after-commit') {
              throw new Error('test consume write timed out');
            }
            return { id: 'test-other-row' };
          };
        }
      }) as AuthFnDatabase;
      const config = createConfig({ database }) as AuthFnRuntimeConfig & {
        __delivery: ReturnType<typeof createDeliveryRecorder>;
      };
      const auth = createTestServer(config);
      const post = (path: string, body: Record<string, unknown>) => auth.router.handle(new Request(`https://account.example.com/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }));
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      // An earlier wrong code on the same challenge must stay counted.
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
      const response = await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' });
      expect(response.status).toBe(mode === 'unconfirmed' ? 400 : 500);
      expect(consumeAttempted).toBe(true);
      // Neither the matching attempt nor the earlier wrong one is released or
      // handed back when the consume outcome is not a confirmed no-op.
      expect(countWritesAfterConsume).toEqual([]);
      const stored = await getLatestOtpChallenge(config, 'sign-in', 'ada@example.com');
      expect(stored?.attemptCount).toBe(2);
      if (mode === 'throw-before-commit') {
        expect(stored?.consumedAt ?? null).toBeNull();
      }
    });

    it('applies the strictest limit configured for either OTP plugin', async () => {
      const { config, post } = setup();
      Object.assign((config.pluginRuntime!.password as { otp: Record<string, unknown> }).otp, { maxFailedAttemptsPerEmail: 2 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' });
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '100000' })).status).toBe(400);
      expect((await post('/otp/verify', { purpose: 'sign-in', email: 'ada@example.com', code: '731942' })).status).toBe(429);
    });

    it('keeps counting a challenge that outlives the window until it expires, across plugins', async () => {
      const { config, post } = setup({ maxFailedAttemptsPerEmail: 3 });
      // The email OTP plugin issues reset codes that live two hours; the
      // password plugin, which completes resets, keeps its one-hour window.
      Object.assign(config.pluginRuntime!.emailOtp as Record<string, unknown>, { challengeTtlSeconds: 2 * 60 * 60 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'reset-password', email: 'ada@example.com' });
      config.__clock.advance(70 * 60 * 1000);
      for (let guess = 0; guess < 3; guess += 1) {
        const response = await post('/password/reset/complete', {
          email: 'ada@example.com',
          code: '100000',
          newPassword: 'An0therSecurePassphrase!'
        });
        expect(response.status).toBe(400);
      }
      const refused = await post('/password/reset/complete', {
        email: 'ada@example.com',
        code: '731942',
        newPassword: 'An0therSecurePassphrase!'
      });
      expect(refused.status).toBe(429);
      expect((await refused.json()).error.details.resetAt).toBe('2026-03-22T02:00:00.000Z');
    });

    it.each([
      ['maxFailedAttemptsPerEmail', 0],
      ['maxFailedAttemptsPerEmail', -1],
      ['maxFailedAttemptsPerEmail', 1.5],
      ['maxFailedAttemptsPerEmail', Number.NaN],
      ['maxChallengesPerEmail', 0],
      ['emailAttemptWindowSeconds', 1e12]
    ])('refuses %s = %s when the server is set up', (field, value) => {
      expect(() => setup({ [field]: value })).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    });

    it('refuses a bad limit in the deprecated password factory options when the server is set up', () => {
      const config = createConfig();
      config.plugins = [
        authFnEmailOtpPlugin(),
        authFnPasswordPlugin({ otp: { maxChallengesPerEmail: 0 } })
      ];
      expect(() => createTestServer(config)).toThrow(expect.objectContaining({ code: 'AUTHFN_CONFIG_INVALID' }));
    });

    it.each([
      [{ maxFailedAttemptsPerEmail: 2 }, 3],
      [{ maxFailedAttemptsPerEmail: 1000 }, 4]
    ])('applies the deprecated password factory limits %j on the email OTP routes too, only to tighten', async (otp, refusedAt) => {
      const config = createConfig() as LimitConfig;
      Object.assign(config.pluginRuntime!.emailOtp as Record<string, unknown>, { maxFailedAttemptsPerEmail: 3 });
      Object.assign((config.pluginRuntime!.password as { otp: Record<string, unknown> }).otp, { maxFailedAttemptsPerEmail: 3 });
      // A hook-only plugin with the same name, listed first, must not hide them.
      config.plugins = [{ name: 'password', hooks: {} }, authFnEmailOtpPlugin(), authFnPasswordPlugin({ otp })];
      const auth = createTestServer(config);
      const post = (path: string, body: Record<string, unknown>) => auth.router.handle(new Request(`https://account.example.com/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }));
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await post('/otp/send', { purpose: 'reset-password', email: 'ada@example.com' });
      let refused: number | null = null;
      for (let guess = 1; guess <= 5 && refused === null; guess += 1) {
        const response = await post('/otp/verify', { purpose: 'reset-password', email: 'ada@example.com', code: '100000' });
        if (response.status === 429) {
          refused = guess;
        }
      }
      expect(refused).toBe(refusedAt);
    });

    it('lets a limit set for one plugin stand when the other plugin leaves it unset', async () => {
      const config = createConfig() as LimitConfig;
      Object.assign(config.pluginRuntime!.emailOtp as Record<string, unknown>, {
        maxFailedAttemptsPerEmail: 30,
        maxChallengesPerEmail: 40,
        emailAttemptWindowSeconds: 600
      });
      // password.otp only supplies delivery.
      const budget = resolveOtpEmailBudget(config, {});
      expect(budget).toMatchObject({ maxFailedAttempts: 30, maxChallenges: 40, windowMs: 600_000 });
      // With neither set, the defaults apply.
      expect(resolveOtpEmailBudget(createConfig(), {})).toMatchObject({ maxFailedAttempts: 10, maxChallenges: 20, windowMs: 3_600_000 });
    });

    it('scans far enough back for reset codes whose lifetime is set in the deprecated factory options', () => {
      const config = createConfig() as LimitConfig;
      config.plugins = [authFnEmailOtpPlugin(), authFnPasswordPlugin({ otp: { challengeTtlSeconds: 4 * 60 * 60 } })];
      expect(resolveOtpEmailBudget(config, {}).longestTtlMs).toBe(4 * 60 * 60 * 1000);
    });

    it('retires a new challenge whose admission could not be confirmed even when reading it back fails', async () => {
      const base = memoryAdapter({ debug: false });
      let failAdmission = false;
      let failReadBack = false;
      const database = new Proxy(base, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === 'update' && typeof value === 'function') {
            return async (params: { model: string; data: Record<string, unknown> }) => {
              const row = await value.call(target, params);
              if (failAdmission && params.model === 'otp_challenges' && !('consumedAt' in params.data) && 'expiresAt' in params.data) {
                failAdmission = false;
                failReadBack = true;
                throw new Error('test admission write timed out');
              }
              return row;
            };
          }
          if (property === 'findOne' && typeof value === 'function') {
            return async (params: { model: string }) => {
              if (failReadBack && params.model === 'otp_challenges') {
                failReadBack = false;
                throw new Error('test read back failed');
              }
              return value.call(target, params);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        }
      }) as AuthFnDatabase;
      const config = createConfig({ database }) as LimitConfig;
      const auth = createTestServer(config);
      const post = (path: string, body: Record<string, unknown>) => auth.router.handle(new Request(`https://account.example.com/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }));
      await createUser(config, { primaryEmail: 'ada@example.com' });
      expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).status).toBe(200);
      const delivered = await getLatestOtpChallenge(config, 'sign-in', 'ada@example.com');
      config.__clock.advance(1000);
      failAdmission = true;
      expect((await post('/otp/send', { purpose: 'sign-in', email: 'ada@example.com' })).ok).toBe(false);
      // The code the user received is still the one checked.
      expect((await getLatestOtpChallenge(config, 'sign-in', 'ada@example.com'))?.id).toBe(delivered?.id);
    });

    it('lets a direct caller tighten the per-email limits but not loosen them', async () => {
      const { config } = setup({ maxFailedAttemptsPerEmail: 3 });
      await createUser(config, { primaryEmail: 'ada@example.com' });
      await createUser(config, { primaryEmail: 'grace@example.com' });
      const base = config.pluginRuntime!.emailOtp as Record<string, unknown>;
      const guessUntilRefused = async (email: string, options: Record<string, unknown>) => {
        await sendOtpChallenge(config, {}, { ...base, ...options }, { purpose: 'sign-in', email });
        for (let guess = 1; guess <= 5; guess += 1) {
          try {
            await verifyOtpChallenge(config, {}, { ...base, ...options }, { purpose: 'sign-in', email, code: '100000' });
          } catch (error) {
            if ((error as { code?: string }).code === 'AUTHFN_RATE_LIMITED') {
              return guess;
            }
            expect((error as { code?: string }).code).toBe('AUTHFN_OTP_INVALID');
          }
        }
        return null;
      };
      // Tighter than the plugin's 3: the third wrong code is refused.
      expect(await guessUntilRefused('ada@example.com', { maxFailedAttemptsPerEmail: 2 })).toBe(3);
      // Looser than the plugin's 3: the plugin's limit still applies.
      expect(await guessUntilRefused('grace@example.com', { maxFailedAttemptsPerEmail: 1000 })).toBe(4);
    });
  });
});
