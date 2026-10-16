import { fileURLToPath } from "node:url";
import { JsonFrameworkAdapter } from "./json-adapter.js";
import type { RunOptions, TestCase, TestResult } from "../types.js";
/** Executes Puppeteer browser suites authored using Node's built-in node:test API. */
export class PuppeteerAdapter extends JsonFrameworkAdapter {
  name = "puppeteer";
  protected arguments(file: string, _options: RunOptions): string[] {
    return [
      "--test",
      "--test-concurrency=1",
      `--test-reporter=${fileURLToPath(new URL("./node-reporter.js", import.meta.url))}`,
      file,
    ];
  }
  protected parse(output: string, test: TestCase): TestResult[] {
    const events = output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const results = events
      .filter((event) => event.event !== "log")
      .map((result) => ({
        ...result,
        id: this.generateTestId(test.file, result.name),
        metadata: { file: test.file, name: result.name },
      }));
    if (results.length)
      results[0].artifacts = events
        .filter((event) => event.event === "log")
        .map((event, index) => ({
          type: "log",
          path: `${test.file}.${event.stream}.${index}.log`,
          buffer: Buffer.from(event.message),
          metadata: { stream: event.stream, scope: "file" },
        }));
    return results;
  }
}
