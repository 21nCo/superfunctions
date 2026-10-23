import type {
  TestFrameworkAdapter,
  TestCase,
  TestResult,
  RunOptions,
} from "../types.js";

export abstract class BaseAdapter implements TestFrameworkAdapter {
  abstract name: string;

  abstract discover(
    pattern: string[],
    options?: Pick<RunOptions, "cwd">,
  ): Promise<TestCase[]>;

  abstract run(tests: TestCase[], options: RunOptions): Promise<TestResult[]>;

  supports(framework: string): boolean {
    return this.name.toLowerCase() === framework.toLowerCase();
  }

  protected generateTestId(file: string, name: string, suite?: string): string {
    const parts = [file];
    if (suite) parts.push(suite);
    parts.push(name);
    return parts.join(" > ");
  }

  protected async executeWithTimeout<T>(
    promise: Promise<T>,
    timeout: number = 30000,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Test execution timeout")),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
