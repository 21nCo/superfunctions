import { describe, it, expect } from "vitest";
import { WorkerPool } from "../src/core/worker-pool.js";
import { TestRunner } from "../src/core/test-runner.js";
import { executeNode } from "../src/integrations/process.js";
import type { TestFrameworkAdapter, TestCase } from "../src/types.js";
const tests: TestCase[] = [
  { id: "one", file: "one", name: "one" },
  { id: "two", file: "two", name: "two" },
];
const adapter = (run: TestFrameworkAdapter["run"]): TestFrameworkAdapter => ({
  name: "stub",
  supports: () => true,
  discover: async () => tests,
  run,
});
describe("worker execution", () => {
  it("preserves every result and input ordering under concurrency", async () => {
    const pool = new WorkerPool(2);
    let active = 0,
      maximum = 0;
    const result = await pool.executeTests(
      tests,
      adapter(async ([test]) => {
        maximum = Math.max(maximum, ++active);
        await new Promise((r) => setTimeout(r, test.id === "one" ? 20 : 1));
        active--;
        return ["chromium", "firefox"].map((browser) => ({
          id: `${test.id}-${browser}`,
          status: "passed",
          duration: 1,
        }));
      }),
      {},
    );
    expect(maximum).toBe(2);
    expect(result.map((r) => r.id)).toEqual([
      "one-chromium",
      "one-firefox",
      "two-chromium",
      "two-firefox",
    ]);
  });
  it("retries failures but never retries skipped tests", async () => {
    const calls: Record<string, number> = {};
    const result = await new WorkerPool(1).executeTests(
      tests,
      adapter(async ([test]) => {
        calls[test.id] = (calls[test.id] ?? 0) + 1;
        return [
          {
            id: test.id,
            status:
              test.id === "two"
                ? "skipped"
                : calls[test.id] === 1
                  ? "failed"
                  : "passed",
            duration: 1,
          },
        ];
      }),
      { retries: 2 },
    );
    expect(calls).toEqual({ one: 2, two: 1 });
    expect(result[0].metadata?.attempts).toBe(2);
  });
  it("fails closed on an adapter returning no result", async () => {
    expect(
      (
        await new WorkerPool().executeTests(
          tests.slice(0, 1),
          adapter(async () => []),
          {},
        )
      )[0].status,
    ).toBe("failed");
  });
  it("rejects invalid worker configuration", () => {
    for (const value of [0, -1, NaN, 1.5])
      expect(() => new WorkerPool(value)).toThrow();
  });
  it("counts timeouts as failed and can be reused after errors", async () => {
    const runner = new TestRunner({
      framework: "vitest",
      reporters: [],
      parallel: "auto",
    });
    runner.setAdapter(
      adapter(async ([test]) => [
        { id: test.id, status: "timeout", duration: 1 },
      ]),
    );
    expect((await runner.run()).summary.failed).toBe(2);
    runner.setAdapter({ ...adapter(async () => []), discover: async () => [] });
    await expect(runner.run()).rejects.toThrow("No tests discovered");
    runner.setAdapter(
      adapter(async ([test]) => [
        { id: test.id, status: "passed", duration: 1 },
      ]),
    );
    expect((await runner.run()).summary.passed).toBe(2);
  });
});
describe("subprocess execution", () => {
  it("passes shell metacharacters literally and forwards environment", async () => {
    const literal = "a; echo injected $(echo nope)";
    const result = await executeNode(
      [
        "-e",
        "console.log(JSON.stringify([process.argv[1],process.env.TESTFN_PROBE]))",
        literal,
      ],
      { env: { TESTFN_PROBE: "yes" } },
    );
    expect(JSON.parse(result.stdout)).toEqual([literal, "yes"]);
    expect(result.code).toBe(0);
  });
  it("terminates a hung child on timeout", async () => {
    const result = await executeNode(["-e", "setInterval(()=>{},1000)"], {
      timeout: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });
  it("terminates a child on cancellation", async () => {
    const controller = new AbortController();
    const result = executeNode(["-e", "setInterval(()=>{},1000)"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    expect((await result).aborted).toBe(true);
  });
});
it("emits completion before the next sequential file starts", async () => {
  const events: string[] = [];
  const runner = new TestRunner({
    framework: "vitest",
    parallel: 1,
    reporters: [
      {
        onTestStart: (test) => {
          events.push("start " + test.id);
        },
        onTestComplete: (result) => {
          events.push("end " + result.id);
        },
      },
    ],
  });
  runner.setAdapter(
    adapter(async ([test]) => {
      events.push("run " + test.id);
      return [{ id: test.id, status: "passed", duration: 1 }];
    }),
  );
  await runner.run();
  expect(events).toEqual([
    "start one",
    "run one",
    "end one",
    "start two",
    "run two",
    "end two",
  ]);
});
