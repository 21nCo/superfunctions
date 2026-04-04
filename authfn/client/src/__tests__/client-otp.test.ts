import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import {
  authFnEmailOtpPlugin,
  authFnPasswordPlugin,
  createAuthFn,
  type AuthFnConfig,
  type AuthFnDeliveryRequest
} from '@authfn/core';
import { createAuthFnClient } from '../index.js';

function createCookieJar() {
  const values = new Map<string, string>();

  return {
    header(): string {
      return Array.from(values.entries())
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; ');
    },
    applySetCookies(cookies: string[]): void {
      for (const cookie of cookies) {
        const [pair] = cookie.split(';');
        const separatorIndex = pair.indexOf('=');
        const name = pair.slice(0, separatorIndex);
        const value = decodeURIComponent(pair.slice(separatorIndex + 1));
        if (value === '') {
          values.delete(name);
        } else {
          values.set(name, value);
        }
      }
    }
  };
}

describe('@authfn/client otp flows', () => {
  it('supports verify-email, otp sign-in, and reset-password completion', async () => {
    const codes = new Map<string, string>();
    const provider = {
      async send(input: AuthFnDeliveryRequest) {
        codes.set(`${input.purpose}:${input.email}`, input.code);
        return { sent: true };
      }
    };

    const auth = createAuthFn({
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnPasswordPlugin({
          otp: {
            delivery: provider,
            codeGenerator: () => '731942'
          }
        }),
        authFnEmailOtpPlugin({
          delivery: provider,
          codeGenerator: () => '731942'
        })
      ]
    } satisfies AuthFnConfig);

    const cookieJar = createCookieJar();
    const client = createAuthFnClient({
      baseUrl: 'https://account.example.com/auth',
      cookieAccessor: () => cookieJar.header(),
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const cookieHeader = cookieJar.header();
        if (cookieHeader) {
          headers.set('cookie', cookieHeader);
        }
        const response = await auth.router.handle(
          new Request(typeof input === 'string' ? input : input.toString(), {
            method: init?.method,
            headers,
            body: init?.body
          })
        );
        cookieJar.applySetCookies(response.headers.getSetCookie());
        return response;
      }
    });

    await client.signUpWithPassword({
      email: 'ada@example.com',
      password: 'Sup3rSecurePassphrase!'
    });
    await client.signOut();

    const sent = await client.sendOtp({
      purpose: 'verify-email',
      email: 'ada@example.com'
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) {
      throw new Error('sendOtp should succeed');
    }

    const verified = await client.verifyOtp({
      purpose: 'verify-email',
      email: 'ada@example.com',
      code: codes.get('verify-email:ada@example.com')!
    });
    expect(verified.ok).toBe(true);

    await client.sendOtp({
      purpose: 'sign-in',
      email: 'ada@example.com'
    });
    const signedIn = await client.verifyOtp({
      purpose: 'sign-in',
      email: 'ada@example.com',
      code: codes.get('sign-in:ada@example.com')!
    });
    expect(signedIn.ok).toBe(true);
    if (!signedIn.ok || !('session' in signedIn.data)) {
      throw new Error('otp sign-in should yield a session envelope');
    }
    expect(signedIn.data.session?.methods).toEqual(['email-otp']);

    const currentSession = await client.getSession();
    expect(currentSession.ok).toBe(true);
    if (!currentSession.ok) {
      throw new Error('getSession should succeed');
    }
    expect(currentSession.data.session?.primaryEmail).toBe('ada@example.com');

    const resetStart = await client.startPasswordReset({
      email: 'ada@example.com'
    });
    expect(resetStart.ok).toBe(true);

    const resetComplete = await client.completePasswordReset({
      email: 'ada@example.com',
      code: codes.get('reset-password:ada@example.com')!,
      newPassword: 'An0therSecurePassphrase!'
    });
    expect(resetComplete.ok).toBe(true);
    if (!resetComplete.ok) {
      throw new Error('reset completion should succeed');
    }
    expect(resetComplete.data.passwordUpdated).toBe(true);

    await client.signOut();
    const wrongOldPassword = await client.signInWithPassword({
      email: 'ada@example.com',
      password: 'Sup3rSecurePassphrase!'
    });
    expect(wrongOldPassword.ok).toBe(false);
    if (wrongOldPassword.ok) {
      throw new Error('old password should fail');
    }
    expect(wrongOldPassword.error.code).toBe('AUTHFN_INVALID_CREDENTIALS');

    const newPassword = await client.signInWithPassword({
      email: 'ada@example.com',
      password: 'An0therSecurePassphrase!'
    });
    expect(newPassword.ok).toBe(true);
  });
});
