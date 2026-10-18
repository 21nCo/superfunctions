/** A reproducible bounded fixture, not a size guarantee for arbitrary artifacts. */
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TestStorage, AnalyticsEngine } from "../typescript/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "testfn-storage-performance-"));
const storage = new TestStorage({
  type: "file",
  dbName: join(directory, "database"),
});
const initial = process.memoryUsage();
const peak = { ...initial };
const sample = () => {
  const current = process.memoryUsage();
  for (const key of Object.keys(current))
    peak[key] = Math.max(peak[key], current[key]);
};
const timer = setInterval(sample, 10);
const started = performance.now();
try {
  await storage.open();
  for (let index = 0; index < 1000; index++) {
    await storage.saveRun({
      id: `run-${index}`,
      timestamp: Date.now(),
      summary: { total: 10, passed: 10, failed: 0, skipped: 0, duration: 100 },
      environment: { platform: process.platform, node: process.version },
      results: Array.from({ length: 10 }, (_, test) => ({
        id: `test-${test}`,
        status: "passed",
        duration: 10,
        artifacts:
          test === 0
            ? [
                {
                  type: "log",
                  path: "",
                  buffer: Buffer.from("test output: passed\n".repeat(500)),
                },
              ]
            : [],
      })),
    });
    sample();
  }
  const writeDurationMs = performance.now() - started;
  const analytics = new AnalyticsEngine(storage);
  const trendStart = performance.now();
  const trends = await analytics.getTrends("test-0", 1);
  const analyticsDurationMs = performance.now() - trendStart;
  assert.equal(trends.dataPoints.length, 1000);
  assert.equal((await storage.getRecentRuns(1001)).length, 1000);
  const run = await storage.getRun("run-999");
  const artifact = await storage.getArtifact(run.artifacts[0].id);
  assert.equal(artifact.buffer.toString(), "test output: passed\n".repeat(500));
  const size = async (path) => {
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      total += entry.isDirectory() ? await size(file) : (await stat(file)).size;
    }
    return total;
  };
  const bytes = await size(join(directory, "database"));
  assert.ok(
    bytes < 100 * 1024 * 1024,
    `Fixture storage ${bytes} exceeds 100MiB`,
  );
  sample();
  const result = {
    directory,
    fixture: { runs: 1000, testsPerRun: 10, logBytesPerRun: 10000 },
    bytes,
    writeDurationMs,
    analyticsDurationMs,
    initialMemory: initial,
    peakMemory: peak,
    finalMemory: process.memoryUsage(),
  };
  await writeFile(
    join(directory, "measurements.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearInterval(timer);
  await storage.close();
}
