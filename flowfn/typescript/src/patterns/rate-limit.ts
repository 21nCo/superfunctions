/**
 * Rate limiting pattern for FlowFn
 */

export interface RateLimitOptions {
  /**
   * Maximum number of requests allowed
   */
  limit: number;

  /**
   * Time window in milliseconds
   */
  window: number;

  /**
   * Strategy for handling rate limit exceeded
   */
  strategy?: "throw" | "delay" | "drop";

  /**
   * Custom key generator for partitioning rate limits
   */
  keyGenerator?: (...args: any[]) => string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export class RateLimiter {
  private counters: Map<string, { count: number; resetAt: number }> = new Map();
  private options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = {
      strategy: "throw",
      ...options,
    };
  }

  /**
   * Check if request is allowed
   */
  async check(key: string = "default"): Promise<RateLimitResult> {
    const now = Date.now();
    let counter = this.counters.get(key);

    // Reset counter if window has passed
    if (!counter || now >= counter.resetAt) {
      counter = {
        count: 0,
        resetAt: now + this.options.window,
      };
      this.counters.set(key, counter);
    }

    const allowed = counter.count < this.options.limit;
    const remaining = Math.max(0, this.options.limit - counter.count);
    const retryAfter = allowed ? undefined : counter.resetAt - now;

    if (allowed) {
      counter.count++;
    }

    return {
      allowed,
      remaining,
      resetAt: counter.resetAt,
      retryAfter,
    };
  }

  /**
   * Execute a function with rate limiting
   */
  async execute<T>(fn: () => Promise<T>, key: string = "default"): Promise<T> {
    const result = await this.check(key);

    if (!result.allowed) {
      switch (this.options.strategy) {
        case "throw":
          throw new Error(
            `Rate limit exceeded. Retry after ${result.retryAfter}ms`
          );

        case "delay":
          await new Promise((resolve) =>
            setTimeout(resolve, result.retryAfter)
          );
          return this.execute(fn, key);

        case "drop":
          throw new Error("Request dropped due to rate limit");

        default:
          throw new Error("Unknown rate limit strategy");
      }
    }

    return fn();
  }

  /**
   * Clear all rate limit counters
   */
  reset(): void {
    this.counters.clear();
  }

  /**
   * Clear rate limit counter for specific key
   */
  resetKey(key: string): void {
    this.counters.delete(key);
  }

  /**
   * Get current limit info for a key
   */
  getInfo(key: string = "default"): RateLimitResult {
    const now = Date.now();
    const counter = this.counters.get(key);

    if (!counter || now >= counter.resetAt) {
      return {
        allowed: true,
        remaining: this.options.limit,
        resetAt: now + this.options.window,
      };
    }

    const allowed = counter.count < this.options.limit;
    const remaining = Math.max(0, this.options.limit - counter.count);

    return {
      allowed,
      remaining,
      resetAt: counter.resetAt,
      retryAfter: allowed ? undefined : counter.resetAt - now,
    };
  }
}

/**
 * Create a rate limiter
 */
export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  return new RateLimiter(options);
}

/**
 * Sliding window rate limiter (more accurate)
 */
export class SlidingWindowRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private options: RateLimitOptions;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  async check(key: string = "default"): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - this.options.window;

    let requests = this.requests.get(key) || [];

    // Remove old requests outside the window
    requests = requests.filter((timestamp) => timestamp > windowStart);
    this.requests.set(key, requests);

    const allowed = requests.length < this.options.limit;
    const remaining = Math.max(0, this.options.limit - requests.length);

    if (allowed) {
      requests.push(now);
    }

    const oldestRequest = requests[0];
    const resetAt = oldestRequest
      ? oldestRequest + this.options.window
      : now + this.options.window;
    const retryAfter = allowed ? undefined : resetAt - now;

    return {
      allowed,
      remaining,
      resetAt,
      retryAfter,
    };
  }

  async execute<T>(fn: () => Promise<T>, key: string = "default"): Promise<T> {
    const result = await this.check(key);

    if (!result.allowed) {
      switch (this.options.strategy || "throw") {
        case "throw":
          throw new Error(
            `Rate limit exceeded. Retry after ${result.retryAfter}ms`
          );
        case "delay":
          await new Promise((resolve) =>
            setTimeout(resolve, result.retryAfter)
          );
          return this.execute(fn, key);
        case "drop":
          throw new Error("Request dropped due to rate limit");
      }
    }

    return fn();
  }

  reset(): void {
    this.requests.clear();
  }
}

/**
 * Token bucket rate limiter
 */
export class TokenBucketRateLimiter {
  private buckets: Map<string, { tokens: number; lastRefill: number }> =
    new Map();
  private capacity: number;
  private refillRate: number; // tokens per second
  private refillInterval: number;

  constructor(options: {
    capacity: number;
    refillRate: number;
    refillInterval?: number;
  }) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.refillInterval = options.refillInterval || 1000; // default 1 second
  }

  private refill(key: string): void {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
      return;
    }

    const timePassed = now - bucket.lastRefill;
    const intervals = timePassed / this.refillInterval;
    const tokensToAdd = intervals * this.refillRate;

    bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  async check(
    key: string = "default",
    cost: number = 1
  ): Promise<RateLimitResult> {
    this.refill(key);
    const bucket = this.buckets.get(key)!;

    const allowed = bucket.tokens >= cost;

    if (allowed) {
      bucket.tokens -= cost;
    }

    return {
      allowed,
      remaining: Math.floor(bucket.tokens),
      resetAt: bucket.lastRefill + this.refillInterval,
      retryAfter: allowed
        ? undefined
        : Math.ceil(
            ((cost - bucket.tokens) / this.refillRate) * this.refillInterval
          ),
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}
