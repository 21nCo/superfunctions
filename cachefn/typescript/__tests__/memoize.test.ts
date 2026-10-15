import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { memoize, memoizeSync } from "../src/memoization/memoize.js";

afterEach(() => vi.useRealTimers());

describe("synchronous memoization", () => {
  it("expires values at the TTL boundary and accounts for hits/misses", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => undefined);
    const cached = memoizeSync(fn, { ttl: 100 });
    cached(); cached();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    cached();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await cached.stats()).toMatchObject({hits: 1, misses: 2, sets: 2, size: 1});
    await cached.clear();
    expect(await cached.stats()).toMatchObject({hits: 0, misses: 0, sets: 0, size: 0});
  });
  it("evicts least recently used entries, including empty-string keys", async () => {
    const fn = vi.fn((key: string) => key);
    const cached = memoizeSync(fn, {maxSize: 2, keyGenerator: key => key});
    cached(""); cached("b"); cached(""); cached("c"); cached("b");
    expect(fn).toHaveBeenCalledTimes(4);
    expect(await cached.stats()).toMatchObject({hits: 1, misses: 4, evictions: 2, size: 2});
    await cached.delete("b");
    expect(await cached.stats()).toMatchObject({deletes: 1, size: 1});
  });
  it("supports a zero-capacity cache and validates configuration", () => {
    const fn = vi.fn(() => 1);
    const cached = memoizeSync(fn, {maxSize: 0});
    cached(); cached();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(() => memoizeSync(fn, {maxSize: -1})).toThrow(RangeError);
    expect(() => memoizeSync(fn, {storage: "indexeddb"})).toThrow(TypeError);
  });
});

describe("asynchronous memoization", () => {
  it("has an async return contract for sync and async originals", async () => {
    const sync = memoize((n: number) => n + 1);
    const asyncFn = memoize(async (n: number) => n + 1);
    expectTypeOf(sync(1)).toEqualTypeOf<Promise<number>>();
    expectTypeOf(asyncFn(1)).toEqualTypeOf<Promise<number>>();
    expect(await sync(1)).toBe(2);
  });
  it("coalesces concurrent calls and caches undefined", async () => {
    const fn = vi.fn(async () => undefined);
    const cached = memoize(fn);
    await Promise.all([cached(), cached(), cached()]);
    await cached();
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries failures", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("retry")).mockResolvedValue(2);
    const cached = memoize(fn);
    await expect(cached()).rejects.toThrow("retry");
    expect(await cached()).toBe(2);
  });
  it.each(["clear", "delete"] as const)("does not repopulate after %s during computation", async method => {
    let resolve!: (n: number) => void;
    const fn = vi.fn(() => new Promise<number>(r => { resolve = r; }));
    const cached = memoize(fn);
    const first = cached();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
    await cached[method]();
    resolve(1);
    expect(await first).toBe(1);
    const second = cached();
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    resolve(2);
    expect(await second).toBe(2);
  });
  it("isolates same-named functions on IndexedDB", async () => {
    const first = memoize(function same() { return 1; }, {storage: "indexeddb"});
    const second = memoize(function same() { return 2; }, {storage: "indexeddb"});
    expect(await first()).toBe(1);
    expect(await second()).toBe(2);
    await first.clear(); await second.clear();
  });
});
