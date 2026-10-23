/**
 * Core Logger implementation
 */

import type {
  LogEvent,
  LogLevel,
  LoggerOptions,
  ChildLoggerOptions,
  ErrorHandler,
} from "../types.js";
import { LOG_LEVEL_VALUES, DEFAULT_VERSION } from "../types.js";
import { validateAndSerialize } from "../validation.js";

/**
 * Logger class for structured logging
 */
export class Logger {
  private readonly options: Required<
    Omit<LoggerOptions, "baseContext" | "baseTags">
  > & {
    baseContext?: Record<string, unknown>;
    baseTags?: string[];
  };
  private readonly errorHandler: ErrorHandler;

  constructor(options: LoggerOptions) {
    // Set defaults
    this.options = {
      name: options.name,
      level: options.level ?? this.defaultLevel(),
      pipeline: options.pipeline ?? [],
      sinks: options.sinks,
      now: options.now ?? (() => new Date()),
      baseContext: options.baseContext,
      baseTags: options.baseTags,
    };

    // Internal error handler - logs to console.error but doesn't throw
    this.errorHandler = (error, context) => {
      console.error("[logfn internal error]", context, error);
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
    const { event: finalEvent, truncated } = validateAndSerialize(event);

    if (truncated) {
      // Note: we could emit a warning here, but that could cause recursion
      // Better to just include _truncated in the context
    }

    // Send to sinks
    const batch = [finalEvent];
    for (const sink of this.options.sinks) {
      try {
        const result = sink(batch);
        if (result instanceof Promise) {
          // Don't await - fire and forget
          result.catch((error) => {
            this.errorHandler(error, { sink: sink.name || "unknown" });
          });
        }
      } catch (error) {
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
      name: overrides.name ?? this.options.name,
      level: overrides.level ?? this.options.level,
      pipeline: this.options.pipeline,
      sinks: this.options.sinks,
      now: this.options.now,
      baseContext: {
        ...this.options.baseContext,
        ...overrides.ctx,
      },
      baseTags: [...(this.options.baseTags ?? []), ...(overrides.tags ?? [])],
    };

    return new Logger(childOptions);
  }

  /**
   * Flush all sinks
   */
  async flush(): Promise<void> {
    const flushPromises: Promise<void>[] = [];

    for (const sink of this.options.sinks) {
      if (sink.flush) {
        try {
          const result = sink.flush();
          if (result instanceof Promise) {
            flushPromises.push(result);
          }
        } catch (error) {
          this.errorHandler(error as Error, { sink: sink.name || "unknown" });
        }
      }
    }

    await Promise.all(flushPromises);
  }
}
