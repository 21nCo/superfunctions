import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonFrameworkAdapter } from "./json-adapter.js";
import { frameworkCli } from "./process.js";
import type { RunOptions, TestCase, TestResult } from "../types.js";

export class PlaywrightAdapter extends JsonFrameworkAdapter {
  name = "playwright";
  protected arguments(_file: string, options: RunOptions): string[] {
    return [
      frameworkCli("@playwright/test", "playwright"),
      "test",
      "--config",
      options.configFile!,
      "--reporter=json",
      "--workers=1",
      ...(options.timeout ? [`--timeout=${options.timeout}`] : []),
    ];
  }
  protected async execute(
    test: TestCase,
    options: RunOptions,
  ): Promise<TestResult[]> {
    const token = randomUUID();
    const configFile = resolve(`.testfn-${token}.config.ts`);
    const original =
      options.configFile ??
      ["ts", "js", "mts", "mjs", "cts", "cjs"]
        .map((ext) => resolve(`playwright.config.${ext}`))
        .find(existsSync);
    const browsers = options.browsers?.length
      ? options.browsers
      : [{ name: "chromium" as const, headless: true }];
    const projects = browsers.map((browser) => ({
      name: browser.name,
      use: {
        ...browser,
        browserName: browser.name,
        timezoneId: browser.timezone,
        name: undefined,
        timezone: undefined,
      },
    }));
    const literalPath = resolve(test.file).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const content = `${original ? `import original from ${JSON.stringify(resolve(original))};` : "const original = {};"}
export default {...original, testDir:${JSON.stringify(process.cwd())}, testMatch:new RegExp(${JSON.stringify("^" + literalPath + "$")}), outputDir:${JSON.stringify(join(process.cwd(), "test-results", `testfn-${token}`))}, projects:${JSON.stringify(projects)}.map(project=>({...project,use:{...original.use,...original.projects?.find(p=>p.name===project.name)?.use,...project.use}}))};`;
    writeFileSync(configFile, content);
    try {
      return await super.execute(test, { ...options, configFile });
    } finally {
      unlinkSync(configFile);
    }
  }
  protected parse(output: string, test: TestCase): TestResult[] {
    const report = JSON.parse(output);
    const results: TestResult[] = [];
    const visit = (suite: any, titles: string[]) => {
      for (const spec of suite.specs ?? [])
        for (const project of spec.tests ?? []) {
          const result = project.results?.at(-1);
          if (!result) continue;
          const status =
            result.status === "skipped"
              ? "skipped"
              : project.status === "expected" || project.status === "flaky"
                ? "passed"
                : result.status === "timedOut"
                  ? "timeout"
                  : "failed";
          const name = [...titles, spec.title].filter(Boolean).join(" > ");
          const logs = ["stdout", "stderr"].flatMap((stream) => {
            const text = (result[stream] ?? [])
              .map(
                (entry: any) =>
                  entry.text ??
                  (entry.buffer
                    ? Buffer.from(entry.buffer, "base64").toString("utf8")
                    : ""),
              )
              .join("");
            return text
              ? [
                  {
                    type: "log" as const,
                    path: `${test.file}.${project.projectName}.${stream}.log`,
                    buffer: Buffer.from(text),
                    metadata: { stream },
                  },
                ]
              : [];
          });
          results.push({
            id: this.generateTestId(
              test.file,
              `${name} (${project.projectName})`,
            ),
            status,
            duration: result.duration ?? 0,
            ...(status === "failed" || status === "timeout"
              ? {
                  error: {
                    message:
                      result.error?.message ??
                      result.errors?.map((e: any) => e.message).join("\n") ??
                      "Playwright test failed",
                  },
                }
              : {}),
            artifacts: [
              ...logs,
              ...(result.attachments ?? [])
                .filter((a: any) => a.path)
                .map((a: any) => ({
                  type: a.contentType?.startsWith("image/")
                    ? "screenshot"
                    : a.contentType?.startsWith("video/")
                      ? "video"
                      : a.name === "trace"
                        ? "trace"
                        : "log",
                  path: a.path,
                })),
            ],
            metadata: { browser: project.projectName, file: test.file, name },
          });
        }
      for (const child of suite.suites ?? [])
        visit(child, [...titles, child.title]);
    };
    for (const suite of report.suites ?? []) visit(suite, []);
    return results;
  }
}
