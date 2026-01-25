/**
 * Fastify plugin for HTTP response caching
 */

import type { CacheFn } from "../core/cache.js";

export interface FastifyPluginOptions {
  cache: CacheFn;
}

export interface FastifyRouteOptions {
  ttl?: number;
  key?: string | ((req: any) => string);
  tags?: string[] | ((req: any) => string[]);
  condition?: (req: any) => boolean;
}

/**
 * Fastify plugin for caching
 */
export async function fastify(fastify: any, options: FastifyPluginOptions) {
  const cache = options.cache;

  if (!cache) {
    throw new Error("Cache instance is required for Fastify plugin");
  }

  // Decorate fastify instance with cache
  fastify.decorate("cache", cache);

  // Add hook for caching
  fastify.addHook("onRequest", async (request: any, reply: any) => {
    const routeOptions: FastifyRouteOptions | undefined =
      request.routeOptions?.config?.cachefn;

    if (!routeOptions) {
      return;
    }

    // Check condition
    if (routeOptions.condition && !routeOptions.condition(request)) {
      return;
    }

    // Only cache GET requests by default
    if (request.method !== "GET") {
      return;
    }

    // Generate cache key
    const cacheKey =
      typeof routeOptions.key === "function"
        ? routeOptions.key(request)
        : routeOptions.key || request.url;

    // Try to get from cache
    const cached = await cache.get(cacheKey);
    if (cached) {
      reply.send(cached);
    }
  });

  // Add hook for storing responses
  fastify.addHook("onSend", async (request: any, reply: any, payload: any) => {
    const routeOptions: FastifyRouteOptions | undefined =
      request.routeOptions?.config?.cachefn;

    if (!routeOptions || reply.sent) {
      return payload;
    }

    // Only cache successful responses
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      return payload;
    }

    // Generate cache key
    const cacheKey =
      typeof routeOptions.key === "function"
        ? routeOptions.key(request)
        : routeOptions.key || request.url;

    // Get tags
    const tags =
      typeof routeOptions.tags === "function"
        ? routeOptions.tags(request)
        : routeOptions.tags;

    // Parse and cache the response
    try {
      const data = typeof payload === "string" ? JSON.parse(payload) : payload;
      await cache.set(cacheKey, data, { ttl: routeOptions.ttl, tags });
    } catch (err) {
      // Ignore parsing errors
    }

    return payload;
  });
}
