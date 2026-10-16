import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { TestStorage, getArtifactId } from "../storage/test-storage.js";
import { ConsoleReporter } from "../reporters/console-reporter.js";
import { VitestAdapter } from "../integrations/vitest-adapter.js";
import { PlaywrightAdapter } from "../integrations/playwright-adapter.js";
import { JestAdapter } from "../integrations/jest-adapter.js";
import { PuppeteerAdapter } from "../integrations/puppeteer-adapter.js";
import { WorkerPool } from "./worker-pool.js";
import type {
  TestFnConfig,
  TestResults,
  TestFrameworkAdapter,
  Reporter,
  BrowserConfig,
} from "../types.js";

export class TestRunner {
  private storage?: TestStorage;
  private reporters: Reporter[];
  private adapter: TestFrameworkAdapter;
  private controller?: AbortController;
  constructor(private config: TestFnConfig) {
    this.reporters = config.reporters ?? [new ConsoleReporter()];
    if (config.storage) this.storage = new TestStorage(config.storage);
    const adapters = {
      vitest: VitestAdapter,
      playwright: PlaywrightAdapter,
      jest: JestAdapter,
      puppeteer: PuppeteerAdapter,
    };
    const Adapter = adapters[config.framework];
    if (!Adapter) throw new Error(`Unsupported framework: ${config.framework}`);
    this.adapter = new Adapter();
  }
  setAdapter(adapter: TestFrameworkAdapter): void {
    if (this.controller)
      throw new Error("Cannot replace an adapter during a run");
    this.adapter = adapter;
  }
  cancel(): void {
    this.controller?.abort();
  }
  async run(): Promise<TestResults> {
    if (this.controller) throw new Error("Runner is already running");
    const controller = new AbortController();
    this.controller = controller;
    const abort = () => controller.abort();
    this.config.signal?.addEventListener("abort", abort, { once: true });
    if (this.config.signal?.aborted) abort();
    const parallel =
      this.config.parallel === "auto"
        ? Math.max(1, Math.floor(availableParallelism() / 2))
        : (this.config.parallel ?? 1);
    let pool: WorkerPool | undefined;
    try {
      pool = new WorkerPool(parallel);
      await this.storage?.open();
      const patterns = Array.isArray(this.config.testPattern)
        ? this.config.testPattern
        : [
            this.config.testPattern ??
              "./tests/**/*.{test,spec}.{ts,js,mjs,cjs}",
          ];
      const tests = await this.adapter.discover(patterns);
      if (!tests.length) throw new Error("No tests discovered");
      const start = Date.now();
      for (const reporter of this.reporters) await reporter.onRunStart?.();
      const browsers: BrowserConfig[] | undefined = this.config.browsers?.map(
        (browser) =>
          typeof browser === "string" ? { name: browser } : browser,
      );
      const results = await pool.executeTests(tests, this.adapter, {
        parallel,
        timeout: this.config.timeout,
        retries: this.config.retries,
        env: {
          ...this.config.env,
          ...(this.config.visual
            ? { TESTFN_VISUAL_CONFIG: JSON.stringify(this.config.visual) }
            : {}),
        },
        browsers,
        signal: controller.signal,
        configFile: this.config.configFile,
        onProgress: this.config.onProgress,
        onTestStart: async (test) => {
          for (const reporter of this.reporters)
            await reporter.onTestStart?.(test);
        },
        onTestComplete: async (result) => {
          for (const reporter of this.reporters)
            await reporter.onTestComplete?.(result);
        },
      });
      const summary = {
        total: results.length,
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter(
          (r) => r.status === "failed" || r.status === "timeout",
        ).length,
        skipped: results.filter((r) => r.status === "skipped").length,
        duration: Date.now() - start,
      };
      const run: TestResults = {
        id: randomUUID(),
        timestamp: Date.now(),
        summary,
        results,
      };
      run.artifacts = results.flatMap((result) =>
        (result.artifacts ?? []).map((artifact, index) => ({
          id: getArtifactId(run.id, result.id, artifact.type, index),
          testId: result.id,
          type: artifact.type,
          path: artifact.path,
        })),
      );
      await this.storage?.saveRun({
        ...run,
        environment: {
          platform: process.platform,
          nodeVersion: process.version,
          ci: process.env.CI === "true",
        },
      });
      for (const reporter of this.reporters)
        await reporter.onRunComplete?.(summary);
      await this.config.onComplete?.(run);
      return run;
    } finally {
      controller.abort();
      try {
        await pool?.shutdown();
      } finally {
        try {
          await this.storage?.close();
        } finally {
          this.controller = undefined;
          this.config.signal?.removeEventListener("abort", abort);
        }
      }
    }
  }
}
