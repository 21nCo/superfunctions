import { createRouter, type Middleware, type Router } from "@superfunctions/http";
import type { EventQuery, Watch, WatchErrorInfo } from "./types.js";

export interface WatchRouterOptions {
  /**
   * Decides whether a request may use the routes. Required, so the endpoints
   * are never exposed by accident; pass `() => true` only for a trusted local
   * listener. A throwing or rejecting check denies the request.
   */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Mount path. Defaults to `/`. */
  basePath?: string;
  /** Largest accepted request body. Defaults to 1 MiB. */
  maxBodyBytes?: number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function failure(error: WatchErrorInfo): Response {
  if (error.code === "storage_failed") {
    // Storage details stay in the server; clients get a retryable status.
    return json({ error: { code: error.code, message: "storage failed; retry later" } }, 503);
  }
  if (error.code === "ingest_failed") {
    // Hook failures are server faults; their details stay in the server too.
    return json({ error: { code: error.code, message: "ingestion failed" } }, 500);
  }
  const status = error.code === "invalid_event" || error.code === "invalid_query" ? 400 : 503;
  return json({ error }, status);
}

/** Matches `WatchError` by shape, so the ESM and CommonJS builds recognise each other's errors. */
function watchErrorInfo(error: unknown): WatchErrorInfo | undefined {
  if (!(error instanceof Error) || error.name !== "WatchError") return undefined;
  const { code, issues } = error as Error & { code?: unknown; issues?: unknown };
  if (code !== "invalid_query" && code !== "not_started") return undefined;
  return Array.isArray(issues) ? { code, message: error.message, issues: issues as string[] } : { code, message: error.message };
}

async function readJson(request: Request, text: () => Promise<string>): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return { ok: false, response: json({ error: { code: "unsupported_media_type", message: "send application/json" } }, 415) };
  }
  const body = await text();
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false, response: json({ error: { code: "invalid_json", message: "the body is not valid JSON" } }, 400) };
  }
}

/**
 * HTTP routes for a WatchFn runtime on `@superfunctions/http`:
 * `GET /health`, `POST /ingest` (one event or an array batch) and `POST /query`,
 * which returns persisted events. Mount the router with any
 * `@superfunctions/http-*` framework adapter.
 */
export function createWatchRouter(watch: Watch, options: WatchRouterOptions): Router {
  if (!watch || typeof watch.ingest !== "function" || typeof watch.query !== "function") {
    throw new TypeError("createWatchRouter: watch must be a runtime from createWatch");
  }
  if (typeof options?.authorize !== "function") {
    throw new TypeError("createWatchRouter: options.authorize is required");
  }
  const authorize = options.authorize;
  const guard: Middleware = async (request, _context, next) => {
    let allowed = false;
    try {
      allowed = (await authorize(request)) === true;
    } catch {
      allowed = false;
    }
    return allowed ? next() : json({ error: { code: "unauthorized", message: "unauthorized" } }, 401);
  };

  return createRouter({
    basePath: options.basePath ?? "/",
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    middleware: [guard],
    routes: [
      {
        method: "GET",
        path: "/health",
        handler: () => json({ status: watch.state === "started" ? "ok" : "unavailable", state: watch.state }, watch.state === "started" ? 200 : 503),
      },
      {
        method: "POST",
        path: "/ingest",
        handler: async (request, context) => {
          const body = await readJson(request, context.text);
          if (!body.ok) return body.response;
          if (Array.isArray(body.value)) {
            const receipt = await watch.ingestBatch(body.value);
            return receipt.ok ? json({ events: receipt.events, storage: receipt.storage, durable: receipt.durable }, 201) : failure(receipt.error);
          }
          const receipt = await watch.ingest(body.value);
          return receipt.ok ? json({ event: receipt.event, storage: receipt.storage, durable: receipt.durable }, 201) : failure(receipt.error);
        },
      },
      {
        method: "POST",
        path: "/query",
        handler: async (request, context) => {
          const body = await readJson(request, context.text);
          if (!body.ok) return body.response;
          try {
            return json(await watch.query(body.value as EventQuery));
          } catch (error) {
            return failure(watchErrorInfo(error) ?? { code: "storage_failed", message: "storage failed the query" });
          }
        },
      },
    ],
  });
}
