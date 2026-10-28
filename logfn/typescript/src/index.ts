/**
 * Main entry point for logfn. Universal: it imports no Node or DOM modules,
 * so it can be bundled for browsers and servers alike. The `./browser` and
 * `./server` entries add only their environment's helpers.
 */

export * from "./core-exports.js";

// Browser utilities
export {
  captureBrowserErrors,
  attachFlushHooks,
} from "./browser/error-capture.js";

// Server utilities
export { registerProcessHandlers } from "./server/process-handlers.js";
