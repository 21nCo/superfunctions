import { describe, expect, it } from 'vitest';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import type { AuthFnRuntimeConfig } from '../index.js';

function createIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.signature`;
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

    // The token carries no `email_verified` claim, so the new account's email
    // is not marked verified.
    const user = await config.database.findOne({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: String(linked?.userId) }],
      namespace: 'authfn'
    });
    expect(user?.primaryEmail).toBe('ada.apple@example.com');
    expect(user?.emailVerifiedAt ?? null).toBeNull();
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
});

// Apple posts `user` through the browser unsigned, so a caller can put any
// email in it. These cases sign in with a token for one Apple ID (the
// "attacker") and an unsigned `user.email` naming someone else.
describe('authfn apple social oauth: email comes only from the verified identity token', () => {
  const VICTIM_EMAIL = 'victim@example.com';
  const ATTACKER_EMAIL = 'attacker@example.net';

  function createAppleConfig(options: { linkByVerifiedEmail?: boolean } = {}): AuthFnRuntimeConfig {
    return {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      ...(options.linkByVerifiedEmail
        ? { accountLinking: { oauthByVerifiedEmail: { providers: ['apple'], requireProviderEmailVerified: true } } }
        : {}),
      plugins: [authFnSocialOAuthPlugin()],
      pluginRuntime: {
        socialOAuth: {
          providers: {
            apple: {
              clientId: 'apple-client-id',
              nativeClientIds: ['io.example.app'],
              clientSecretResolver: async () => ({ clientSecret: 'test-apple-client-secret' }),
              allowlistedReturnTo: ['https://app.example.com/apple-post-auth']
            }
          },
          fetcher: async () => {
            throw new Error('token exchange should not be called for Apple identity tokens');
          }
        }
      }
    } as AuthFnRuntimeConfig;
  }

  async function createVerifiedUser(config: AuthFnRuntimeConfig, email: string): Promise<string> {
    const id = `user_seed_${email.split('@')[0]}`;
    const now = new Date();
    await config.database.create({
      model: 'users',
      namespace: 'authfn',
      data: { id, primaryEmail: email, emailVerifiedAt: now, createdAt: now, updatedAt: now }
    });
    return id;
  }

  async function findUser(config: AuthFnRuntimeConfig, id: string) {
    return config.database.findOne<Record<string, unknown>>({
      model: 'users',
      where: [{ field: 'id', operator: 'eq', value: id }],
      namespace: 'authfn'
    });
  }

  async function findAppleAccount(config: AuthFnRuntimeConfig, subject: string) {
    return config.database.findOne<Record<string, unknown>>({
      model: 'oauth_accounts',
      where: [
        { field: 'provider', operator: 'eq', value: 'apple' },
        { field: 'providerAccountId', operator: 'eq', value: subject }
      ],
      namespace: 'authfn'
    });
  }

  async function formPostCallback(
    auth: ReturnType<typeof createTestServer>,
    claims: Record<string, unknown>,
    user: Record<string, unknown>
  ): Promise<Response> {
    const start = await auth.router.handle(
      new Request('https://account.example.com/auth/social/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'apple', returnTo: 'https://app.example.com/apple-post-auth' })
      })
    );
    const startBody = await start.json();
    const nonce = new URL(startBody.data.redirectTo).searchParams.get('nonce');
    return auth.router.handle(
      new Request('https://account.example.com/auth/social/callback/apple', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          state: startBody.data.stateId,
          id_token: createIdToken({ iss: 'https://appleid.apple.com', aud: 'apple-client-id', nonce, ...claims }),
          user: JSON.stringify(user)
        })
      })
    );
  }

  async function nativeComplete(
    auth: ReturnType<typeof createTestServer>,
    claims: Record<string, unknown>,
    user?: Record<string, unknown>
  ): Promise<Response> {
    const start = await auth.router.handle(
      new Request('https://account.example.com/auth/social/native/apple/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
    );
    const startBody = await start.json();
    return auth.router.handle(
      new Request('https://account.example.com/auth/social/native/apple/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stateId: startBody.data.stateId,
          identityToken: createIdToken({
            iss: 'https://appleid.apple.com',
            aud: 'io.example.app',
            nonce: startBody.data.nonce,
            ...claims
          }),
          ...(user ? { user } : {})
        })
      })
    );
  }

  it('form_post ignores an unsigned user.email and does not link to the account it names', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);
    const victimId = await createVerifiedUser(config, VICTIM_EMAIL);

    const callback = await formPostCallback(
      auth,
      { sub: 'apple-attacker-01', email: ATTACKER_EMAIL, email_verified: 'true' },
      { email: VICTIM_EMAIL, name: { firstName: 'Form', lastName: 'Post' } }
    );
    expect(callback.status).toBe(303);

    const linked = await findAppleAccount(config, 'apple-attacker-01');
    expect(linked?.userId).not.toBe(victimId);
    expect(linked?.email).toBe(ATTACKER_EMAIL);
    expect(linked?.profile).toMatchObject({ name: 'Form Post' });
    const user = await findUser(config, String(linked?.userId));
    expect(user?.primaryEmail).toBe(ATTACKER_EMAIL);
  });

  it('form_post does not create an account under an unsigned user.email', async () => {
    const config = createAppleConfig();
    const auth = createTestServer(config);

    const callback = await formPostCallback(
      auth,
      { sub: 'apple-attacker-02', email: ATTACKER_EMAIL, email_verified: 'true' },
      { email: 'unregistered@example.org' }
    );
    expect(callback.status).toBe(303);

    const linked = await findAppleAccount(config, 'apple-attacker-02');
    const user = await findUser(config, String(linked?.userId));
    expect(user?.primaryEmail).toBe(ATTACKER_EMAIL);
    await expect(config.database.findOne({
      model: 'users',
      where: [{ field: 'primaryEmail', operator: 'eq', value: 'unregistered@example.org' }],
      namespace: 'authfn'
    })).resolves.toBeNull();
  });

  it('form_post refuses a token without an email claim even when user.email is present', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);
    await createVerifiedUser(config, VICTIM_EMAIL);

    const callback = await formPostCallback(auth, { sub: 'apple-attacker-03' }, { email: VICTIM_EMAIL });
    expect(callback.status).toBe(303);
    const redirectTo = new URL(callback.headers.get('location')!);
    expect(redirectTo.searchParams.get('auth_error_code')).toBe('AUTHFN_OAUTH_CALLBACK_INVALID');
    await expect(findAppleAccount(config, 'apple-attacker-03')).resolves.toBeNull();
  });

  it('form_post treats a token email without email_verified as unverified', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);
    const victimId = await createVerifiedUser(config, VICTIM_EMAIL);

    const linking = await formPostCallback(auth, { sub: 'apple-user-unverified-01', email: VICTIM_EMAIL }, {});
    expect(linking.status).toBe(303);
    expect(new URL(linking.headers.get('location')!).searchParams.get('auth_error')).toBeTruthy();
    await expect(findAppleAccount(config, 'apple-user-unverified-01')).resolves.toBeNull();
    expect((await findUser(config, victimId))?.primaryEmail).toBe(VICTIM_EMAIL);

    const created = await formPostCallback(auth, { sub: 'apple-user-unverified-02', email: 'new.user@example.com' }, {});
    expect(created.status).toBe(303);
    const linked = await findAppleAccount(config, 'apple-user-unverified-02');
    const user = await findUser(config, String(linked?.userId));
    expect(user?.primaryEmail).toBe('new.user@example.com');
    expect(user?.emailVerifiedAt ?? null).toBeNull();
  });

  it('native ignores an unsigned user.email when the token has no email claim', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);
    const victimId = await createVerifiedUser(config, VICTIM_EMAIL);

    const complete = await nativeComplete(
      auth,
      { sub: 'apple-attacker-native-01' },
      { email: VICTIM_EMAIL, name: { firstName: 'Native', lastName: 'Apple' } }
    );
    const body = await complete.json();
    expect(complete.status).toBe(200);
    expect(body.data.userId).not.toBe(victimId);
    expect(body.data.isNewUser).toBe(true);

    const user = await findUser(config, body.data.userId);
    expect(user?.primaryEmail ?? null).toBeNull();
    expect(user?.emailVerifiedAt ?? null).toBeNull();
    const linked = await findAppleAccount(config, 'apple-attacker-native-01');
    expect(linked?.userId).toBe(body.data.userId);
    expect(linked?.email ?? null).toBeNull();
    expect(linked?.profile).toMatchObject({ name: 'Native Apple' });
  });

  it('native ignores an unsigned user.email that differs from the token email', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);
    const victimId = await createVerifiedUser(config, VICTIM_EMAIL);

    const complete = await nativeComplete(
      auth,
      { sub: 'apple-attacker-native-02', email: ATTACKER_EMAIL, email_verified: true },
      { email: VICTIM_EMAIL }
    );
    const body = await complete.json();
    expect(complete.status).toBe(200);
    expect(body.data.userId).not.toBe(victimId);
    expect((await findUser(config, body.data.userId))?.primaryEmail).toBe(ATTACKER_EMAIL);
  });

  it('native still signs in an already linked Apple ID whose token has no email claim', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);

    const first = await (await nativeComplete(
      auth,
      { sub: 'apple-user-native-03', email: 'native.user@example.com', email_verified: 'true', is_private_email: 'true' },
      { name: { firstName: 'Native', lastName: 'User' } }
    )).json();
    expect(first.data.isNewUser).toBe(true);
    expect((await findUser(config, first.data.userId))?.emailVerifiedAt).toBeTruthy();

    const again = await nativeComplete(auth, { sub: 'apple-user-native-03' }, { email: VICTIM_EMAIL });
    const againBody = await again.json();
    expect(again.status).toBe(200);
    expect(againBody.data.userId).toBe(first.data.userId);
    expect(againBody.data.isNewUser).toBe(false);

    // The stored email and profile survive a token that carries no email.
    const linked = await findAppleAccount(config, 'apple-user-native-03');
    expect(linked?.email).toBe('native.user@example.com');
    expect(linked?.profile).toMatchObject({
      email: 'native.user@example.com',
      emailVerified: true,
      isPrivateEmail: true,
      name: 'Native User'
    });
    expect((await findUser(config, first.data.userId))?.primaryEmail).toBe('native.user@example.com');
  });

  it('links by verified email when the verified token email matches an existing account', async () => {
    const config = createAppleConfig({ linkByVerifiedEmail: true });
    const auth = createTestServer(config);
    const ownerId = await createVerifiedUser(config, VICTIM_EMAIL);

    const callback = await formPostCallback(
      auth,
      { sub: 'apple-owner-01', email: VICTIM_EMAIL, email_verified: 'true' },
      { email: 'someone.else@example.org' }
    );
    expect(callback.status).toBe(303);
    expect((await findAppleAccount(config, 'apple-owner-01'))?.userId).toBe(ownerId);
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
