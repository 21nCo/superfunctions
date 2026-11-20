import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestServer } from './test-server.js';
import { memoryAdapter } from '../../../../packages/db/src/testing/index.js';
import { authFnApiKeyPlugin } from '@authfn/api-keys';
import { authFnMultiRegionEnvironment, authFnMultiRegionPlugin } from '@authfn/multi-region';
import { authFnNativeHandoffPlugin, sanitizeReturnTo } from '@authfn/native-handoff';
import { authFnPasswordPlugin } from '@authfn/password';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import type { SocialOAuthPluginConfig } from '@authfn/social-oauth';
import type { AuthFnRuntimeConfig } from '../index.js';
import { issueSessionCookies } from '../core/cookies.js';
import { createAuthFnRateLimitMiddleware } from '../core/rate-limit.js';
import { issueSession } from '../core/sessions.js';
import { createUser } from '../core/users.js';
import { satisfyTwoFactorChallenge } from '../core/two-factor.js';

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.slice(0, cookie.indexOf(';')))
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

describe('web handoff return target (F-09)', () => {
  it.each([
    ['/\\evil.example/x', '/'],
    ['\\\\evil.example', '/'],
    ['//evil.example', '/'],
    ['/\tevil', '/'],
    ['https://evil.example/path?q=1#h', '/path?q=1#h'],
    ['javascript:alert(1)', '/'],
    ['/settings?tab=account', '/settings?tab=account'],
    ['', '/']
  ])('reduces %j to %j', (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });
});

describe('web handoff consume navigation (F-08)', () => {
  function createConfig(): AuthFnRuntimeConfig {
    return {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      environment: authFnMultiRegionEnvironment({
        regions: [
          {
            regionId: 'us-east-1',
            authority: 'https://us.account.example.com',
            hosts: ['us.account.example.com']
          }
        ]
      }),
      plugins: [authFnPasswordPlugin(), authFnMultiRegionPlugin(), authFnNativeHandoffPlugin()]
    };
  }

  async function mintConsumeUrl(auth: ReturnType<typeof createTestServer>, email: string) {
    const signUp = await auth.router.handle(new Request('https://us.account.example.com/auth/sign-up/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Sup3rSecurePassphrase!', sessionMode: 'hybrid' })
    }));
    const token = (await signUp.json()).data.token as string;
    const start = await auth.router.handle(new Request('https://us.account.example.com/auth/handoff/web/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ returnTo: '/\\evil.example/x' })
    }));
    expect(start.status).toBe(200);
    return (await start.json()).data.consumeUrl as string;
  }

  it('refuses a consume URL reached from another site and keeps the code usable', async () => {
    const auth = createTestServer(createConfig());
    const consumeUrl = await mintConsumeUrl(auth, 'attacker@example.com');

    for (const fetchSite of ['cross-site', 'same-site']) {
      const refused = await auth.router.handle(new Request(consumeUrl, {
        headers: { 'sec-fetch-site': fetchSite }
      }));
      expect(refused.status).toBe(400);
      expect(refused.headers.getSetCookie()).toHaveLength(0);
    }

    const direct = await auth.router.handle(new Request(consumeUrl, {
      headers: { 'sec-fetch-site': 'none' }
    }));
    expect(direct.status).toBe(302);
    expect(direct.headers.get('location')).toBe('/');
    expect(direct.headers.getSetCookie()).toHaveLength(2);
  });
});

