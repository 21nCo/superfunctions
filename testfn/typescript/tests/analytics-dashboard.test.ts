import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestStorage } from "../src/storage/test-storage.js";
import { AnalyticsEngine } from "../src/analytics/analytics-engine.js";
import { testSignificance } from "../src/analytics/statistics.js";
import { generateDashboard } from "../src/reporters/dashboard.js";
import type { TestRun } from "../src/types.js";
it("permutation tests distinguish equal samples from a repeatable substantial shift", () => {
  const same = testSignificance([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]);
  expect(same.pValue).toBe(1);
  expect(same.significant).toBe(false);
  const shifted = testSignificance(
    [1, 1, 1, 1, 1, 1],
    [10, 10, 10, 10, 10, 10],
  );
  expect(shifted.significant).toBe(true);
  expect(shifted).toEqual(
    testSignificance([1, 1, 1, 1, 1, 1], [10, 10, 10, 10, 10, 10]),
  );
  expect(() => testSignificance([NaN, 1], [1, 2])).toThrow();
});
it("computes custom metrics and coverage trends and exports offline safe history pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testfn-dashboard-"));
  const storage = new TestStorage({
    type: "indexeddb",
    dbName: crypto.randomUUID(),
  });
  await storage.open();
  try {
    const run: TestRun = {
      id: "</script><script>globalThis.injected=true</script>",
      timestamp: Date.now(),
      environment: { platform: "test" },
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        duration: 4,
        coverage: { lines: 90, functions: 80, branches: 70, statements: 95 },
      },
      results: [{ id: "<b>case</b>", status: "passed", duration: 4 }],
    };
    await storage.saveRun(run);
    const analytics = new AnalyticsEngine(storage);
    analytics.registerMetric(
      "double duration",
      (value) => value.summary.duration * 2,
    );
    expect(await analytics.computeCustomMetrics(run.id)).toEqual({
      "double duration": 8,
    });
    expect((await analytics.getCoverageTrends())[0].coverage.lines).toBe(90);
    analytics.registerMetric("invalid", () => NaN);
    await expect(analytics.computeCustomMetrics(run.id)).rejects.toThrow(
      "finite",
    );
    await generateDashboard(storage, dir);
    for (const file of [
      "index.html",
      "test.html",
      "visual.html",
      "analytics.html",
    ]) {
      const html = await readFile(join(dir, file), "utf8");
      expect(html).not.toContain("</script><script>globalThis.injected=true");
      expect(html).toContain("\\u003c/script>");
      expect(html).not.toContain("<script src=");
    }
    expect(
      JSON.parse(await readFile(join(dir, "data/runs.json"), "utf8")),
    ).toHaveLength(1);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("invalidates cached metrics when a stored run changes and isolates returned objects", async () => {
  const storage = new TestStorage({
    type: "indexeddb",
    dbName: crypto.randomUUID(),
  });
  await storage.open();
  try {
    const run: TestRun = {
      id: "cached",
      timestamp: 1,
      environment: { platform: "test" },
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, duration: 1 },
      results: [{ id: "test", status: "passed", duration: 1 }],
    };
    await storage.saveRun(run);
    const analytics = new AnalyticsEngine(storage);
    const first = await analytics.computeMetrics(run.id);
    first.failuresByType.bad = 99;
    expect((await analytics.computeMetrics(run.id)).failuresByType).toEqual({});
    await storage.saveRun({
      ...run,
      results: [{ id: "test", status: "passed", duration: 20 }],
    });
    expect((await analytics.computeMetrics(run.id)).avgDuration).toBe(20);
  } finally {
    await storage.close();
  }
});
