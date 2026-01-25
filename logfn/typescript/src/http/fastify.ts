/**
 * Fastify plugin for request logging
 */

import type {
  FastifyRequest,
  FastifyReply,
  FastifyPluginCallback,
} from "fastify";
import type { RequestLoggerOptions } from "./middleware.js";
import {
  extractCorrelationIds,
  redactHeaders,
  truncateBody,
} from "./middleware.js";

/**
 * Create Fastify request logger plugin
 */
export function requestLogger(
  options: RequestLoggerOptions = {}
): FastifyPluginCallback {
  const {
    header = "traceparent",
    redactHeaders: redactList = [],
    logger,
    includeBody = false,
    captureUser,
  } = options;

  return (fastify, _opts, done) => {
    fastify.addHook("onRequest", async (request: FastifyRequest) => {
      const startTime = Date.now();

      // Extract correlation IDs
      const ids = extractCorrelationIds(request.headers, header);

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
      (request as any).log = requestLogger;

      // Store start time for latency calculation
      (request as any)._startTime = startTime;

      // Capture user/tenant if provided
      let userId: string | undefined;
      let tenantId: string | undefined;
      if (captureUser) {
        const userInfo = captureUser(request);
        userId = userInfo?.userId;
        tenantId = userInfo?.tenantId;
      }

      // Store user info
      (request as any)._userId = userId;
      (request as any)._tenantId = tenantId;

      // Log request start
      if (requestLogger) {
        requestLogger.info("Request started", {
          method: request.method,
          url: request.url,
          headers: redactHeaders(request.headers, redactList),
          query: request.query,
          userId,
          tenantId,
          body: includeBody ? truncateBody(request.body) : undefined,
        });
      }
    });

    fastify.addHook(
      "onResponse",
      async (request: FastifyRequest, reply: FastifyReply) => {
        const startTime = (request as any)._startTime || Date.now();
        const latencyMs = Date.now() - startTime;
        const requestLogger = (request as any).log;
        const userId = (request as any)._userId;
        const tenantId = (request as any)._tenantId;

        // Log response
        if (requestLogger) {
          requestLogger.info("Request completed", {
            method: request.method,
            url: request.url,
            statusCode: reply.statusCode,
            contentLength: reply.getHeader("content-length"),
            latencyMs,
            userId,
            tenantId,
          });
        }
      }
    );

    done();
  };
}

// Re-export types
export type { RequestLoggerOptions } from "./middleware.js";
