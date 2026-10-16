/**
 * Tests for rate limiter
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter } from "../src/core/rate-limiter.js";
import type { RateLimitConfig } from "../src/core/types.js";

describe("RateLimiter", () => {
  it("should allow requests within limit", async () => {
    const config: RateLimitConfig = { requests: 2, window: 1000 };
    const limiter = new RateLimiter(config);

    expect(await limiter.checkLimit("test")).toBe(true);
    expect(await limiter.checkLimit("test")).toBe(true);
    expect(await limiter.checkLimit("test")).toBe(false);
  });

  it("should reset limit after window expires", async () => {
    const config: RateLimitConfig = { requests: 2, window: 100 };
    const limiter = new RateLimiter(config);

    await limiter.checkLimit("test");
    await limiter.checkLimit("test");
    expect(await limiter.checkLimit("test")).toBe(false);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await limiter.checkLimit("test")).toBe(true);
  });

  it("should support per-provider limits", async () => {
    const limiter = new RateLimiter(undefined, {
      fast: { requests: 10, window: 1000 },
      slow: { requests: 2, window: 1000 },
    });

    // Fast provider should allow more
    for (let i = 0; i < 5; i++) {
      expect(await limiter.checkLimit("fast")).toBe(true);
    }

    // Slow provider should be limited
    expect(await limiter.checkLimit("slow")).toBe(true);
    expect(await limiter.checkLimit("slow")).toBe(true);
    expect(await limiter.checkLimit("slow")).toBe(false);
  });

  it("should return accurate rate limit status", async () => {
    const config: RateLimitConfig = { requests: 5, window: 1000 };
    const limiter = new RateLimiter(config);

    await limiter.checkLimit("test");
    await limiter.checkLimit("test");

    const status = limiter.getStatus("test");

    expect(status.limit).toBe(5);
    expect(status.remaining).toBe(3);
    expect(status.resetAt).toBeGreaterThan(Date.now());
  });

  it("should reset limits", async () => {
    const config: RateLimitConfig = { requests: 2, window: 1000 };
    const limiter = new RateLimiter(config);

    await limiter.checkLimit("test");
    await limiter.checkLimit("test");
    expect(await limiter.checkLimit("test")).toBe(false);

    await limiter.reset("test");

    expect(await limiter.checkLimit("test")).toBe(true);
  });

  it("should wait for rate limit", async () => {
    const config: RateLimitConfig = { requests: 1, window: 200 };
    const limiter = new RateLimiter(config);

    await limiter.checkLimit("test");

    const start = Date.now();
    await limiter.waitForLimit("test");
    const duration = Date.now() - start;

    // Should have waited approximately 200ms
    expect(duration).toBeGreaterThanOrEqual(150);
    expect(await limiter.checkLimit("test")).toBe(false);
  });

  it("should expose the shared middleware import path", () => {
    const limiter = new RateLimiter({ requests: 1, window: 1000 });
    expect(limiter.getImportPath()).toBe("@superfunctions/middleware/rate-limit");
  });

  it("should surface remaining and retry delay when rate limited", async () => {
    const limiter = new RateLimiter({ requests: 1, window: 1000 });

    expect(await limiter.checkLimit("unsplash")).toBe(true);
    expect(await limiter.checkLimit("unsplash")).toBe(false);

    const status = limiter.getStatus("unsplash");
    expect(status.allowed).toBe(false);
    expect(status.provider).toBe("unsplash");
    expect(status.remaining).toBe(0);
    expect(status.retryAfterMs).toBeGreaterThan(0);
  });
});

it('enforces an aggregate quota across providers and their individual limits', async () => {
  const limiter = new RateLimiter({ requests: 2, window: 10_000 }, { a: { requests: 5, window: 10_000 }, b: { requests: 5, window: 10_000 } });
  const results = await Promise.all(['a', 'b', 'a', 'b', 'c'].map(provider => limiter.checkLimit(provider)));
  expect(results.filter(Boolean)).toHaveLength(2);
  expect(limiter.getStatus('never-used').remaining).toBe(0);
});

it('does not charge the global window for a provider denial', async () => {
  const limiter = new RateLimiter({ requests: 3, window: 10_000 }, { a: { requests: 1, window: 10_000 } });
  expect(await limiter.checkLimit('a')).toBe(true);
  expect(await limiter.checkLimit('a')).toBe(false);
  expect(await limiter.checkLimit('b')).toBe(true);
  expect(await limiter.checkLimit('b')).toBe(true);
  expect(await limiter.checkLimit('b')).toBe(false);
  await limiter.reset('a');
  expect(await limiter.checkLimit('a')).toBe(false);
});

it('allows a provider window to expire independently of the global quota', async () => {
  const limiter = new RateLimiter({ requests: 2, window: 10_000 }, { a: { requests: 1, window: 30 } });
  expect(await limiter.checkLimit('a')).toBe(true);
  expect(await limiter.checkLimit('a')).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await limiter.checkLimit('a')).toBe(true);
  expect(await limiter.checkLimit('b')).toBe(false);
});
