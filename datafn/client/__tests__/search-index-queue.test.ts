/**
 * DATA-15: search index updates for one provider and resource run one at a
 * time, in the order they were queued, and a failure does not block the rest.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { indexStoredRecords, runSearchIndexUpdate } from "../src/searchIndexQueue.js";

describe("runSearchIndexUpdate", () => {
  it("runs updates for a resource in order and resources independently", async () => {
    const provider = {};
    const log: string[] = [];
    let releaseFirst!: () => void;
    const first = runSearchIndexUpdate(provider, "notes", async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      log.push("notes 1");
    });
    const second = runSearchIndexUpdate(provider, "notes", async () => {
      log.push("notes 2");
    });
    const other = runSearchIndexUpdate(provider, "tags", async () => {
      log.push("tags");
    });
    await other;
    expect(log).toEqual(["tags"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(log).toEqual(["tags", "notes 1", "notes 2"]);
  });

  it("keeps running queued updates after one fails", async () => {
    const provider = {};
    const failed = runSearchIndexUpdate(provider, "notes", async () => {
      throw new Error("index unavailable");
    });
    const next = runSearchIndexUpdate(provider, "notes", async () => "done");
    await expect(failed).rejects.toThrow("index unavailable");
    await expect(next).resolves.toBe("done");
  });
});

describe("indexStoredRecords", () => {
  const provider = () => ({ updateIndices: vi.fn(async (_params: any) => {}) });

  it("indexes what storage holds when its turn comes, and removes deleted ids", async () => {
    const storage = new MemoryStorageAdapter(["notes"]);
    await storage.upsertRecord("notes", { id: "notes:1", title: "Server copy" });
    const search = provider();
    let release!: () => void;
    const held = runSearchIndexUpdate(search, "notes", () => new Promise<void>((resolve) => (release = resolve)));
    const indexing = indexStoredRecords(search, storage, "notes", ["notes:1", "notes:gone"]);
    // A newer local write lands before the queued update runs.
    await storage.upsertRecord("notes", { id: "notes:1", title: "Local edit" });
    release();
    await Promise.all([held, indexing]);
    expect(search.updateIndices.mock.calls.map(([params]) => params)).toEqual([
      { resource: "notes", records: [{ id: "notes:1", title: "Local edit" }], operation: "upsert" },
      { resource: "notes", records: [{ id: "notes:gone" }], operation: "delete" },
    ]);
  });

  it("reads by id when the ids are a small part of the resource", async () => {
    const storage = new MemoryStorageAdapter(["notes"]);
    for (let i = 0; i < 2_000; i++) await storage.upsertRecord("notes", { id: `notes:${i}`, title: `${i}` });
    const listSpy = vi.spyOn(storage, "listRecords");
    const ids = Array.from({ length: 300 }, (_, i) => `notes:${i}`);
    const search = provider();
    await indexStoredRecords(search, storage, "notes", ids);
    expect(listSpy).not.toHaveBeenCalled();
    expect(search.updateIndices.mock.calls[0][0].records).toHaveLength(300);
  });

  it("re-indexes a pulled deletion whose record a later write recreated", async () => {
    const storage = new MemoryStorageAdapter(["notes"]);
    const search = provider();
    let release!: () => void;
    const held = runSearchIndexUpdate(search, "notes", () => new Promise<void>((resolve) => (release = resolve)));
    // The pull deleted notes:1 and queued its index update; an import then recreates it.
    const deleting = indexStoredRecords(search, storage, "notes", ["notes:1"]);
    await storage.upsertRecord("notes", { id: "notes:1", title: "Restored" });
    release();
    await Promise.all([held, deleting]);
    expect(search.updateIndices.mock.calls.map(([params]) => params)).toEqual([
      { resource: "notes", records: [{ id: "notes:1", title: "Restored" }], operation: "upsert" },
    ]);
  });
});

