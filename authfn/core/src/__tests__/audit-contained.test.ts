import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';

const scryptProbe = vi.hoisted(() => ({
  calls: 0,
  inFlight: 0,
  maxInFlight: 0,
  delayMs: 0
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const scrypt = ((...args: unknown[]) => {
    scryptProbe.calls += 1;
    scryptProbe.inFlight += 1;
    scryptProbe.maxInFlight = Math.max(scryptProbe.maxInFlight, scryptProbe.inFlight);
    const run = () => {
      scryptProbe.inFlight -= 1;
      return (actual.scrypt as (...params: unknown[]) => unknown)(...args);
    };
    if (scryptProbe.delayMs > 0) {
      setTimeout(run, scryptProbe.delayMs);
      return undefined;
    }
    return run();
  }) as typeof actual.scrypt;
  return { ...actual, scrypt };
});
import { authFnEmailOtpPlugin } from '@authfn/email-otp';
import { authFnPasswordPlugin } from '@authfn/password';
import type { AuthFnDeliveryRequest, AuthFnRuntimeConfig } from '../index.js';
import { AuthFnInternalError } from '../core/errors.js';
import {
  AUTHFN_PASSWORD_KDF_CONCURRENCY,
  AUTHFN_PASSWORD_MAX_BYTES,
  hashPassword,
  signInWithPassword,
  signUpWithPassword,
  verifyPassword
} from '../core/passwords.js';
import { createUser } from '../core/users.js';
import { AUTHFN_MAX_BODY_BYTES } from '../http/body-limit.js';
import { jsonSuccess, resolveRequestId } from '../http/envelopes.js';
import { createTestServer } from './test-server.js';

const PASSWORD = 'Sup3rSecurePassphrase!';
const OTHER_PASSWORD = 'An0therSecurePassphrase!';
const WRONG_PASSWORD = 'not-the-password';

function createDatabaseCounter(database: AuthFnRuntimeConfig['database']) {
  let calls = 0;
  const tracked = new Proxy(database, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]) => {
        calls += 1;
        return value.apply(target, args);
      };
    }
  });
  return {
    database: tracked,
    reset() {
      calls = 0;
    },
    count() {
      return calls;
    }
  };
}

function streamedBody(byteLength: number): ReadableStream<Uint8Array> {
  const payload = new Uint8Array(byteLength);
  payload.fill(0x61);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(payload);
    }
  });
}

function oversizedStreamRequest(url: string): Request {
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: streamedBody(AUTHFN_MAX_BODY_BYTES + 1),
    duplex: 'half'
  } as RequestInit);
  expect(request.headers.get('content-length')).toBeNull();
  return request;
}

function passwordConfig(
  database: AuthFnRuntimeConfig['database'],
  options?: { requireEmailVerifiedForSignIn?: boolean; rateLimit?: boolean }
): AuthFnRuntimeConfig {
  return {
    database,
    namespace: 'authfn',
    plugins: [
      authFnPasswordPlugin({
        requireEmailVerifiedForSignIn: options?.requireEmailVerifiedForSignIn
      })
    ],
    ...(options?.rateLimit
      ? { rateLimit: { enabled: true, mode: 'local' as const } }
      : {})
  };
}

function exposedError(error: unknown) {
  const authError = error as {
    code?: string;
    message?: string;
    status?: number;
    retryable?: boolean;
    details?: unknown;
  };
  return {
    code: authError.code,
    message: authError.message,
    status: authError.status,
    retryable: authError.retryable,
    details: authError.details
  };
}

async function errorBody(response: Response) {
  const body = await response.json() as {
    ok: boolean;
    requestId: string;
    error: { code: string; message: string; details?: { userId?: string; primaryEmail?: string; maxBytes?: number } };
  };
  const { requestId, ...rest } = body;
  return { requestId, rest };
}

