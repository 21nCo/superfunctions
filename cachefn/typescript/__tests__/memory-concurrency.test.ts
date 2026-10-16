import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../src/storage/memory-storage.js";
const metadata = (tags: string[] = []) => ({createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags});
describe("memory capacity and concurrent mutations", () => {
  it("keeps concurrent writes bounded and removes evicted tags", async () => {
    const storage = new MemoryStorage<number>({maxSize: 1});
    await storage.set("", 0, metadata(["old"]));
    await Promise.all(Array.from({length: 20}, (_, i) => storage.set(String(i), i, metadata(["new"]))));
    expect(await storage.size()).toBe(1);
    expect(await storage.getKeysByTag("old")).toEqual([]);
    expect(await storage.getKeysByTag("new")).toEqual(["19"]);
  });
  it("maintains tag consistency across concurrent overwrites", async () => {
    const storage = new MemoryStorage<number>();
    await storage.set("key", 0, metadata(["initial"]));
    await Promise.all([storage.set("key", 1, metadata(["one"])), storage.set("key", 2, metadata(["two"]))]);
    expect(await storage.get("key")).toBe(2);
    expect(await storage.getKeysByTag("one")).toEqual([]);
    expect(await storage.getKeysByTag("two")).toEqual(["key"]);
  });
  it("disables storage at zero capacity and rejects invalid capacities", async () => {
    const storage = new MemoryStorage({maxSize: 0});
    await storage.set("key", 1, metadata());
    expect(await storage.size()).toBe(0);
    for (const maxSize of [-1, NaN, Infinity, 1.5]) {
      expect(() => new MemoryStorage({maxSize})).toThrow(RangeError);
    }
  });
});

it("reclaims expired entries before evicting live values", async () => {
  const storage = new MemoryStorage<number>({maxSize: 2});
  await storage.set("live", 1, metadata());
  await storage.set("expired", 2, {...metadata(), expiresAt: 0});
  await storage.set("new", 3, metadata());
  expect(await storage.get("live")).toBe(1);
  expect(await storage.size()).toBe(2);
});
it("does not expose mutable tag metadata", async () => {
  const storage = new MemoryStorage<number>();
  const tags = ["original"];
  await storage.set("key", 1, metadata(tags));
  tags.push("foreign");
  const result = await storage.getMetadata("key");
  result!.tags!.push("another");
  expect((await storage.getMetadata("key"))!.tags).toEqual(["original"]);
  expect(await storage.getKeysByTag("original")).toEqual(["key"]);
});
