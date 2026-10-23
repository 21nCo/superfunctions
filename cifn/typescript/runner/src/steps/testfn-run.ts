import type { TestFnConfig } from '@testfn/core';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface TestFnRunOptions {
  framework?: string;
  testPattern?: string;
  reporter?: string;
  outputPath?: string;
  workspace: string;
  env?: Record<string, string>;
  parallel?: number | 'auto';
  timeout?: number;
  retries?: number;
}

export interface TestFnRunResult {
  success: boolean;
  exitCode: number;
  lines: string[];
  error?: string;
}

/** @deprecated TestFn execution is asynchronous; use executeTestFnRunAsync. */
export function executeTestFnRun(_options: TestFnRunOptions): TestFnRunResult {
  const error = 'TestFn execution requires executeTestFnRunAsync; synchronous execution is unavailable.';
  return { success: false, exitCode: 1, lines: [`Test execution failed: ${error}`], error };
}

export async function executeTestFnRunAsync(options: TestFnRunOptions): Promise<TestFnRunResult> {
  const {
    framework = 'vitest',
    testPattern,
    reporter,
    outputPath = './testfn-results.json',
    workspace,
    env,
    parallel,
    timeout,
    retries
  } = options;
  const lines: string[] = [];

  lines.push(`Running tests with testfn SDK (framework: ${framework})`);

  try {
    const cwd = resolve(workspace);
    if (!['vitest', 'playwright', 'jest'].includes(framework)) {
      throw new Error(`Unsupported framework: ${framework}. Supported: vitest, playwright, jest`);
    }

    const { TestRunner, JsonReporter } = await import('@testfn/core');
    const config: TestFnConfig = {
      framework: framework as 'vitest' | 'playwright' | 'jest',
      cwd,
      testPattern: testPattern || './tests/**/*.{test,spec}.{ts,js}',
      parallel,
      timeout,
      retries,
      env,
      reporters: reporter === 'json' ? [new JsonReporter(join(cwd, outputPath))] : undefined,
    };

    const runner = new TestRunner(config);
    const results = await runner.run();

    lines.push(`Tests completed: ${results.summary.total} total`);
    lines.push(`Passed: ${results.summary.passed}, Failed: ${results.summary.failed}`);

    if (reporter === 'json' && outputPath) {
      const fullPath = join(cwd, outputPath);
      if (existsSync(fullPath)) {
        lines.push(`JSON report written to ${outputPath}`);
      }
    }

    if (results.summary.failed > 0) {
      return {
        success: false,
        exitCode: 1,
        lines,
        error: 'Tests failed'
      };
    }

    return { success: true, exitCode: 0, lines };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    lines.push(`Test execution failed: ${errorMessage}`);
    return {
      success: false,
      exitCode: 1,
      lines,
      error: errorMessage
    };
  }
}