describe('authfn contained audit fixes', () => {
  beforeEach(() => {
    scryptProbe.calls = 0;
    scryptProbe.inFlight = 0;
    scryptProbe.maxInFlight = 0;
    scryptProbe.delayMs = 0;
  });

  it('rejects an oversized stream with no Content-Length before the database or scrypt', async () => {
    const tracked = createDatabaseCounter(memoryAdapter({ debug: false }));
    const auth = createTestServer(passwordConfig(tracked.database));
    tracked.reset();
    scryptProbe.calls = 0;

    const response = await auth.router.handle(
      oversizedStreamRequest('https://account.example.com/auth/sign-in/password')
    );
    expect(response.status).toBe(413);
    const body = await errorBody(response);
    expect(body.rest).toMatchObject({
      ok: false,
      error: {
        code: 'AUTHFN_VALIDATION_ERROR',
        details: { maxBytes: AUTHFN_MAX_BODY_BYTES }
      }
    });
    expect(scryptProbe.calls).toBe(0);
    expect(tracked.count()).toBe(0);
  });

  it('rejects an oversized stream from the rate limiter before counting or hashing', async () => {
    const tracked = createDatabaseCounter(memoryAdapter({ debug: false }));
    const auth = createTestServer(passwordConfig(tracked.database, { rateLimit: true }));
    tracked.reset();
    scryptProbe.calls = 0;

    const response = await auth.router.handle(
      oversizedStreamRequest('https://account.example.com/auth/sign-in/password')
    );
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('AUTHFN_VALIDATION_ERROR');
    expect(scryptProbe.calls).toBe(0);
    expect(tracked.count()).toBe(0);
  });

  it('bounds raw body readers and preserves the original request on accepted requests', async () => {
    const auth = createTestServer(passwordConfig(memoryAdapter({ debug: false })));
    const request = jsonRequest('/auth/test-body', { value: 'test-value' });
    const requestId = resolveRequestId(request);
    let calls = 0;
    auth.router.addRoute({
      method: 'POST',
      path: '/test-body',
      async handler(routed) {
        calls += 1;
        expect(routed).toBe(request);
        expect(routed.bodyUsed).toBe(false);
        const data = await new Response(routed.body).json();
        return jsonSuccess(routed, data);
      }
    });

    const tooLarge = await auth.router.handler(oversizedStreamRequest(request.url));
    expect(tooLarge.status).toBe(413);
    expect(calls).toBe(0);
    const accepted = await auth.router.handler(request);
    await expect(accepted.json()).resolves.toMatchObject({ requestId, data: { value: 'test-value' } });
    expect(calls).toBe(1);
  });

  it('finishes the body check when a stream stalls', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const auth = createTestServer(passwordConfig(memoryAdapter({ debug: false })));
      const response = auth.router.handle(new Request('https://account.example.com/auth/sign-in/password', {
        method: 'POST',
        body: new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array([0x7b])); }
        }),
        duplex: 'half'
      } as RequestInit));
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await response).status).toBe(408);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the body source for a request that was aborted before handling', async () => {
    const auth = createTestServer(passwordConfig(memoryAdapter({ debug: false })));
    const cancellation = vi.fn();
    const controller = new AbortController();
    const request = new Request('https://account.example.com/auth/sign-in/password', {
      method: 'POST',
      body: new ReadableStream({ cancel: cancellation }),
      signal: controller.signal,
      duplex: 'half'
    } as RequestInit);
    controller.abort();
    expect((await auth.router.handle(request)).status).toBe(408);
    expect(cancellation).toHaveBeenCalledOnce();
  });

  it('rejects an over-long password on signup, sign-in, and reset before the database or scrypt', async () => {
    const tracked = createDatabaseCounter(memoryAdapter({ debug: false }));
    const delivery = createDeliveryRecorder();
    const auth = createTestServer({
      ...passwordConfig(tracked.database),
      plugins: [authFnPasswordPlugin(), authFnEmailOtpPlugin()],
      pluginRuntime: {
        password: { otp: { delivery: delivery.provider, codeGenerator: () => '731942' } },
        emailOtp: { delivery: delivery.provider, codeGenerator: () => '731942' } }
    });
    const password = 'a'.repeat(AUTHFN_PASSWORD_MAX_BYTES + 1);
    const cases = [
      {
        url: 'https://account.example.com/auth/sign-up/password',
        body: { email: 'ada@example.com', password }
      },
      {
        url: 'https://account.example.com/auth/sign-in/password',
        body: { email: 'ada@example.com', password }
      },
      {
        url: 'https://account.example.com/auth/password/reset/complete',
        body: { email: 'ada@example.com', code: '731942', newPassword: password }
      }
    ];

    for (const input of cases) {
      tracked.reset();
      scryptProbe.calls = 0;
      const response = await auth.router.handle(new Request(input.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.body)
      }));
      expect(response.status, input.url).toBe(400);
      const body = await errorBody(response);
      expect(body.rest.error).toMatchObject({
        code: 'AUTHFN_VALIDATION_ERROR',
        details: { field: 'password', maxBytes: AUTHFN_PASSWORD_MAX_BYTES }
      });
      expect(scryptProbe.calls, input.url).toBe(0);
      expect(tracked.count(), input.url).toBe(0);
    }
  });

  it('still signs up, signs in, and resets a password inside the limits', async () => {
    const delivery = createDeliveryRecorder();
    const config = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnPasswordPlugin(), authFnEmailOtpPlugin()],
      pluginRuntime: {
        password: { otp: { delivery: delivery.provider, codeGenerator: () => '731942' } },
        emailOtp: { delivery: delivery.provider, codeGenerator: () => '731942' } }
    } as AuthFnRuntimeConfig;
    const auth = createTestServer(config);

    const signUp = await auth.router.handle(jsonRequest('/auth/sign-up/password', {
      email: 'ada@example.com',
      password: PASSWORD
    }));
    expect(signUp.status).toBe(200);

    const signIn = await auth.router.handle(jsonRequest('/auth/sign-in/password', {
      email: 'ada@example.com',
      password: PASSWORD
    }));
    expect(signIn.status).toBe(200);

    const start = await auth.router.handle(jsonRequest('/auth/password/reset/start', {
      email: 'ada@example.com'
    }));
    expect(start.status).toBe(200);

    const reset = await auth.router.handle(jsonRequest('/auth/password/reset/complete', {
      email: 'ada@example.com',
      code: delivery.codeFor('reset-password', 'ada@example.com'),
      newPassword: OTHER_PASSWORD
    }));
    expect(reset.status).toBe(200);
    await expect(signInWithPassword(config, {
      email: 'ada@example.com',
      password: OTHER_PASSWORD
    })).resolves.toMatchObject({
      user: { primaryEmail: 'ada@example.com' }
    });
  });

  it('discards a sign-in session if a reset finishes before session creation', async () => {
    const email = 'ada@example.com';
    const delivery = createDeliveryRecorder();
    const config = passwordConfig(memoryAdapter({ debug: false }));
    const signedUp = await signUpWithPassword(config, {}, { email, password: PASSWORD });
    let sessionReady!: () => void;
    let allowSession!: () => void;
    const ready = new Promise<void>((resolve) => { sessionReady = resolve; });
    const waitForReset = new Promise<void>((resolve) => { allowSession = resolve; });
    const afterSessionIssue = vi.fn();
    const auth = createTestServer({
      ...config,
      hooks: {
        async beforeSessionIssue() {
          sessionReady();
          await waitForReset;
        },
        afterSessionIssue
      },
      pluginRuntime: { password: { otp: { delivery: delivery.provider } } }
    });

    const signIn = auth.router.handle(jsonRequest('/auth/sign-in/password', { email, password: PASSWORD }));
    await ready;
    try {
      const start = await auth.router.handle(jsonRequest('/auth/password/reset/start', { email }));
      expect(start.status).toBe(200);
      const reset = await auth.router.handle(jsonRequest('/auth/password/reset/complete', {
        email,
        code: delivery.codeFor('reset-password', email),
        newPassword: OTHER_PASSWORD
      }));
      expect(reset.status).toBe(200);
    } finally {
      allowSession();
    }
    const rejected = await signIn;
    expect(rejected.status).toBe(401);
    expect(rejected.headers.has('set-cookie')).toBe(false);
    expect(afterSessionIssue).not.toHaveBeenCalled();
    const sessions = await config.database.findMany<{ revokedAt: Date | null }>({
      model: 'sessions',
      where: [{ field: 'userId', operator: 'eq', value: signedUp.user.id }],
      namespace: config.namespace
    });
    expect(sessions).toEqual([expect.objectContaining({ revokedAt: expect.any(Date) })]);
  });

  it('leaves the reset code unspent when it expires during password preparation', async () => {
    const email = 'ada@example.com';
    const delivery = createDeliveryRecorder();
    const config = passwordConfig(memoryAdapter({ debug: false }));
    await signUpWithPassword(config, {}, { email, password: PASSWORD });
    let now = new Date('2026-01-01T00:00:00Z');
    const auth = createTestServer({
      ...config,
      plugins: [authFnPasswordPlugin({
        compromisedPasswordChecker: async () => {
          now = new Date(now.getTime() + 1_000);
          return false;
        }
      })],
      pluginRuntime: {
        password: { otp: { delivery: delivery.provider, challengeTtlSeconds: 1, now: () => now } }
      }
    });
    const start = await auth.router.handle(jsonRequest('/auth/password/reset/start', { email }));
    expect(start.status).toBe(200);
    const reset = await auth.router.handle(jsonRequest('/auth/password/reset/complete', {
      email,
      code: delivery.codeFor('reset-password', email),
      newPassword: OTHER_PASSWORD
    }));
    expect((await errorBody(reset)).rest.error.code).toBe('AUTHFN_OTP_EXPIRED');
    const rows = await config.database.findMany<{ consumedAt: Date | null }>({
      model: 'otp_challenges',
      where: [{ field: 'email', operator: 'eq', value: email }],
      namespace: config.namespace
    });
    expect(rows).toEqual([expect.objectContaining({ consumedAt: null })]);
  });

  it('does the same scrypt work for missing, existing, and unverified accounts and hides account details until the password matches', async () => {
    const config = passwordConfig(memoryAdapter({ debug: false }), {
      requireEmailVerifiedForSignIn: true
    });
    const missing = await signInWithPassword(config, {
        email: 'missing@example.com',
        password: WRONG_PASSWORD
      }).then(() => {
        throw new Error('missing account signed in');
      }, (error: unknown) => error);
      expect(scryptProbe.calls).toBe(1);

      await signUpWithPassword(config, {}, {
        email: 'ada@example.com',
        password: PASSWORD
      });
      const unverifiedWrong = await signInWithPassword(config, {
        email: 'ada@example.com',
        password: WRONG_PASSWORD
      }, { requireEmailVerifiedForSignIn: true }).then(() => {
        throw new Error('wrong password signed in');
      }, (error: unknown) => error);
      const wrongPassword = await signInWithPassword(config, {
        email: 'ada@example.com',
        password: 'still-not-the-password'
      }, { requireEmailVerifiedForSignIn: true }).then(() => {
        throw new Error('wrong password signed in');
      }, (error: unknown) => error);

      expect(exposedError(missing)).toEqual(exposedError(wrongPassword));
      expect(exposedError(unverifiedWrong)).toEqual(exposedError(missing));
      expect(exposedError(missing)).toMatchObject({
        code: 'AUTHFN_INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        status: 401
      });
      expect(exposedError(missing).details).toBeUndefined();

      const credentialless = passwordConfig(memoryAdapter({ debug: false }));
      await createUser(credentialless, { primaryEmail: 'no-password@example.com' });
      const callsBeforeMissingCredential = scryptProbe.calls;
      const missingCredential = await signInWithPassword(credentialless, {
        email: 'no-password@example.com',
        password: WRONG_PASSWORD
      }).then(() => {
        throw new Error('missing credential signed in');
      }, (error: unknown) => error);
      expect(scryptProbe.calls - callsBeforeMissingCredential).toBe(1);
      expect(exposedError(missingCredential)).toEqual(exposedError(missing));

      const callsBeforeUnverified = scryptProbe.calls;
      const unverified = await signInWithPassword(config, {
        email: 'ada@example.com',
        password: PASSWORD
      }, { requireEmailVerifiedForSignIn: true }).then(() => {
        throw new Error('unverified account signed in');
      }, (error: unknown) => error);
      expect(scryptProbe.calls - callsBeforeUnverified).toBe(1);
      expect(exposedError(unverified)).toMatchObject({
        code: 'AUTHFN_EMAIL_NOT_VERIFIED',
        status: 403,
        details: {
          primaryEmail: 'ada@example.com'
        }
      });
      expect((exposedError(unverified).details as { userId?: string }).userId).toEqual(expect.any(String));
  });

  it('returns the same public sign-in error for a missing account and a wrong password', async () => {
    const auth = createTestServer(passwordConfig(memoryAdapter({ debug: false }), {
      requireEmailVerifiedForSignIn: true
    }));
    await auth.router.handle(jsonRequest('/auth/sign-up/password', {
      email: 'ada@example.com',
      password: PASSWORD
    }));

    const missing = await auth.router.handle(jsonRequest('/auth/sign-in/password', {
      email: 'missing@example.com',
      password: WRONG_PASSWORD
    }));
    const wrong = await auth.router.handle(jsonRequest('/auth/sign-in/password', {
      email: 'ada@example.com',
      password: 'too-short'
    }));
    const unverifiedWrong = await auth.router.handle(jsonRequest('/auth/sign-in/password', {
      email: 'ada@example.com',
      password: 'still-not-the-password'
    }));
    const unverified = await auth.router.handle(jsonRequest('/auth/sign-in/password', {
      email: 'ada@example.com',
      password: PASSWORD
    }));

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unverifiedWrong.status).toBe(401);
    const missingBody = await errorBody(missing);
    const wrongBody = await errorBody(wrong);
    const unverifiedWrongBody = await errorBody(unverifiedWrong);
    expect(missingBody.rest).toEqual(wrongBody.rest);
    expect(unverifiedWrongBody.rest).toEqual(missingBody.rest);
    expect(JSON.stringify(missingBody.rest)).not.toContain('userId');

    expect(unverified.status).toBe(403);
    const unverifiedBody = await errorBody(unverified);
    expect(unverifiedBody.rest.error).toMatchObject({
      code: 'AUTHFN_EMAIL_NOT_VERIFIED',
      details: { primaryEmail: 'ada@example.com' }
    });
    expect(unverifiedBody.rest.error.details?.userId).toEqual(expect.any(String));
  });

  it('rejects a stored hash whose parameters or digest size differ before scrypt', async () => {
    const salt = Buffer.from('test-password!!!').toString('base64url');
    const digest = Buffer.alloc(64, 0x2e).toString('base64url');
    await expect(verifyPassword(PASSWORD, `scrypt$1073741824$8$1$${salt}$${digest}`))
      .rejects.toBeInstanceOf(AuthFnInternalError);
    await expect(verifyPassword(PASSWORD, `scrypt$16384$8$1$${salt}$aa`))
      .rejects.toBeInstanceOf(AuthFnInternalError);
    expect(scryptProbe.calls).toBe(0);
  });

  it('keeps the invalid-credentials result for the Python scrypt format', async () => {
    const salt = Buffer.alloc(16, 0x2e).toString('hex');
    const digest = Buffer.alloc(64, 0x2e).toString('hex');
    await expect(verifyPassword(PASSWORD, `scrypt$16384$8$1$${salt}$${digest}`)).resolves.toBe(false);
    expect(scryptProbe.calls).toBe(1);
  });

  it('runs at most the configured number of scrypt operations at once', async () => {
    scryptProbe.delayMs = 30;
    scryptProbe.calls = 0;
    scryptProbe.maxInFlight = 0;
    await Promise.all(Array.from({ length: 8 }, () => hashPassword(PASSWORD)));
    expect(scryptProbe.calls).toBe(8);
    expect(scryptProbe.maxInFlight).toBeGreaterThan(0);
    expect(scryptProbe.maxInFlight).toBeLessThanOrEqual(AUTHFN_PASSWORD_KDF_CONCURRENCY);
  });

  it('rejects password work that exceeds the pending limit and frees a canceled place', async () => {
    scryptProbe.delayMs = 15;
    const controller = new AbortController();
    const active = Array.from({ length: AUTHFN_PASSWORD_KDF_CONCURRENCY }, () => hashPassword(PASSWORD));
    const canceled = expect(hashPassword(PASSWORD, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const pending = Array.from({ length: 15 }, () => hashPassword(PASSWORD));
    await expect(hashPassword(PASSWORD)).rejects.toMatchObject({ status: 429, retryable: true });
    controller.abort();
    const replacement = hashPassword(PASSWORD);
    await Promise.all([canceled, ...active, ...pending, replacement]);
    expect(scryptProbe.calls).toBe(active.length + pending.length + 1);
  });
});

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://account.example.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function createDeliveryRecorder() {
  const codes = new Map<string, string>();
  return {
    provider: {
      async send(input: AuthFnDeliveryRequest) {
        codes.set(`${input.purpose}:${input.email}`, input.code);
        return { sent: true };
      }
    },
    codeFor(purpose: string, email: string) {
      const code = codes.get(`${purpose}:${email}`);
      if (!code) {
        throw new Error(`no code for ${purpose}`);
      }
      return code;
    }
  };
}
