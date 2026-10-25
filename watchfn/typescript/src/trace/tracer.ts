import { AsyncLocalStorage } from "async_hooks";
import type { WatchFn } from "../core/watch-fn";
import { Span, SpanOptions } from "./span";

export class Tracer {
  private watch: WatchFn;
  private context: AsyncLocalStorage<Span>;

  constructor(watch: WatchFn, private readonly service?: string) {
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
    }, finished => this.record(finished));

    return span;
  }

  /** Manual transactions keep explicit parentage without leaking ambient context. */
  startTransaction(name: string): Span & { startSpan(name: string, options?: Partial<SpanOptions>): Span } {
    const transaction = this.startSpan(name);
    return Object.assign(transaction, {
      startSpan: (childName: string, options: Partial<SpanOptions> = {}) => {
        if (transaction.endTime !== undefined) throw new Error("Transaction is finished");
        return this.startSpan(childName, { ...options, parentId: transaction.id, traceId: transaction.traceId });
      },
    });
  }

  // Callback spans record once on finish, including manual early completion.
  start<T>(name: string, cb: (span: Span) => T, options: Partial<SpanOptions> = {}): T {
    const span = this.startSpan(name, options);
    const fail = (error: unknown): never => {
      span.setTag("error", true);
      span.log({ event: "error", error });
      span.finish();
      throw error;
    };
    return this.context.run(span, () => {
      try {
        const result = cb(span);
        if (result != null && typeof (result as any).then === "function") {
          return Promise.resolve(result).then(value => { span.finish(); return value; }, fail) as T;
        }
        span.finish();
        return result;
      } catch (error) { return fail(error); }
    });
  }

  record(span: Span) {
      this.watch.track("trace.span", { ...span.toJSON(), ...(this.service ? { service: this.service } : {}) });
  }
  
  currentSpan(): Span | undefined {
      return this.context.getStore();
  }
}
