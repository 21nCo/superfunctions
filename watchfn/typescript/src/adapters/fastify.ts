import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { createPlugin as createHttpPlugin } from "@superfunctions/http-fastify";
import type { WatchFn } from "../core/watch-fn";
import { createRoutes } from "../http/router";

export interface FastifyWatchFnOptions {
  prefix?: string;
}

/**
 * Create Fastify plugin for WatchFn
 */
export function createFastifyPlugin(
  watchFn: WatchFn,
  options: FastifyWatchFnOptions = {}
): FastifyPluginCallback {
  const routes = createRoutes(watchFn);
  return createHttpPlugin(routes, options);
}

/**
 * Create Fastify hook for automatic request tracking
 */
export function createFastifyHooks(watchFn: WatchFn) {
  return {
    onRequest: async (request: FastifyRequest, reply: FastifyReply) => {
      (request as any).watchFnStartTime = Date.now();
      (request as any).watchFnRequestId =
        `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    },

    onResponse: async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = (request as any).watchFnStartTime;
      const requestId = (request as any).watchFnRequestId;

      if (startTime) {
        const duration = Date.now() - startTime;

        watchFn.track("http.request", {
          method: request.method,
          path: request.url,
          statusCode: reply.statusCode,
          duration,
          requestId,
          userAgent: request.headers["user-agent"],
          ip: request.ip,
        });
      }
    },

    onError: async (
      request: FastifyRequest,
      reply: FastifyReply,
      error: Error
    ) => {
      watchFn.captureException(error, {
        method: request.method,
        path: request.url,
        requestId: (request as any).watchFnRequestId,
      });
    },
  };
}

/**
 * Register WatchFn with Fastify
 */
export async function registerWatchFn(
  fastify: FastifyInstance,
  watchFn: WatchFn,
  options: FastifyWatchFnOptions = {}
): Promise<void> {
  // Register plugin
  await fastify.register(createFastifyPlugin(watchFn, options));

  // Add hooks for tracking
  const hooks = createFastifyHooks(watchFn);
  fastify.addHook("onRequest", hooks.onRequest);
  fastify.addHook("onResponse", hooks.onResponse);
  fastify.addHook("onError", hooks.onError);
}
