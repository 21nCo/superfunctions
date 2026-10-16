import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { IndexedDBStorage } from "../src/storage/indexeddb-storage.js";

let sequence = 0;
const create = () => new IndexedDBStorage<any>({ name: `storage-${++sequence}` });
const metadata = (tags = ["old"], expiresAt?: number) => ({
  createdAt: Date.now(), lastAccess: Date.now(), hits: 0, tags, expiresAt,
});
afterEach(() => vi.restoreAllMocks());

describe("IndexedDB transactional storage", () => {
  it("updates tag metadata consistently through add, remove, replacement and deletion", async () => {
    const storage = create();
    await storage.set("key", 1, metadata());
    await storage.addTag("new", "key");
    await storage.addTag("new", "key");
    expect(await storage.getTagsForKey("key")).toEqual(["old", "new"]);
    expect(await storage.getKeysByTag("new")).toEqual(["key"]);
    await storage.removeTag("old", "key");
    expect(await storage.getKeysByTag("old")).toEqual([]);
    expect((await storage.getMetadata("key"))?.tags).toEqual(["new"]);
    await storage.set("key", 2, metadata(["replacement"]));
    expect(await storage.getKeysByTag("new")).toEqual([]);
    expect(await storage.getKeysByTag("replacement")).toEqual(["key"]);
    expect(await storage.delete("key")).toBe(true);
    expect(await storage.delete("key")).toBe(false);
    expect(await storage.getKeysByTag("replacement")).toEqual([]);
    await storage.addTag("orphan", "missing");
    expect(await storage.getKeysByTag("orphan")).toEqual([]);
  });

  it.each(["get", "has", "getMetadata", "getTagsForKey", "keys", "size", "getKeysByTag"] as const)(
    "%s excludes expired entries and removes them in its transaction", async method => {
      const storage = create();
      await storage.set("expired", 1, metadata(["tag"], Date.now() - 1));
      await storage.set("live", 2, metadata(["tag"]));
      const result = await storage[method](method === "getKeysByTag" ? "tag" : method === "keys" ? undefined as any : "expired");
      const expected = { get: undefined, has: false, getMetadata: undefined, getTagsForKey: [], keys: ["live"], size: 1, getKeysByTag: ["live"] };
      expect(result).toEqual(expected[method]);
      expect(await storage.delete("expired")).toBe(false);
    },
  );

  it("rejects uncloneable writes and keeps the previous value and tags", async () => {
    const storage = create();
    await storage.set("key", 1, metadata());
    await expect(storage.set("key", () => 1, metadata(["bad"]))).rejects.toThrow();
    expect(await storage.get("key")).toBe(1);
    expect(await storage.getKeysByTag("old")).toEqual(["key"]);
    expect(await storage.getKeysByTag("bad")).toEqual([]);
  });

  it("rejects an abort after a request succeeds instead of reporting a committed write", async () => {
    const storage = create();
    await storage.set("key", 1, metadata());
    const original = IDBObjectStore.prototype.delete;
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key) {
      const request = original.call(this, key);
      request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(storage.delete("key")).rejects.toThrow("aborted");
    expect(await storage.has("key")).toBe(true);
  });

  it("rejects failures in a get callback and rolls back access metadata", async () => {
    const storage = create();
    await storage.set("key", 1, metadata());
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => { throw new Error("put failed"); });
    await expect(storage.get("key")).rejects.toThrow("put failed");
    put.mockRestore();
    expect((await storage.getMetadata("key"))?.hits).toBe(0);
  });

  it("rejects request errors and preserves prior data", async () => {
    const storage = create();
    await storage.set("key", 1, metadata());
    // Force a genuine asynchronous ConstraintError by turning put into add.
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value) {
      return this.add(value);
    });
    await expect(storage.set("key", 2, metadata(["replacement"]))).rejects.toThrow();
    put.mockRestore();
    expect(await storage.get("key")).toBe(1);
    expect(await storage.getTagsForKey("key")).toEqual(["old"]);
  });

  it("retries initialization after a failed open", async () => {
    const storage = create();
    const open = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => { throw new Error("open failed"); });
    await expect(storage.has("key")).rejects.toThrow("open failed");
    open.mockRestore();
    await storage.set("key", 1, metadata());
    expect(await storage.get("key")).toBe(1);
  });

  it("rejects blocked upgrades and retries after the blocking connection closes", async () => {
    const name = `blocked-${++sequence}`;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`cachefn-${name}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("entries", { keyPath: "key" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storage = new IndexedDBStorage({ name, version: 2 });
    try {
      await expect(storage.has("key")).rejects.toThrow("blocked");
    } finally {
      legacy.close();
    }
    await storage.set("key", 1, metadata());
    expect(await storage.get("key")).toBe(1);
  });

  it("serializes concurrent tag mutations without losing updates", async () => {
    const storage = create();
    await storage.set("key", 1, metadata([]));
    await Promise.all(Array.from({ length: 20 }, (_, index) => storage.addTag(`tag-${index}`, "key")));
    expect(await storage.getTagsForKey("key")).toHaveLength(20);
  });
});
