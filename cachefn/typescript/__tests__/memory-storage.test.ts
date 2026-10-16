/**
 * Memory storage tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStorage } from "../src/storage/memory-storage.js";

describe("MemoryStorage", () => {
  let storage: MemoryStorage<any>;

  beforeEach(() => {
    storage = new MemoryStorage({ maxSize: 3 });
  });

  describe("Basic Operations", () => {
    it("should set and get a value", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      const value = await storage.get("key1");
      expect(value).toBe("value1");
    });

    it("should return undefined for non-existent key", async () => {
      const value = await storage.get("nonexistent");
      expect(value).toBeUndefined();
    });

    it("should check if key exists", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      expect(await storage.has("key1")).toBe(true);
      expect(await storage.has("key2")).toBe(false);
    });

    it("should delete a value", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      const deleted = await storage.delete("key1");
      expect(deleted).toBe(true);
      expect(await storage.get("key1")).toBeUndefined();
    });

    it("should clear all values", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("key2", "value2", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      await storage.clear();
      expect(await storage.size()).toBe(0);
    });
  });

  describe("LRU Eviction", () => {
    it("should evict least recently used item when maxSize is reached", async () => {
      const onEviction = vi.fn();
      storage = new MemoryStorage({ maxSize: 2, onEviction });

      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("key2", "value2", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("key3", "value3", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      expect(await storage.get("key1")).toBeUndefined();
      expect(await storage.get("key2")).toBe("value2");
      expect(await storage.get("key3")).toBe("value3");
      expect(onEviction).toHaveBeenCalledWith("key1", "lru");
    });

    it("should update LRU order on access", async () => {
      storage = new MemoryStorage({ maxSize: 2 });

      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("key2", "value2", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      // Access key1 to make it more recently used
      await storage.get("key1");

      // Add key3, should evict key2 (least recently used)
      await storage.set("key3", "value3", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      expect(await storage.get("key1")).toBe("value1");
      expect(await storage.get("key2")).toBeUndefined();
      expect(await storage.get("key3")).toBe("value3");
    });
  });

  describe("TTL Expiration", () => {
    it("should expire entries after TTL", async () => {
      const now = Date.now();
      await storage.set("key1", "value1", {
        createdAt: now,
        expiresAt: now + 1000, // Expires in 1 second
        hits: 0,
        lastAccess: now,
      });

      // Should exist immediately
      expect(await storage.get("key1")).toBe("value1");

      // Mock time passing
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be expired
      expect(await storage.get("key1")).toBeUndefined();
    });

    it("should not expire entries without TTL", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(await storage.get("key1")).toBe("value1");
    });
  });

  describe("Tag Management", () => {
    it("should add and retrieve tags", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        tags: ["tag1", "tag2"],
        hits: 0,
        lastAccess: Date.now(),
      });

      const keys = await storage.getKeysByTag("tag1");
      expect(keys).toContain("key1");
    });

    it("should get keys by tag", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        tags: ["users"],
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("key2", "value2", {
        createdAt: Date.now(),
        tags: ["users"],
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("key3", "value3", {
        createdAt: Date.now(),
        tags: ["posts"],
        hits: 0,
        lastAccess: Date.now(),
      });

      const userKeys = await storage.getKeysByTag("users");
      expect(userKeys).toHaveLength(2);
      expect(userKeys).toContain("key1");
      expect(userKeys).toContain("key2");
    });

    it("should remove tags when entry is deleted", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        tags: ["tag1"],
        hits: 0,
        lastAccess: Date.now(),
      });

      await storage.delete("key1");

      const keys = await storage.getKeysByTag("tag1");
      expect(keys).toHaveLength(0);
    });
  });

  describe("Pattern Matching", () => {
    it("should get keys matching pattern", async () => {
      await storage.set("user:1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("user:2", "value2", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });
      await storage.set("post:1", "value3", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      const userKeys = await storage.keys("user:*");
      expect(userKeys).toHaveLength(2);
      expect(userKeys).toContain("user:1");
      expect(userKeys).toContain("user:2");
    });
  });

  describe("Metadata", () => {
    it("should track access count", async () => {
      await storage.set("key1", "value1", {
        createdAt: Date.now(),
        hits: 0,
        lastAccess: Date.now(),
      });

      await storage.get("key1");
      await storage.get("key1");

      const metadata = await storage.getMetadata("key1");
      expect(metadata?.hits).toBe(2);
    });

    it("should update last access time", async () => {
      const now = Date.now();
      await storage.set("key1", "value1", {
        createdAt: now,
        hits: 0,
        lastAccess: now,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.get("key1");

      const metadata = await storage.getMetadata("key1");
      expect(metadata?.lastAccess).toBeGreaterThan(now);
    });
  });
});
