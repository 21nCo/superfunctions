/**
 * Run: node scripts/browser-acceptance.mjs
 * Requires esbuild and playwright resolvable from this package. Alternatively,
 * PLAYWRIGHT_MODULE_PATH may point to an installed playwright package directory.
 * BROWSER_EXECUTABLE_PATH optionally selects an installed Chrome/Chromium binary;
 * BROWSER_ENGINE selects chromium (default), firefox, or webkit.
 * Otherwise Playwright uses its installed engine. No user profile is loaded.
 */
import { storageContract } from "./browser-storage-contract.mjs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const engines = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const engine = process.env.BROWSER_ENGINE || 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('Unsupported BROWSER_ENGINE');
const { build } = require("esbuild");
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: 'export {CacheFn} from "./src/core/cache.ts"; export {IndexedDBStorage} from "./src/storage/indexeddb-storage.ts";',
    resolveDir: packageDirectory,
  },
  bundle: true,
  format: "iife",
  globalName: "Acceptance",
  write: false,
  platform: "browser",
});
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><html><title>CacheFn acceptance</title></html>");
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  browser = await engines[engine].launch({
    headless: true,
    timeout: 30000,
    ...(process.env.BROWSER_EXECUTABLE_PATH
      ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(storageContract);
  // Exercise actual browser connectivity state and online events, not synthetic flags.
  await page.context().setOffline(true);
  await page.waitForFunction(() => navigator.onLine === false);
  await page.evaluate(async () => {
    const { CacheFn } = globalThis.Acceptance;
    const name = `offline-${crypto.randomUUID()}`;
    globalThis.offlineRemote = 0;
    const config = { name, storage: 'indexeddb', offlineStrategy: 'cache-first', offlineQueue: {
      sync: async ({ value }) => { globalThis.offlineRemote = value; },
    } };
    const first = new CacheFn(config);
    await first.queueUpdate('item', 7);
    first.dispose();
    globalThis.offlineCache = new CacheFn(config);
    const cached = await offlineCache.getOrFetch('item', { fetcher: async () => offlineRemote });
    if (cached !== 7 || offlineRemote !== 0) throw new Error('Offline update was not local-only');
    const fallback = await offlineCache.getOrFetch('absent', { fetcher: async () => offlineRemote, offlineFallback: () => -1 });
    if (fallback !== -1 || await offlineCache.has('absent')) throw new Error('Offline fallback contract failed');
    if ((await offlineCache.queuedUpdates()).length !== 1) throw new Error('Durable queue did not reopen');
  });
  await page.context().setOffline(false);
  await page.waitForFunction(async () => (await offlineCache.queuedUpdates()).length === 0 && await offlineCache.get('absent') === 7);
  await page.evaluate(() => offlineCache.dispose());
  result.assertions += 4;
  console.log(JSON.stringify({ engine, browser: await browser.version(), ...result }));
} finally {
  // Closing the fresh nonpersistent browser context also discards test databases.
  try {
    await browser?.close();
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
