import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthFnRuntimeConfig } from 'authfn';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import { authFnTwoFactorPlugin } from '@authfn/two-factor';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import {
  createAuthFnClient,
  createAuthFnRegionalClient,
  createBrowserHandoff,
  createMemoryHandoffStore,
  createRegionalHandoffExchange,
  type AuthFnBrowserHandoffStore
} from '../index.js';

const APP = 'https://app.example.com';
const TEST_NOW = new Date('2026-11-26T00:00:00.000Z');
const TEST_2FA_KEY = Buffer.alloc(32, 7);
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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

function generateTotp(secret: string, now: Date = TEST_NOW): string {
  const counter = Math.floor(now.getTime() / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

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

function createAuthServer(input: { twoFactor?: boolean } = {}) {
  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: input.twoFactor ? [authFnSocialOAuthPlugin(), authFnTwoFactorPlugin()] : [authFnSocialOAuthPlugin()],
    pluginRuntime: {
      ...(input.twoFactor
        ? {
            twoFactor: {
              issuer: 'authfn-client-tests',
              now: () => TEST_NOW,
              encryptionKeyResolver: () => TEST_2FA_KEY
            }
          }
        : {}),
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
  return createTestServer(config);
}

type TestServer = ReturnType<typeof createAuthServer>;

const fetchVia = (auth: TestServer) => async (input: RequestInfo | URL, init?: RequestInit) =>
  auth.router.handle(new Request(String(input), {
    method: init?.method,
    headers: init?.headers,
    body: init?.body
  }));

function createServerAndClient(input: { twoFactor?: boolean } = {}) {
  const auth = createAuthServer(input);
  const client = createAuthFnClient({ baseUrl: 'https://account.example.com/auth', fetch: fetchVia(auth) });
  return { auth, client };
}

/** Runs the provider callback for a started sign-in and returns where it redirects. */
async function runCallback(auth: TestServer, baseUrl: string, stateId: string): Promise<string> {
  const callback = await auth.router.handle(new Request(
    `${baseUrl}/social/callback/google?code=test-provider-code&state=${encodeURIComponent(stateId)}`
  ));
  expect(callback.status).toBe(303);
  return callback.headers.get('location')!;
}

/**
 * Signs the provider's user in with a cookie (no handoff), which creates the
 * account, and enrolls a TOTP second factor. Returns the TOTP secret.
 */
async function enrollTwoFactor(auth: TestServer, baseUrl: string): Promise<string> {
  const jar = new Map<string, string>();
  const remember = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('=')).trim();
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value) {
        jar.set(name, value);
      } else {
        jar.delete(name);
      }
    }
  };
  const cookieHeader = () => Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
  const account = createAuthFnClient({
    baseUrl,
    cookieAccessor: cookieHeader,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookieHeader());
      const response = await auth.router.handle(new Request(String(input), { method: init?.method, headers, body: init?.body }));
      remember(response);
      return response;
    }
  });
  const cookieStart = await account.startSocialSignIn({ provider: 'google', returnTo: `${APP}/signed-in`, callbackMode: 'redirect' });
  if (!cookieStart.ok) {
    throw new Error(`social start failed: ${cookieStart.error.code}`);
  }
  remember(await auth.router.handle(new Request(
    `${baseUrl}/social/callback/google?code=test-provider-code&state=${encodeURIComponent(cookieStart.data.stateId)}`
  )));
  const enrollment = await account.enableTwoFactor();
  if (!enrollment.ok) {
    throw new Error(`2fa enrollment failed: ${enrollment.error.code}`);
  }
  expect((await account.confirmTwoFactor({ code: generateTotp(enrollment.data.secret) })).ok).toBe(true);
  return enrollment.data.secret;
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

