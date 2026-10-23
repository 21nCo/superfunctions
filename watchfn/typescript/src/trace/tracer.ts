import { AsyncLocalStorage } from "async_hooks";
import { WatchFn } from "../core/watch-fn";
import { Span, SpanOptions } from "./span";

export class Tracer {
  private watch: WatchFn;
  private context: AsyncLocalStorage<Span>;

  constructor(watch: WatchFn) {
    this.watch = watch;
    this.context = new AsyncLocalStorage<Span>();
  }

  startSpan(name: string, options: Partial<SpanOptions> = {}): Span {
    const parentSpan = this.context.getStore();
    
    // Use parent from options or from context
    const parentId = options.parentId || parentSpan?.id;
    const traceId = options.traceId || parentSpan?.traceId;

    const span = new Span({
      name,
      ...options,
      parentId,
      traceId,
    });

    return span;
  }

  // Wrapper to automatically handle context
  start<T>(name: string, cb: (span: Span) => T, options: Partial<SpanOptions> = {}): T {
      const span = this.startSpan(name, options);
      
      // Run the callback within the context of the new span
      return this.context.run(span, () => {
          try {
              const result = cb(span);
              if (result instanceof Promise) {
                  return result
                    .then((val) => {
                        span.finish();
                        this.record(span);
                        return val;
                    })
                    .catch((err) => {
                        span.setTag("error", true);
                        span.log({ event: "error", error: err });
                        span.finish();
                        this.record(span);
                        throw err;
                    }) as any;
              }
              
              span.finish();
              this.record(span);
              return result;
          } catch (err) {
              span.setTag("error", true);
              span.log({ event: "error", error: err });
              span.finish();
              this.record(span);
              throw err;
          }
      });
  }

  record(span: Span) {
      this.watch.track("trace.span", span.toJSON());
  }
  
  currentSpan(): Span | undefined {
      return this.context.getStore();
  }
}
