import type { Hono, Context, Next } from "hono";
import { createRouter as createHttpRouter } from "@superfunctions/http-hono";
import type { WatchFn } from "../core/watch-fn";
import { createRoutes } from "../http/router";

export interface HonoWatchFnOptions {
  prefix?: string;
}

/**
 * Create Hono router for WatchFn
 */
export function createHonoRouter(
  watchFn: WatchFn,
  options: HonoWatchFnOptions = {}
): Hono {
  const routes = createRoutes(watchFn);
  return createHttpRouter(routes, options);
}

/**
 * Create Hono middleware for automatic request tracking
 */
export function createHonoMiddleware(watchFn: WatchFn) {
  return async (c: Context, next: Next) => {
    const startTime = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Store in context
    c.set("watchFnStartTime", startTime);
    c.set("watchFnRequestId", requestId);

    try {
      await next();
    } catch (error) {
      // Capture error
      watchFn.captureException(error as Error, {
        method: c.req.method,
        path: c.req.path,
        requestId,
      });
      throw error;
    } finally {
      // Track request
      const duration = Date.now() - startTime;

      watchFn.track("http.request", {
        method: c.req.method,
        path: c.req.path,
        statusCode: c.res.status,
        duration,
        requestId,
        userAgent: c.req.header("user-agent"),
      });
    }
  };
}

/**
 * Apply WatchFn to Hono app
 */
export function applyWatchFn(
  app: Hono,
  watchFn: WatchFn,
  options: HonoWatchFnOptions = {}
): void {
  // Add middleware for tracking
  app.use("*", createHonoMiddleware(watchFn));

  // Mount WatchFn routes
  const router = createHonoRouter(watchFn, options);
  const prefix = options.prefix || "/watch";
  app.route(prefix, router);
}
