import type { TestFrameworkAdapter, TestCase, TestResult, RunOptions } from '../types.js';

export abstract class BaseAdapter implements TestFrameworkAdapter {
  abstract name: string;

  abstract discover(pattern: string[]): Promise<TestCase[]>;
  
  abstract run(tests: TestCase[], options: RunOptions): Promise<TestResult[]>;

  supports(framework: string): boolean {
    return this.name.toLowerCase() === framework.toLowerCase();
  }

  protected generateTestId(file: string, name: string, suite?: string): string {
    const parts = [file];
    if (suite) parts.push(suite);
    parts.push(name);
    return parts.join(' > ');
  }

  protected async executeWithTimeout<T>(
    promise: Promise<T>,
    timeout: number = 30000
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error('Test execution timeout')), timeout)
      )
    ]);
  }
}
