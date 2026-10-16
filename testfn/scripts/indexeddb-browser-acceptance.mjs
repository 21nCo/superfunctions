import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const entry = fileURLToPath(
  new URL("../typescript/dist/storage/indexeddb-manager.js", import.meta.url),
);
const bundle = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "TestFnBrowser",
});
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<title>IndexedDB acceptance</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
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
  });
  assert.deepEqual(result, {
    history: 2,
    old: null,
    artifact: null,
    current: "new",
  });
  console.log(
    "Real Chrome IndexedDB: history, artifact cleanup and reopen passed",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
