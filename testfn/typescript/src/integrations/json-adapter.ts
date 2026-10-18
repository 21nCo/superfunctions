import { glob } from "tinyglobby";
import { resolve } from "node:path";
import { BaseAdapter } from "./base-adapter.js";
import { executeNode, type ProcessResult } from "./process.js";
import type { RunOptions, TestCase, TestResult } from "../types.js";

export abstract class JsonFrameworkAdapter extends BaseAdapter {
  protected abstract arguments(file: string, options: RunOptions): string[];
  protected parse(output: string, test: TestCase): TestResult[] {
    const report = JSON.parse(output);
    const results: TestResult[] = [];
    for (const suite of report.testResults ?? [])
      for (const assertion of suite.assertionResults ?? []) {
        const status =
          assertion.status === "passed"
            ? "passed"
            : ["pending", "skipped", "todo", "disabled"].includes(
                  assertion.status,
                )
              ? "skipped"
              : "failed";
        const name =
          assertion.fullName ??
          [...(assertion.ancestorTitles ?? []), assertion.title].join(" ");
        results.push({
          id: this.generateTestId(test.file, name),
          status,
          duration: assertion.duration ?? 0,
          ...(status === "failed"
            ? {
                error: {
                  message:
                    (assertion.failureMessages ?? []).join("\n") ||
                    `Test ${name} failed`,
                },
              }
            : {}),
          metadata: { file: test.file, name },
        });
      }
    return results;
  }
  async discover(pattern: string[]): Promise<TestCase[]> {
    return (await glob(pattern, { onlyFiles: true })).sort().map((file) => ({
      id: this.generateTestId(file, this.name),
      file,
      name: file,
      suite: this.name,
    }));
  }
  protected async execute(
    test: TestCase,
    options: RunOptions,
  ): Promise<TestResult[]> {
    const start = Date.now();
    let processResult: ProcessResult;
    try {
      processResult = await executeNode(
        this.arguments(resolve(test.file), options),
        options,
      );
    } catch (error) {
      return [
        {
          id: test.id,
          status: "failed",
          duration: Date.now() - start,
          error: { message: String(error) },
        },
      ];
    }
    const fail = (message: string): TestResult[] => [
      {
        id: test.id,
        status: processResult.timedOut ? "timeout" : "failed",
        duration: Date.now() - start,
        error: { message },
      },
    ];
    if (processResult.timedOut) return fail("Framework process timed out");
    if (processResult.aborted) return fail("Test run aborted");
    try {
      const results = this.parse(processResult.stdout, test);
      if (!results.length)
        return fail(
          `Framework produced no test results (exit ${processResult.code}): ${processResult.stderr || processResult.stdout}`,
        );
      if (
        processResult.code !== 0 &&
        !results.some(
          (result) => result.status === "failed" || result.status === "timeout",
        )
      )
        results.push(
          ...fail(
            `Framework failed after tests (exit ${processResult.code}): ${processResult.stderr}`,
          ),
        );
      if (processResult.stderr)
        results[0].artifacts = [
          ...(results[0].artifacts ?? []),
          {
            type: "log",
            path: `${test.file}.stderr.log`,
            buffer: Buffer.from(processResult.stderr),
            metadata: { stream: "stderr", file: test.file },
          },
        ];
      return results;
    } catch {
      return fail(
        `Invalid framework report (exit ${processResult.code}): ${processResult.stderr || processResult.stdout}`,
      );
    }
  }
  async run(tests: TestCase[], options: RunOptions): Promise<TestResult[]> {
    const results: TestResult[] = [];
    for (const [index, test] of tests.entries()) {
      results.push(...(await this.execute(test, options)));
      options.onProgress?.({
        completed: index + 1,
        total: tests.length,
        current: test,
      });
      if (options.signal?.aborted) break;
    }
    return results;
  }
}