describe('createBrowserHandoff with two-factor and regional AuthFn servers', () => {
  it('returns the two-factor challenge the social callback redirects with, and retires the handoff', async () => {
    const { auth, client } = createServerAndClient({ twoFactor: true });
    const baseUrl = 'https://account.example.com/auth';

    await enrollTwoFactor(auth, baseUrl);

    const store = createMemoryHandoffStore();
    const options = { store, allowedOrigins: [APP], exchange: client.exchangeSocialHandoff };
    const begun = await createBrowserHandoff(options).begin({ returnTo: `${APP}/post-auth` });
    const started = await client.startSocialSignIn({ provider: 'google', ...begun.start });
    if (!started.ok) {
      throw new Error(`social start failed: ${started.error.code}`);
    }
    const location = await runCallback(auth, baseUrl, started.data.stateId);

    expect(new URL(location).searchParams.get('authfnCode')).toBe('AUTHFN_2FA_REQUIRED');
    expect(await createBrowserHandoff(options).complete(location)).toEqual({
      status: 'two-factor-required',
      handoffId: begun.handoffId,
      challengeId: expect.any(String),
      primaryMethod: 'oauth-google',
      cleanUrl: `${APP}/post-auth`
    });
    expect(await createBrowserHandoff(options).complete(location)).toMatchObject({
      status: 'failed',
      reason: 'already-used'
    });
  });

  /** Two AuthFn regions behind real regional clients; each page builds a new client in region us. */
  function setupRegions(input: { twoFactor?: boolean } = {}) {
    const servers: Record<string, TestServer> = {
      us: createAuthServer(input),
      eu: createAuthServer(input)
    };
    const requests: string[] = [];
    const baseUrlOf = (regionId: string) => `https://${regionId}.account.example.com/auth`;
    const clientOptions = {
      fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(request));
        requests.push(`${url.host}${url.pathname}`);
        return fetchVia(servers[url.host.split('.')[0]!]!)(request, init);
      }
    };
    const regionalClient = () => createAuthFnRegionalClient({
      defaultRegionId: 'us',
      resolveBaseUrl: baseUrlOf,
      storage: { get: async () => null, set: async () => undefined, delete: async () => undefined },
      clientOptions
    });
    const handoffFor = (client: ReturnType<typeof regionalClient>, store: AuthFnBrowserHandoffStore) =>
      createBrowserHandoff({
        store,
        allowedOrigins: [APP],
        exchange: createRegionalHandoffExchange({ regionalClient: client, resolveBaseUrl: baseUrlOf, clientOptions })
      });
    /** Begins in region eu and returns where eu's callback redirects. */
    const beginInEu = async (store: AuthFnBrowserHandoffStore) => {
      const before = regionalClient();
      before.setCurrentRegionId('eu');
      const begun = await handoffFor(before, store)
        .begin({ returnTo: `${APP}/post-auth`, regionId: before.getCurrentRegionId() });
      const started = await before.startSocialSignIn({ provider: 'google', ...begun.start });
      if (!started.ok) {
        throw new Error(`social start failed: ${started.error.code}`);
      }
      return { begun, location: await runCallback(servers.eu!, baseUrlOf('eu'), started.data.stateId) };
    };
    return { servers, requests, baseUrlOf, regionalClient, handoffFor, beginInEu };
  }

  it('exchanges in the region the sign-in began in after a reload starts in the default region', async () => {
    const { requests, regionalClient, handoffFor, beginInEu } = setupRegions();
    const store = createMemoryHandoffStore();
    const { begun, location } = await beginInEu(store);

    // The page after the redirect builds a new client, back in region us.
    const after = regionalClient();
    expect(after.getCurrentRegionId()).toBe('us');
    const result = await handoffFor(after, store).complete(location);

    expect(result).toMatchObject({ status: 'completed', handoffId: begun.handoffId });
    expect(requests.filter((request) => request.endsWith('/social/handoff/exchange')))
      .toEqual(['eu.account.example.com/auth/social/handoff/exchange']);
    // The session lives in eu, so the client continues there.
    expect(after.getCurrentRegionId()).toBe('eu');
  });

  it('returns the issuing region with a two-factor challenge, so it completes there after a reload', async () => {
    const { servers, requests, baseUrlOf, regionalClient, handoffFor, beginInEu } = setupRegions({ twoFactor: true });
    const secret = await enrollTwoFactor(servers.eu!, baseUrlOf('eu'));
    const store = createMemoryHandoffStore();
    const { begun, location } = await beginInEu(store);
    expect(new URL(location).searchParams.get('authfnCode')).toBe('AUTHFN_2FA_REQUIRED');

    const after = regionalClient();
    expect(after.getCurrentRegionId()).toBe('us');
    const result = await handoffFor(after, store).complete(location);
    expect(result).toMatchObject({
      status: 'two-factor-required',
      handoffId: begun.handoffId,
      regionId: 'eu',
      challengeId: expect.any(String)
    });
    if (result.status !== 'two-factor-required' || !result.regionId) {
      throw new Error('expected a two-factor result with a region');
    }

    // As documented: select the challenge's region, then complete it.
    after.setCurrentRegionId(result.regionId);
    const completed = await after.completeTwoFactorChallenge({
      challengeId: result.challengeId,
      // The enrollment used the current time step, which cannot be replayed.
      code: generateTotp(secret, new Date(TEST_NOW.getTime() + 30_000))
    });
    expect(completed).toMatchObject({ ok: true });
    expect(requests.filter((request) => request.endsWith('/2fa/challenge')))
      .toEqual(['eu.account.example.com/auth/2fa/challenge']);
  });
});
