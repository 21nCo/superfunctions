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

    // Response completion is the delivery boundary. Writing JSON may occur
    // before completion, and a disconnected socket may never emit finish.
    let completed = false;
    const complete = (aborted: boolean) => {
      if (completed) return;
      completed = true;
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      watchFn.track("http.request", {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: Date.now() - startTime,
        requestId,
        userAgent: req.get("user-agent"),
        ip: req.ip,
        aborted,
      });
    };
    const onFinish = () => complete(false);
    const onClose = () => complete(!res.writableFinished);
    res.once("finish", onFinish);
    res.once("close", onClose);

    next();
  };
}
