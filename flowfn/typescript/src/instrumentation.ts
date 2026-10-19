import { context, propagation, ROOT_CONTEXT, trace, SpanStatusCode, type Attributes, type Tracer } from '@opentelemetry/api';

/** W3C trace fields only; application baggage is never persisted. */
export interface FlowTraceContext { traceparent?: string; tracestate?: string }
function traceFields(value: FlowTraceContext): FlowTraceContext {
  const carrier: FlowTraceContext = {};
  for (const key of ['traceparent', 'tracestate'] as const) {
    if (typeof value[key] === 'string' && value[key]!.length <= 512) carrier[key] = value[key];
  }
  return carrier;
}

export interface FlowTelemetryOptions {
  enabled: boolean;
  provider?: 'opentelemetry' | 'custom';
  /** Required for the custom provider; otherwise the application's global tracer is used. */
  tracer?: Tracer;
}
export interface FlowErrorContext { operation: string; attributes: Attributes }
interface Registration { tracer?: Tracer }
const key = Symbol.for('@flowfn/core/instrumentation/v1');
function registrations(): Set<Registration> {
  const shared = globalThis as typeof globalThis & { [key]?: Set<Registration> };
  return shared[key] ??= new Set();
}

/** Enables tracing for runtimes without an explicit telemetry setting. Configure the OTel SDK separately. */
export class FlowInstrumentation {
  private options: Registration;
  constructor(options: { tracer?: Tracer } = {}) { this.options = { ...options }; }
  enable(): void { registrations().add(this.options); }
  disable(): void { registrations().delete(this.options); }
  isEnabled(): boolean { return registrations().has(this.options); }
}

/** Operation boundaries shared by adapters and callbacks; observers cannot change their outcome. */
export class OperationObserver {
  constructor(private telemetry?: FlowTelemetryOptions, private onError?: (error: Error, context: FlowErrorContext) => void) {
    if (telemetry?.enabled && telemetry.provider === 'custom' && !telemetry.tracer) throw new Error('Custom telemetry requires a tracer');
  }
  capture(): FlowTraceContext | undefined {
    if (!(this.telemetry ? this.telemetry.enabled : registrations().size > 0)) return;
    try {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      const fields = traceFields(carrier);
      return fields.traceparent ? fields : undefined;
    } catch { return undefined; }
  }
  async run<T>(operation: string, attributes: Attributes, callback: () => T | Promise<T>, carrier?: FlowTraceContext): Promise<T> {
    const active = [...registrations()];
    const enabled = this.telemetry ? this.telemetry.enabled : active.length > 0;
    const execute = async () => {
      try { return await callback(); }
      catch (failure) {
        const error = failure instanceof Error ? failure : new Error(String(failure));
        try { void Promise.resolve(this.onError?.(error, { operation, attributes: { ...attributes } })).catch(() => undefined); } catch { /* Observers cannot alter the failure. */ }
        throw failure;
      }
    };
    if (!enabled) return execute();
    const tracer = this.telemetry?.tracer ?? active.at(-1)?.tracer ?? trace.getTracer('@flowfn/core');
    let invocation: Promise<T> | undefined;
    try {
      // Consumer boundaries must not inherit the worker's unrelated ambient context.
      let parent = context.active();
      if (carrier !== undefined) {
        parent = ROOT_CONTEXT;
        try { parent = propagation.extract(ROOT_CONTEXT, traceFields(carrier)); } catch { /* Invalid/custom propagation cannot block work. */ }
      }
      const result = context.with(parent, () => tracer.startActiveSpan(operation, { attributes }, span => {
        if (invocation) { try { span.end(); } catch {} return invocation; }
        return invocation = (async () => {
          try { return await execute(); }
          catch (failure) {
            try { span.recordException(failure instanceof Error ? failure : new Error(String(failure))); span.setStatus({ code: SpanStatusCode.ERROR }); } catch { /* Exporter failures must not alter application results. */ }
            throw failure;
          } finally { try { span.end(); } catch { /* Exporter failures are isolated. */ } }
        })();
      }));
      // Consume a faulty tracer's separate rejected result without replacing the operation result.
      void Promise.resolve(result).catch(() => undefined);
    } catch { /* A custom tracer can fail before or after invoking the operation. */ }
    return invocation ??= execute();
  }
}
