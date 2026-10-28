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
import { isErrorValue, isRecord, toError } from "../pipeline/redact.js";

// The error handlers whose work is running: those on the stack, plus, while
// an async sink failure is reported, those that were running when that sink
// was called. Replaced, never mutated, so a snapshot keeps its provenance.
let activeHandlers: ReadonlySet<ErrorHandler> = new Set();

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

// A call, base or child context that is not a record is kept under a key, never spread.
function normalizeContext(ctx: unknown): Record<string, unknown> | undefined {
  if (ctx === undefined || ctx === null) return undefined;
  if (isErrorValue(ctx)) return { error: ctx };
  return isRecord(ctx) ? ctx : { value: ctx };
}

// Tags that are not an array are ignored, never split into characters.
const normalizeTags = (tags: unknown): string[] => (Array.isArray(tags) ? [...(tags as string[])] : []);

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
      baseContext: normalizeContext(options.baseContext),
      baseTags: normalizeTags(options.baseTags),
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

  private report(
    error: unknown,
    context: { stage?: string; sink?: string },
    provenance: ReadonlySet<ErrorHandler> = activeHandlers
  ): void {
    // An onError that logs through a failing sink fails again, at once or
    // when the async sink call rejects. That nested failure goes to the
    // default console reporter, never back into the handler that caused it,
    // so one error cannot start a recursion.
    const handler = provenance.has(this.options.onError)
      ? defaultErrorHandler
      : this.options.onError;
    const previous = activeHandlers;
    activeHandlers = new Set(provenance).add(handler);
    try {
      handler(toError(error), context);
    } catch {
      // A failing error handler must not reach the caller either.
    } finally {
      activeHandlers = previous;
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

    // Send to sinks; each sink gets its own batch array. A later rejection is
    // reported with the handlers running now, so an onError that logged this
    // event is not called for that rejection.
    const provenance = activeHandlers;
    for (const sink of this.options.sinks) {
      try {
        const result = sink([finalEvent]);
        if (result && typeof (result as Promise<void>).then === "function") {
          // Not awaited here; flush() waits for it.
          const settled = Promise.resolve(result).then(
            () => undefined,
            (error: unknown) => {
              this.report(error, { sink: callableName(sink) }, provenance);
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
      baseContext: overrides.ctx == null ? this.options.baseContext : { ...this.options.baseContext, ...normalizeContext(overrides.ctx) },
      baseTags: [...(this.options.baseTags ?? []), ...normalizeTags(overrides.tags)],
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
    // Taken before the first await, while a calling onError is still on the
    // stack: a flush that onError started reports its failures to the
    // default reporter, not back into that handler.
    const provenance = activeHandlers;
    await this.drain();
    const pending = this.options.sinks.map(async (sink) => {
      try {
        // Read once inside the try: a throwing flush getter is this sink's
        // failure, reported like any other, and siblings still flush.
        const flush: unknown = sink.flush;
        if (typeof flush !== "function") return;
        await (flush as () => unknown).call(sink);
      } catch (error) {
        this.report(error, { sink: callableName(sink) }, provenance);
      }
    });
    await Promise.all(pending);
    await this.drain();
  }

  // Also waits for calls an onError starts meanwhile, for at most 16 rounds, so an onError that keeps logging cannot hold flush().
  private async drain(): Promise<void> {
    for (let round = 0; this.pending.size > 0 && round < 16; round++) await Promise.all([...this.pending]);
  }
}
