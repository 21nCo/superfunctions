/**
 * Fastify plugin for request logging
 */

import type {
  FastifyRequest,
  FastifyReply,
  FastifyPluginCallback,
} from "fastify";
import type { RequestLoggerOptions } from "./middleware.js";
import type { Logger } from "../core/logger.js";

declare module "fastify" {
  interface FastifyRequest {
    /** LogFn request logger; Fastify's native request.log remains unchanged. */
    logfn?: Logger;
  }
}
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

  const plugin: FastifyPluginCallback = (fastify, _opts, done) => {
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
      request.logfn = requestLogger;

      // Store start time for latency calculation
      (request as any)._startTime = startTime;
    });

    // Body parsing has completed by preHandler.
    fastify.addHook("preHandler", async (request: FastifyRequest) => {
      const requestLogger = request.logfn;
      if (captureUser) {
        const userInfo = captureUser(request);
        (request as any)._userId = userInfo?.userId;
        (request as any)._tenantId = userInfo?.tenantId;
      }
      const userId = (request as any)._userId;
      const tenantId = (request as any)._tenantId;
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
        const requestLogger = request.logfn;
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
  // Register the hooks in the caller scope, like a conventional Fastify plugin.
  Object.defineProperty(plugin, Symbol.for("skip-override"), { value: true });
  return plugin;
}

// Re-export types
export type { RequestLoggerOptions } from "./middleware.js";
