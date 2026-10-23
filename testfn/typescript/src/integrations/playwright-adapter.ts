import { spawn } from 'child_process';
import fg from 'fast-glob';
import { BaseAdapter } from './base-adapter.js';
import type { TestCase, TestResult, RunOptions, BrowserConfig, BrowserType } from '../types.js';

export class PlaywrightAdapter extends BaseAdapter {
  name = 'playwright';

  async discover(pattern: string[]): Promise<TestCase[]> {
    const files = await fg(pattern, {
      absolute: false,
      onlyFiles: true
    });

    const tests: TestCase[] = [];
    
    for (const file of files) {
      const testId = this.generateTestId(file, 'playwright-test');
      tests.push({
        id: testId,
        file,
        name: file,
        suite: 'playwright'
      });
    }

    return tests;
  }

  async run(tests: TestCase[], options: RunOptions): Promise<TestResult[]> {
    const browsers = this.getBrowsers(options.browsers);
    const results: TestResult[] = [];

    for (const test of tests) {
      for (const browser of browsers) {
        const startTime = Date.now();
        const testId = `${test.id} (${browser.name})`;
        
        try {
          const result = await this.runPlaywrightTest(test.file, browser, options);
          const duration = Date.now() - startTime;

          results.push({
            id: testId,
            status: result.passed ? 'passed' : 'failed',
            duration,
            error: result.error ? {
              message: result.error.message,
              stack: result.error.stack
            } : undefined,
            artifacts: result.artifacts,
            metadata: {
              browser: browser.name,
              headless: browser.headless
            }
          });

          if (options.onProgress) {
            options.onProgress({
              completed: results.length,
              total: tests.length * browsers.length,
              current: test
            });
          }
        } catch (error) {
          const duration = Date.now() - startTime;
          results.push({
            id: testId,
            status: 'failed',
            duration,
            error: {
              message: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined
            },
            metadata: {
              browser: browser.name
            }
          });
        }
      }
    }

    return results;
  }

  private getBrowsers(browserConfigs?: BrowserConfig[]): Array<{ name: BrowserType; headless: boolean }> {
    if (!browserConfigs || browserConfigs.length === 0) {
      return [{ name: 'chromium', headless: true }];
    }

    return browserConfigs.map(config => ({
      name: config.name,
      headless: config.headless ?? true
    }));
  }

  private async runPlaywrightTest(
    file: string,
    browser: { name: BrowserType; headless: boolean },
    options: RunOptions
  ): Promise<{ passed: boolean; error?: Error; artifacts?: Array<{ type: 'screenshot' | 'video' | 'trace'; path: string }> }> {
    return new Promise((resolve) => {
      const args = ['test', file, `--project=${browser.name}`, '--reporter=json'];
      
      if (browser.headless) {
        args.push('--headed=false');
      }

      if (options.timeout) {
        args.push(`--timeout=${options.timeout}`);
      }

      const child = spawn('npx', ['playwright', ...args], {
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
          resolve({
            passed: false,
            error: new Error(stderr || stdout || `Test failed with code ${code}`)
          });
        }
      });

      child.on('error', (error) => {
        resolve({ passed: false, error });
      });
    });
  }
}
