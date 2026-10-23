import { randomBytes } from 'crypto';
import { TestStorage } from '../storage/test-storage.js';
import { ConsoleReporter } from '../reporters/console-reporter.js';
import { VitestAdapter } from '../integrations/vitest-adapter.js';
import { PlaywrightAdapter } from '../integrations/playwright-adapter.js';
import { JestAdapter } from '../integrations/jest-adapter.js';
import { WorkerPool } from './worker-pool.js';
import type {
  TestFnConfig,
  TestResults,
  TestRunSummary,
  TestFrameworkAdapter,
  EnvironmentInfo,
  Reporter
} from '../types.js';

export class TestRunner {
  private config: TestFnConfig;
  private storage?: TestStorage;
  private reporters: Reporter[];
  private adapter?: TestFrameworkAdapter;

  constructor(config: TestFnConfig) {
    this.config = config;
    this.reporters = config.reporters ?? [new ConsoleReporter()];
    
    if (config.storage) {
      this.storage = new TestStorage(config.storage);
    }

    this.adapter = this.detectAdapter(config.framework);
  }

  private detectAdapter(framework: string): TestFrameworkAdapter {
    switch (framework.toLowerCase()) {
      case 'vitest':
        return new VitestAdapter();
      case 'playwright':
        return new PlaywrightAdapter();
      case 'jest':
        return new JestAdapter();
      default:
        throw new Error(`Unsupported framework: ${framework}. Supported: vitest, playwright, jest`);
    }
  }

  setAdapter(adapter: TestFrameworkAdapter): void {
    this.adapter = adapter;
  }

  async run(): Promise<TestResults> {
    if (!this.adapter) {
      throw new Error('No test framework adapter configured');
    }

    if (this.storage) {
      await this.storage.open();
    }

    const pattern = Array.isArray(this.config.testPattern)
      ? this.config.testPattern
      : [this.config.testPattern ?? './tests/**/*.{test,spec}.{ts,js}'];

    const tests = await this.adapter.discover(pattern);
    
    const startTime = Date.now();

    for (const test of tests) {
      for (const reporter of this.reporters) {
        reporter.onTestStart?.(test);
      }
    }

const parallelCount = this.config.parallel === 'auto' 
      ? Math.max(1, Math.floor(require('os').cpus().length / 2))
      : (this.config.parallel ?? 1);

    const workerPool = new WorkerPool(parallelCount);
    
    const results = await workerPool.executeTests(tests, this.adapter, {
      parallel: parallelCount,
      timeout: this.config.timeout,
      retries: this.config.retries,
      env: this.config.env,
      browsers: this.config.browsers as any,
      onProgress: (progress) => {
        if (this.config.onProgress) {
          this.config.onProgress(progress);
        }
      }
    });

    for (const result of results) {
      for (const reporter of this.reporters) {
        reporter.onTestComplete?.(result);
      }
    }

    await workerPool.shutdown();

    const duration = Date.now() - startTime;
    const summary: TestRunSummary = {
      total: results.length,
      passed: results.filter(r => r.status === 'passed').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      duration
    };

    for (const reporter of this.reporters) {
      reporter.onRunComplete?.(summary);
    }

    const runId = randomBytes(16).toString('hex');
    const testResults: TestResults = {
      id: runId,
      timestamp: Date.now(),
      summary,
      results
    };

    if (this.storage) {
      const environment: EnvironmentInfo = {
        platform: process.platform,
        nodeVersion: process.version,
        ci: process.env.CI === 'true'
      };

      await this.storage.saveRun({
        id: runId,
        timestamp: testResults.timestamp,
        environment,
        summary,
        results
      });

      await this.storage.close();
    }

    if (this.config.onComplete) {
      this.config.onComplete(testResults);
    }

    return testResults;
  }
}
