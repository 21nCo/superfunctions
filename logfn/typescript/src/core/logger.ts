/**
 * Core Logger implementation
 */

import type {
  LogEvent,
  LogLevel,
  LoggerOptions,
  ChildLoggerOptions,
  ErrorHandler,
  PipelineStage,
  Sink,
} from "../types.js";
import { LOG_LEVEL_VALUES, DEFAULT_VERSION } from "../types.js";
import { sanitizeEvent } from "../validation.js";
import { sinkConsole } from "../sinks/console.js";

// The error handlers currently running (synchronously).
const runningHandlers = new Set<ErrorHandler>();

const defaultErrorHandler: ErrorHandler = (error, context) => {
  console.error("[logfn internal error]", context, error);
};

// Sinks and stages are caller objects: reading their name may run a getter
// that throws, which must not replace the error being reported.
function callableName(fn: unknown): string {
  try {
    const name = (fn as { name?: unknown }).name;
    return typeof name === "string" && name ? name : "unknown";
  } catch {
    return "unknown";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// A context argument that is not a plain record (an Error passed straight to
// logger.error, a string) is kept under a named key instead of being spread.
function normalizeContext(ctx: unknown): Record<string, unknown> | undefined {
  if (ctx === undefined || ctx === null) return undefined;
  if (ctx instanceof Error) return { error: ctx };
  if (typeof ctx !== "object" || Array.isArray(ctx)) return { value: ctx };
  return ctx as Record<string, unknown>;
}

interface ResolvedOptions {
  name: string;
  level: LogLevel;
  pipeline: PipelineStage[];
  sinks: Sink[];
  now: () => Date;
  baseContext?: Record<string, unknown>;
  baseTags?: string[];
  onError: ErrorHandler;
}

/**
 * Logger class for structured logging. Logging calls and flush() never throw:
 * pipeline and sink failures are reported to onError.
 */
export class Logger {
  private readonly options: ResolvedOptions;
  // Unsettled async sink calls, shared with child loggers so flush() on any
  // of them waits for every call made through the shared sinks.
  private pending = new Set<Promise<void>>();

  constructor(options: LoggerOptions) {
    // An own-key check: `in` would accept inherited names such as "toString".
    if (
      options.level !== undefined &&
      !Object.prototype.hasOwnProperty.call(LOG_LEVEL_VALUES, options.level)
    ) {
      throw new Error(`Unknown log level: ${String(options.level)}`);
    }
    if (options.sinks && options.sinks.length === 0) {
      throw new Error("At least one sink is required");
    }

    this.options = {
      name: options.name,
      level: options.level ?? this.defaultLevel(),
      pipeline: options.pipeline ?? [],
      // The default is local console output only; no remote sink is implied.
      sinks: options.sinks ?? [sinkConsole()],
      now: options.now ?? (() => new Date()),
      baseContext: options.baseContext,
      baseTags: options.baseTags,
      onError: options.onError ?? defaultErrorHandler,
    };
  }

  /**
   * Get default log level based on environment
   */
  private defaultLevel(): LogLevel {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    return env?.NODE_ENV === "production" ? "info" : "debug";
  }

  private report(error: unknown, context: { stage?: string; sink?: string }): void {
    // An onError that logs through a failing sink fails again; that nested
    // failure is not reported to the handler already running, so one error
    // cannot start a recursion.
    const handler = this.options.onError;
    if (runningHandlers.has(handler)) return;
    runningHandlers.add(handler);
    try {
      handler(toError(error), context);
    } catch {
      // A failing error handler must not reach the caller either.
    } finally {
      runningHandlers.delete(handler);
    }
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
  private log(level: LogLevel, msg: string, ctx?: unknown, tags?: string[]): void {
    try {
      this.emit(level, msg, ctx, tags);
    } catch (error) {
      this.report(error, {});
    }
  }

  private emit(level: LogLevel, msg: string, ctx?: unknown, tags?: string[]): void {
    if (!this.shouldLog(level)) {
      return;
    }

    // Create base event
    let event: LogEvent = {
      ts: this.options.now().toISOString(),
      level,
      msg: String(msg),
      name: this.options.name,
      version: DEFAULT_VERSION,
    };

    // Merge context and tags
    const callContext = normalizeContext(ctx);
    if (this.options.baseContext || callContext) {
      event.ctx = { ...this.options.baseContext, ...callContext };
    }

    // Like the Python logger, an event without tags has no tags field.
    const mergedTags = [...(this.options.baseTags ?? []), ...(Array.isArray(tags) ? tags : [])];
    if (mergedTags.length > 0) {
      event.tags = mergedTags;
    }

    // Apply pipeline stages. A failing stage drops the event: a broken
    // redaction stage must not let the unredacted event through.
    for (const stage of this.options.pipeline) {
      let result: LogEvent | null;
      try {
        result = stage(event);
      } catch (error) {
        this.report(error, { stage: callableName(stage) });
        return;
      }
      if (result === null || result === undefined) {
        // Event dropped by sampling or filtering
        return;
      }
      event = result;
    }

    // JSON-safe but not size-bounded: truncating here could cut a secret's
    // delimiter (an @, a closing quote) before a sink's own redaction runs,
    // so each sink bounds the size after it redacts.
    const finalEvent = sanitizeEvent(event);

    // Send to sinks; each sink gets its own batch array.
    for (const sink of this.options.sinks) {
      try {
        const result = sink([finalEvent]);
        if (result && typeof (result as Promise<void>).then === "function") {
          // Not awaited here; flush() waits for it.
          const settled = Promise.resolve(result).then(
            () => undefined,
            (error: unknown) => {
              this.report(error, { sink: callableName(sink) });
            }
          );
          this.pending.add(settled);
          void settled.finally(() => this.pending.delete(settled));
        }
      } catch (error) {
        this.report(error, { sink: callableName(sink) });
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
   * Log at error level. An Error may be passed as ctx; it is logged as ctx.error.
   */
  error(msg: string, ctx?: Record<string, unknown> | Error, tags?: string[]): void {
    this.log("error", msg, ctx, tags);
  }

  /**
   * Log at fatal level. An Error may be passed as ctx; it is logged as ctx.error.
   */
  fatal(msg: string, ctx?: Record<string, unknown> | Error, tags?: string[]): void {
    this.log("fatal", msg, ctx, tags);
  }

  /**
   * Create a child logger with merged configuration
   */
  child(overrides: ChildLoggerOptions): Logger {
    const child = new Logger({
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
      onError: this.options.onError,
    });
    child.pending = this.pending;
    return child;
  }

  /**
   * Wait for pending async sink calls, then flush all sinks. Resolves once
   * every sink has settled; sink failures are reported to onError rather
   * than rejected.
   */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
    const pending = this.options.sinks.map(async (sink) => {
      try {
        // Read once inside the try: a throwing flush getter is this sink's
        // failure, reported like any other, and siblings still flush.
        const flush: unknown = sink.flush;
        if (typeof flush !== "function") return;
        await (flush as () => unknown).call(sink);
      } catch (error) {
        this.report(error, { sink: callableName(sink) });
      }
    });
    await Promise.all(pending);
  }
}
