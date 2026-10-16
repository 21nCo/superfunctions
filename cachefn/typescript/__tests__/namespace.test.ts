import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";
import { CacheFn } from "../src/core/cache.js";

describe("shared IndexedDB namespace isolation", () => {
  let sequence = 0;
  function caches() {
    const name = `namespace-${++sequence}`;
    return ["one", "other"].map(namespace => new CacheFn<string>({
      name, namespace, storage: "indexeddb",
    }));
  }

  it("lists and counts only owned keys", async () => {
    const [one, other] = caches();
    await one.set("item:1", "one");
    await other.set("item:2", "other");
    expect(await one.keys()).toEqual(["item:1"]);
    expect(await one.size()).toBe(1);
    expect(await one.entries()).toEqual([{ key: "item:1", value: "one" }]);
  });

  it("clears only the selected namespace", async () => {
    const [one, other] = caches();
    await one.set("item", "one");
    await other.set("item", "other");
    await one.clear();
    expect(await one.get("item")).toBeUndefined();
    expect(await other.get("item")).toBe("other");
  });

  it("invalidates shared tags only within the selected namespace", async () => {
    const [one, other] = caches();
    await one.set("item", "one", { tags: ["shared"] });
    await other.set("item", "other", { tags: ["shared"] });
    await one.invalidateByTag("shared");
    expect(await one.get("item")).toBeUndefined();
    expect(await other.get("item")).toBe("other");
  });

  it.each(["memory", "indexeddb"] as const)("matches public keys for %s pattern invalidation", async storage => {
    const one = new CacheFn({name: `pattern-${storage}`, namespace: "one", storage});
    await one.set("item:1", "one");
    await one.set("keep:1", "keep");
    await one.invalidateByPattern("item:*");
    expect(await one.get("item:1")).toBeUndefined();
    expect(await one.get("keep:1")).toBe("keep");
  });
});

describe("ambiguous namespace boundaries", () => {
  it.each(["clear", "invalidateByTag", "invalidateByPattern"] as const)("isolates default and overlapping namespaces during %s", async method => {
    const name = `ambiguous-${method}`;
    const root = new CacheFn<string>({ name, storage: "indexeddb" });
    const parent = new CacheFn<string>({ name, storage: "indexeddb", namespace: "a" });
    const child = new CacheFn<string>({ name, storage: "indexeddb", namespace: "a:b" });
    await root.set("a:b:item", "root", { tags: ["shared"] });
    await parent.set("b:item", "parent", { tags: ["shared"] });
    await child.set("item", "child", { tags: ["shared"] });
    expect(await root.keys()).toEqual(["a:b:item"]);
    expect(await parent.keys()).toEqual(["b:item"]);
    expect(await child.keys()).toEqual(["item"]);
    await parent[method](method === "invalidateByTag" ? "shared" : "*");
    expect(await root.get("a:b:item")).toBe("root");
    expect(await parent.get("b:item")).toBeUndefined();
    expect(await child.get("item")).toBe("child");
    await root[method](method === "invalidateByTag" ? "shared" : "*");
    expect(await child.get("item")).toBe("child");
  });
});
