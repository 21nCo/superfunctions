/**
 * Core Logger implementation
 */

import type {
  LogEvent,
  LogLevel,
  LoggerOptions,
  ChildLoggerOptions,
  ErrorHandler,
  Sink,
} from "../types.js";
import { LOG_LEVEL_VALUES, DEFAULT_VERSION } from "../types.js";
import { defaultRedactor } from "../pipeline/default-redaction.js";
import { sanitizeValue, validateAndSerialize } from "../validation.js";

/**
 * Logger class for structured logging
 */
export class Logger {
  private readonly options: Required<
    Omit<LoggerOptions, "baseContext" | "baseTags" | "onError">
  > & {
    baseContext?: Record<string, unknown>;
    baseTags?: string[];
    onError?: ErrorHandler;
  };
  private readonly redact: (input: unknown) => unknown;
  private readonly errorHandler: ErrorHandler;
  private delivery: { pending: Set<Promise<void>>; failure?: { reason: unknown } } = {
    pending: new Set(),
  };

  private attachedSinks = new Map<Sink, number>();

  /**
   * Attach a sink to this logger family, including existing and future children.
   * Detach affects future events; flush still joins previously admitted async work.
   * Flush a buffering sink before detaching it to drain its private buffer.
   */
  addSink(sink: Sink): () => void {
    if (typeof sink !== "function" || (sink.flush !== undefined && typeof sink.flush !== "function")) throw new TypeError("Invalid log sink");
    const attached = this.attachedSinks;
    attached.set(sink, (attached.get(sink) ?? 0) + 1);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      const count = attached.get(sink)!;
      if (count === 1) attached.delete(sink); else attached.set(sink, count - 1);
    };
  }

  private sinks(): Sink[] {
    return [...this.options.sinks, ...[...this.attachedSinks.keys()].filter(sink => !this.options.sinks.includes(sink))];
  }

  constructor(options: LoggerOptions) {
    this.redact = defaultRedactor(options.redaction);
    // Set defaults
    this.options = {
      redaction: { allowlist: [...(options.redaction?.allowlist ?? [])] },
      correlation: { ...options.correlation },
      name: options.name,
      level: options.level ?? this.defaultLevel(),
      pipeline: options.pipeline ?? [],
      sinks: options.sinks,
      now: options.now ?? (() => new Date()),
      baseContext: options.baseContext,
      baseTags: options.baseTags,
      onError: options.onError,
    };

    // Internal error handler - logs to console.error but doesn't throw
    let reporting = false;
    this.errorHandler = (error, context) => {
      if (reporting) return;
      reporting = true;
      try {
        if (options.onError) options.onError(error, context);
        else console.error("[logfn internal error]", this.redact({ context, error }));
      } catch {
        // Failure reporting must never interrupt application logging.
      } finally {
        reporting = false;
      }
    };

    if (this.options.sinks.length === 0) {
      throw new Error("At least one sink is required");
    }
  }

  /**
   * Get default log level based on environment
   */
  private defaultLevel(): LogLevel {
    if (
      typeof process !== "undefined" &&
      process.env?.NODE_ENV === "production"
    ) {
      return "info";
    }
    return "debug";
  }

  /**
   * Check if a log level should be emitted
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.options.level];
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    msg: string,
    ctx?: Record<string, unknown>,
    tags?: string[]
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    // Create base event
    let event: LogEvent = {
      ...this.options.correlation,
      ts: this.options.now().toISOString(),
      level,
      msg,
      name: this.options.name,
      version: DEFAULT_VERSION,
    };

    // Merge context and tags
    if (this.options.baseContext || ctx) {
      event.ctx = { ...this.options.baseContext, ...ctx };
    }

    if (this.options.baseTags || tags) {
      event.tags = [...(this.options.baseTags ?? []), ...(tags ?? [])];
    }

    // Apply pipeline stages
    for (const stage of this.options.pipeline) {
      try {
        const result = stage(event);
        if (result === null) {
          // Event dropped by sampling or filtering
          return;
        }
        event = result;
      } catch (error) {
        this.errorHandler(error as Error, { stage: stage.name || "unknown" });
        // Continue with unmodified event
      }
    }

    // Validate and serialize
    let finalEvent: LogEvent;
    try {
      // Terminal policy also covers data introduced by enrichment/custom stages.
      finalEvent = validateAndSerialize(this.redact(event) as LogEvent).event;
    } catch {
      this.errorHandler(new Error("Log event could not be safely redacted"), { stage: "defaultRedaction" });
      return;
    }
    const truncated = finalEvent.ctx?._truncated === true;

    if (truncated) {
      // Note: we could emit a warning here, but that could cause recursion
      // Better to just include _truncated in the context
    }

    // Send to sinks
    for (const sink of this.sinks()) {
      try {
        const result = sink([sanitizeValue(finalEvent) as LogEvent]);
        if (result && typeof result.then === "function") {
          const task = Promise.resolve(result).then(
            () => { this.delivery.pending.delete(task); },
            (error: unknown) => {
              this.delivery.pending.delete(task);
              this.delivery.failure ??= { reason: error };
              this.errorHandler(error as Error, { sink: sink.name || "unknown" });
            }
          );
          this.delivery.pending.add(task);
        }
      } catch (error) {
        this.delivery.failure ??= { reason: error };
        this.errorHandler(error as Error, { sink: sink.name || "unknown" });
      }
    }
  }

  /**
   * Log at trace level
   */
  trace(msg: string, ctx?: Record<string, unknown>, tags?: string[]): void {
    this.log("trace", msg, ctx, tags);
  }

  /**
   * Log at debug level
   */
  debug(msg: string, ctx?: Record<string, unknown>, tags?: string[]): void {
    this.log("debug", msg, ctx, tags);
  }

  /**
   * Log at info level
   */
  info(msg: string, ctx?: Record<string, unknown>, tags?: string[]): void {
    this.log("info", msg, ctx, tags);
  }

  /**
   * Log at warn level
   */
  warn(msg: string, ctx?: Record<string, unknown>, tags?: string[]): void {
    this.log("warn", msg, ctx, tags);
  }

  /**
   * Log at error level
   */
  error(msg: string, ctx?: Record<string, unknown>, tags?: string[]): void {
    this.log("error", msg, ctx, tags);
  }

  /**
   * Log at fatal level
   */
  fatal(msg: string, ctx?: Record<string, unknown>, tags?: string[]): void {
    this.log("fatal", msg, ctx, tags);
  }

  /**
   * Create a child logger with merged configuration
   */
  child(overrides: ChildLoggerOptions): Logger {
    const childOptions: LoggerOptions = {
      correlation: { ...this.options.correlation, ...overrides.correlation },
      name: overrides.name ?? this.options.name,
      level: overrides.level ?? this.options.level,
      redaction: this.options.redaction,
      pipeline: this.options.pipeline,
      sinks: this.options.sinks,
      now: this.options.now,
      onError: this.options.onError,
      baseContext: {
        ...this.options.baseContext,
        ...overrides.ctx,
      },
      baseTags: [...(this.options.baseTags ?? []), ...(overrides.tags ?? [])],
    };

    const child = new Logger(childOptions);
    child.delivery = this.delivery;
    child.attachedSinks = this.attachedSinks;
    return child;
  }

  /**
   * Flush all sinks
   */
  async flush(): Promise<void> {
    const sinks = this.sinks();
    while (this.delivery.pending.size) {
      await Promise.all([...this.delivery.pending]);
    }
    const results = await Promise.allSettled(
      sinks.map(sink => Promise.resolve().then(() => sink.flush?.()).catch(error => {
        this.errorHandler(error as Error, { sink: sink.name || "unknown" });
        throw error;
      }))
    );
    const failure = this.delivery.failure;
    this.delivery.failure = undefined;
    if (failure) throw failure.reason;
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw rejected.reason;
  }
}
