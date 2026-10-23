import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const engines = createRequire(new URL("../typescript/package.json", import.meta.url))("playwright");
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const bundle = readFileSync(process.env.TESTFN_BROWSER_BUNDLE ?? fileURLToPath(
  new URL("../typescript/dist/browser/indexeddb.js", import.meta.url),
), "utf8");
async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser storage acceptance timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<title>IndexedDB acceptance</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const engine = process.env.TESTFN_BROWSER_ENGINE ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw new Error("Unsupported browser engine");
const browser = await engines[engine].launch({
  ...(engine === "chromium" ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}),
  headless: true,
});
try {
  for (const compatibility of [false, true]) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if (compatibility) await page.evaluate(() => {
    // Exercise the shipped polyfills, prefixed factory lookup and task-based
    // Promise scheduling independently of modern native Promise behavior.
    window.webkitIndexedDB = window.indexedDB;
    window.webkitIDBKeyRange = window.IDBKeyRange;
    for (const name of ["indexedDB", "IDBKeyRange", "Promise", "queueMicrotask", "MutationObserver", "WebKitMutationObserver"]) {
      Object.defineProperty(window, name, { value: undefined, configurable: true, writable: true });
    }
    Array.prototype.flatMap = undefined;
    Array.prototype.includes = undefined;
  });
  await page.addScriptTag({ content: bundle });
  const result = await within(page.evaluate(async () => {
    const db = new TestFnBrowser.IndexedDbManager({
      dbName: crypto.randomUUID(),
    });
    await db.open();
    const run = (id, timestamp) => ({
      id,
      timestamp,
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, duration: 1 },
      environment: { platform: "browser" },
      results: [{ id: "same", status: "passed", duration: 1 }],
    });
    await db.putRun(run("old", Date.now() - 3 * 86400000));
    await db.putRun(run("new", Date.now()));
    await db.putArtifact({
      id: "old-log",
      runId: "old",
      testId: "same",
      type: "log",
      path: "log",
      buffer: new Uint8Array([1, 2, 3]),
    });
    const history = (await db.getTestHistory("same", 10)).length;
    await db.cleanup(1);
    const old = await db.getRun("old"),
      artifact = await db.getArtifact("old-log");
    await db.close();
    await db.open();
    const current = await db.getRun("new");
    await db.close();
    return { history, old, artifact, current: current?.id };
  }), 30000);
  assert.deepEqual(result, {
    history: 2,
    old: null,
    artifact: null,
    current: "new",
  });
  console.log(
    `Shipped ES5 bundle (${engine}): history, cleanup and reopen passed (polyfill mode: ${compatibility})`,
  );
  await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
