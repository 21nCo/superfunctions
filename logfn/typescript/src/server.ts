/**
 * Server entry point: the runtime-neutral API plus process signal handlers.
 */

export * from "./core-exports.js";

export { registerProcessHandlers } from "./server/process-handlers.js";
