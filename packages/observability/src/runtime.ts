type GlobalScopeLike = {
  process?: { versions?: { node?: unknown } };
  Deno?: unknown;
  Bun?: unknown;
  navigator?: { userAgent?: unknown };
  document?: unknown;
  window?: unknown;
  WorkerGlobalScope?: unknown;
  importScripts?: unknown;
};

/**
 * Reports whether the global scope belongs to a browser page or web worker,
 * where Node-only built-ins such as `node:async_hooks` cannot be imported.
 * Server runtimes are recognised first (Node, including Node with a DOM shim,
 * Deno, Bun and Cloudflare Workers, which may expose an `importScripts` stub),
 * so they keep `AsyncLocalStorage`. Browser pages are detected through
 * `document`/`window`, and classic and module workers through
 * `WorkerGlobalScope` or `importScripts`.
 */
export function isBrowserScope(scope: object = globalThis): boolean {
  const candidate = scope as GlobalScopeLike;
  if (candidate.process?.versions?.node || candidate.Deno !== undefined || candidate.Bun !== undefined) {
    return false;
  }
  if (candidate.navigator?.userAgent === "Cloudflare-Workers") {
    return false;
  }
  return (
    typeof candidate.document !== "undefined" ||
    typeof candidate.window !== "undefined" ||
    typeof candidate.WorkerGlobalScope !== "undefined" ||
    typeof candidate.importScripts === "function"
  );
}
