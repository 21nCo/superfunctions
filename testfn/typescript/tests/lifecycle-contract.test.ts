import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRunner } from "../src/core/test-runner.js";
import { WorkerPool } from "../src/core/worker-pool.js";
import { TestStorage } from "../src/storage/test-storage.js";
import type { TestFrameworkAdapter, TestFnConfig } from "../src/types.js";
const cases = [
  { id: "one", name: "one", file: "one" },
  { id: "two", name: "two", file: "two" },
];
const adapter = (run: TestFrameworkAdapter["run"]): TestFrameworkAdapter => ({
  name: "contract",
  supports: () => true,
  discover: async () => cases,
  run,
});
it("cancels queued files, reports progress, and forbids concurrent mutation", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let startedResolve!: () => void;
  const started = {
    promise: new Promise<void>((resolve) => (startedResolve = resolve)),
    resolve: () => startedResolve(),
  };
  const progress = vi.fn();
  const runner = new TestRunner({
    framework: "vitest",
    reporters: [],
    onProgress: progress,
  });
  const selected = adapter(async ([test], options) => {
    started.resolve();
    await gate;
    expect(options.signal?.aborted).toBe(true);
    return [{ id: test.id, status: "passed", duration: 1 }];
  });
  runner.setAdapter(selected);
  const pending = runner.run();
  await started.promise;
  await expect(runner.run()).rejects.toThrow("already running");
  expect(() => runner.setAdapter(selected)).toThrow("during a run");
  runner.cancel();
  release();
  const result = await pending;
  expect(result.results.map((x) => x.status)).toEqual(["passed", "skipped"]);
  expect(result.results[1].metadata?.cancelled).toBe(true);
  expect(progress).toHaveBeenCalledTimes(2);
});
it("pre-aborted external signal skips all execution and fires complete", async () => {
  const signal = AbortSignal.abort();
  const run = vi.fn();
  const complete = vi.fn();
  const runner = new TestRunner({
    framework: "jest",
    signal,
    reporters: [],
    onComplete: complete,
    testPattern: ["one"],
  });
  runner.setAdapter(adapter(run));
  expect((await runner.run()).summary.skipped).toBe(2);
  expect(run).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
});
it("rejects invalid results and options and recovers after callback errors", async () => {
  const pool = new WorkerPool(1);
  for (const options of [
    { retries: -1 },
    { retries: 1.5 },
    { timeout: 0 },
    { timeout: NaN },
  ])
    await expect(
      pool.executeTests(
        cases,
        adapter(async () => []),
        options,
      ),
    ).rejects.toThrow();
  const invalid = await pool.executeTests(
    cases,
    adapter(async () => [{ id: "bad", status: "passed", duration: NaN }]),
    {},
  );
  expect(
    invalid.every((x) => x.error?.message.includes("invalid test result")),
  ).toBe(true);
  await expect(
    pool.executeTests(
      cases,
      adapter(async () => []),
      {
        onTestStart: () => {
          throw Error("reporter failure");
        },
      },
    ),
  ).rejects.toThrow("reporter failure");
  expect(
    await pool.executeTests(
      [],
      adapter(async () => []),
      {},
    ),
  ).toEqual([]);
});
it("awaits active workers on shutdown and rejects pool reuse during execution", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pool = new WorkerPool(1);
  const pending = pool.executeTests(
    cases,
    adapter(async ([test]) => {
      await gate;
      return [{ id: test.id, status: "passed", duration: 1 }];
    }),
    {},
  );
  await expect(
    pool.executeTests(
      [],
      adapter(async () => []),
      {},
    ),
  ).rejects.toThrow("already running");
  let stopped = false;
  const shutdown = pool.shutdown().then(() => (stopped = true));
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await pending;
  await shutdown;
  expect(stopped).toBe(true);
});
it("persists artifacts and forwards visual and browser configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "testfn-lifecycle-"));
  try {
    const runner = new TestRunner({
      framework: "playwright",
      reporters: [],
      browsers: [
        "firefox",
        { name: "chromium", viewport: { width: 300, height: 200 } },
      ],
      visual: { baselineDir: directory },
      storage: { type: "file", dbName: directory },
    });
    runner.setAdapter(
      adapter(async ([test], options) => {
        expect(options.browsers?.[0]).toEqual({ name: "firefox" });
        expect(JSON.parse(options.env!.TESTFN_VISUAL_CONFIG)).toEqual({
          baselineDir: directory,
        });
        return [
          {
            id: test.id,
            status: "passed",
            duration: 1,
            artifacts: [
              { type: "log", path: "", buffer: Buffer.from("evidence") },
            ],
          },
        ];
      }),
    );
    const run = await runner.run();
    const storage = new TestStorage({ type: "file", dbName: directory });
    await storage.open();
    expect(
      (await storage.getArtifact(run.artifacts![0].id))?.buffer?.toString(),
    ).toBe("evidence");
    await storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  expect(
    () => new TestRunner({ framework: "unknown" } as unknown as TestFnConfig),
  ).toThrow("Unsupported framework");
});
