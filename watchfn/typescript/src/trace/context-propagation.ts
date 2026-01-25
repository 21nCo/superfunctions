"""W3C Trace Context propagation for distributed tracing."""

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
  traceState?: string;
}

export class TraceContextPropagator {
  /**
   * Extract trace context from headers (W3C Trace Context format)
   */
  extract(headers: Record<string, string | string[] | undefined>): TraceContext | null {
    const traceparent = this.getHeader(headers, "traceparent");
    if (!traceparent) {
      return null;
    }

    const parts = traceparent.split("-");
    if (parts.length !== 4) {
      return null;
    }

    const [version, traceId, spanId, traceFlags] = parts;

    const context: TraceContext = {
      traceId,
      spanId,
      traceFlags: parseInt(traceFlags, 16),
    };

    const tracestate = this.getHeader(headers, "tracestate");
    if (tracestate) {
      context.traceState = tracestate;
    }

    return context;
  }

  /**
   * Inject trace context into headers
   */
  inject(context: TraceContext, headers: Record<string, string> = {}): Record<string, string> {
    const traceparent = `00-${context.traceId}-${context.spanId}-${this.formatFlags(context.traceFlags)}`;
    headers["traceparent"] = traceparent;

    if (context.traceState) {
      headers["tracestate"] = context.traceState;
    }

    return headers;
  }

  /**
   * Create a new trace context
   */
  create(parentSpanId?: string): TraceContext {
    return {
      traceId: this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId,
      traceFlags: 1, // Sampled
    };
  }

  /**
   * Create a child span context
   */
  createChild(parent: TraceContext): TraceContext {
    return {
      traceId: parent.traceId,
      spanId: this.generateSpanId(),
      parentSpanId: parent.spanId,
      traceFlags: parent.traceFlags,
      traceState: parent.traceState,
    };
  }

  private getHeader(headers: Record<string, string | string[] | undefined>, name: string): string | null {
    const value = headers[name] || headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] || null;
    }
    return value || null;
  }

  private formatFlags(flags: number): string {
    return flags.toString(16).padStart(2, "0");
  }

  private generateTraceId(): string {
    // Generate 32 hex characters
    let id = "";
    for (let i = 0; i < 32; i++) {
      id += Math.floor(Math.random() * 16).toString(16);
    }
    return id;
  }

  private generateSpanId(): string {
    // Generate 16 hex characters
    let id = "";
    for (let i = 0; i < 16; i++) {
      id += Math.floor(Math.random() * 16).toString(16);
    }
    return id;
  }
}

// Export a singleton instance
export const traceContextPropagator = new TraceContextPropagator();
