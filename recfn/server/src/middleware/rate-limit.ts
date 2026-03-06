/**
 * Rate limiting middleware.
 * Per-IP sliding window. Returns 429 Too Many Requests on exceed.
 */

import type { Middleware } from '@superfunctions/http';
import { createError, ErrorCode } from 'recfn';

export interface RateLimitStore {
  get(key: string): Promise<{ count: number; windowStart: number } | null>;
  set(key: string, count: number, windowStart: number): Promise<void>;
  increment(key: string, windowMs: number): Promise<{ count: number; windowStart: number }>;
}

class InMemoryRateLimitStore implements RateLimitStore {
  private data = new Map<string, { count: number; windowStart: number }>();

  async get(key: string): Promise<{ count: number; windowStart: number } | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, count: number, windowStart: number): Promise<void> {
    this.data.set(key, { count, windowStart });
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; windowStart: number }> {
    const now = Date.now();
    const entry = this.data.get(key);
    if (!entry) {
      const newEntry = { count: 1, windowStart: now };
      this.data.set(key, newEntry);
      return newEntry;
    }
    if (now - entry.windowStart >= windowMs) {
      const newEntry = { count: 1, windowStart: now };
      this.data.set(key, newEntry);
      return newEntry;
    }
    entry.count++;
    return entry;
  }
}

export function createInMemoryRateLimitStore(): RateLimitStore {
  return new InMemoryRateLimitStore();
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

  return async (request: Request, _context: unknown, next: () => Promise<Response>) => {
    const key = `ratelimit:${getClientIp(request)}`;
    const { count } = await store.increment(key, windowMs);

    if (count > requestsPerSecond) {
      throw createError(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        'Rate limit exceeded. Try again later.',
      );
    }

    return next();
  };
}
