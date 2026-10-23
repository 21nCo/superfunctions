import { TestRunner, JsonReporter, type TestFnConfig } from '@testfn/core';
import { join } from 'node:path';
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

export function executeTestFnRun(options: TestFnRunOptions): TestFnRunResult {
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
    if (!['vitest', 'playwright', 'jest'].includes(framework)) {
      throw new Error(`Unsupported framework: ${framework}. Supported: vitest, playwright, jest`);
    }

    const config: TestFnConfig = {
      framework: framework as 'vitest' | 'playwright' | 'jest',
      testPattern: testPattern || './tests/**/*.{test,spec}.{ts,js}',
      parallel,
      timeout,
      retries,
      env,
      reporters: reporter === 'json' ? [new JsonReporter(join(workspace, outputPath))] : undefined,
    };

    const originalCwd = process.cwd();
    try {
      process.chdir(workspace);
      
      const runner = new TestRunner(config);
      const results = runner.run();
      
      process.chdir(originalCwd);

      if (results && typeof results === 'object' && 'then' in results) {
        throw new Error('executeTestFnRun must be called from async context or use sync adapter');
      }

      lines.push(`Tests completed: ${(results as any).summary?.total || 0} total`);
      lines.push(`Passed: ${(results as any).summary?.passed || 0}, Failed: ${(results as any).summary?.failed || 0}`);
      
      if (reporter === 'json' && outputPath) {
        const fullPath = join(workspace, outputPath);
        if (existsSync(fullPath)) {
          lines.push(`JSON report written to ${outputPath}`);
        }
      }

      const hasFailed = (results as any).summary?.failed > 0;
      if (hasFailed) {
        return {
          success: false,
          exitCode: 1,
          lines,
          error: 'Tests failed'
        };
      }

      return { success: true, exitCode: 0, lines };
    } catch (innerErr) {
      process.chdir(originalCwd);
      throw innerErr;
    }
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
    if (!['vitest', 'playwright', 'jest'].includes(framework)) {
      throw new Error(`Unsupported framework: ${framework}. Supported: vitest, playwright, jest`);
    }

    const config: TestFnConfig = {
      framework: framework as 'vitest' | 'playwright' | 'jest',
      testPattern: testPattern || './tests/**/*.{test,spec}.{ts,js}',
      parallel,
      timeout,
      retries,
      env,
      reporters: reporter === 'json' ? [new JsonReporter(join(workspace, outputPath))] : undefined,
    };

    const originalCwd = process.cwd();
    try {
      process.chdir(workspace);
      
      const runner = new TestRunner(config);
      const results = await runner.run();
      
      process.chdir(originalCwd);

      lines.push(`Tests completed: ${results.summary.total} total`);
      lines.push(`Passed: ${results.summary.passed}, Failed: ${results.summary.failed}`);
      
      if (reporter === 'json' && outputPath) {
        const fullPath = join(workspace, outputPath);
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
    } catch (innerErr) {
      process.chdir(originalCwd);
      throw innerErr;
    }
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
