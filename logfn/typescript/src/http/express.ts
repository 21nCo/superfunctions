/**
 * Express middleware adapter for request logging
 */

import type { Request, Response, NextFunction } from "express";
import type { RequestLoggerOptions } from "./middleware.js";
import {
  extractCorrelationIds,
  getDefaultRequestLogger,
  createRequestSampler,
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
    logger = getDefaultRequestLogger(),
    includeBody = false,
    captureUser,
  } = options;
  const shouldSample = createRequestSampler(options.sample);

  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const sampled = shouldSample();

    // Extract correlation IDs
    const ids = extractCorrelationIds(req.headers, header);

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
      const userInfo = captureUser(req);
      userId = userInfo?.userId;
      tenantId = userInfo?.tenantId;
    }

    if (requestLogger && (userId !== undefined || tenantId !== undefined)) {
      requestLogger = requestLogger.child({ correlation: {
        ...(userId !== undefined ? { userId } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
      } });
    }
    (req as any).log = requestLogger;

    // Log request start
    if (requestLogger && sampled) {
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

    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      res.off("finish", finish);
      res.off("close", finish);
      if (requestLogger && sampled) {
        requestLogger.info(res.writableFinished ? "Request completed" : "Request aborted", {
          method: req.method, url: req.url, path: req.path,
          statusCode: res.statusCode, contentLength: res.get("content-length"),
          latencyMs: Date.now() - startTime, userId, tenantId,
          aborted: !res.writableFinished,
        });
      }
    };
    res.once("finish", finish);
    res.once("close", finish);

    next();
  };
}

// Re-export types
export type { RequestLoggerOptions } from "./middleware.js";
