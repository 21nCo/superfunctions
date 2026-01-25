/**
 * Express middleware adapter for request logging
 */

import type { Request, Response, NextFunction } from "express";
import type { RequestLoggerOptions } from "./middleware.js";
import {
  extractCorrelationIds,
  redactHeaders,
  truncateBody,
} from "./middleware.js";

/**
 * Create Express request logger middleware
 */
export function requestLogger(options: RequestLoggerOptions = {}) {
  const {
    header = "traceparent",
    redactHeaders: redactList = [],
    logger,
    includeBody = false,
    captureUser,
  } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Extract correlation IDs
    const ids = extractCorrelationIds(req.headers, header);

    // Create child logger with correlation IDs
    const requestLogger = logger
      ? logger.child({
          ctx: {
            traceId: ids.traceId,
            spanId: ids.spanId,
            requestId: ids.requestId,
          },
        })
      : undefined;

    // Attach logger to request
    (req as any).log = requestLogger;

    // Capture user/tenant if provided
    let userId: string | undefined;
    let tenantId: string | undefined;
    if (captureUser) {
      const userInfo = captureUser(req);
      userId = userInfo?.userId;
      tenantId = userInfo?.tenantId;
    }

    // Log request start
    if (requestLogger) {
      requestLogger.info("Request started", {
        method: req.method,
        url: req.url,
        path: req.path,
        headers: redactHeaders(req.headers, redactList),
        query: req.query,
        userId,
        tenantId,
        body: includeBody ? truncateBody(req.body) : undefined,
      });
    }

    // Capture response finish
    const originalEnd = res.end;
    res.end = function (this: Response, ...args: any[]): any {
      const latencyMs = Date.now() - startTime;

      // Log response
      if (requestLogger) {
        requestLogger.info("Request completed", {
          method: req.method,
          url: req.url,
          path: req.path,
          statusCode: res.statusCode,
          contentLength: res.get("content-length"),
          latencyMs,
          userId,
          tenantId,
        });
      }

      return originalEnd.apply(this, args as any);
    };

    next();
  };
}

// Re-export types
export type { RequestLoggerOptions } from "./middleware.js";
