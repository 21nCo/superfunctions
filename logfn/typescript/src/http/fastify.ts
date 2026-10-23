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
  correlationResponseHeaders,
  extractCorrelationIds,
  getDefaultRequestLogger,
  createRequestSampler,
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
    logger = getDefaultRequestLogger(),
    includeBody = false,
    captureUser,
  } = options;
  const shouldSample = createRequestSampler(options.sample);

  const sampled = new WeakMap<FastifyRequest, boolean>();
  const plugin: FastifyPluginCallback = (fastify, _opts, done) => {
    fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = Date.now();
      sampled.set(request, shouldSample());

      // Extract correlation IDs
      const ids = extractCorrelationIds(request.headers, header);
      for (const [name, value] of Object.entries(correlationResponseHeaders(ids))) reply.header(name, value);

      // Create child logger with correlation IDs
      const requestLogger = logger
        ? logger.child({
            correlation: ids,
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
      let requestLogger = request.logfn;
      if (captureUser) {
        const userInfo = captureUser(request);
        (request as any)._userId = userInfo?.userId;
        (request as any)._tenantId = userInfo?.tenantId;
      }
      const userId = (request as any)._userId;
      const tenantId = (request as any)._tenantId;
      if (requestLogger && (userId !== undefined || tenantId !== undefined)) {
        requestLogger = requestLogger.child({ correlation: {
          ...(userId !== undefined ? { userId } : {}),
          ...(tenantId !== undefined ? { tenantId } : {}),
        } });
        request.logfn = requestLogger;
      }
      if (requestLogger && sampled.get(request)) {
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
        if (requestLogger && sampled.get(request)) {
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
