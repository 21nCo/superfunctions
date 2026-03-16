/**
 * Rate limiting middleware.
 */

import type { Middleware } from '@superfunctions/http';
import {
  createInMemoryKVStore,
  createRateLimiter,
  type KVStoreAdapter,
} from '@superfunctions/middleware';
import { createError, ErrorCode } from 'recfn';

export type RateLimitStore = KVStoreAdapter;

export function createInMemoryRateLimitStore(): RateLimitStore {
  return createInMemoryKVStore();
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

export interface RateLimitMiddlewareOptions {
  requestsPerSecond: number;
  windowMs?: number;
  store?: RateLimitStore;
}

export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions,
): Middleware {
  const {
    requestsPerSecond,
    windowMs = 1000,
    store = createInMemoryRateLimitStore(),
  } = options;

  const limiter = createRateLimiter({
    windowMs,
    maxRequests: requestsPerSecond,
    algorithm: 'sliding-window',
    persistence: store,
    keyPrefix: 'recfn:ratelimit:',
  });

  return async (request: Request, _context: unknown, next: () => Promise<Response>) => {
    const key = `ip:${getClientIp(request)}`;
    const { allowed } = await limiter.check({ key });

    if (!allowed) {
      throw createError(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        'Rate limit exceeded. Try again later.',
      );
    }

    return next();
  };
}
