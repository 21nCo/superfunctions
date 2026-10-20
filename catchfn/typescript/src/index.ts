/**
 * CatchFn - Self-hosted bug reporting and context collection
 * @module catchfn
 */

// Core exports
export { CatchFn } from "./core/catch-fn.js";
export { CatchFnDeliveryError } from "./core/delivery-error.js";
export type {
  CatchFnConfig,
  BugReportEvent,
  CaptureBugOptions,
  BugSeverity,
  Breadcrumb,
  BreadcrumbType,
  ConsoleLogEntry,
  NetworkRequest,
  DeviceInfo,
  AttachmentReference,
  BeforeSendHook,
  IgnorePattern,
  ContextCollector,
  WatchBugReportEvent,
  WatchBugReportClient,
  WatchEndpointConfig,
} from "./core/types.js";

// Collector exports
export { BreadcrumbCollector } from "./collectors/breadcrumbs.js";
export { ConsoleCollector } from "./collectors/console.js";
export { NetworkCollector } from "./collectors/network.js";
export { DeviceCollector } from "./collectors/device.js";

// Utility exports
export {
  redactObject,
  redactString,
  redactUrl,
  redactHeaders,
} from "./utils/redaction.js";
export {
  serializeError,
  safeSerialize,
  estimateSize,
  truncateString,
  trimArray,
} from "./utils/serialization.js";
export { limitPayloadSize } from "./utils/size-limiter.js";

// Factory function
import { CatchFn } from "./core/catch-fn.js";
import type { CatchFnConfig } from "./core/types.js";

/**
 * Create a new CatchFn instance
 */
export function catchFn(config: CatchFnConfig): CatchFn {
  return new CatchFn(config);
}

// Default export
export default catchFn;
