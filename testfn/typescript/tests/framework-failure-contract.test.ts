import { it, expect, vi } from "vitest";
import { JsonFrameworkAdapter } from "../src/integrations/json-adapter.js";
import { PuppeteerAdapter } from "../src/integrations/puppeteer-adapter.js";
import { ConsoleReporter } from "../src/reporters/console-reporter.js";
import type { TestCase } from "../src/types.js";
const test = { id: "file", name: "file", file: "fixture.js" };
class ProcessProbe extends JsonFrameworkAdapter {
  name = "probe";
  constructor(private code: string) {
    super();
  }
  protected arguments() {
    return ["-e", this.code];
  }
  wait<T>(promise: Promise<T>, timeout: number) {
    return this.executeWithTimeout(promise, timeout);
  }
  identifier() {
    return this.generateTestId("file", "name", "suite");
  }
}
class PuppeteerProbe extends PuppeteerAdapter {
  read(output: string) {
    return this.parse(output, test);
  }
}
it("fails closed on malformed, empty and failing process reports while preserving stderr", async () => {
  const good = JSON.stringify({
    testResults: [
      { assertionResults: [{ title: "pass", status: "passed", duration: 1 }] },
    ],
  });
  const probe = new ProcessProbe(
    `process.stdout.write(${JSON.stringify(good)});console.error('diagnostic');process.exitCode=1`,
  );
  expect(probe.supports("PROBE")).toBe(true);
  expect(probe.supports("vitest")).toBe(false);
  expect(probe.identifier()).toBe("file > suite > name");
  expect(
    await probe.discover(["tests/framework-failure-contract.test.ts"]),
  ).toHaveLength(1);
  const progress = vi.fn();
  const result = await probe.run([test], { onProgress: progress });
  expect(result.map((x) => x.status)).toEqual(["passed", "failed"]);
  expect(result[0].artifacts?.[0].buffer?.toString()).toContain("diagnostic");
  expect(progress).toHaveBeenCalledOnce();
  for (const output of ["not JSON", "{}"]) {
    const [failure] = await new ProcessProbe(
      `console.log(${JSON.stringify(output)})`,
    ).run([test], {});
    expect(failure.status).toBe("failed");
    expect(failure.error?.message).toMatch(
      /Invalid framework report|no test results/,
    );
  }
  const [timeout] = await new ProcessProbe("setInterval(()=>{},1000)").run(
    [test],
    { timeout: 20 },
  );
  expect(timeout.status).toBe("timeout");
  const [cancelled] = await probe.run([test], { signal: AbortSignal.abort() });
  expect(cancelled.error?.message).toContain("aborted");
  expect(await probe.wait(Promise.resolve(42), 100)).toBe(42);
  await expect(probe.wait(new Promise(() => {}), 1)).rejects.toThrow("timeout");
});
it("captures Node reporter logs without treating logs as assertions", () => {
  const output = [
    { event: "log", stream: "stdout", message: "stdout text" },
    { name: "case", status: "passed", duration: 1 },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n");
  const result = new PuppeteerProbe().read(output);
  expect(result).toHaveLength(1);
  expect(result[0].artifacts?.[0].buffer?.toString()).toBe("stdout text");
  expect(result[0].id).toBe("fixture.js > case");
});
it("console reports failures and skips accurately including pre-cancelled runs", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const reporter = new ConsoleReporter();
    reporter.onRunStart();
    reporter.onRunComplete({
      total: 2,
      passed: 0,
      failed: 0,
      skipped: 2,
      duration: 25,
    });
    expect(log.mock.calls.flat().join("\n")).not.toContain("All tests passed");
    expect(log.mock.calls.flat().join("\n")).toContain("Duration: 0.03s");
    log.mockClear();
    reporter.onRunStart();
    reporter.onTestStart();
    reporter.onTestStart();
    for (const status of ["passed", "skipped", "failed"] as const)
      reporter.onTestComplete({
        id: status,
        status,
        duration: 1,
        ...(status === "failed"
          ? { error: { message: "bad", stack: "first\nsecond" } }
          : {}),
      });
    reporter.onRunComplete({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      duration: 100,
    });
    expect(log.mock.calls.flat().join("\n")).toContain("Tests failed");
    expect(log.mock.calls.flat().join("\n")).toContain("Error: bad");
    log.mockClear();
    reporter.onRunComplete({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      duration: 1,
    });
    expect(log.mock.calls.flat().join("\n")).toContain("All tests passed");
  } finally {
    log.mockRestore();
  }
});