describe('web handoff verifier and route toggle (F-08)', () => {
  function createConfig(webHandoff?: boolean): AuthFnRuntimeConfig {
    return {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      environment: authFnMultiRegionEnvironment({
        regions: [{ regionId: 'us-east-1', authority: 'https://us.account.example.com', hosts: ['us.account.example.com'] }]
      }),
      plugins: [authFnPasswordPlugin(), authFnMultiRegionPlugin(), authFnNativeHandoffPlugin({ webHandoff })]
    };
  }

  async function bearer(auth: ReturnType<typeof createTestServer>) {
    const signUp = await auth.router.handle(new Request('https://us.account.example.com/auth/sign-up/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'verifier@example.com', password: 'Sup3rSecurePassphrase!', sessionMode: 'hybrid' })
    }));
    return (await signUp.json()).data.token as string;
  }

  it('requires the verifier header when the code was minted with a challenge', async () => {
    const auth = createTestServer(createConfig());
    const token = await bearer(auth);
    const verifier = 'test-web-verifier-'.padEnd(64, 'w');
    const start = await auth.router.handle(new Request('https://us.account.example.com/auth/handoff/web/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ verifierChallenge: createHash('sha256').update(verifier).digest('base64url') })
    }));
    const consumeUrl = (await start.json()).data.consumeUrl as string;

    const withoutVerifier = await auth.router.handle(new Request(consumeUrl, { headers: { 'sec-fetch-site': 'none' } }));
    expect(withoutVerifier.status).toBe(400);
    const withVerifier = await auth.router.handle(new Request(consumeUrl, {
      headers: { 'sec-fetch-site': 'none', 'x-authfn-handoff-verifier': verifier }
    }));
    expect(withVerifier.status).toBe(302);
  });

  it('requires a verifier on every web handoff when requireWebHandoffVerifier is set', async () => {
    const config = createConfig();
    config.plugins = [authFnPasswordPlugin(), authFnMultiRegionPlugin(), authFnNativeHandoffPlugin({ requireWebHandoffVerifier: true })];
    const auth = createTestServer(config);
    const token = await bearer(auth);
    const unbound = await auth.router.handle(new Request('https://us.account.example.com/auth/handoff/web/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}'
    }));
    expect(unbound.status).toBe(400);
  });

  it('does not register the web handoff routes when webHandoff is false', async () => {
    const auth = createTestServer(createConfig(false));
    const token = await bearer(auth);
    const start = await auth.router.handle(new Request('https://us.account.example.com/auth/handoff/web/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}'
    }));
    const unknownRoute = await auth.router.handle(new Request('https://us.account.example.com/auth/no-such-route', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}'
    }));
    expect(start.ok).toBe(false);
    expect(start.status).toBe(unknownRoute.status);
  });
});

