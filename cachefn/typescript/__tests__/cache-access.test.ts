import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { CacheFn } from "../src/core/cache.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";
import { IndexedDBStorage } from "../src/storage/indexeddb-storage.js";

let sequence = 0;
afterEach(() => vi.restoreAllMocks());

for (const storage of ["memory", "indexeddb"] as const) {
  describe(`${storage} cache access`, () => {
    it.each(["set", "delete"] as const)("touch cannot undo a concurrent %s after reading", async operation => {
      const cache = new CacheFn<string>({ name: `touch-${++sequence}`, storage });
      await cache.set("key", "old");
      const prototype = storage === "memory" ? MemoryStorage.prototype : IndexedDBStorage.prototype;
      const original = prototype.get;
      let read!: () => void;
      let release!: () => void;
      const readPromise = new Promise<void>(resolve => { read = resolve; });
      const releasePromise = new Promise<void>(resolve => { release = resolve; });
      const get = vi.spyOn(prototype, "get").mockImplementationOnce(async function (this: any, key) {
        const value = await original.call(this, key);
        read();
        await releasePromise;
        return value;
      });
      const touching = cache.touch("key");
      await readPromise;
      if (operation === "set") await cache.set("key", "new");
      else await cache.delete("key");
      release();
      await touching;
      get.mockRestore();
      expect(await cache.get("key")).toBe(operation === "set" ? "new" : undefined);
    });

    it("touch refreshes access time without altering creation, expiry or tags", async () => {
      const cache = new CacheFn<string>({ name: `touch-${++sequence}`, storage });
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      await cache.set("key", "value", { ttl: 1000, tags: ["tag"] });
      clock.mockReturnValue(1100);
      await cache.touch("key");
      const backend = (cache as any).storage;
      const [key] = await backend.keys();
      expect(await backend.getMetadata(key)).toMatchObject({
        createdAt: 1000, expiresAt: 2000, lastAccess: 1100, hits: 1, tags: ["tag"],
      });
      expect((await cache.getStats()).hits).toBe(0);
    });

    it("preserves undefined values in stats, cache-aside fetches and entries", async () => {
      const cache = new CacheFn<string | undefined>({ name: `undefined-${++sequence}`, storage });
      await cache.set("key", undefined);
      expect(await cache.get("key")).toBeUndefined();
      expect(await cache.has("key")).toBe(true);
      expect(await cache.getStats()).toMatchObject({ hits: 1, misses: 0, size: 1 });
      const fetcher = vi.fn(async () => "fallback");
      expect(await cache.getOrFetch("key", fetcher)).toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
      expect(await cache.entries()).toEqual([{ key: "key", value: undefined }]);
      expect(await cache.get("missing")).toBeUndefined();
      expect(await cache.getStats()).toMatchObject({ hits: 3, misses: 1 });
    });

    it("honors zero and positive entry limits", async () => {
      const cache = new CacheFn<string>({ name: `entries-${++sequence}`, storage });
      await cache.set("a", "a");
      await cache.set("b", "b");
      expect(await cache.entries({ limit: 0 })).toEqual([]);
      expect((await cache.getStats()).hits).toBe(0);
      expect(await cache.entries({ limit: 1 })).toHaveLength(1);
      expect(await cache.entries()).toHaveLength(2);
    });

    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid entry limit %s", async limit => {
      const cache = new CacheFn<string>({ name: `entries-${++sequence}`, storage });
      await expect(cache.entries({ limit })).rejects.toThrow("non-negative safe integer");
    });
  });
}
