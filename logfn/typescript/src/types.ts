/**
 * Core type definitions for LogFn
 */

// ============================================================================
// Log Levels
// ============================================================================

/**
 * Log severity levels
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Numeric representation of log levels for comparison
 */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

// ============================================================================
// Log Event Schema
// ============================================================================

/**
 * Structured log event matching v0 spec
 */
export interface LogEvent {
  /** RFC3339 timestamp with milliseconds */
  ts: string;

  /** Log severity level */
  level: LogLevel;

  /** Human-readable message */
  msg: string;

  /** Logger/component name */
  name: string;

  /** Arbitrary context (JSON-serializable after validation) */
  ctx?: Record<string, unknown>;

  /** Tags for categorization (<= 20 entries) */
  tags?: string[];

  /** W3C TraceContext trace ID */
  traceId?: string;

  /** W3C TraceContext span ID */
  spanId?: string;

  /** Request correlation ID */
  requestId?: string;

  /** User identifier (may be redacted) */
  userId?: string;

  /** Tenant identifier (may be redacted) */
  tenantId?: string;

  /** Schema version */
  version: string;
}

// ============================================================================
// Pipeline & Sinks
// ============================================================================

/**
 * Pipeline stage processes and optionally modifies events
 * Returns null to drop the event (sampling)
 */
export type PipelineStage = (event: LogEvent) => LogEvent | null;

/**
 * Sink receives batches of log events and sends them to a destination
 */
export interface Sink {
  /** Process a batch of log events */
  (batch: LogEvent[]): Promise<void> | void;

  /** Optional: flush any buffered events */
  flush?(): Promise<void>;
}

// ============================================================================
// Logger Configuration
// ============================================================================

/**
 * Logger configuration options
 */
export interface LoggerOptions {
  /** Logger/component name (required) */
  name: string;

  /** Minimum log level to emit (default: 'info' in prod, 'debug' in dev) */
  level?: LogLevel;

  /** Pipeline stages to apply in order (default: empty) */
  pipeline?: PipelineStage[];

  /**
   * Sinks to send events to (default: a local console sink). Remote sinks
   * such as sinkHttp are never added implicitly.
   */
  sinks?: Sink[];

  /** Custom timestamp function for testing (default: () => new Date()) */
  now?: () => Date;

  /** Base context to include in all events */
  baseContext?: Record<string, unknown>;

  /** Base tags to include in all events */
  baseTags?: string[];

  /** Receives pipeline and sink failures (default: console.error) */
  onError?: ErrorHandler;
}

/**
 * Options for creating child loggers
 */
export interface ChildLoggerOptions {
  /** Override logger name */
  name?: string;

  /** Override log level */
  level?: LogLevel;

  /** Additional context to merge */
  ctx?: Record<string, unknown>;

  /** Additional tags to merge */
  tags?: string[];
}

// ============================================================================
// Validation Constants
// ============================================================================

/**
 * Maximum event size in UTF-8 bytes after serialization
 */
export const MAX_EVENT_SIZE = 64 * 1024; // 64KB

/**
 * Maximum number of tags per event
 */
export const MAX_TAGS = 20;

/**
 * Default schema version
 */
export const DEFAULT_VERSION = "0";

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Internal error handler for pipeline/sink failures
 */
export type ErrorHandler = (
  error: Error,
  context: { stage?: string; sink?: string }
) => void;

/**
 * Serialization result
 */
export interface SerializationResult {
  event: LogEvent;
  truncated: boolean;
}
