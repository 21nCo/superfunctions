import { describe, expect, it } from 'vitest';
import type { AuthFnRuntimeConfig } from 'authfn';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import {
  createAuthFnClient,
  createBrowserHandoff,
  createMemoryHandoffStore,
  type AuthFnBrowserHandoffStore
} from '../index.js';

const APP = 'https://app.example.com';

function createIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

/** Stands in for Google's token endpoint, so no provider sign-in is needed. */
async function googleTokenFetcher(url: string) {
  if (url !== 'https://oauth2.googleapis.com/token') {
    throw new Error(`unexpected fetch: ${url}`);
  }
  const body = JSON.stringify({
    access_token: 'test-google-access-token',
    token_type: 'Bearer',
    scope: 'openid email profile',
    id_token: createIdToken({
      sub: 'google-user-handoff',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada Lovelace'
    })
  });
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => body
  };
}

function createServerAndClient() {
  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [authFnSocialOAuthPlugin()],
    pluginRuntime: {
      socialOAuth: {
        fetcher: googleTokenFetcher,
        providers: {
          google: {
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            // The handoff id travels in the return fragment, so the app's
            // origin is allowlisted rather than one exact URL.
            allowlistedReturnTo: [APP]
          }
        }
      }
    }
  };
  const auth = createTestServer(config);
  const client = createAuthFnClient({
    baseUrl: 'https://account.example.com/auth',
    fetch: async (input, init) => auth.router.handle(new Request(String(input), {
      method: init?.method,
      headers: init?.headers,
      body: init?.body
    }))
  });
  return { auth, client };
}

describe('createBrowserHandoff against the AuthFn social plugin', () => {
  it('completes once through the real start, callback redirect and single-use exchange', async () => {
    const { auth, client } = createServerAndClient();
    const store = createMemoryHandoffStore();
    // A copy of the store taken before the return stands in for a window
    // whose storage did not see the claim, so only the server can refuse it.
    const stale: AuthFnBrowserHandoffStore = createMemoryHandoffStore();
    const options = { allowedOrigins: [APP], exchange: client.exchangeSocialHandoff };
    const handoff = createBrowserHandoff({ store, ...options });

    const begun = await handoff.begin({ returnTo: `${APP}/post-auth` });
    const started = await client.startSocialSignIn({ provider: 'google', ...begun.start });
    if (!started.ok) {
      throw new Error(`social start failed: ${started.error.code}`);
    }
    for (const key of await store.keys()) {
      await stale.set(key, String(await store.get(key)));
    }
    const callback = await auth.router.handle(new Request(
      `https://account.example.com/auth/social/callback/google?code=test-provider-code&state=${encodeURIComponent(started.data.stateId)}`
    ));
    expect(callback.status).toBe(303);
    const location = callback.headers.get('location')!;
    expect(new URL(location).hash).toContain(`authfn_handoff=${begun.handoffId}`);
    expect(new URL(location).hash).toContain('handoff=code');

    const completed = await createBrowserHandoff({ store, ...options }).complete(location);
    expect(completed).toMatchObject({
      status: 'completed',
      handoffId: begun.handoffId,
      session: { actorType: 'user' },
      handoff: { type: 'session-token', token: expect.any(String) },
      cleanUrl: `${APP}/post-auth`
    });

    expect(await createBrowserHandoff({ store, ...options }).complete(location)).toMatchObject({
      status: 'failed',
      reason: 'already-used'
    });
    expect(await createBrowserHandoff({ store: stale, ...options }).complete(location)).toMatchObject({
      status: 'failed',
      reason: 'already-used',
      error: { code: 'AUTHFN_OAUTH_STATE_REPLAYED' }
    });
  });
});
