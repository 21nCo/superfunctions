/**
 * Main entry point for logfn
 */

// Core
export { Logger } from "./core/logger.js";
export { createLogger, devLogger, serverLogger } from "./core/factory.js";

// Types
export type {
  LogEvent,
  LogLevel,
  LogCorrelation,
  LoggerOptions,
  DefaultRedactionOptions,
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
  validateAndSerialize,
  isValidLogEvent,
} from "./validation.js";

// Pipeline stages
export { defaultRedactor } from "./pipeline/default-redaction.js";
export { redactSecFn } from "./pipeline/redact.js";
export type { RedactionOptions } from "./pipeline/redact.js";

export { enrichContext } from "./pipeline/enrich.js";

export {
  withRequestIds,
  parseW3CTraceContext,
} from "./pipeline/request-ids.js";
export type { RequestIdOptions } from "./pipeline/request-ids.js";

export { sample } from "./pipeline/sample.js";
export type { SamplingRates } from "./pipeline/sample.js";

// Sinks
export { sinkConsole } from "./sinks/console.js";
export type { ConsoleSinkOptions } from "./sinks/console.js";

export { sinkHttp } from "./sinks/http.js";
export type { HttpSinkOptions, HttpSink } from "./sinks/http.js";

// Browser utilities
export {
  captureBrowserErrors,
  attachFlushHooks,
} from "./browser/error-capture.js";

// Server utilities
export { registerProcessHandlers } from "./server/process-handlers.js";
