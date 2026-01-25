import type { RequestEvent } from "@sveltejs/kit";
import { createHandler as createHttpHandler } from "@superfunctions/http-sveltekit";
import type { WatchFn } from "../core/watch-fn";
import { createRoutes } from "../http/router";

export interface SvelteKitWatchFnOptions {
  trackRequests?: boolean;
}

/**
 * Create SvelteKit handlers for WatchFn
 */
export function createSvelteKitHandler(
  watchFn: WatchFn,
  options: SvelteKitWatchFnOptions = {}
) {
  const routes = createRoutes(watchFn);
  const { GET, POST, PUT, DELETE, PATCH } = createHttpHandler(routes);

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
  return async (event: RequestEvent) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    try {
      const response = await handler(event);
      const duration = Date.now() - startTime;

      watchFn.track("http.request", {
        method,
        path: event.url.pathname,
        statusCode: response.status,
        duration,
        requestId,
        userAgent: event.request.headers.get("user-agent") || undefined,
        ip: event.getClientAddress(),
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      watchFn.captureException(error as Error, {
        method,
        path: event.url.pathname,
        duration,
        requestId,
        ip: event.getClientAddress(),
      });

      throw error;
    }
  };
}

/**
 * SvelteKit hook for automatic tracking
 */
export function createSvelteKitHook(watchFn: WatchFn) {
  return async ({ event, resolve }: { event: RequestEvent; resolve: any }) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    try {
      const response = await resolve(event);
      const duration = Date.now() - startTime;

      watchFn.track("http.request", {
        method: event.request.method,
        path: event.url.pathname,
        statusCode: response.status,
        duration,
        requestId,
        userAgent: event.request.headers.get("user-agent") || undefined,
        ip: event.getClientAddress(),
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      watchFn.captureException(error as Error, {
        method: event.request.method,
        path: event.url.pathname,
        duration,
        requestId,
        ip: event.getClientAddress(),
      });

      throw error;
    }
  };
}
