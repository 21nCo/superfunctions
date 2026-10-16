import type {
  TestCase,
  TestResult,
  RunOptions,
  TestFrameworkAdapter,
} from "../types.js";

export class WorkerPool {
  private active?: Promise<TestResult[]>;
  constructor(private maxWorkers = 4) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1)
      throw new Error("parallel must be a positive integer");
  }
  async executeTests(
    tests: TestCase[],
    adapter: TestFrameworkAdapter,
    options: RunOptions,
  ): Promise<TestResult[]> {
    if (this.active) throw new Error("Worker pool is already running");
    const retries = options.retries ?? 0;
    if (!Number.isInteger(retries) || retries < 0)
      throw new Error("retries must be a nonnegative integer");
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) || options.timeout <= 0)
    )
      throw new Error("timeout must be positive");
    let next = 0,
      completed = 0;
    const grouped: TestResult[][] = new Array(tests.length);
    const worker = async () => {
      while (next < tests.length) {
        const index = next++,
          test = tests[index];
        if (options.signal?.aborted) {
          grouped[index] = [
            {
              id: test.id,
              status: "skipped",
              duration: 0,
              metadata: { cancelled: true },
            },
          ];
          await options.onTestComplete?.(grouped[index][0]);
          completed++;
          options.onProgress?.({
            completed,
            total: tests.length,
            current: test,
          });
          continue;
        }
        await options.onTestStart?.(test);
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const results = await adapter.run([test], {
              ...options,
              onProgress: undefined,
              onTestStart: undefined,
              onTestComplete: undefined,
            });
            if (!results.length)
              throw new Error(
                "Adapter returned no results for a discovered test",
              );
            if (
              results.some(
                (result) =>
                  !result ||
                  typeof result.id !== "string" ||
                  !["passed", "failed", "skipped", "timeout"].includes(
                    result.status,
                  ) ||
                  !Number.isFinite(result.duration) ||
                  result.duration < 0,
              )
            )
              throw new Error("Adapter returned an invalid test result");
            grouped[index] = results.map((result) => ({
              ...result,
              metadata: { ...result.metadata, attempts: attempt + 1 },
            }));
          } catch (error) {
            grouped[index] = [
              {
                id: test.id,
                status: "failed",
                duration: 0,
                error: { message: String(error) },
              },
            ];
          }
          if (
            options.signal?.aborted ||
            !grouped[index].some(
              (result) =>
                result.status === "failed" || result.status === "timeout",
            )
          )
            break;
        }
        for (const result of grouped[index])
          await options.onTestComplete?.(result);
        completed++;
        options.onProgress?.({ completed, total: tests.length, current: test });
      }
    };
    this.active = Promise.allSettled(
      Array.from({ length: Math.min(this.maxWorkers, tests.length) }, worker),
    ).then((settled) => {
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return grouped.flat();
    });
    try {
      return await this.active;
    } finally {
      this.active = undefined;
    }
  }
  async shutdown(): Promise<void> {
    await this.active;
  }
}
