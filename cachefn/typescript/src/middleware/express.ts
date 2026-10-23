/**
 * Express middleware for HTTP response caching
 */

import type { CacheFn } from "../core/cache.js";

export interface ExpressMiddlewareOptions {
  cache?: CacheFn;
  ttl?: number;
  key?: string | ((req: any) => string);
  tags?: string[] | ((req: any) => string[]);
  condition?: (req: any) => boolean;
  vary?: string[];
}

/**
 * Create Express middleware for caching
 */
export function middleware(options: ExpressMiddlewareOptions = {}) {
  const cache = options.cache;

  if (!cache) {
    throw new Error("Cache instance is required for Express middleware");
  }

  return async (req: any, res: any, next: any) => {
    // Check condition
    if (options.condition && !options.condition(req)) {
      return next();
    }

    // Only cache GET requests by default
    if (req.method !== "GET") {
      return next();
    }

    // Generate cache key
    const cacheKey =
      typeof options.key === "function"
        ? options.key(req)
        : options.key || req.url;

    // Try to get from cache
    const cached = await cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Intercept response
    const originalJson = res.json.bind(res);
    res.json = (data: any) => {
      // Get tags
      const tags =
        typeof options.tags === "function" ? options.tags(req) : options.tags;

      // Cache the response
      cache.set(cacheKey, data, { ttl: options.ttl, tags }).catch((err) => {
        console.error("Failed to cache response:", err);
      });

      return originalJson(data);
    };

    next();
  };
}
