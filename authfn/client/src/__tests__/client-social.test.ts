import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import {
  authFnSocialOAuthPlugin,
  createAuthFn,
  type AuthFnConfig
} from '../../../core/src/index.js';
import { createAuthFnClient } from '../index.js';

function createConfig(): AuthFnConfig {
  return {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [
      authFnSocialOAuthPlugin({
        providers: {
          google: {
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            allowlistedReturnTo: ['https://app.example.com/post-auth']
          }
        },
        fetcher: async () => {
          throw new Error('social start should not exchange tokens');
        }
      })
    ]
  };
}

describe('@authfn/client social flows', () => {
  it('starts social sign-in and returns the redirect envelope', async () => {
    const auth = createAuthFn(createConfig());

    const client = createAuthFnClient({
      baseUrl: 'https://account.example.com/auth',
      fetch: async (input, init) =>
        auth.router.handle(
          new Request(typeof input === 'string' ? input : input.toString(), {
            method: init?.method,
            headers: init?.headers,
            body: init?.body
          })
        )
    });

    const started = await client.startSocialSignIn({
      provider: 'google',
      returnTo: 'https://app.example.com/post-auth'
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      throw new Error('social start should have succeeded');
    }

    expect(started.data).toEqual({
      provider: 'google',
      redirectTo: expect.stringContaining('https://accounts.google.com/o/oauth2/v2/auth'),
      stateId: expect.any(String),
      expiresAt: expect.any(String)
    });
  });
});
