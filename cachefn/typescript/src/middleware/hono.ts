/**
 * Hono middleware for HTTP response caching
 */

import type { CacheFn } from "../core/cache.js";

export interface HonoMiddlewareOptions {
  cache?: CacheFn;
  ttl?: number;
  key?: string | ((c: any) => string);
  tags?: string[] | ((c: any) => string[]);
  condition?: (c: any) => boolean;
}

/**
 * Create Hono middleware for caching
 */
export function hono(options: HonoMiddlewareOptions = {}) {
  const cache = options.cache;

  if (!cache) {
    throw new Error("Cache instance is required for Hono middleware");
  }

  return async (c: any, next: any) => {
    // Check condition
    if (options.condition && !options.condition(c)) {
      return next();
    }

    // Only cache GET requests by default
    if (c.req.method !== "GET") {
      return next();
    }

    // Generate cache key
    const cacheKey =
      typeof options.key === "function"
        ? options.key(c)
        : options.key || c.req.url;

    // Try to get from cache
    const cached = await cache.get(cacheKey);
    if (cached) {
      return c.json(cached);
    }

    // Execute the handler
    await next();

    // Get the response
    const response = await c.res.clone().json();

    // Get tags
    const tags =
      typeof options.tags === "function" ? options.tags(c) : options.tags;

    // Cache the response
    await cache.set(cacheKey, response, { ttl: options.ttl, tags });
  };
}
