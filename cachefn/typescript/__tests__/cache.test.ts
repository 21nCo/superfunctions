/**
 * Core cache tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { cacheFn } from "../src/index.js";

describe("CacheFn", () => {
  let cache: ReturnType<typeof cacheFn>;

  beforeEach(() => {
    cache = cacheFn({
      name: "test-cache",
      storage: "memory",
      maxSize: 10,
    });
  });

  describe("Basic Operations", () => {
    it("should set and get a value", async () => {
      await cache.set("key1", "value1");
      const value = await cache.get("key1");
      expect(value).toBe("value1");
    });

    it("should return undefined for non-existent key", async () => {
      const value = await cache.get("nonexistent");
      expect(value).toBeUndefined();
    });

    it("should check if key exists", async () => {
      await cache.set("key1", "value1");
      expect(await cache.has("key1")).toBe(true);
      expect(await cache.has("key2")).toBe(false);
    });

    it("should delete a value", async () => {
      await cache.set("key1", "value1");
      const deleted = await cache.delete("key1");
      expect(deleted).toBe(true);
      expect(await cache.get("key1")).toBeUndefined();
    });

    it("should clear all values", async () => {
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");
      await cache.clear();
      expect(await cache.size()).toBe(0);
    });
  });

  describe("Batch Operations", () => {
    it("should get multiple values", async () => {
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      const values = await cache.getMany(["key1", "key2", "key3"]);
      expect(values).toEqual(["value1", "value2", undefined]);
    });

    it("should set multiple values", async () => {
      await cache.setMany([
        { key: "key1", value: "value1" },
        { key: "key2", value: "value2" },
      ]);

      expect(await cache.get("key1")).toBe("value1");
      expect(await cache.get("key2")).toBe("value2");
    });

    it("should delete multiple values", async () => {
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");
      await cache.set("key3", "value3");

      await cache.deleteMany(["key1", "key2"]);

      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("key2")).toBeUndefined();
      expect(await cache.get("key3")).toBe("value3");
    });
  });

  describe("TTL", () => {
    it("should expire entries after TTL", async () => {
      await cache.set("key1", "value1", { ttl: 100 });

      expect(await cache.get("key1")).toBe("value1");

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await cache.get("key1")).toBeUndefined();
    });

    it("should use default TTL", async () => {
      const cacheWithTTL = cacheFn({
        name: "ttl-cache",
        storage: "memory",
        defaultTTL: 100,
      });

      await cacheWithTTL.set("key1", "value1");

      expect(await cacheWithTTL.get("key1")).toBe("value1");

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(await cacheWithTTL.get("key1")).toBeUndefined();
    });
  });

  describe("Tag-based Invalidation", () => {
    it("should invalidate by tag", async () => {
      await cache.set("key1", "value1", { tags: ["tag1"] });
      await cache.set("key2", "value2", { tags: ["tag1"] });
      await cache.set("key3", "value3", { tags: ["tag2"] });

      await cache.invalidateByTag("tag1");

      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("key2")).toBeUndefined();
      expect(await cache.get("key3")).toBe("value3");
    });

    it("should invalidate by multiple tags", async () => {
      await cache.set("key1", "value1", { tags: ["tag1"] });
      await cache.set("key2", "value2", { tags: ["tag2"] });
      await cache.set("key3", "value3", { tags: ["tag3"] });

      await cache.invalidateByTags(["tag1", "tag2"]);

      expect(await cache.get("key1")).toBeUndefined();
      expect(await cache.get("key2")).toBeUndefined();
      expect(await cache.get("key3")).toBe("value3");
    });
  });

  describe("Pattern-based Invalidation", () => {
    it("should invalidate by glob pattern", async () => {
      await cache.set("user:1", "value1");
      await cache.set("user:2", "value2");
      await cache.set("post:1", "value3");

      await cache.invalidateByPattern("user:*");

      expect(await cache.get("user:1")).toBeUndefined();
      expect(await cache.get("user:2")).toBeUndefined();
      expect(await cache.get("post:1")).toBe("value3");
    });

    it("should invalidate by regex pattern", async () => {
      await cache.set("user:1", "value1");
      await cache.set("user:2", "value2");
      await cache.set("post:1", "value3");

      await cache.invalidateByPattern(/^user:/);

      expect(await cache.get("user:1")).toBeUndefined();
      expect(await cache.get("user:2")).toBeUndefined();
      expect(await cache.get("post:1")).toBe("value3");
    });
  });

  describe("getOrFetch", () => {
    it("should fetch and cache on miss", async () => {
      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        return "fetched-value";
      };

      const value1 = await cache.getOrFetch("key1", fetcher);
      expect(value1).toBe("fetched-value");
      expect(fetchCount).toBe(1);

      const value2 = await cache.getOrFetch("key1", fetcher);
      expect(value2).toBe("fetched-value");
      expect(fetchCount).toBe(1); // Should not fetch again
    });
  });

  describe("Statistics", () => {
    it("should track hits and misses", async () => {
      await cache.set("key1", "value1");

      await cache.get("key1"); // hit
      await cache.get("key1"); // hit
      await cache.get("key2"); // miss

      const stats = await cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(66.67, 1);
    });

    it("should track sets and deletes", async () => {
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");
      await cache.delete("key1");

      const stats = await cache.getStats();
      expect(stats.sets).toBe(2);
      expect(stats.deletes).toBe(1);
    });
  });

  describe("Events", () => {
    it("should emit hit event", async () => {
      await cache.set("key1", "value1");

      let hitEvent: any;
      cache.on("hit", (event) => {
        hitEvent = event;
      });

      await cache.get("key1");

      expect(hitEvent).toBeDefined();
      expect(hitEvent.key).toBe("key1");
    });

    it("should emit miss event", async () => {
      let missEvent: any;
      cache.on("miss", (event) => {
        missEvent = event;
      });

      await cache.get("nonexistent");

      expect(missEvent).toBeDefined();
      expect(missEvent.key).toBe("nonexistent");
    });

    it("should emit set event", async () => {
      let setEvent: any;
      cache.on("set", (event) => {
        setEvent = event;
      });

      await cache.set("key1", "value1");

      expect(setEvent).toBeDefined();
      expect(setEvent.key).toBe("key1");
    });

    it("should emit delete event", async () => {
      await cache.set("key1", "value1");

      let deleteEvent: any;
      cache.on("delete", (event) => {
        deleteEvent = event;
      });

      await cache.delete("key1");

      expect(deleteEvent).toBeDefined();
      expect(deleteEvent.key).toBe("key1");
    });
  });

  describe("Namespace", () => {
    it("should prefix keys with namespace", async () => {
      const namespacedCache = cacheFn({
        name: "namespaced",
        storage: "memory",
        namespace: "app",
      });

      await namespacedCache.set("key1", "value1");

      const keys = await namespacedCache.keys();
      expect(keys).toContain("key1"); // Should return without namespace prefix
    });
  });
});
