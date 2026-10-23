/**
 * Hono middleware for request logging
 */

import type { Context, MiddlewareHandler } from "hono";
import type { RequestLoggerOptions } from "./middleware.js";
import {
  withCorrelationHeaders,
  extractCorrelationIds,
  getDefaultRequestLogger,
  createRequestSampler,
  redactHeaders,
  captureRequestBody,
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
    logger = getDefaultRequestLogger(),
    includeBody = false,
    captureUser,
  } = options;
  const shouldSample = createRequestSampler(options.sample);
  const bodyTimeout = options.bodyCaptureTimeoutMs ?? 100;
  if (!Number.isFinite(bodyTimeout) || bodyTimeout <= 0) {
    throw new RangeError("Body capture timeout must be a positive finite number");
  }

  return async (c: Context, next) => {
    const startTime = Date.now();
    const sampled = shouldSample();
    const req = c.req;

    // Extract correlation IDs
    const headersObj: Record<string, string> = {};
    req.raw.headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    const ids = extractCorrelationIds(headersObj, header);

    // Create child logger with correlation IDs
    let requestLogger = logger
      ? logger.child({
          correlation: ids,
          ctx: {
            traceId: ids.traceId,
            spanId: ids.spanId,
            requestId: ids.requestId,
          },
        })
      : undefined;

    // Capture user/tenant if provided
    let userId: string | undefined;
    let tenantId: string | undefined;
    if (captureUser) {
      const userInfo = captureUser(c);
      userId = userInfo?.userId;
      tenantId = userInfo?.tenantId;
    }

    if (requestLogger && (userId !== undefined || tenantId !== undefined)) {
      requestLogger = requestLogger.child({ correlation: {
        ...(userId !== undefined ? { userId } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      } });
    }
    c.set("log", requestLogger);

    // Log request start
    if (requestLogger && sampled) {
      requestLogger.info("Request started", {
        method: req.method,
        url: req.url,
        path: req.path,
        headers: redactHeaders(headersObj, redactList),
        query: req.query(),
        userId,
        tenantId,
        body: includeBody
          ? await captureRequestBody(req.raw, bodyTimeout)
          : undefined,
      });
    }

    // Process request
    await next();
    c.res = withCorrelationHeaders(c.res, ids);

    // Log response
    const latencyMs = Date.now() - startTime;
    if (requestLogger && sampled) {
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
