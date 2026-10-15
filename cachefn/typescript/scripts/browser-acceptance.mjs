/**
 * Run: node scripts/browser-acceptance.mjs
 * Requires esbuild and playwright resolvable from this package. Alternatively,
 * PLAYWRIGHT_MODULE_PATH may point to an installed playwright package directory.
 * BROWSER_EXECUTABLE_PATH optionally selects an installed Chrome/Chromium binary;
 * otherwise Playwright uses its installed Chromium. No user profile is loaded.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
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
  browser = await chromium.launch({
    headless: true,
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
          return { assertions, userAgent: navigator.userAgent };
        })(),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });
  console.log(JSON.stringify({ browser: await browser.version(), ...result }));
} finally {
  // Closing the fresh nonpersistent browser context also discards test databases.
  try {
    await browser?.close();
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
