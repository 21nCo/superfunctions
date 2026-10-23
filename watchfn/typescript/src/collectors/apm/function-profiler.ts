// Function profiler for APM

export class FunctionProfiler {
  constructor(
    private trackCallback: (name: string, data: Record<string, any>) => void,
    private slowThreshold: number = 1000
  ) {}

  private enabled: boolean = true;

  /**
   * Profile a function execution
   */
  profile<T>(name: string, fn: () => T, tags?: Record<string, string>): T {
    if (!this.enabled) {
      return fn();
    }

    const startTime = Date.now();
    let error: Error | undefined;

    try {
      return fn();
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      const duration = Date.now() - startTime;
      this.trackExecution(name, duration, error, tags);
    }
  }

  /**
   * Profile an async function execution
   */
  async profileAsync<T>(
    name: string,
    fn: () => Promise<T>,
    tags?: Record<string, string>
  ): Promise<T> {
    if (!this.enabled) {
      return fn();
    }

    const startTime = Date.now();
    let error: Error | undefined;

    try {
      return await fn();
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      const duration = Date.now() - startTime;
      this.trackExecution(name, duration, error, tags);
    }
  }

  private trackExecution(
    name: string,
    duration: number,
    error?: Error,
    tags?: Record<string, string>
  ): void {
    const isSlow = duration > this.slowThreshold;

    const eventData: Record<string, any> = {
      function: name,
      duration,
      slow: isSlow,
      type: "function",
    };

    if (tags) {
      eventData.tags = tags;
    }

    if (error) {
      eventData.error = error.message;
      eventData.errorType = error.name;
    }

    const eventName = isSlow ? "function.slow" : "function.execution";
    this.trackCallback(eventName, eventData);
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }
}

/**
 * Decorator for profiling functions
 */
export function profileFunction(
  profiler: FunctionProfiler,
  name?: string,
  tags?: Record<string, string>
) {
  return function (
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const functionName = name || `${target.constructor.name}.${propertyName}`;

    if (originalMethod.constructor.name === "AsyncFunction") {
      descriptor.value = async function (...args: any[]) {
        return profiler.profileAsync(
          functionName,
          () => originalMethod.apply(this, args),
          tags
        );
      };
    } else {
      descriptor.value = function (...args: any[]) {
        return profiler.profile(
          functionName,
          () => originalMethod.apply(this, args),
          tags
        );
      };
    }

    return descriptor;
  };
}
