export interface TraceSpanOptions {
  name: string;
  metadata?: Record<string, any>;
}

export class Tracer {
  private watch: any;

  constructor(options: { watch?: any } = {}) {
    this.watch = options.watch;
  }

  async trace<T>(name: string, metadata: Record<string, any>, fn: () => Promise<T>): Promise<T> {
    const traceId = Math.random().toString(36).substring(7);
    
    if (this.watch) {
      this.watch.track(name, { phase: "start", traceId, ...metadata });
    }

    try {
      const result = await fn();
      
      if (this.watch) {
        this.watch.track(name, { phase: "end", traceId, ...metadata });
      }
      
      return result;
    } catch (error: any) {
      if (this.watch) {
        this.watch.track(name, { phase: "error", traceId, error: error.message, ...metadata });
      }
      throw error;
    }
  }
}
