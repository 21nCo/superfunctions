import { randomBytes } from "node:crypto";
import { sampleTrace } from "./sampling";
import { AsyncLocalStorage } from "async_hooks";
import type { WatchFn } from "../core/watch-fn";
import { Span, SpanOptions } from "./span";
import { traceContextPropagator } from "./context-propagation";

export class Tracer {
  private watch: WatchFn;
  private context: AsyncLocalStorage<Span | undefined>;

  constructor(watch: WatchFn, private readonly service?: string, private readonly policy: { enabled?: boolean; sampleRate?: number } = {}) {
    sampleTrace("validation", policy.sampleRate ?? 1);
    if (policy.enabled !== undefined && typeof policy.enabled !== "boolean") throw new TypeError("Invalid tracing enabled flag");
    this.watch = watch;
    this.context = new AsyncLocalStorage<Span | undefined>();
  }

  startSpan(name: string, options: Partial<SpanOptions> = {}): Span {
    const ambient = this.context.getStore();
    const parentSpan = ambient?.endTime === undefined ? ambient : undefined;
    
    // Use parent from options or from context
    const sameTrace = options.traceId === undefined || options.traceId === parentSpan?.traceId;
    const parentId = options.parentId ?? (sameTrace ? parentSpan?.id : undefined);
    const traceId = options.traceId || parentSpan?.traceId || randomBytes(16).toString("hex");
    const inheritedFlags = options.traceFlags ?? (sameTrace ? parentSpan?.traceFlags : undefined);
    if (inheritedFlags !== undefined && (!Number.isInteger(inheritedFlags) || inheritedFlags < 0 || inheritedFlags > 255)) throw new TypeError("Invalid trace flags");
    const traceFlags = this.policy.enabled === false ? 0 : inheritedFlags === undefined ? (sampleTrace(traceId, this.policy.sampleRate ?? 1) ? 1 : 0) : inheritedFlags & 1;

    const span = new Span({
      name,
      ...options,
      parentId,
      traceId,
      traceFlags,
      traceState: options.traceState ?? (sameTrace ? parentSpan?.traceState : undefined),
    }, finished => this.record(finished));

    return span;
  }

  startWithHeaders<T>(name: string, headers: Record<string, string | string[] | undefined>, callback: (span: Span) => T): T {
    const parent = traceContextPropagator.extract(headers);
    return this.context.run(undefined, () => this.start(name, callback, parent ? { traceId: parent.traceId, parentId: parent.spanId, traceFlags: parent.traceFlags, traceState: parent.traceState } : {}));
  }

  injectHeaders(headers: Record<string, string> = {}, span = this.context.getStore()): Record<string, string> {
    if (!span || span.endTime !== undefined) throw new Error('No active trace span');
    return traceContextPropagator.inject({ traceId: span.traceId, spanId: span.id, traceFlags: span.traceFlags, traceState: span.traceState }, headers);
  }

  /** Manual transactions keep explicit parentage without leaking ambient context. */
  startTransaction(name: string): Span & { startSpan(name: string, options?: Partial<SpanOptions>): Span } {
    const transaction = this.startSpan(name);
    return Object.assign(transaction, {
      startSpan: (childName: string, options: Partial<SpanOptions> = {}) => {
        if (transaction.endTime !== undefined) throw new Error("Transaction is finished");
        return this.startSpan(childName, { ...options, parentId: transaction.id, traceId: transaction.traceId, traceFlags: options.traceFlags ?? transaction.traceFlags, traceState: options.traceState ?? transaction.traceState });
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
      if (!(span.traceFlags & 1)) return;
      this.watch.track("trace.span", { ...span.toJSON(), ...(this.service ? { service: this.service } : {}) });
  }
  
  currentSpan(): Span | undefined {
      return this.context.getStore();
  }
}
