/**
 * DATA-15: local lookups by id and by indexed field read only the records
 * they need, even after the client wraps the caller's filter in the default
 * trashed, archived and inactive-ancestor filters.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { IndexedDbStorageAdapter } from "../src/adapters/indexedDbStorage.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import type { DatafnStorageAdapter } from "../src/storage.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "folders",
      version: 1,
      capabilities: ["trash", "archivable"],
      fields: [{ name: "name", type: "string", required: false }],
    },
    {
      name: "notes",
      version: 1,
      capabilities: ["trash", "archivable"],
      fields: [
        { name: "title", type: "string", required: false },
        { name: "folderId", type: "string", required: false, nullable: true },
        { name: "status", type: "string", required: false },
      ],
      indices: { base: ["status"] },
    },
  ],
  relations: [
    {
      from: "notes",
      to: "folders",
      type: "many-one",
      relation: "folder",
      inverse: "notes",
      fkField: "folderId",
      inheritsInactive: true,
    },
  ],
};

const clients: Array<{ destroy?: () => Promise<void> | void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.destroy?.();
});

async function markReady(storage: DatafnStorageAdapter, resources: string[]) {
  for (const resource of resources) {
    await storage.setHydrationState(resource, "hydrating");
    await storage.setHydrationState(resource, "ready");
  }
}

function makeClient(storage: DatafnStorageAdapter) {
  const client = createDatafnClient({
    schema,
    sync: { remote: "http://example.com" },
    clientId: "fast-path-client",
    storage,
  });
  clients.push(client as any);
  return client;
}

async function seedIndexedDb() {
  const dbName = `data15_${Math.random().toString(36).slice(2, 10)}`;
  const storage = IndexedDbStorageAdapter.create({ dbName, schema });
  await storage.upsertRecord("folders", { id: "folders:1", name: "Inbox" });
  await storage.upsertRecord("notes", { id: "notes:a", title: "A", folderId: "folders:1", status: "open" });
  await storage.upsertRecord("notes", { id: "notes:b", title: "B", folderId: "folders:1", status: "done" });
  await storage.upsertRecord("notes", { id: "notes:c", title: "C", status: "open", isArchived: true });
  await storage.upsertRecord("notes", { id: "notes:t", title: "Trashed", status: "open", trashedAt: 10 });
  await markReady(storage, ["folders", "notes"]);
  return storage;
}

describe("id lookups with default filters (IndexedDB)", () => {
  it("select(id) and every id filter form read records directly, never listRecords", async () => {
    const storage = await seedIndexedDb();
    const client = makeClient(storage);
    const listRecords = vi.spyOn(storage, "listRecords");
    const getRecord = vi.spyOn(storage, "getRecord");

    expect(await client.table("notes").select("notes:a")).toMatchObject({ id: "notes:a", title: "A" });

    const plain = await client.table("notes").query({ filters: { id: "notes:b" } });
    expect(plain.data.map((r: any) => r.id)).toEqual(["notes:b"]);

    const eq = await client.table("notes").query({ filters: { id: { $eq: "notes:a" } } });
    expect(eq.data.map((r: any) => r.id)).toEqual(["notes:a"]);

    const eqAlias = await client.table("notes").query({ filters: { id: { eq: "notes:a" } } } as any);
    expect(eqAlias.data.map((r: any) => r.id)).toEqual(["notes:a"]);

    const inIds = await client.table("notes").query({
      filters: { id: { $in: ["notes:b", "notes:a", "notes:missing"] } },
    });
    expect(inIds.data.map((r: any) => r.id)).toEqual(["notes:a", "notes:b"]);

    const selected = await client.table("notes").query({
      select: ["id", "title", "folder.*"],
      filters: { id: "notes:a" },
    });
    expect(selected.data[0]).toMatchObject({ id: "notes:a", folder: { id: "folders:1" } });

    expect(listRecords).not.toHaveBeenCalledWith("notes");
    expect(listRecords).not.toHaveBeenCalled();
    expect(getRecord).toHaveBeenCalledWith("notes", "notes:a");
  });

  it("keeps hiding trashed and archived records unless the caller includes them", async () => {
    const storage = await seedIndexedDb();
    const client = makeClient(storage);
    const listRecords = vi.spyOn(storage, "listRecords");

    expect(await client.table("notes").select("notes:t")).toBeUndefined();
    expect(
      await client.table("notes").select("notes:t", { metadata: { includeTrashed: true } } as any),
    ).toMatchObject({ id: "notes:t" });

    expect(await client.table("notes").select("notes:c")).toBeUndefined();
    const archived = await client.table("notes").query({
      filters: { id: { $in: ["notes:c", "notes:a"] } },
      metadata: { includeArchived: true },
    } as any);
    expect(archived.data.map((r: any) => r.id)).toEqual(["notes:a", "notes:c"]);

    const trashedById = await client.table("notes").query({ filters: { id: { $eq: "notes:t" } } });
    expect(trashedById.data).toEqual([]);

    expect(listRecords).not.toHaveBeenCalled();
  });

  it("hides a record whose ancestor is inactive on the id path", async () => {
    const storage = await seedIndexedDb();
    await storage.upsertRecord("notes", { id: "notes:i", title: "I", isAncestorInactive: true });
    const client = makeClient(storage);
    const listRecords = vi.spyOn(storage, "listRecords");

    expect(await client.table("notes").select("notes:i")).toBeUndefined();
    expect(
      await client.table("notes").select("notes:i", { metadata: { includeAncestorInactive: true } } as any),
    ).toMatchObject({ id: "notes:i" });
    expect(listRecords).not.toHaveBeenCalled();
  });

  it("uses findRecords for an indexed equality inside the injected $and", async () => {
    const storage = await seedIndexedDb();
    const client = makeClient(storage);
    const listRecords = vi.spyOn(storage, "listRecords");
    const findRecords = vi.spyOn(storage, "findRecords");

    const byFolder = await client.table("notes").query({ filters: { folderId: "folders:1" } });
    expect(byFolder.data.map((r: any) => r.id)).toEqual(["notes:a", "notes:b"]);
    expect(findRecords).toHaveBeenLastCalledWith("notes", "folderId", "folders:1");

    const byStatus = await client.table("notes").query({
      filters: { $and: [{ status: { $eq: "open" } }, { title: { $ne: "zzz" } }] },
      sort: ["-title"],
    });
    expect(byStatus.data.map((r: any) => r.id)).toEqual(["notes:a"]);
    expect(findRecords).toHaveBeenLastCalledWith("notes", "status", "open");

    expect(listRecords).not.toHaveBeenCalled();
  });

  it("still scans when no condition can use an index", async () => {
    const storage = await seedIndexedDb();
    const client = makeClient(storage);
    const listRecords = vi.spyOn(storage, "listRecords");

    const byTitle = await client.table("notes").query({ filters: { title: "B" } });
    expect(byTitle.data.map((r: any) => r.id)).toEqual(["notes:b"]);
    const either = await client.table("notes").query({
      filters: { $or: [{ id: "notes:a" }, { id: "notes:b" }] },
    });
    expect(either.data.map((r: any) => r.id)).toEqual(["notes:a", "notes:b"]);
    expect(listRecords).toHaveBeenCalledWith("notes");
  });

  it("does not read the timezone registry for a query without temporal clauses", async () => {
    const storage = await seedIndexedDb();
    const client = makeClient(storage);
    const listRecords = vi.spyOn(storage, "listRecords");
    await client.table("notes").query({ sort: ["title"], limit: 2 });
    expect(listRecords.mock.calls.map((call) => call[0])).toEqual(["notes"]);
  });
});

describe("id lookup at 35,000 records", () => {
  it("finds a record by id in under 10 ms", async () => {
    const storage = new MemoryStorageAdapter(["folders", "notes"]);
    for (let i = 0; i < 35_000; i++) {
      await storage.upsertRecord("notes", {
        id: `notes:${String(i).padStart(6, "0")}`,
        title: `Note ${i}`,
        status: i % 2 === 0 ? "open" : "done",
      });
    }
    await markReady(storage, ["folders", "notes"]);
    const client = makeClient(storage);
    const notes = client.table("notes");

    // Warm up module and schema caches.
    await notes.select("notes:000001");

    const timings: Record<string, number> = {};
    const measure = async (name: string, run: () => Promise<unknown>) => {
      const runs = 20;
      const start = performance.now();
      for (let i = 0; i < runs; i++) await run();
      timings[name] = (performance.now() - start) / runs;
    };
    await measure("select", () => notes.select("notes:017500"));
    await measure("query id", () => notes.query({ filters: { id: "notes:034999" } }));
    await measure("query id $in", () =>
      notes.query({ filters: { id: { $in: ["notes:000100", "notes:020000"] } } }),
    );
    console.info("[DATA-15] id lookup over 35,000 records (ms per lookup):", timings);

    expect(await notes.select("notes:017500")).toMatchObject({ title: "Note 17500" });
    for (const value of Object.values(timings)) expect(value).toBeLessThan(10);
  }, 60_000);
});
