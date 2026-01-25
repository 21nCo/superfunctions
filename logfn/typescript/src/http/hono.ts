/**
 * Hono middleware for request logging
 */

import type { Context, MiddlewareHandler } from "hono";
import type { RequestLoggerOptions } from "./middleware.js";
import {
  extractCorrelationIds,
  redactHeaders,
  truncateBody,
} from "./middleware.js";

/**
 * Create Hono request logger middleware
 */
export function requestLogger(
  options: RequestLoggerOptions = {}
): MiddlewareHandler {
  const {
    header = "traceparent",
    redactHeaders: redactList = [],
    logger,
    includeBody = false,
    captureUser,
  } = options;

  return async (c: Context, next) => {
    const startTime = Date.now();
    const req = c.req;

    // Extract correlation IDs
    const headersObj: Record<string, string> = {};
    req.raw.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    const ids = extractCorrelationIds(headersObj, header);

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

    // Attach logger to context
    c.set("log", requestLogger);

    // Capture user/tenant if provided
    let userId: string | undefined;
    let tenantId: string | undefined;
    if (captureUser) {
      const userInfo = captureUser(c);
      userId = userInfo?.userId;
      tenantId = userInfo?.tenantId;
    }

    // Log request start
    if (requestLogger) {
      requestLogger.info("Request started", {
        method: req.method,
        url: req.url,
        path: req.path,
        headers: redactHeaders(headersObj, redactList),
        query: req.query(),
        userId,
        tenantId,
        body: includeBody
          ? truncateBody(await req.raw.clone().text())
          : undefined,
      });
    }

    // Process request
    await next();

    // Log response
    const latencyMs = Date.now() - startTime;
    if (requestLogger) {
      requestLogger.info("Request completed", {
        method: req.method,
        url: req.url,
        path: req.path,
        statusCode: c.res.status,
        contentLength: c.res.headers.get("content-length"),
        latencyMs,
        userId,
        tenantId,
      });
    }
  };
}

// Re-export types
export type { RequestLoggerOptions } from "./middleware.js";
