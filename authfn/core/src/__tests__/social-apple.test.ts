import { sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import type { AuthFnRuntimeConfig } from '../index.js';

// Apple identity tokens are verified against Apple's published key set. The
// tests sign their tokens with a key pair made for this run and serve its
// public key in place of Apple's remote key set.
const appleTestKeys = vi.hoisted(() => {
  // vi.hoisted runs before imports, so node:crypto is required here.
  const { generateKeyPairSync: generate } = require('node:crypto') as typeof import('node:crypto');
  const { privateKey, publicKey } = generate('ec', { namedCurve: 'P-256' });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'apple-test-key', alg: 'ES256', use: 'sig' } };
});
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet({ keys: [appleTestKeys.jwk] })
  };
});

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createIdToken(claims: Record<string, unknown>): string {
  const signingInput = `${encodeSegment({ alg: 'ES256', kid: 'apple-test-key', typ: 'JWT' })}.${encodeSegment({
    iss: 'https://appleid.apple.com',
    ...claims
  })}`;
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: appleTestKeys.privateKey,
    dsaEncoding: 'ieee-p1363'
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

/** The pre-fix test token shape: `alg: none` with no signature check. */
function createUnsignedIdToken(claims: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'none', typ: 'JWT' })}.${encodeSegment({
    iss: 'https://appleid.apple.com',
    ...claims
  })}.`;
}

describe('authfn apple social oauth', () => {
  it('uses runtime client secret resolution and links the local account', async () => {
    let capturedBody = '';
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      environment: {
        resolve() {
          return {
            issuer: 'https://account.example.com',
            baseUrl: 'https://account.example.com',
            oauth: {
              apple: {
                clientId: 'apple-client-id',
                clientSecretResolver: async () => ({
                  clientSecret: 'generated-apple-client-secret'
                }),
                allowlistedReturnTo: ['https://app.example.com/apple-post-auth']
              }
            }
          };
        }
      },
      plugins: [
        authFnSocialOAuthPlugin()
      ],
      pluginRuntime: {
        socialOAuth: {
          fetcher: async (url, init) => {
            if (url !== 'https://appleid.apple.com/auth/token') {
              throw new Error(`unexpected fetch: ${url}`);
            }

            capturedBody = init.body ?? '';
            return createResponse({
              status: 200,
              body: JSON.stringify({
                access_token: 'apple-access-token',
                refresh_token: 'apple-refresh-token',
                token_type: 'Bearer',
                id_token: createIdToken({
                  sub: 'apple-user-01',
                  email: 'ada.apple@example.com',
                  name: 'Ada Apple'
                })
              })
            });
          }
        }
      }
    };
    const auth = createTestServer(config);

    const start = await auth.router.handle(
      new Request('https://account.example.com/auth/social/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          returnTo: 'https://app.example.com/apple-post-auth'
        })
      })
    );
    const startBody = await start.json();
    const authorizeUrl = new URL(startBody.data.redirectTo);
    expect(authorizeUrl.searchParams.get('response_mode')).toBe('form_post');
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBeNull();
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBeNull();

    const callback = await auth.router.handle(
      new Request('https://account.example.com/auth/social/callback/apple', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: 'apple_code',
          state: startBody.data.stateId
        })
      })
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('https://app.example.com/apple-post-auth');
    expect(callback.headers.getSetCookie()).toHaveLength(2);

    const params = new URLSearchParams(capturedBody);
    expect(params.get('client_secret')).toBe('generated-apple-client-secret');

    const linked = await config.database.findOne({
      model: 'oauth_accounts',
      where: [
        { field: 'provider', operator: 'eq', value: 'apple' },
        { field: 'providerAccountId', operator: 'eq', value: 'apple-user-01' }
      ],
      namespace: 'authfn'
    });
    expect(linked?.email).toBe('ada.apple@example.com');
  });

  it('rejects callbacks that do not resolve required Apple claims', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnSocialOAuthPlugin()
      ],
      pluginRuntime: {
        socialOAuth: {
          providers: {
            apple: {
              clientId: 'apple-client-id',
              nativeClientIds: ['io.nucleum'],
              clientSecretResolver: async () => ({
                clientSecret: 'generated-apple-client-secret'
              }),
              allowlistedReturnTo: ['https://app.example.com/apple-post-auth']
            }
          },
          fetcher: async () =>
            createResponse({
              status: 200,
              body: JSON.stringify({
                access_token: 'apple-access-token',
                token_type: 'Bearer',
                id_token: createIdToken({
                  sub: 'apple-user-02'
                })
              })
            })
        }
      }
    };
    const auth = createTestServer(config);

    const start = await auth.router.handle(
      new Request('https://account.example.com/auth/social/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          returnTo: 'https://app.example.com/apple-post-auth'
        })
      })
    );
    const startBody = await start.json();

    const callback = await auth.router.handle(
      new Request(
        `https://account.example.com/auth/social/callback/apple?code=apple_code&state=${encodeURIComponent(startBody.data.stateId)}`,
        { method: 'GET' }
      )
    );
    expect(callback.status).toBe(303);
    const redirectTo = new URL(callback.headers.get('location')!);
    expect(redirectTo.origin + redirectTo.pathname).toBe('https://app.example.com/apple-post-auth');
    expect(redirectTo.searchParams.get('auth_error')).toBe('oauth_callback_failed');
    expect(redirectTo.searchParams.get('auth_error_code')).toBe('AUTHFN_OAUTH_CALLBACK_INVALID');
    expect(redirectTo.searchParams.get('auth_provider')).toBe('apple');
    expect(redirectTo.searchParams.get('auth_request_id')).toBeTruthy();
  });

  it('uses Apple form_post id_token and user payload without token exchange', async () => {
    let tokenExchangeAttempted = false;
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnSocialOAuthPlugin()
      ],
      pluginRuntime: {
        socialOAuth: {
          providers: {
            apple: {
              clientId: 'apple-client-id',
              nativeClientIds: ['io.nucleum'],
              clientSecretResolver: async () => ({
                clientSecret: 'generated-apple-client-secret'
              }),
              allowlistedReturnTo: ['https://app.example.com/apple-post-auth']
            }
          },
          fetcher: async () => {
            tokenExchangeAttempted = true;
            throw new Error('token exchange should not be called for Apple form_post identity');
          }
        }
      }
    };
    const auth = createTestServer(config);

    const start = await auth.router.handle(
      new Request('https://account.example.com/auth/social/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'apple',
          returnTo: 'https://app.example.com/apple-post-auth'
        })
      })
    );
    const startBody = await start.json();
    const authorizeUrl = new URL(startBody.data.redirectTo);
    const nonce = authorizeUrl.searchParams.get('nonce');
    expect(nonce).toBeTruthy();

    const callback = await auth.router.handle(
      new Request('https://account.example.com/auth/social/callback/apple', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: 'apple_code',
          state: startBody.data.stateId,
          id_token: createIdToken({
            iss: 'https://appleid.apple.com',
            aud: 'apple-client-id',
            sub: 'apple-user-03',
            email: 'formpost.apple@example.com',
            email_verified: 'true',
            nonce
          }),
          user: JSON.stringify({
            email: 'formpost.apple@example.com',
            name: {
              firstName: 'Form',
              lastName: 'Post'
            }
          })
        })
      })
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('https://app.example.com/apple-post-auth');
    expect(callback.headers.getSetCookie()).toHaveLength(2);
    expect(tokenExchangeAttempted).toBe(false);

    const linked = await config.database.findOne({
      model: 'oauth_accounts',
      where: [
        { field: 'provider', operator: 'eq', value: 'apple' },
        { field: 'providerAccountId', operator: 'eq', value: 'apple-user-03' }
      ],
      namespace: 'authfn'
    });
    expect(linked?.email).toBe('formpost.apple@example.com');
    expect(linked?.profile).toMatchObject({
      name: 'Form Post',
      firstName: 'Form',
      lastName: 'Post'
    });
  });

  it('supports native Apple sign-in with nonce-bound identity tokens', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [
        authFnSocialOAuthPlugin()
      ],
      pluginRuntime: {
        socialOAuth: {
          providers: {
            apple: {
              clientId: 'apple-client-id',
              nativeClientIds: ['io.nucleum'],
              clientSecretResolver: async () => ({
                clientSecret: 'generated-apple-client-secret'
              }),
              allowlistedReturnTo: ['nucleum://oauthsignin']
            }
          }
        }
      }
    };
    const auth = createTestServer(config);

    const start = await auth.router.handle(
      new Request('https://account.example.com/auth/social/native/apple/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          returnTo: 'nucleum://oauthsignin',
          handoffMode: 'session-token'
        })
      })
    );
    const startBody = await start.json();
    expect(startBody.ok).toBe(true);

    const complete = await auth.router.handle(
      new Request('https://account.example.com/auth/social/native/apple/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stateId: startBody.data.stateId,
          identityToken: createIdToken({
            iss: 'https://appleid.apple.com',
            aud: 'io.nucleum',
            sub: 'native-apple-user-01',
            email: 'native.apple@example.com',
            email_verified: 'true',
            nonce: startBody.data.nonce
          }),
          user: {
            email: 'native.apple@example.com',
            name: {
              firstName: 'Native',
              lastName: 'Apple'
            }
          }
        })
      })
    );
    const completeBody = await complete.json();
    expect(complete.status).toBe(200);
    expect(completeBody.ok).toBe(true);
    expect(completeBody.data.token).toMatch(/^st_/);
    expect(completeBody.data.isNewUser).toBe(true);
    expect(completeBody.data.regionId).toBeUndefined();

    const linked = await config.database.findOne({
      model: 'oauth_accounts',
      where: [
        { field: 'provider', operator: 'eq', value: 'apple' },
        { field: 'providerAccountId', operator: 'eq', value: 'native-apple-user-01' }
      ],
      namespace: 'authfn'
    });
    expect(linked?.email).toBe('native.apple@example.com');
    expect(linked?.profile).toMatchObject({
      name: 'Native Apple'
    });
  });

  describe('identity token signatures', () => {
    function nativeConfig(): AuthFnRuntimeConfig {
      return {
        database: memoryAdapter({ debug: false }),
        namespace: 'authfn',
        plugins: [authFnSocialOAuthPlugin()],
        pluginRuntime: {
          socialOAuth: {
            providers: {
              apple: {
                clientId: 'apple-client-id',
                nativeClientIds: ['io.nucleum'],
                clientSecretResolver: async () => ({ clientSecret: 'generated-apple-client-secret' }),
                allowlistedReturnTo: ['nucleum://oauthsignin']
              }
            }
          }
        }
      };
    }

    async function completeNative(tokenFor: (nonce: string) => string) {
      const auth = createTestServer(nativeConfig());
      const start = await auth.router.handle(
        new Request('https://account.example.com/auth/social/native/apple/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ returnTo: 'nucleum://oauthsignin', handoffMode: 'session-token' })
        })
      );
      const startBody = await start.json();
      return auth.router.handle(
        new Request('https://account.example.com/auth/social/native/apple/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stateId: startBody.data.stateId, identityToken: tokenFor(startBody.data.nonce) })
        })
      );
    }

    const claims = (nonce: string) => ({
      aud: 'io.nucleum',
      sub: 'native-apple-user-02',
      email: 'native.apple@example.com',
      email_verified: 'true',
      nonce
    });

    it('refuses an unsigned (alg: none) token even when NODE_ENV is test or the old switch is set', async () => {
      // Security audit AF-11: these two settings used to turn signature
      // verification off for Apple identity tokens.
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('AUTHFN_ALLOW_UNSIGNED_APPLE_TOKENS', 'true');
      try {
        const response = await completeNative((nonce) => createUnsignedIdToken(claims(nonce)));
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('AUTHFN_OAUTH_CALLBACK_INVALID');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('refuses a token whose signature does not verify', async () => {
      const response = await completeNative((nonce) => {
        const [header, , signature] = createIdToken(claims(nonce)).split('.');
        const forged = Buffer.from(JSON.stringify({
          iss: 'https://appleid.apple.com',
          ...claims(nonce),
          sub: 'someone-else'
        })).toString('base64url');
        return `${header}.${forged}.${signature}`;
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('AUTHFN_OAUTH_CALLBACK_INVALID');
    });

    it('accepts a correctly signed token', async () => {
      const response = await completeNative((nonce) => createIdToken(claims(nonce)));
      expect(response.status).toBe(200);
    });
  });

  describe('return targets with custom schemes', () => {
    // Security audit AF-04: every non-http URL has the origin "null", so an
    // allowlisted custom-scheme entry used to accept any custom scheme.
    async function start(returnTo: string, allowlistedReturnTo: string[]) {
      const auth = createTestServer({
        database: memoryAdapter({ debug: false }),
        namespace: 'authfn',
        plugins: [authFnSocialOAuthPlugin()],
        pluginRuntime: {
          socialOAuth: {
            providers: {
              apple: {
                clientId: 'apple-client-id',
                nativeClientIds: ['io.nucleum'],
                clientSecretResolver: async () => ({ clientSecret: 'generated-apple-client-secret' }),
                allowlistedReturnTo
              }
            }
          }
        }
      });
      return auth.router.handle(
        new Request('https://account.example.com/auth/social/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'apple', returnTo })
        })
      );
    }

    it.each([
      'evilapp://steal',
      'evilapp://oauthsignin',
      'exampleapp://other-host',
      'javascript:alert(document.domain)//',
      'data:text/html,hello',
      'file:///etc/passwd'
    ])('refuses %s when only exampleapp://oauthsignin is allowlisted', async (returnTo) => {
      const response = await start(returnTo, ['exampleapp://oauthsignin', 'https://app.example.com']);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('AUTHFN_REDIRECT_URI_DISALLOWED');
    });

    it.each([
      'exampleapp://oauthsignin',
      'exampleapp://oauthsignin/done?x=1',
      'https://app.example.com/after-sign-in'
    ])('accepts %s', async (returnTo) => {
      const response = await start(returnTo, ['exampleapp://oauthsignin', 'https://app.example.com']);
      expect(response.status).toBe(200);
    });

    it('matches a host-less custom-scheme entry only exactly', async () => {
      expect((await start('myapp:callback', ['myapp:callback'])).status).toBe(200);
      expect((await start('myapp:other', ['myapp:callback'])).status).toBe(400);
      expect((await start('otherapp:callback', ['myapp:'])).status).toBe(400);
    });

    it('accepts a relative path only when it is listed exactly and stays on the site', async () => {
      expect((await start('/post-auth', ['/post-auth'])).status).toBe(200);
      expect((await start('/elsewhere', ['/post-auth'])).status).toBe(400);
      expect((await start('//evil.example/post-auth', ['//evil.example/post-auth'])).status).toBe(400);
      expect((await start('/\\evil.example', ['/\\evil.example'])).status).toBe(400);
    });

    it('refuses a script scheme even when it is allowlisted exactly', async () => {
      const response = await start('javascript:alert(1)', ['javascript:alert(1)']);
      expect(response.status).toBe(400);
    });
  });
});

function createResponse(input: { status: number; body: string; contentType?: string }) {
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') {
          return input.contentType ?? 'application/json';
        }
        return null;
      }
    },
    async text() {
      return input.body;
    }
  };
}
