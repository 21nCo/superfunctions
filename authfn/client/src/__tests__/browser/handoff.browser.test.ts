import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthFnRuntimeConfig } from 'authfn';
import { authFnSocialOAuthPlugin } from '@authfn/social-oauth';
import { createTestServer } from '../test-server.js';
import { memoryAdapter } from '../../../../../packages/db/src/testing/index.js';
import type {
  AuthFnBrowserHandoffBeginResult,
  AuthFnBrowserHandoffResult,
  AuthFnBrowserHandoffStore
} from '../../index.js';

/**
 * Chromium contract test of the bundled client: pages of one browser context
 * (independent pages in separate renderer processes, and a popup) share the
 * origin's IndexedDB, the app and the AuthFn server are served on
 * https://app.example.com through request interception, and the provider's
 * token endpoint is faked, so no provider sign-in is needed.
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
  store(): AuthFnBrowserHandoffStore;
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
  async function beginAndReturn() {
    const tab = await openPage();
    const { begun, stateId } = await tab.evaluate(async () => {
      const begun = await authfnTest.make().begin({ returnTo: `${location.origin}/post-auth` });
      const started = await authfnTest.client.startSocialSignIn({ provider: 'google', ...begun.start });
      return { begun, stateId: started.data.stateId };
    });
    const verifier = await readVerifier(tab, begun.handoffId);
    const callback = await auth.router.handle(new Request(
      `${APP}/auth/social/callback/google?code=test-provider-code&state=${encodeURIComponent(stateId)}`
    ));
    expect(callback.status).toBe(303);
    await tab.goto(new URL(callback.headers.get('location')!, APP).href);
    expect(tab.url()).toContain(`#authfn_handoff=${begun.handoffId}`);
    return { tab, begun, verifier, returnUrl: tab.url() };
  }

  const readRecord = (tab: Page, handoffId: string) =>
    tab.evaluate((key) => authfnTest.store().get(key), `authfn.handoff.${handoffId}`);
  const readVerifier = async (tab: Page, handoffId: string) =>
    JSON.parse((await readRecord(tab, handoffId)) ?? '{}').verifier as string;
  const complete = (tab: Page, atomic?: boolean) =>
    tab.evaluate((value) => authfnTest.make({ atomic: value }).complete(location.href), atomic);
  const dumpStorage = (tab: Page) => tab.evaluate(async () => {
    const store = authfnTest.store();
    const records: Array<[string, unknown]> = [];
    for (const key of await store.keys()) {
      records.push([key, await store.get(key)]);
    }
    return JSON.stringify({ records, local: { ...localStorage }, session: { ...sessionStorage } });
  });

  /**
   * Shows that two pages run in different renderer processes: while one
   * page's main thread is busy, the other still answers.
   */
  async function expectSeparateProcesses(first: Page, second: Page) {
    const busy = first.evaluate(() => {
      const end = Date.now() + 2_000;
      while (Date.now() < end) {
        // Hold this renderer's main thread.
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    await second.evaluate(() => 1);
    expect(Date.now() - started).toBeLessThan(1_000);
    await busy;
  }

  /** Begins once and mints two codes, as a double-clicked start does. */
  async function beginWithTwoCodes(tab: Page) {
    const { begun, stateIds } = await tab.evaluate(async () => {
      const begun = await authfnTest.make().begin({ returnTo: `${location.origin}/post-auth` });
      const first = await authfnTest.client.startSocialSignIn({ provider: 'google', ...begun.start });
      const second = await authfnTest.client.startSocialSignIn({ provider: 'google', ...begun.start });
      return { begun, stateIds: [first.data.stateId, second.data.stateId] };
    });
    const locations: string[] = [];
    for (const stateId of stateIds) {
      const callback = await auth.router.handle(new Request(
        `${APP}/auth/social/callback/google?code=test-provider-code&state=${encodeURIComponent(stateId)}`
      ));
      locations.push(new URL(callback.headers.get('location')!, APP).href);
    }
    expect(new URL(locations[0]!).hash).not.toBe(new URL(locations[1]!).hash);
    return { begun, locations };
  }

  it('lets one of two windows in separate processes complete a return after the redirect', async () => {
    const { tab, verifier, returnUrl } = await beginAndReturn();
    const second = await openPage(returnUrl);
    await expectSeparateProcesses(tab, second);

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

  it('lets one of two windows in separate processes complete when a retried start returns two different codes', async () => {
    const tab = await openPage();
    const { begun, locations } = await beginWithTwoCodes(tab);
    await tab.goto(locations[0]!);
    const second = await openPage(locations[1]!);
    await expectSeparateProcesses(tab, second);

    const results = await Promise.all([complete(tab), complete(second)]);

    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'failed']);
    expect(results.find((result) => result.status === 'failed')).toMatchObject({
      reason: 'already-used',
      handoffId: begun.handoffId
    });
    expect(exchanges).toBe(1);
  });

  it('lets one of an opener and its popup complete two different codes, since the popup shares the store', async () => {
    const tab = await openPage();
    const { begun, locations } = await beginWithTwoCodes(tab);
    await tab.goto(locations[0]!);
    // A popup gets a copy of the opener's sessionStorage but the same IndexedDB.
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      tab.evaluate((url) => {
        window.open(url, '_blank');
      }, locations[1]!)
    ]);
    await popup!.waitForLoadState();
    expect(await popup!.evaluate(() => window.opener !== null)).toBe(true);

    const results = await Promise.all([complete(tab), complete(popup!)]);

    expect(results.map((result) => result.status).sort()).toEqual(['completed', 'failed']);
    expect(results.find((result) => result.status === 'failed')).toMatchObject({
      reason: 'already-used',
      handoffId: begun.handoffId
    });
    expect(exchanges).toBe(1);
  });

  it('claims each record exactly once across renderer processes', async () => {
    const pages = [await openPage(), await openPage(), await openPage()];
    await expectSeparateProcesses(pages[0]!, pages[1]!);
    const keys = Array.from({ length: 25 }, (_, index) => `authfn.handoff.race-${index}`);
    await pages[0]!.evaluate(async (names) => {
      for (const name of names) {
        await authfnTest.store().set(name, 'pending');
      }
    }, keys);

    // Each page fires one claim per key at once; the pages race each other.
    const claims = await Promise.all(pages.map((tab, index) => tab.evaluate(([names, label]) => {
      const store = authfnTest.store();
      return Promise.all((names as string[]).map((name) => store.compareAndSet(name, 'pending', `used-by-${label}`)));
    }, [keys, String(index)] as const)));

    for (let index = 0; index < keys.length; index += 1) {
      expect(claims.filter((perPage) => perPage[index]).length).toBe(1);
    }
    const stored = await pages[2]!.evaluate((names) => Promise.all(names.map((name) => authfnTest.store().get(name))), keys);
    stored.forEach((value, index) => {
      expect(value).toBe(`used-by-${claims.findIndex((perPage) => perPage[index])}`);
    });
  });

  it('refuses to begin or complete in a window without IndexedDB', async () => {
    const tab = await openPage();
    expect(await tab.evaluate(() => authfnTest.make({ atomic: false })
      .begin({ returnTo: `${location.origin}/post-auth` })
      .then(() => 'begun', (error: Error) => error.message))).toMatch(/atomic/);

    const { tab: returned, begun } = await beginAndReturn();
    expect(await complete(returned, false)).toMatchObject({
      status: 'failed',
      reason: 'store-not-atomic',
      handoffId: begun.handoffId,
      cleanUrl: `${APP}/post-auth`
    });
    // A store without IndexedDB cannot reach the record to retire it either;
    // nothing was exchanged, and only an atomic store can claim it.
    expect(exchanges).toBe(0);
    expect(await complete(returned)).toMatchObject({ status: 'completed', handoffId: begun.handoffId });
    expect(exchanges).toBe(1);
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
    await tab.evaluate((name) => authfnTest.store().set(name, '{"v":1,"state":"pending"'), key);

    expect(await complete(tab)).toMatchObject({ status: 'failed', reason: 'malformed-state' });
    expect(await readRecord(tab, begun.handoffId)).toBeNull();
    expect(exchanges).toBe(0);
  });
});
