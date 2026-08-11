import type { Request, RequestHandler, Response } from "express";
import { toExpress } from "@superfunctions/http-express";
import type { WatchFn } from "../core/watch-fn";
import { createWatchFnRouter } from "../http/router";

export interface ExpressWatchFnOptions {
  prefix?: string;
}

/**
 * Create Express router for WatchFn
 */
export function createExpressRouter(
  watchFn: WatchFn,
  options: ExpressWatchFnOptions = {}
): RequestHandler {
  return toExpress(createWatchFnRouter(watchFn));
}

/**
 * Create Express middleware for automatic request tracking
 */
export function createExpressMiddleware(watchFn: WatchFn) {
  return async (req: Request, res: Response, next: Function) => {
    const startTime = Date.now();

    // Track request start
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

    // Override res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      const duration = Date.now() - startTime;

      watchFn.track("http.request", {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        requestId,
        userAgent: req.get("user-agent"),
        ip: req.ip,
      });

      return originalJson(body);
    };

    // Handle response finish
    res.on("finish", () => {
      const duration = Date.now() - startTime;

      watchFn.track("http.request", {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        requestId,
        userAgent: req.get("user-agent"),
        ip: req.ip,
      });
    });

    next();
  };
}
