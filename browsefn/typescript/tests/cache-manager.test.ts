/**
 * Tests for cache manager
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CacheManager } from "../src/core/cache-manager.js";
import type { CacheConfig } from "../src/core/types.js";

describe("CacheManager", () => {
  let config: CacheConfig;
  let cache: CacheManager;

  beforeEach(() => {
    config = {
      enabled: true,
      ttl: 60000,
      storage: "memory",
    };
    cache = new CacheManager(config);
  });

  it("should set and get cache entries", async () => {
    await cache.set("test", "https://example.com", { data: "test" });
    const result = await cache.get("test", "https://example.com");

    expect(result).toEqual({ data: "test" });
  });

  it("should expire entries after TTL", async () => {
    const shortConfig = { ...config, ttl: 100 };
    const shortCache = new CacheManager(shortConfig);

    await shortCache.set("test", "https://example.com", "data");

    // Should be available immediately
    let result = await shortCache.get("test", "https://example.com");
    expect(result).toBe("data");

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should be expired
    result = await shortCache.get("test", "https://example.com");
    expect(result).toBeNull();
  });

  it("should evict oldest entry when max size reached", async () => {
    const limitedConfig = { ...config, maxSize: 2 };
    const limitedCache = new CacheManager(limitedConfig);

    await limitedCache.set("test", "url1", "data1");
    await limitedCache.set("test", "url2", "data2");
    await limitedCache.set("test", "url3", "data3"); // Should evict url1

    expect(await limitedCache.get("test", "url1")).toBeNull();
    expect(await limitedCache.get("test", "url2")).toBe("data2");
    expect(await limitedCache.get("test", "url3")).toBe("data3");
  });

  it("should invalidate cache by pattern", async () => {
    await cache.set("test", "https://example.com/page1", "data1");
    await cache.set("test", "https://example.com/page2", "data2");
    await cache.set("test", "https://other.com/page1", "data3");

    await cache.invalidate("example.com");

    expect(await cache.get("test", "https://example.com/page1")).toBeNull();
    expect(await cache.get("test", "https://example.com/page2")).toBeNull();
    expect(await cache.get("test", "https://other.com/page1")).toBe("data3");
  });

  it("should track cache statistics", async () => {
    await cache.set("test", "url1", "data1");

    // Cache hit
    await cache.get("test", "url1");

    // Cache miss
    await cache.get("test", "url2");

    const stats = await cache.getStats();

    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(50);
    expect(stats.size).toBe(1);
  });

  it("should clear all cache", async () => {
    await cache.set("test", "url1", "data1");
    await cache.set("test", "url2", "data2");

    await cache.clear();

    const stats = await cache.getStats();
    expect(stats.size).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it("should not cache when disabled", async () => {
    const disabledCache = new CacheManager({ enabled: false });

    await disabledCache.set("test", "url1", "data1");
    const result = await disabledCache.get("test", "url1");

    expect(result).toBeNull();
  });
});
