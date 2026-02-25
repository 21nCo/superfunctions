/**
 * Rate Limiting Middleware
 * Implements RATE-001 through RATE-005: configurable per-endpoint rate limiting
 * with Redis-backed and in-memory fallback implementations.
 */

import type { RedisAdapter } from "@superfunctions/db";

/**
 * Rate limiter interface for checking request allowance.
 */
export interface RateLimiter {
  check(key: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }>;
}

/**
 * Redis-backed rate limiter using atomic INCR with TTL (RATE-002).
 * Key format: ratelimit:{endpoint}:{clientKey}:{windowId}
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: RedisAdapter) {}

  async check(key: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    const windowId = Math.floor(Date.now() / (windowSeconds * 1000));
    const redisKey = `ratelimit:${key}:${windowId}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.set(redisKey, String(count), windowSeconds);
    }
    return {
      allowed: count <= maxRequests,
      remaining: Math.max(0, maxRequests - count),
    };
  }
}

/**
 * In-memory sliding window rate limiter (RATE-003).
 * Uses a Map<string, { count, resetAt }> structure with lazy cleanup.
 * Single-process only — does NOT work across multiple processes.
 */
export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  async check(key: string, maxRequests: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = this.windows.get(key);

    if (!entry || now >= entry.resetAt) {
      // Window expired or first request — start new window
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    entry.count++;
    return {
      allowed: entry.count <= maxRequests,
      remaining: Math.max(0, maxRequests - entry.count),
    };
  }
}

/**
 * Rate limit middleware configuration.
 */
export interface RateLimitMiddlewareConfig {
  limiter: RateLimiter;
  maxRequests: number;
  windowSeconds: number;
  endpoints?: Partial<Record<string, { maxRequests: number; windowSeconds: number }>>;
  keyExtractor: (ctx: any) => string | Promise<string>;
}

/**
 * Creates a rate limit middleware function (RATE-001).
 * Returns null if the request is allowed, or a 429 Response if rate-limited.
 * Applied BEFORE JSON body parsing and authorization per spec.
 */
export function createRateLimitMiddleware(config: RateLimitMiddlewareConfig) {
  return async (endpoint: string, ctx: any): Promise<Response | null> => {
    const key = await config.keyExtractor(ctx);
    const endpointConfig = config.endpoints?.[endpoint];
    const max = endpointConfig?.maxRequests ?? config.maxRequests;
    const windowSec = endpointConfig?.windowSeconds ?? config.windowSeconds;

    const result = await config.limiter.check(`${endpoint}:${key}`, max, windowSec);

    if (!result.allowed) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            details: { path: "$" },
          },
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      );
    }

    return null; // Allowed
  };
}
