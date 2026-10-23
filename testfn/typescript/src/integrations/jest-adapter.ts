import { spawn } from 'child_process';
import fg from 'fast-glob';
import { BaseAdapter } from './base-adapter.js';
import type { TestCase, TestResult, RunOptions } from '../types.js';

export class JestAdapter extends BaseAdapter {
  name = 'jest';

  async discover(pattern: string[]): Promise<TestCase[]> {
    const files = await fg(pattern, {
      absolute: false,
      onlyFiles: true
    });

    const tests: TestCase[] = [];
    
    for (const file of files) {
      const testId = this.generateTestId(file, 'jest-test');
      tests.push({
        id: testId,
        file,
        name: file,
        suite: 'jest'
      });
    }

    return tests;
  }

  async run(tests: TestCase[], options: RunOptions): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (const test of tests) {
      const startTime = Date.now();
      
      try {
        const result = await this.runJestTest(test.file, options);
        const duration = Date.now() - startTime;

        results.push({
          id: test.id,
          status: result.passed ? 'passed' : 'failed',
          duration,
          error: result.error ? {
            message: result.error.message,
            stack: result.error.stack
          } : undefined
        });

        if (options.onProgress) {
          options.onProgress({
            completed: results.length,
            total: tests.length,
            current: test
          });
        }
      } catch (error) {
        const duration = Date.now() - startTime;
        results.push({
          id: test.id,
          status: 'failed',
          duration,
          error: {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          }
        });
      }
    }

    return results;
  }

  private async runJestTest(
    file: string,
    options: RunOptions
  ): Promise<{ passed: boolean; error?: Error }> {
    return new Promise((resolve) => {
      const args = ['--testPathPattern', file, '--json', '--no-coverage'];
      
      if (options.timeout) {
        args.push(`--testTimeout=${options.timeout}`);
      }

      const child = spawn('npx', ['jest', ...args], {
        env: { ...process.env, ...options.env },
        shell: true
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ passed: true });
        } else {
          try {
            const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
            if (jsonMatch) {
              const result = JSON.parse(jsonMatch[0]);
              const failureMessage = result.testResults?.[0]?.message || stderr || stdout;
              resolve({
                passed: false,
                error: new Error(failureMessage)
              });
            } else {
              resolve({
                passed: false,
                error: new Error(stderr || stdout || `Test failed with code ${code}`)
              });
            }
          } catch {
            resolve({
              passed: false,
              error: new Error(stderr || stdout || `Test failed with code ${code}`)
            });
          }
        }
      });

      child.on('error', (error) => {
        resolve({ passed: false, error });
      });
    });
  }
}
