import { describe, expect, it, vi } from "vitest";
import { CacheFn } from "../src/core/cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("cache-aside concurrency", () => {
  it("shares a pending fetch and retries after rejection", async () => {
    const cache = new CacheFn<string>({ name: "fetch" });
    const started = deferred<string>();
    const fetch = vi.fn(() => started.promise);
    const a = cache.getOrFetch("key", fetch);
    const b = cache.getOrFetch("key", fetch);
    started.resolve("value");
    expect(await Promise.all([a, b])).toEqual(["value", "value"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(cache.getOrFetch("bad", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    expect(await cache.getOrFetch("bad", async () => "retry")).toBe("retry");
  });

  it.each(["set", "delete", "clear", "tag", "pattern"])("does not repopulate stale data after %s", async operation => {
    const cache = new CacheFn<string>({ name: "fetch" });
    const started = deferred<void>();
    const value = deferred<string>();
    const stale = cache.getOrFetch("key", () => { started.resolve(); return value.promise; }, { tags: ["tag"] });
    await started.promise;
    if (operation === "set") await cache.set("key", "new");
    if (operation === "delete") await cache.delete("key");
    if (operation === "clear") await cache.clear();
    if (operation === "tag") await cache.invalidateByTag("tag");
    if (operation === "pattern") await cache.invalidateByPattern("k*");
    value.resolve("old");
    expect(await stale).toBe("old");
    expect(await cache.get("key")).toBe(operation === "set" ? "new" : undefined);
    if (operation !== "set") expect(await cache.getOrFetch("key", async () => "fresh")).toBe("fresh");
  });
});
