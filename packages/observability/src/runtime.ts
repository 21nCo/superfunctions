/**
 * Reports whether the global scope belongs to a browser page or web worker,
 * where Node-only built-ins such as `node:async_hooks` cannot be imported.
 */
export function isBrowserScope(scope: object = globalThis): boolean {
  const candidate = scope as { document?: unknown; importScripts?: unknown };
  return typeof candidate.document !== "undefined" || typeof candidate.importScripts === "function";
}
