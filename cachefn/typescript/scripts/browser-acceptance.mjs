/**
 * Run: node scripts/browser-acceptance.mjs
 * Requires esbuild and playwright resolvable from this package. Alternatively,
 * PLAYWRIGHT_MODULE_PATH may point to an installed playwright package directory.
 * BROWSER_EXECUTABLE_PATH optionally selects an installed Chrome/Chromium binary;
 * BROWSER_ENGINE selects chromium (default), firefox, or webkit.
 * Otherwise Playwright uses its installed engine. No user profile is loaded.
 */
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
  const result = await page.evaluate(async () => {
    const { CacheFn, IndexedDBStorage } = globalThis.Acceptance;
    let assertions = 0;
    const assert = (value, message) => {
      if (!value) throw new Error(message);
      assertions++;
    };
    // Bound observation without retaining a timer after success/failure.
    let timeout;
    try {
      return await Promise.race([
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Browser acceptance timed out")), 15000);
        }),
        (async () => {
          const name = `acceptance-${crypto.randomUUID()}`;
          const root = new CacheFn({ name, storage: "indexeddb" });
          const parent = new CacheFn({ name, namespace: "a", storage: "indexeddb" });
          const child = new CacheFn({ name, namespace: "a:b", storage: "indexeddb" });
          await Promise.all([
            root.set("a:b:item", "root", { tags: ["shared"] }),
            parent.set("b:item", "parent", { tags: ["shared"] }),
            child.set("item", "child", { tags: ["shared"] }),
          ]);
          assert((await root.keys()).join() === "a:b:item", "default namespace keys");
          assert((await parent.keys()).join() === "b:item", "parent namespace keys");
          assert((await child.keys()).join() === "item", "child namespace keys");
          await parent.invalidateByTag("shared");
          assert(await child.get("item") === "child", "child survives tag invalidation");
          await root.clear();
          assert(await child.get("item") === "child", "child survives default clear");
          await child.set("expired", "old", { ttl: -1, tags: ["expired"] });
          assert(!(await child.keys()).includes("expired"), "expired enumeration");
          assert(await child.size() === 1, "expired size");
          const storage = new IndexedDBStorage({ name: `direct-${crypto.randomUUID()}` });
          const metadata = { createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags: ["old"] };
          await storage.set("key", 1, metadata);
          await storage.addTag("new", "key");
          assert((await storage.getTagsForKey("key")).includes("new"), "tag metadata consistency");
          await storage.removeTag("old", "key");
          assert((await storage.getKeysByTag("old")).length === 0, "tag removal consistency");
          let rejected = false;
          try { await storage.set("key", () => 1, metadata); } catch { rejected = true; }
          assert(rejected, "uncloneable write rejects");
          assert(await storage.get("key") === 1, "failed write rollback");
          const original = IDBObjectStore.prototype.delete;
          rejected = false;
          try {
            IDBObjectStore.prototype.delete = function (key) {
              const request = original.call(this, key);
              request.addEventListener("success", () => this.transaction.abort());
              return request;
            };
            try { await storage.delete("key"); } catch { rejected = true; }
          } finally {
            IDBObjectStore.prototype.delete = original;
          }
          assert(rejected, "abort after request success rejects");
          assert(await storage.has("key"), "aborted delete rollback");
          const persistentName = `local-${crypto.randomUUID()}`;
          const local = new CacheFn({ name: persistentName, storage: 'localstorage', namespace: 'one' });
          await local.set('key', { value: 1n }, { tags: ['tag'] });
          const reopened = new CacheFn({ name: persistentName, storage: 'localstorage', namespace: 'one' });
          assert((await reopened.get('key')).value === 1n, 'localStorage typed persistence');
          const neighbor = new CacheFn({ name: persistentName, storage: 'localstorage', namespace: 'one:two' });
          await neighbor.set('key', 2, { tags: ['tag'] });
          await local.invalidateByTag('tag');
          assert(await neighbor.get('key') === 2, 'localStorage namespace isolation');
          const open = indexedDB.open.bind(indexedDB);
          indexedDB.open = () => { throw new DOMException('Disabled by browser policy', 'SecurityError'); };
          try {
            const automaticName = `automatic-${crypto.randomUUID()}`;
            const automatic = new CacheFn({ name: automaticName, storage: 'auto' });
            await automatic.set('key', 3);
            assert(await new CacheFn({ name: automaticName, storage: 'localstorage' }).get('key') === 3, 'disabled IndexedDB falls to localStorage');
            const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
            Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Disabled storage', 'SecurityError'); } });
            try {
              const memory = new CacheFn({ name: crypto.randomUUID(), storage: 'auto' });
              await memory.set('key', 4);
              assert(await memory.get('key') === 4, 'all persistent storage denied falls to memory');
            } finally {
              if (descriptor) Object.defineProperty(window, 'localStorage', descriptor);
              else delete window.localStorage;
            }
          } finally { indexedDB.open = open; }
          const quota = new CacheFn({ name: crypto.randomUUID(), storage: 'auto', fallbackOrder: ['localstorage'], localStorageMaxBytes: 40 * 1024 * 1024 });
          // Exceeds Chromium's origin localStorage quota, but not our configured
          // cap: this exercises a native QuotaExceededError and runtime failover.
          const large = 'x'.repeat(10 * 1024 * 1024);
          await quota.set('large', large);
          assert((await quota.get('large')).length === large.length, 'native browser quota falls to memory');
          assert(!Object.keys(localStorage).some(key => key.includes(':probe:')), 'localStorage probes cleaned');
          const autoIdb = new CacheFn({ name: `auto-idb-${crypto.randomUUID()}`, storage: 'auto' });
          await autoIdb.set('key', 5);
          assert(await autoIdb.get('key') === 5, 'automatic IndexedDB works');
          if (typeof indexedDB.databases === 'function') assert(!(await indexedDB.databases()).some(db => db.name?.includes(':probe:')), 'IndexedDB probe databases removed');
          const heapDescriptor = Object.getOwnPropertyDescriptor(performance, 'memory');
          const heap = { usedJSHeapSize: 90, jsHeapSizeLimit: 100 };
          Object.defineProperty(performance, 'memory', { configurable: true, value: heap });
          const adaptive = new CacheFn({ name: crypto.randomUUID(), storage: 'memory', eviction: 'adaptive', memoryMonitoring: { checkInterval: 10 } });
          try {
            await adaptive.set('low', 1, { priority: 'low' });
            await adaptive.set('high', 2, { priority: 'high' });
            await new Promise(resolve => adaptive.on('eviction', () => { heap.usedJSHeapSize = 10; resolve(); }));
            assert(!await adaptive.has('low') && await adaptive.has('high'), 'adaptive browser timer evicts low priority first');
            adaptive.dispose(); heap.usedJSHeapSize = 99;
            await new Promise(resolve => setTimeout(resolve, 30));
            assert(await adaptive.has('high'), 'disposed adaptive monitor preserves entries under pressure');
          } finally {
            adaptive.dispose();
            if (heapDescriptor) Object.defineProperty(performance, 'memory', heapDescriptor);
            else delete performance.memory;
          }
          return { assertions, userAgent: navigator.userAgent };
        })(),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });
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
