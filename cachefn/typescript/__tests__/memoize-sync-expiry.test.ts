import { afterEach, describe, expect, it, vi } from "vitest";
import { memoizeSync } from "../src/memoization/memoize.js";

afterEach(() => vi.useRealTimers());

describe("populated synchronous memoization expiry and capacity", () => {
  it("reclaims an expired MRU entry before evicting a live LRU entry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const original = vi.fn((key: string) => key);
    const cached = memoizeSync(original, { maxSize: 2, ttl: 100, keyGenerator: key => key });
    cached("old"); vi.setSystemTime(50); cached("young");
    vi.setSystemTime(75); cached("old"); // Expiry remains 100, although this is now MRU.
    vi.setSystemTime(100); cached("new"); cached("young");
    expect(original.mock.calls.map(([key]) => key)).toEqual(["old", "young", "new"]);
    expect(await cached.stats()).toMatchObject({ hits: 2, misses: 3, sets: 3, evictions: 0, size: 2 });
  });

  it("returns a miss at the exact expiry boundary and computes exact cold-entry statistics", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const original = vi.fn((key: string) => key === "undefined" ? undefined : key);
    const cached = memoizeSync(original, { maxSize: 4, ttl: 100, keyGenerator: key => key });
    cached("cold"); cached("undefined"); vi.setSystemTime(99); cached("undefined");
    expect(original).toHaveBeenCalledTimes(2);
    vi.setSystemTime(100); cached("undefined");
    expect(original).toHaveBeenCalledTimes(3);
    expect(await cached.stats()).toMatchObject({ hits: 1, misses: 3, evictions: 0, size: 1 });
    vi.setSystemTime(200);
    expect(await cached.stats()).toMatchObject({ size: 0, evictions: 0 });
  });

  it("reclaims entries that expire during computation before capacity eviction", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const original = vi.fn((key: string) => { if (key === "slow") vi.setSystemTime(150); return key; });
    const cached = memoizeSync(original, { maxSize: 2, ttl: 100, keyGenerator: key => key });
    cached("old"); vi.setSystemTime(75); cached("young"); cached("old");
    vi.setSystemTime(90); cached("slow"); cached("young");
    expect(original).toHaveBeenCalledTimes(3);
    expect(await cached.stats()).toMatchObject({ size: 2, evictions: 0 });
  });

  it("bounds reentrant insertions and evicts the actual LRU entry", async () => {
    const calls: string[] = [];
    const cached = memoizeSync((key: string): string => {
      calls.push(key);
      if (key === "outer") { cached("inner-a"); cached("inner-b"); }
      return key;
    }, { maxSize: 2, keyGenerator: key => key });
    cached("outer"); cached("inner-b"); cached("inner-a");
    expect(calls).toEqual(["outer", "inner-a", "inner-b", "inner-a"]);
    expect(await cached.stats()).toMatchObject({ hits: 1, misses: 4, size: 2, evictions: 2 });
  });

  it.each([undefined, Infinity])("retains populated non-expiring entries with ttl=%s", async ttl => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const original = vi.fn((key: number) => key);
    const cached = memoizeSync(original, { maxSize: 1000, ttl });
    for (let i = 0; i < 1000; i++) cached(i);
    vi.setSystemTime(1e12);
    for (let i = 0; i < 1000; i++) expect(cached(i)).toBe(i);
    expect(original).toHaveBeenCalledTimes(1000);
    expect(await cached.stats()).toMatchObject({ hits: 1000, misses: 1000, size: 1000, evictions: 0 });
    await cached.delete(0); cached(0);
    expect(await cached.stats()).toMatchObject({ deletes: 1, size: 1000 });
    await cached.clear(); expect(await cached.stats()).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });

  it.each([0, -1])("never serves a value after immediate expiry ttl=%s", async ttl => {
    const original = vi.fn(() => 1); const cached = memoizeSync(original, { ttl, maxSize: 1 });
    cached(); cached();
    expect(original).toHaveBeenCalledTimes(2);
    expect(await cached.stats()).toMatchObject({ size: 0, evictions: 0, misses: 2 });
  });
});
