import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium } from "playwright";
import {
  TestStorage,
  generateDashboard,
  VisualTester,
  applyNetworkProfile,
  networkProfiles,
  TestRunner,
} from "../typescript/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "testfn-dashboard-"));
const storage = new TestStorage({
  type: "indexeddb",
  dbName: crypto.randomUUID(),
});
await storage.open();
const browser = await chromium.launch({
  executablePath:
    process.env.BROWSER_EXECUTABLE_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const server = createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  res.end(
    req.url === "/data" ? "x".repeat(10000) : "<title>TestFn browser</title>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const metrics = {};
let assertions = 0;
const check = (value, message) => {
  assert(value, message);
  assertions++;
};
try {
  const results = Array.from({ length: 1000 }, (_, i) => ({
    id: `test-${i}`,
    status: i % 3 ? "passed" : "failed",
    duration: i % 100,
    error: i % 3 ? undefined : { message: "sample assertion" },
  }));
  const run = (i, items) => ({
    id: `run-${i}`,
    timestamp: Date.now() + i,
    environment: { platform: "acceptance" },
    summary: {
      total: items.length,
      passed: items.filter((t) => t.status === "passed").length,
      failed: items.filter((t) => t.status === "failed").length,
      skipped: 0,
      duration: 100 + i,
    },
    results: items,
  });
  let start = performance.now();
  await storage.saveRun(run(0, results));
  metrics.store1000Ms = performance.now() - start;
  check(metrics.store1000Ms < 500, "1000-result persistence target");
  for (let i = 1; i < 100; i++)
    await storage.saveRun(run(i, results.slice(0, 10)));
  start = performance.now();
  const history = await storage.getTestHistory("test-1", 99);
  metrics.history99Ms = performance.now() - start;
  check(history.length === 99 && metrics.history99Ms < 50, "history target");
  const page = await browser.newPage();
  await page.setViewportSize({ width: 320, height: 200 });
  await page.setContent("<style>body{margin:0;background:black}</style>");
  const visual = new VisualTester({
    baselineDir: join(directory, "base"),
    diffDir: join(directory, "diff"),
    threshold: 0,
  });
  const baseline = await visual.captureScreenshot(page, "screen");
  await visual.updateBaseline("screen", baseline);
  start = performance.now();
  const identical = await visual.compareScreenshot(baseline, "screen");
  metrics.compare320x200Ms = performance.now() - start;
  check(
    identical.passed && metrics.compare320x200Ms < 200,
    "visual comparison target",
  );
  await page.setContent("<style>body{margin:0;background:white}</style>");
  const current = await visual.captureScreenshot(page, "screen");
  await generateDashboard(storage, directory, {
    limit: 100,
    comparisons: [{ name: "screen", baseline, current }],
  });
  start = performance.now();
  await page.goto(pathToFileURL(join(directory, "index.html")).href);
  await page
    .getByRole("heading", { name: "Recent runs", exact: true })
    .waitFor();
  metrics.dashboard100RunsMs = performance.now() - start;
  check(metrics.dashboard100RunsMs < 1000, "dashboard load target");
  check(
    (await page.locator("table").first().locator("tr").count()) === 101,
    "all100runs visible",
  );
  await page.getByRole("link", { name: "Test details", exact: true }).click();
  check(
    (await page
      .getByRole("combobox", { name: "Test" })
      .locator("option")
      .count()) === 1000,
    "test identities",
  );
  await page.getByRole("combobox", { name: "Test" }).selectOption("test-1");
  check((await page.locator("table tr").count()) === 101, "history table");
  await page.getByRole("link", { name: "Analytics", exact: true }).click();
  check(
    (await page
      .getByRole("heading", { name: "Failure analysis", exact: true })
      .count()) === 1,
    "failure analysis",
  );
  await page.getByRole("link", { name: "Visual diffs", exact: true }).click();
  check(
    (await page.locator("iframe").count()) === 1,
    "embedded standalone visual viewer",
  );
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const reset = await applyNetworkProfile(page, {
    name: "latency",
    downloadThroughput: 10,
    uploadThroughput: 10,
    latency: 120,
  });
  start = performance.now();
  await page.evaluate(() => fetch("/data").then((r) => r.text()));
  metrics.networkLatencyMs = performance.now() - start;
  check(metrics.networkLatencyMs >= 100, "actual CDP latency");
  await reset();
  const online = await applyNetworkProfile(page, networkProfiles.offline);
  check(
    await page.evaluate(() =>
      fetch("/data").then(
        () => false,
        () => true,
      ),
    ),
    "offline blocks request",
  );
  await online();
  check(
    await page.evaluate(() => fetch("/data").then((r) => r.ok)),
    "cleanup restores network",
  );
  const runner = new TestRunner({
    framework: "vitest",
    parallel: 8,
    reporters: [],
  });
  runner.setAdapter({
    name: "in-process",
    supports: () => true,
    discover: async () =>
      Array.from({ length: 10000 }, (_, i) => ({
        id: String(i),
        name: String(i),
        file: "in-process",
      })),
    run: async ([test]) => [{ id: test.id, status: "passed", duration: 0 }],
  });
  start = performance.now();
  const large = await runner.run();
  metrics.inProcess10000Ms = performance.now() - start;
  check(
    large.summary.total === 10000 && large.summary.passed === 10000,
    "10000-test run",
  );
  console.log(JSON.stringify({ assertions, metrics }));
} finally {
  await storage.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
