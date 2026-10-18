import { it, expect } from "vitest";
import { AnalyticsEngine } from "../src/analytics/analytics-engine.js";
import { TestStorage } from "../src/storage/test-storage.js";
import type { TestRun, TestResult } from "../src/types.js";
const run = (
  id: string,
  results: TestResult[],
  timestamp = Date.now(),
): TestRun => ({
  id,
  timestamp,
  results,
  summary: {
    total: results.length,
    passed: results.filter((x) => x.status === "passed").length,
    failed: results.filter((x) => x.status === "failed").length,
    skipped: 0,
    duration: 1,
  },
  environment: { platform: "test" },
});
it("computes percentiles, error categories and invalidates protected cached values", async () => {
  const store = new TestStorage({
    type: "indexeddb",
    dbName: crypto.randomUUID(),
  });
  await store.open();
  try {
    const messages = [
      "timeout",
      "expected assertion",
      "fetch failed",
      "selector missing",
      "undefined variable",
      "opaque failure",
    ];
    const value = run(
      "metrics",
      messages.map((message, index) => ({
        id: String(index),
        duration: (index + 1) * 10,
        status: "failed",
        error: { message },
      })),
    );
    await store.saveRun(value);
    const analytics = new AnalyticsEngine(store);
    const first = await analytics.computeMetrics("metrics");
    expect(first).toEqual({
      successRate: 0,
      avgDuration: 35,
      p50Duration: 30,
      p95Duration: 60,
      p99Duration: 60,
      failuresByType: {
        timeout: 1,
        assertion: 1,
        network: 1,
        selector: 1,
        reference: 1,
        other: 1,
      },
    });
    first.failuresByType.timeout = 100;
    expect(
      (await analytics.computeMetrics("metrics")).failuresByType.timeout,
    ).toBe(1);
    value.results[0].duration = 1000;
    await store.saveRun(value);
    expect((await analytics.computeMetrics("metrics")).p99Duration).toBe(1000);
    await expect(analytics.computeMetrics("missing")).rejects.toThrow(
      "not found",
    );
    for (let i = 0; i < 101; i++) {
      await store.saveRun(run(String(i), []));
      await analytics.computeMetrics(String(i));
    }
    expect((await analytics.computeMetrics("metrics")).p99Duration).toBe(1000);
  } finally {
    await store.close();
  }
});
it("detects volatility, practical regressions and uncapped chronological trends", async () => {
  const store = new TestStorage({
    type: "indexeddb",
    dbName: crypto.randomUUID(),
    cleanupThreshold: 0,
  });
  await store.open();
  try {
    const analytics = new AnalyticsEngine(store);
    expect((await analytics.detectFlaky("absent")).recommendation).toBe(
      "stable",
    );
    for (let index = 0; index < 1001; index++)
      await store.saveRun(
        run(
          String(index),
          [
            {
              id: "flaky",
              duration: index + 1,
              status: index % 2 ? "passed" : "failed",
            },
          ],
          Date.now() - 2000 + index,
        ),
      );
    const flaky = await analytics.detectFlaky("flaky", 10);
    expect(flaky.passRate).toBe(0.5);
    expect(flaky.recommendation).toBe("quarantine");
    const trends = await analytics.getTrends("flaky", 1);
    expect(trends.dataPoints).toHaveLength(1001);
    expect(trends.dataPoints[0].value).toBe(1);
    expect((await analytics.getTrends("absent", 1)).dataPoints).toEqual([]);
    await store.saveRun(
      run("baseline", [
        { id: "slow", status: "passed", duration: 100 },
        { id: "zero", status: "passed", duration: 0 },
      ]),
    );
    await store.saveRun(
      run("current", [
        { id: "slow", status: "passed", duration: 1000 },
        { id: "zero", status: "passed", duration: 500 },
        { id: "new", status: "passed", duration: 500 },
      ]),
    );
    expect(await analytics.findRegressions("baseline", "current")).toEqual([
      {
        testId: "slow",
        metric: "duration",
        baseline: 100,
        current: 1000,
        change: 9,
        significant: true,
      },
    ]);
    await expect(
      analytics.findRegressions("missing", "current"),
    ).rejects.toThrow("not found");
  } finally {
    await store.close();
  }
});
