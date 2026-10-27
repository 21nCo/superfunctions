/**
 * Runtime-neutral exports shared by every entry point
 */

// Core
export { Logger } from "./core/logger.js";
export { createLogger, devLogger, serverLogger } from "./core/factory.js";

// Types
export type {
  LogEvent,
  LogLevel,
  LoggerOptions,
  ChildLoggerOptions,
  Sink,
  PipelineStage,
  SerializationResult,
  ErrorHandler,
} from "./types.js";

export {
  LOG_LEVEL_VALUES,
  MAX_EVENT_SIZE,
  MAX_TAGS,
  DEFAULT_VERSION,
} from "./types.js";

// Validation
export {
  isSerializable,
  sanitizeValue,
  sanitizeEvent,
  validateAndSerialize,
  isValidLogEvent,
  MAX_METADATA_CHARS,
} from "./validation.js";

// Pipeline stages
export {
  redactSecFn,
  redactEvent,
  isSensitiveKey,
  REDACTED,
  CIRCULAR,
  MAX_DEPTH,
  MAX_REDACTION_DEPTH,
  DEFAULT_PATTERNS,
} from "./pipeline/redact.js";
export type { RedactionOptions } from "./pipeline/redact.js";

export { enrichContext } from "./pipeline/enrich.js";

export {
  withRequestIds,
  parseW3CTraceContext,
} from "./pipeline/request-ids.js";
export type { RequestIdOptions } from "./pipeline/request-ids.js";

export { sample, DEFAULT_SAMPLING_RATES } from "./pipeline/sample.js";
export type { SamplingRates, SamplingOptions } from "./pipeline/sample.js";

// Sinks
export { sinkConsole } from "./sinks/console.js";
export type { ConsoleSinkOptions } from "./sinks/console.js";

export { sinkHttp } from "./sinks/http.js";
export type {
  HttpSink,
  HttpSinkDropReason,
  HttpSinkFetch,
  HttpSinkOptions,
  HttpSinkRequest,
  HttpSinkStats,
} from "./sinks/http.js";
