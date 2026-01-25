// Database query tracer for APM

export interface QueryTraceOptions {
  query: string;
  params?: Record<string, any>;
}

export class DatabaseTracer {
  constructor(
    private trackCallback: (name: string, data: Record<string, any>) => void,
    private slowThreshold: number = 100
  ) {}

  /**
   * Trace a database query
   */
  async traceQuery<T>(
    query: string,
    fn: () => Promise<T>,
    params?: Record<string, any>
  ): Promise<T> {
    const startTime = Date.now();
    let error: Error | undefined;

    try {
      const result = await fn();
      return result;
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      const duration = Date.now() - startTime;
      this.trackQuery(query, duration, params, error);
    }
  }

  /**
   * Trace a synchronous database query
   */
  traceQuerySync<T>(
    query: string,
    fn: () => T,
    params?: Record<string, any>
  ): T {
    const startTime = Date.now();
    let error: Error | undefined;

    try {
      return fn();
    } catch (e) {
      error = e as Error;
      throw e;
    } finally {
      const duration = Date.now() - startTime;
      this.trackQuery(query, duration, params, error);
    }
  }

  private trackQuery(
    query: string,
    duration: number,
    params?: Record<string, any>,
    error?: Error
  ): void {
    const isSlow = duration > this.slowThreshold;

    const eventData: Record<string, any> = {
      query,
      duration,
      params: params || {},
      slow: isSlow,
      type: "database",
    };

    if (error) {
      eventData.error = error.message;
      eventData.errorType = error.name;
    }

    const eventName = isSlow ? "db.query.slow" : "db.query";
    this.trackCallback(eventName, eventData);
  }
}

/**
 * Decorator for tracing database queries
 */
export function traceQuery(tracer: DatabaseTracer, query: string) {
  return function (
    target: any,
    propertyName: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      return tracer.traceQuery(query, () => originalMethod.apply(this, args));
    };

    return descriptor;
  };
}