describe('two-factor challenge attempts (F-11)', () => {
  it('limits verification attempts per challenge', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn-2fa-limit',
      plugins: [],
      rateLimit: { enabled: true, mode: 'local' }
    };
    const middleware = createAuthFnRateLimitMiddleware(config)!;
    const attempt = (challengeId: string, ip: string) => middleware(
      new Request('https://account.example.com/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ challengeId, code: '000000' })
      }),
      {} as never,
      async () => new Response('ok')
    );

    for (let index = 0; index < 5; index += 1) {
      expect((await attempt('chal_test', `198.51.100.${index}`)).status).toBe(200);
    }
    await expect(attempt('chal_test', '198.51.100.99')).rejects.toMatchObject({
      code: 'AUTHFN_RATE_LIMITED',
      details: expect.objectContaining({ scope: 'two-factor', dimension: 'identifier' })
    });
    expect((await attempt('chal_other', '198.51.100.99')).status).toBe(200);
  });

  it('ignores extra body fields and trailing slashes when counting challenge attempts', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn-2fa-bypass',
      plugins: [],
      rateLimit: { enabled: true, mode: 'local' }
    };
    const middleware = createAuthFnRateLimitMiddleware(config)!;
    const attempt = (index: number) => middleware(
      new Request(`https://account.example.com/auth/2fa/challenge${index % 2 ? '/' : ''}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${index}` },
        body: JSON.stringify({
        challengeId: index % 3 === 0 ? 'chal_bypass' : index % 3 === 1 ? ' CHAL_BYPASS' : 'Chal_Bypass ',
        code: '000000',
        email: `random-${index}@example.com`
      })
      }),
      {} as never,
      async () => new Response('ok')
    );
    for (let index = 0; index < 5; index += 1) {
      expect((await attempt(index)).status).toBe(200);
    }
    await expect(attempt(5)).rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
  });

  it('refuses non-canonical challenge ids before looking them up', async () => {
    const config: AuthFnRuntimeConfig = { database: memoryAdapter({ debug: false }), namespace: 'authfn', plugins: [] };
    for (const challengeId of ['SIGNIN_2FA_ABC', 'chál_x', ' signin_2fa_abc']) {
      await expect(satisfyTwoFactorChallenge(config, challengeId, '000000')).rejects.toMatchObject({
        code: 'AUTHFN_2FA_INVALID_CODE'
      });
    }
  });

  it('counts non-ASCII challenge ids together', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn-2fa-accent',
      plugins: [],
      rateLimit: { enabled: true, mode: 'local' }
    };
    const middleware = createAuthFnRateLimitMiddleware(config)!;
    const attempt = (challengeId: string, index: number) => middleware(
      new Request('https://account.example.com/auth/2fa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `192.0.2.${index}` },
        body: JSON.stringify({ challengeId, code: '000000' })
      }),
      {} as never,
      async () => new Response('ok')
    );
    const variants = ['chál_x', 'chàl_x', 'châl_x', 'chäl_x', 'chãl_x'];
    for (let index = 0; index < variants.length; index += 1) {
      expect((await attempt(variants[index], index)).status).toBe(200);
    }
    await expect(attempt('chål_x', 9)).rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
  });

  it('limits /2fa/disable attempts per session', async () => {
    const config: AuthFnRuntimeConfig = {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn-2fa-disable',
      plugins: [],
      rateLimit: { enabled: true, mode: 'local' }
    };
    const middleware = createAuthFnRateLimitMiddleware(config)!;
    const attempt = (index: number) => middleware(
      new Request('https://account.example.com/auth/2fa/disable', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': `203.0.113.${index}`,
          cookie: index % 2
            ? `__Secure-authfn.session=junk-${index}; __Secure-authfn.session=test-session-token`
            : `__Secure-authfn.session=${index === 0 ? 'test-session-token' : 'test-session-%74oken'}`,
          authorization: `Bearer test-other-${index}`
        },
        body: JSON.stringify({ code: '000000' })
      }),
      {} as never,
      async () => new Response('ok')
    );
    for (let index = 0; index < 5; index += 1) {
      expect((await attempt(index)).status).toBe(200);
    }
    await expect(attempt(5)).rejects.toMatchObject({ code: 'AUTHFN_RATE_LIMITED' });
  });
});

