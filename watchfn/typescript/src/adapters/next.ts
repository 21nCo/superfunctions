import { toNextHandlers } from "@superfunctions/http-next";
import type { WatchFn } from "../core/watch-fn";
import { createWatchFnRouter } from "../http/router";

/** The request surface used by tracking; actual NextRequest objects satisfy it. */
export type WatchFnNextRequest = Request & { nextUrl: { pathname: string } };

export interface NextWatchFnOptions {
  trackRequests?: boolean;
}

/**
 * Create Next.js App Router handlers for WatchFn
 */
export function createNextHandler(
  watchFn: WatchFn,
  options: NextWatchFnOptions = {}
) {
  const { GET, POST, PUT, DELETE, PATCH } = toNextHandlers(createWatchFnRouter(watchFn));

  // Wrap handlers with request tracking
  if (options.trackRequests) {
    return {
      GET: wrapHandler(watchFn, GET, "GET"),
      POST: wrapHandler(watchFn, POST, "POST"),
      PUT: wrapHandler(watchFn, PUT, "PUT"),
      DELETE: wrapHandler(watchFn, DELETE, "DELETE"),
      PATCH: wrapHandler(watchFn, PATCH, "PATCH"),
    };
  }

  return { GET, POST, PUT, DELETE, PATCH };
}

/**
 * Wrap handler with tracking
 */
function wrapHandler(watchFn: WatchFn, handler: any, method: string) {
  return async (request: WatchFnNextRequest, context: any) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    try {
      const response = await handler(request, context);
      const duration = Date.now() - startTime;

      watchFn.track("http.request", {
        method,
        path: request.nextUrl.pathname,
        statusCode: response.status,
        duration,
        requestId,
        userAgent: request.headers.get("user-agent") || undefined,
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      watchFn.captureException(error as Error, {
        method,
        path: request.nextUrl.pathname,
        duration,
        requestId,
      });

      throw error;
    }
  };
}

/**
 * Next.js middleware for automatic tracking
 */
export function createNextMiddleware(watchFn: WatchFn) {
  return async (request: WatchFnNextRequest) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Continue to next middleware/handler
    const response = await fetch(request);
    const duration = Date.now() - startTime;

    watchFn.track("http.request", {
      method: request.method,
      path: request.nextUrl.pathname,
      statusCode: response.status,
      duration,
      requestId,
      userAgent: request.headers.get("user-agent") || undefined,
    });

    return response;
  };
}
