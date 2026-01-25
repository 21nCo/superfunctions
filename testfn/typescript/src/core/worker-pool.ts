import type { TestCase, TestResult, RunOptions, TestFrameworkAdapter } from '../types.js';

interface WorkerTask {
  test: TestCase;
  resolve: (result: TestResult) => void;
  reject: (error: Error) => void;
}

export class WorkerPool {
  private queue: WorkerTask[] = [];
  private activeWorkers: number = 0;
  private maxWorkers: number;

  constructor(maxWorkers: number = 4) {
    this.maxWorkers = Math.max(1, maxWorkers);
  }

  async executeTests(
    tests: TestCase[],
    adapter: TestFrameworkAdapter,
    options: RunOptions
  ): Promise<TestResult[]> {
    const results: TestResult[] = [];
    let completedCount = 0;

    const promises = tests.map(test => {
      return new Promise<TestResult>((resolve, reject) => {
        this.queue.push({ test, resolve, reject });
      }).then(result => {
        results.push(result);
        completedCount++;
        
        if (options.onProgress) {
          options.onProgress({
            completed: completedCount,
            total: tests.length,
            current: test
          });
        }
        
        return result;
      });
    });

    this.processQueue(adapter, options);

    await Promise.all(promises);
    return results;
  }

  private async processQueue(
    adapter: TestFrameworkAdapter,
    options: RunOptions
  ): Promise<void> {
    while (this.queue.length > 0 || this.activeWorkers > 0) {
      if (this.queue.length === 0 || this.activeWorkers >= this.maxWorkers) {
        await new Promise(resolve => setTimeout(resolve, 10));
        continue;
      }

      const task = this.queue.shift();
      if (!task) continue;

      this.activeWorkers++;

      this.executeTest(adapter, task, options)
        .then(result => {
          task.resolve(result);
        })
        .catch(error => {
          task.reject(error);
        })
        .finally(() => {
          this.activeWorkers--;
        });
    }
  }

  private async executeTest(
    adapter: TestFrameworkAdapter,
    task: WorkerTask,
    options: RunOptions
  ): Promise<TestResult> {
    const { test } = task;
    let lastError: Error | undefined;
    const retries = options.retries ?? 0;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const results = await adapter.run([test], {
          ...options,
          onProgress: undefined
        });

        const result = results[0];
        
        if (result.status === 'passed' || attempt === retries) {
          return result;
        }

        lastError = result.error ? new Error(result.error.message) : undefined;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === retries) {
          return {
            id: test.id,
            status: 'failed',
            duration: 0,
            error: {
              message: lastError.message,
              stack: lastError.stack
            }
          };
        }
      }
    }

    return {
      id: test.id,
      status: 'failed',
      duration: 0,
      error: {
        message: lastError?.message || 'Test failed after retries',
        stack: lastError?.stack
      }
    };
  }

  async shutdown(): Promise<void> {
    while (this.activeWorkers > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