describe('API key creation policy (F-13)', () => {
  const now = new Date('2026-03-22T00:00:00.000Z');

  function createConfig(pluginConfig: Parameters<typeof authFnApiKeyPlugin>[0]): AuthFnRuntimeConfig {
    return {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      scopes: { skills: ['read'] },
      plugins: [authFnApiKeyPlugin(pluginConfig)],
      pluginRuntime: { apiKey: { now: () => now } }
    };
  }

  let userCount = 0;

  async function sessionHeaders(config: AuthFnRuntimeConfig, createdAt: Date, metadata?: Record<string, unknown>) {
    userCount += 1;
    const user = await createUser(config, { primaryEmail: `key-owner-${userCount}@example.com` });
    const issued = await issueSession(config, {}, {
      request: new Request('https://account.example.com/auth/session'),
      userId: user.id,
      primaryEmail: user.primaryEmail,
      methods: ['password'],
      metadata
    });
    await config.database.update({
      model: 'sessions',
      where: [{ field: 'id', operator: 'eq', value: issued.session.id }],
      data: { createdAt },
      namespace: 'authfn'
    });
    return {
      cookie: cookieHeaderFromSetCookies(
        Object.values(issueSessionCookies(issued.cookiePolicy!, issued.sessionToken, issued.csrfToken))
      ),
      'content-type': 'application/json',
      'x-authfn-csrf': issued.csrfToken
    };
  }

  async function createKey(config: AuthFnRuntimeConfig, headers: Record<string, string>, body: Record<string, unknown>) {
    return createTestServer(config).router.handle(new Request('https://account.example.com/auth/api-keys', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }));
  }

  it('requires a recent sign-in that was not issued by a handoff', async () => {
    const config = createConfig({ recentAuthenticationSeconds: 600 });
    const stale = await createKey(config, await sessionHeaders(config, new Date(now.getTime() - 3_600_000)), { name: 'stale' });
    expect(stale.status).toBe(403);
    expect((await stale.json()).error.code).toBe('AUTHFN_REAUTHENTICATION_REQUIRED');

    const handoff = await createKey(
      config,
      await sessionHeaders(config, new Date(now.getTime() - 1000), { sourceSessionId: 'sess_source' }),
      { name: 'handoff' }
    );
    expect(handoff.status).toBe(403);

    const fresh = await createKey(config, await sessionHeaders(config, new Date(now.getTime() - 1000)), { name: 'fresh' });
    expect(fresh.status).toBe(201);
  });

  it('rejects invalid policy settings when the plugin is created', () => {
    expect(() => authFnApiKeyPlugin({ defaultExpiresInSeconds: 30 * 86_400, maxExpiresInSeconds: 7 * 86_400 })).toThrow(/must not exceed/);
    for (const value of [Number.NaN, 0, -1, 1.5]) {
      expect(() => authFnApiKeyPlugin({ recentAuthenticationSeconds: value })).toThrow(/positive whole number/);
      expect(() => authFnApiKeyPlugin({ maxExpiresInSeconds: value })).toThrow(/positive whole number/);
    }
  });

  it('applies a default expiry and refuses expiries past the maximum lifetime', async () => {
    const config = createConfig({ defaultExpiresInSeconds: 86_400, maxExpiresInSeconds: 7 * 86_400 });
    const headers = await sessionHeaders(config, now);

    const defaulted = await createKey(config, headers, { name: 'defaulted' });
    expect(defaulted.status).toBe(201);
    const keyId = (await defaulted.json()).data.keyId as string;
    const stored = await config.database.findOne<{ expiresAt: Date }>({
      model: 'api_keys',
      where: [{ field: 'id', operator: 'eq', value: keyId }],
      namespace: 'authfn'
    });
    expect(new Date(stored!.expiresAt).toISOString()).toBe('2026-03-23T00:00:00.000Z');

    const tooLong = await createKey(config, headers, { name: 'too-long', expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(tooLong.status).toBe(400);
  });
});

describe('social sign-in binding and handoff (F-08, F-10)', () => {
  function createIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  function createResponse(body: string) {
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      async text() {
        return body;
      }
    };
  }

  function createConfig(pluginConfig: SocialOAuthPluginConfig): AuthFnRuntimeConfig {
    return {
      database: memoryAdapter({ debug: false }),
      namespace: 'authfn',
      plugins: [authFnSocialOAuthPlugin(pluginConfig)],
      pluginRuntime: {
        socialOAuth: {
          fetcher: async (url: string) => {
            if (url !== 'https://oauth2.googleapis.com/token') throw new Error(`unexpected fetch: ${url}`);
            return createResponse(JSON.stringify({
              access_token: 'test-access-token',
              token_type: 'Bearer',
              scope: 'openid email profile',
              id_token: createIdToken({ sub: 'google-user-01', email: 'ada@example.com', email_verified: true })
            }));
          },
          providers: {
            google: {
              clientId: 'test-google-client-id',
              clientSecret: 'test-google-client-secret',
              allowlistedReturnTo: ['https://app.example.com/post-auth', 'nucleum://oauthsignin']
            }
          }
        }
      }
    };
  }

  async function start(auth: ReturnType<typeof createTestServer>, body: Record<string, unknown>) {
    return auth.router.handle(new Request('https://account.example.com/auth/social/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', ...body })
    }));
  }

  function callback(auth: ReturnType<typeof createTestServer>, stateId: string, cookie?: string) {
    return auth.router.handle(new Request(
      `https://account.example.com/auth/social/callback/google?code=test-code&state=${encodeURIComponent(stateId)}`,
      { headers: cookie ? { cookie } : {} }
    ));
  }

  it('only completes a browser-bound sign-in in the browser that started it', async () => {
    const auth = createTestServer(createConfig({ bindBrowserState: true }));
    const started = await start(auth, { returnTo: 'https://app.example.com/post-auth' });
    expect(started.status).toBe(200);
    const bindingCookie = started.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-authfn.oauth_binding.'));
    expect(bindingCookie).toMatch(/HttpOnly/i);
    expect(bindingCookie).toMatch(/Path=\//);
    expect(bindingCookie).not.toMatch(/Domain=/i);
    const stateId = (await started.json()).data.stateId as string;

    const otherBrowser = await callback(auth, stateId);
    expect(otherBrowser.status).toBe(303);
    expect(otherBrowser.headers.getSetCookie().some((cookie) => cookie.includes('oauth_binding.') && /Max-Age=0/i.test(cookie))).toBe(true);
    const errorTarget = new URL(otherBrowser.headers.get('location')!);
    expect(errorTarget.searchParams.get('auth_error_code')).toBe('AUTHFN_OAUTH_STATE_INVALID');
    expect(otherBrowser.headers.getSetCookie().some((cookie) => cookie.includes('.session='))).toBe(false);

    const secondStart = await start(auth, { returnTo: 'https://app.example.com/post-auth' });
    const secondStateId = (await secondStart.json()).data.stateId as string;
    const thirdStart = await start(auth, { returnTo: 'https://app.example.com/post-auth' });
    const browserCookies = cookieHeaderFromSetCookies([
      ...secondStart.headers.getSetCookie(),
      ...thirdStart.headers.getSetCookie()
    ]);
    const sameBrowser = await callback(auth, secondStateId, browserCookies);
    expect(sameBrowser.status).toBe(303);
    expect(sameBrowser.headers.get('location')).toBe('https://app.example.com/post-auth');
    expect(sameBrowser.headers.getSetCookie().some((cookie) => cookie.includes('.session='))).toBe(true);
  });

  it('binds JSON and session-token callbacks too, so no unbound callback sets session cookies', async () => {
    const events: string[] = [];
    const auth = createTestServer({ ...createConfig({ bindBrowserState: true }), observability: { events: { emit: async (event: { type: string }) => { events.push(event.type); } } } as never });
    for (const body of [
      { callbackMode: 'json' },
      { returnTo: 'nucleum://oauthsignin', handoffMode: 'session-token' }
    ]) {
      const started = await start(auth, body);
      expect(started.status).toBe(200);
      expect(started.headers.getSetCookie().some((cookie) => cookie.includes('oauth_binding.'))).toBe(true);
      const stateId = (await started.json()).data.stateId as string;
      const elsewhere = await callback(auth, stateId);
      expect(elsewhere.headers.getSetCookie().some((cookie) => cookie.includes('.session='))).toBe(false);
      expect(elsewhere.headers.getSetCookie().some((cookie) => cookie.includes('oauth_binding.') && /Max-Age=0/i.test(cookie))).toBe(true);
    }
    expect(events).toContain('authfn.request.failed');
  });

  it('binds a JSON session-token start even when it sends a handoff challenge', async () => {
    const auth = createTestServer(createConfig({ bindBrowserState: true }));
    const verifier = 'test-verifier-'.padEnd(64, 'v');
    const started = await start(auth, {
      callbackMode: 'json',
      handoffMode: 'session-token',
      handoffChallenge: createHash('sha256').update(verifier).digest('base64url')
    });
    expect(started.headers.getSetCookie().some((cookie) => cookie.includes('oauth_binding.'))).toBe(true);
    const elsewhere = await callback(auth, (await started.json()).data.stateId as string);
    expect(elsewhere.headers.getSetCookie().some((cookie) => cookie.includes('.session='))).toBe(false);
  });

  it('keeps the binding cookie Secure and SameSite=None on an https origin when session cookies are not secure', async () => {
    const config = createConfig({ bindBrowserState: true });
    const auth = createTestServer({ ...config, cookie: { secure: false } });
    const started = await start(auth, { returnTo: 'https://app.example.com/post-auth' });
    const binding = started.headers.getSetCookie().find((cookie) => cookie.includes('oauth_binding.'));
    expect(binding).toMatch(/^__Host-/);
    expect(binding).toMatch(/Secure/i);
    expect(binding).toMatch(/SameSite=None/i);
  });

  it('re-checks the handoff policy at the callback for states started under an older policy', async () => {
    const database = memoryAdapter({ debug: false });
    const lax = createTestServer({ ...createConfig({}), database });
    const strict = createTestServer({ ...createConfig({ requireHandoffChallenge: true }), database });
    const started = await start(lax, { returnTo: 'nucleum://oauthsignin' });
    const stateId = (await started.json()).data.stateId as string;
    const completed = await callback(strict, stateId);
    const location = completed.headers.get('location') ?? '';
    expect(location).not.toContain('token=st_');
    expect(completed.headers.getSetCookie().some((cookie) => cookie.includes('.session='))).toBe(false);
  });

  it('refuses handoff grants presented as OAuth states at the callback', async () => {
    const auth = createTestServer(createConfig({ requireHandoffChallenge: true }));
    const verifier = 'test-verifier-'.padEnd(64, 'v');
    const handoffChallenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await start(auth, { returnTo: 'nucleum://oauthsignin', handoffChallenge });
    const completed = await callback(auth, (await started.json()).data.stateId as string);
    const code = new URLSearchParams(new URL(completed.headers.get('location')!).hash.slice(1)).get('token')!;
    const grantStateId = `social-handoff:${createHash('sha256').update(code).digest('hex')}`;

    const misuse = await callback(auth, grantStateId);
    expect(misuse.ok).toBe(false);

    const exchanged = await auth.router.handle(new Request('https://account.example.com/auth/social/handoff/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, verifier })
    }));
    expect(exchanged.status).toBe(200);
  });

  it('refuses session-token handoff to web URLs and requires a handoff challenge when configured', async () => {
    const auth = createTestServer(createConfig({ allowWebSessionTokenHandoff: false, requireHandoffChallenge: true }));
    const web = await start(auth, { returnTo: 'https://app.example.com/post-auth', handoffMode: 'session-token' });
    expect(web.status).toBe(400);
    const nativeWithoutChallenge = await start(auth, { returnTo: 'nucleum://oauthsignin' });
    expect(nativeWithoutChallenge.status).toBe(400);
    const badChallenge = await start(auth, { returnTo: 'nucleum://oauthsignin', handoffChallenge: 'short' });
    expect(badChallenge.status).toBe(400);
    for (const handoffChallenge of ['', 42, null]) {
      const malformed = await start(createTestServer(createConfig({})), { returnTo: 'nucleum://oauthsignin', handoffChallenge });
      expect(malformed.status).toBe(400);
    }
  });

  it('returns a one-time code instead of a session token and exchanges it only with the verifier', async () => {
    const auth = createTestServer(createConfig({ requireHandoffChallenge: true }));
    const verifier = 'test-verifier-'.padEnd(64, 'v');
    const handoffChallenge = createHash('sha256').update(verifier).digest('base64url');
    const started = await start(auth, { returnTo: 'nucleum://oauthsignin', handoffChallenge });
    expect(started.status).toBe(200);
    const stateId = (await started.json()).data.stateId as string;

    const completed = await callback(auth, stateId);
    expect(completed.status).toBe(303);
    expect(completed.headers.getSetCookie().some((cookie) => cookie.includes('.session='))).toBe(false);
    const location = new URL(completed.headers.get('location')!);
    expect(`${location.protocol}//${location.host}`).toBe('nucleum://oauthsignin');
    const fragment = new URLSearchParams(location.hash.slice(1));
    const code = fragment.get('token')!;
    expect(code).toMatch(/^shc_/);
    expect(fragment.get('handoff')).toBe('code');
    expect(fragment.get('sessionId')).toBeNull();

    const exchange = (body: Record<string, unknown>) => auth.router.handle(
      new Request('https://account.example.com/auth/social/handoff/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    );

    const wrongVerifier = await exchange({ code, verifier: 'other-verifier-'.padEnd(64, 'x') });
    expect(wrongVerifier.status).toBe(400);

    const exchanged = await exchange({ code, verifier });
    expect(exchanged.status).toBe(200);
    const exchangedBody = await exchanged.json();
    expect(exchangedBody.data.handoff.token).toMatch(/^st_/);
    expect(exchangedBody.data.session.id).toEqual(expect.any(String));

    const replayed = await exchange({ code, verifier });
    expect(replayed.ok).toBe(false);
    expect((await replayed.json()).error.code).toBe('AUTHFN_OAUTH_STATE_REPLAYED');
  });
});
