import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthFnRuntimeConfig } from 'authfn';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import { createTestServer } from '../test-server.js';
import { memoryAdapter } from '../../../../../packages/db/src/testing/index.js';
import type { AuthFnBrowserHandoffBeginResult, AuthFnBrowserHandoffResult } from '../../index.js';

/**
 * Chromium contract test of the bundled client: two pages of one browser
 * context share localStorage and Web Locks, the app and the AuthFn server are
 * served on https://app.example.com through request interception, and the
 * provider's token endpoint is faked, so no provider sign-in is needed.
 */

const APP = 'https://app.example.com';
const page = `<!doctype html><html><head><script src="/handoff-test.js"></script></head><body></body></html>`;

declare const authfnTest: {
  client: { startSocialSignIn(input: Record<string, unknown>): Promise<{ ok: boolean; data: { stateId: string } }> };
  events: unknown[];
  make(input?: { atomic?: boolean }): {
    begin(input: { returnTo: string }): Promise<AuthFnBrowserHandoffBeginResult>;
    complete(url: string): Promise<AuthFnBrowserHandoffResult>;
  };
};

function createIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function createAuthServer() {
  const config: AuthFnRuntimeConfig = {
    database: memoryAdapter({ debug: false }),
    namespace: 'authfn',
    plugins: [authFnSocialOAuthPlugin()],
    pluginRuntime: {
      socialOAuth: {
        fetcher: async (url: string) => {
          if (url !== 'https://oauth2.googleapis.com/token') {
            throw new Error(`unexpected fetch: ${url}`);
          }
          const body = JSON.stringify({
            access_token: 'test-google-access-token',
            token_type: 'Bearer',
            scope: 'openid email profile',
            id_token: createIdToken({ sub: 'google-user-browser', email: 'ada@example.com', email_verified: true })
          });
          return {
            ok: true,
            status: 200,
            headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
            text: async () => body
          };
        },
        providers: {
          google: {
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            allowlistedReturnTo: [APP]
          }
        }
      }
    }
  };
  return createTestServer(config);
}

let browser: Browser;
let bundle: string;

beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./entry.ts', import.meta.url))],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false
  });
  bundle = result.outputFiles[0]!.text;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

describe('createBrowserHandoff in Chromium', () => {
  let context: BrowserContext;
  let auth: ReturnType<typeof createAuthServer>;
  let exchanges: number;
  let consoleText: string[];

  beforeEach(async () => {
    auth = createAuthServer();
    exchanges = 0;
    consoleText = [];
    context = await browser.newContext();
    await context.route(/^https:\/\/(app|evil)\.example\.com\//, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/handoff-test.js') {
        return route.fulfill({ contentType: 'text/javascript', body: bundle });
      }
      if (url.origin === APP && url.pathname.startsWith('/auth/')) {
        if (url.pathname === '/auth/social/handoff/exchange') {
          exchanges += 1;
        }
        const response = await auth.router.handle(new Request(url.href, {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postDataBuffer() ?? undefined
        }));
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: Buffer.from(await response.arrayBuffer())
        });
      }
      return route.fulfill({ contentType: 'text/html', body: page });
    });
  });

  afterEach(async () => {
    await context.close();
  });

  async function openPage(url = `${APP}/start`): Promise<Page> {
    const tab = await context.newPage();
    tab.on('console', (message) => consoleText.push(message.text()));
    await tab.goto(url);
    return tab;
  }

  /**
   * Begins in a fresh page, runs the provider callback on the server, and
   * loads the URL it redirects to in the same page, as after the provider's
   * consent screen. (A redirect fulfilled through request interception is not
   * followed, so the page navigates to its Location.)
   */
  async function beginAndReturn(input: { atomic?: boolean } = {}) {
    const tab = await openPage();
    const { begun, stateId } = await tab.evaluate(async (atomic) => {
      const begun = await authfnTest.make({ atomic }).begin({ returnTo: `${location.origin}/post-auth` });
      const started = await authfnTest.client.startSocialSignIn({ provider: 'google', ...begun.start });
      return { begun, stateId: started.data.stateId };
    }, input.atomic);
    const verifier = await readVerifier(tab, begun.handoffId);
    const callback = await auth.router.handle(new Request(
      `${APP}/auth/social/callback/google?code=test-provider-code&state=${encodeURIComponent(stateId)}`
    ));
    expect(callback.status).toBe(303);
    await tab.goto(new URL(callback.headers.get('location')!, APP).href);
    expect(tab.url()).toContain(`#authfn_handoff=${begun.handoffId}`);
    return { tab, begun, verifier, returnUrl: tab.url() };
  }

  const readVerifier = (tab: Page, handoffId: string) =>
    tab.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}').verifier as string, `authfn.handoff.${handoffId}`);
  const complete = (tab: Page, atomic?: boolean) =>
    tab.evaluate((value) => authfnTest.make({ atomic: value }).complete(location.href), atomic);
  const dumpStorage = (tab: Page) => tab.evaluate(() => JSON.stringify({ ...localStorage }));

  it('lets one of two windows complete a return after the redirect, with Web Locks', async () => {
    const { tab, verifier, returnUrl } = await beginAndReturn();
    const second = await openPage(returnUrl);

    const results = await Promise.all([complete(tab), complete(second)]);

    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'failed']);
    expect(results.find((result) => result.status === 'failed')).toMatchObject({ reason: 'already-used' });
    expect(exchanges).toBe(1);
    const disclosed = [
      await dumpStorage(tab),
      JSON.stringify(results),
      JSON.stringify(await tab.evaluate(() => authfnTest.events)),
      JSON.stringify(await second.evaluate(() => authfnTest.events)),
      consoleText.join('\n')
    ].join('\n');
    expect(disclosed).not.toContain(verifier);
  });

  it('lets the server decide between two windows when the store has no lock', async () => {
    const { tab, returnUrl } = await beginAndReturn({ atomic: false });
    const second = await openPage(returnUrl);

    const results = await Promise.all([complete(tab, false), complete(second, false)]);

    expect(results.filter((result) => result.status === 'completed')).toHaveLength(1);
    expect(results.find((result) => result.status === 'failed')).toMatchObject({ reason: 'already-used' });
  });

  it('completes after the page reloads and refuses the same return after the next reload', async () => {
    const { tab, begun } = await beginAndReturn();
    await tab.reload();

    expect(await complete(tab)).toMatchObject({
      status: 'completed',
      handoffId: begun.handoffId,
      cleanUrl: `${APP}/post-auth`
    });
    await tab.reload();
    expect(await complete(tab)).toMatchObject({ status: 'failed', reason: 'already-used' });
    expect(exchanges).toBe(1);
  });

  it('refuses the return on another origin, which cannot read the handoff', async () => {
    const { returnUrl } = await beginAndReturn();
    const evil = await openPage(returnUrl.replace(APP, 'https://evil.example.com'));

    expect(await complete(evil)).toMatchObject({ status: 'failed', reason: 'origin-mismatch' });
    expect(exchanges).toBe(0);
  });

  it('removes a malformed persisted record without exchanging', async () => {
    const { tab, begun } = await beginAndReturn();
    const key = `authfn.handoff.${begun.handoffId}`;
    await tab.evaluate((name) => localStorage.setItem(name, '{"v":1,"state":"pending"'), key);

    expect(await complete(tab)).toMatchObject({ status: 'failed', reason: 'malformed-state' });
    expect(await tab.evaluate((name) => localStorage.getItem(name), key)).toBeNull();
    expect(exchanges).toBe(0);
  });
});
