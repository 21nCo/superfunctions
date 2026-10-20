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


describe("priority-filtered pending fetch invalidation", () => {
  it.each(["low", "normal", "high"] as const)("fences absent pending %s entries while preserving other priorities", async priority => {
    const cache = new CacheFn<string>({name:"priority-pending"});
    const started = deferred<void>(), otherStarted = deferred<void>();
    const old = deferred<string>(), other = deferred<string>();
    const otherPriority = priority === "high" ? "low" : "high";
    const pending = cache.getOrFetch("matching", () => {started.resolve(); return old.promise}, priority === "normal" ? undefined : {priority});
    const retained = cache.getOrFetch("other", () => {otherStarted.resolve(); return other.promise}, {priority:otherPriority});
    await Promise.all([started.promise, otherStarted.promise]);
    await cache.clear({priority});
    old.resolve("old"); other.resolve("retained");
    expect(await pending).toBe("old"); expect(await retained).toBe("retained");
    expect(await cache.has("matching")).toBe(false);
    expect(await cache.get("other")).toBe("retained");
    cache.dispose();
  });

  it("retains a high-priority refresh when clearing its older low-priority stored value", async () => {
    const cache = new CacheFn<string>({name:"priority-refresh"});
    const started = deferred<void>(), fresh = deferred<string>();
    await cache.set("key", "low", {priority:"low"});
    await cache.getOrFetch("key", {priority:"high",fetcher:()=>{started.resolve();return fresh.promise}});
    const refresh = cache.refresh(); await started.promise;
    await cache.clear({priority:"low"}); fresh.resolve("high"); await refresh;
    expect(await cache.get("key")).toBe("high"); cache.dispose();
  });

  it("keeps a replacement fill registered when the superseded fill settles", async () => {
    const cache = new CacheFn<string>({name:"priority-reentry"});
    const oldStarted = deferred<void>(), freshStarted = deferred<void>();
    const old = deferred<string>(), fresh = deferred<string>();
    const stale = cache.getOrFetch("key", () => {oldStarted.resolve();return old.promise}, {priority:"low"});
    await oldStarted.promise; await cache.clear({priority:"low"});
    const replacement = cache.getOrFetch("key", () => {freshStarted.resolve();return fresh.promise}, {priority:"low"});
    await freshStarted.promise; old.resolve("stale"); await stale;
    const unexpected = vi.fn(async()=>"unexpected");
    const joined = cache.getOrFetch("key", unexpected, {priority:"low"});
    expect(joined).toBe(replacement);
    fresh.resolve("fresh"); expect(await joined).toBe("fresh");
    expect(unexpected).not.toHaveBeenCalled(); expect(await cache.get("key")).toBe("fresh");
    cache.dispose();
  });

  it("preserves an explicit write after priority clear when an older fill finishes", async () => {
    const cache = new CacheFn<string>({name:"priority-write"});
    const started = deferred<void>(), old = deferred<string>();
    const pending = cache.getOrFetch("key", () => {started.resolve();return old.promise}, {priority:"low"});
    await started.promise; await cache.clear({priority:"low"});
    await cache.set("key", "explicit", {priority:"low"}); old.resolve("stale"); await pending;
    expect(await cache.get("key")).toBe("explicit"); cache.dispose();
  });
});
