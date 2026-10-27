/**
 * Browser entry point: the runtime-neutral API plus browser error capture
 * and flush hooks. Contains no server helpers.
 */

export * from "./core-exports.js";

export {
  captureBrowserErrors,
  attachFlushHooks,
} from "./browser/error-capture.js";
