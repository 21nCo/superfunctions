/**
 * DATA-15: importData leaves the store searchable and live, and reports a
 * rejected push instead of discarding it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { DefaultHttpTransport } from "../src/transport/http.js";
import type { DatafnExportPayload } from "../src/export.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      fields: [{ name: "title", type: "string", required: true }],
      indices: { search: ["title"] },
    },
  ],
  relations: [],
};

const payload: DatafnExportPayload = {
  version: 1,
  exportedAt: new Date(0).toISOString(),
  schema: [{ name: "notes", version: 1 }],
  resources: {
    notes: [
      { id: "notes:r1", title: "Restored meeting notes" },
      { id: "notes:r2", title: "Restored travel plan" },
    ],
  },
};

/**
 * A search provider whose documents persist across client instances, like
 * the IndexedDB-backed providers apps use.
 */
function createPersistentProvider(documents = new Map<string, Map<string, string>>()) {
  const docsFor = (resource: string) => {
    let docs = documents.get(resource);
    if (!docs) {
      docs = new Map();
      documents.set(resource, docs);
    }
    return docs;
  };
  const provider = {
    name: "persistent-test-provider",
    documents,
    updateIndices: vi.fn(async (params: {
      resource: string;
      records: Record<string, unknown>[];
      operation: "upsert" | "delete";
    }) => {
      const docs = docsFor(params.resource);
      for (const record of params.records) {
        if (params.operation === "delete") docs.delete(String(record.id));
        else docs.set(String(record.id), String(record.title ?? "").toLowerCase());
      }
    }),
    clearIndices: vi.fn(async (resource: string) => {
      docsFor(resource).clear();
    }),
    search: vi.fn(async (params: { resource: string; query: string }) =>
      [...docsFor(params.resource)]
        .filter(([, text]) => text.includes(params.query.toLowerCase()))
        .map(([id]) => id),
    ),
    searchAll: vi.fn(async (params: { query: string; resources?: string[] }) => {
      const out: Array<{ resource: string; id: string; score: number }> = [];
      for (const resource of params.resources ?? [...documents.keys()]) {
        for (const [id, text] of docsFor(resource)) {
          if (text.includes(params.query.toLowerCase())) out.push({ resource, id, score: 1 });
        }
      }
      return out;
    }),
  };
  return provider;
}

const clients: Array<{ destroy?: () => Promise<void> | void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) await client.destroy?.();
});

async function readyStorage() {
  const storage = new MemoryStorageAdapter(["notes"]);
  await storage.upsertRecord("notes", { id: "notes:old", title: "Old shopping list" });
  await storage.setHydrationState("notes", "hydrating");
  await storage.setHydrationState("notes", "ready");
  return storage;
}

function localClient(storage: MemoryStorageAdapter, searchProvider: ReturnType<typeof createPersistentProvider>) {
  const client = createDatafnClient({
    schema,
    clientId: "import-client",
    storage,
    searchProvider: searchProvider as any,
    sync: { mode: "local-only", offlinability: true },
  });
  clients.push(client as any);
  return client;
}

async function searchIds(client: ReturnType<typeof localClient>, query: string) {
  const result = (await client.search({ query, resources: ["notes"], source: "local" })) as any;
  const rows = Array.isArray(result) ? result : result.results ?? result.data ?? [];
  return rows.map((row: any) => row.id).sort();
}

describe("importData and search", () => {
  it("finds imported records immediately and after the client is re-created", async () => {
    const storage = await readyStorage();
    const provider = createPersistentProvider();
    const first = localClient(storage, provider);

    // The first search builds the index and marks it current.
    expect(await searchIds(first, "shopping")).toEqual(["notes:old"]);

    const result = await first.importData(payload);
    expect(result.ok).toBe(true);
    expect(await searchIds(first, "restored")).toEqual(["notes:r1", "notes:r2"]);

    // A new client trusts the index marker and does not rebuild.
    await first.destroy();
    clients.splice(clients.indexOf(first as any), 1);
    provider.clearIndices.mockClear();
    const second = localClient(storage, provider);
    expect(await searchIds(second, "restored")).toEqual(["notes:r1", "notes:r2"]);
    expect(provider.clearIndices).not.toHaveBeenCalled();
  });

  it("rebuilds in the same client when indexing the import fails", async () => {
    const storage = await readyStorage();
    const provider = createPersistentProvider();
    const first = localClient(storage, provider);
    expect(await searchIds(first, "shopping")).toEqual(["notes:old"]);

    provider.updateIndices.mockRejectedValueOnce(new Error("index unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await first.importData(payload)).ok).toBe(true);
    warn.mockRestore();

    provider.clearIndices.mockClear();
    expect(await searchIds(first, "restored")).toEqual(["notes:r1", "notes:r2"]);
    expect(provider.clearIndices).toHaveBeenCalledWith("notes");
  });

  it("clears the index marker when indexing the import fails, so the next client rebuilds", async () => {
    const storage = await readyStorage();
    const provider = createPersistentProvider();
    const first = localClient(storage, provider);
    expect(await searchIds(first, "shopping")).toEqual(["notes:old"]);

    provider.updateIndices.mockRejectedValueOnce(new Error("index unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await first.importData(payload)).ok).toBe(true);
    warn.mockRestore();
    // The provider holds none of the imported documents.
    expect(provider.documents.get("notes")?.has("notes:r1")).toBe(false);

    await first.destroy();
    clients.splice(clients.indexOf(first as any), 1);
    provider.clearIndices.mockClear();
    const second = localClient(storage, provider);
    expect(await searchIds(second, "restored")).toEqual(["notes:r1", "notes:r2"]);
    expect(provider.clearIndices).toHaveBeenCalledWith("notes");
  });

  it("indexes an import after a rebuild that read storage before it", async () => {
    const storage = await readyStorage();
    const provider = createPersistentProvider();
    // The rebuild's upsert waits until the import has run.
    let releaseRebuild!: () => void;
    const rebuildGate = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    const upsert = provider.updateIndices.getMockImplementation()!;
    provider.updateIndices.mockImplementationOnce(async (params) => {
      await rebuildGate;
      return upsert(params);
    });
    const client = localClient(storage, provider);

    const searching = searchIds(client, "shopping");
    await vi.waitFor(() => expect(provider.updateIndices).toHaveBeenCalledTimes(1));

    // The import replaces the record the rebuild already read.
    const importing = client.importData({
      ...payload,
      resources: { notes: [{ id: "notes:old", title: "Restored shopping list" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseRebuild();
    await searching;
    expect((await importing).ok).toBe(true);

    expect(provider.documents.get("notes")?.get("notes:old")).toBe("restored shopping list");
    expect(await searchIds(client, "restored")).toEqual(["notes:old"]);
  });
});

describe("importData and live queries", () => {
  it("an open live query emits the imported rows", async () => {
    const storage = await readyStorage();
    const client = localClient(storage, createPersistentProvider());
    const signal = client.table("notes").signal({ sort: ["title"] });
    const values: any[][] = [];
    signal.subscribe((value: any) => {
      if (value !== undefined) values.push(value);
    });
    await vi.waitFor(() => expect(values.length).toBeGreaterThan(0));
    expect(values.at(-1)!.map((r) => r.id)).toEqual(["notes:old"]);

    await client.importData(payload);
    await vi.waitFor(() =>
      expect(values.at(-1)!.map((r) => r.id)).toEqual(["notes:old", "notes:r1", "notes:r2"]),
    );
  });

  it("announces the imported records as local writes, not as a sync", async () => {
    const storage = await readyStorage();
    const client = localClient(storage, createPersistentProvider());
    const events: any[] = [];
    client.subscribe((event: any) => events.push(event));
    const before = client.sync.statusSignal().get();

    await client.importData(payload);

    expect(events.filter((event) => event.type === "sync_applied")).toEqual([]);
    const applied = events.filter((event) => event.type === "mutation_applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      resource: "notes",
      action: "replace",
      ids: ["notes:r1", "notes:r2"],
      context: { source: "import" },
    });
    const after = client.sync.statusSignal().get();
    expect(after.lastSyncAt).toBe(before.lastSyncAt);
    expect(after.lastError).toBe(before.lastError);
  });
});

describe("importData with cloneUp", () => {
  it("resolves ok: false with the push errors when the server rejects the push", async () => {
    const storage = await readyStorage();
    const push = vi.spyOn(DefaultHttpTransport.prototype, "push").mockResolvedValue({
      ok: false,
      error: {
        code: "DFQL_INVALID",
        message: "Unknown field: legacy",
        details: { path: "mutations[0].record.legacy" },
      },
    } as any);
    const client = createDatafnClient({
      schema,
      clientId: "import-push-client",
      storage,
      sync: { remote: "http://example.com", offlinability: true },
    });
    clients.push(client as any);

    const result = await client.importData(payload, { triggerCloneUp: true });
    expect(push).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "DFQL_INVALID", message: "Unknown field: legacy" }),
    ]);
    // Local writes stay in place.
    expect(result.stats.resources.notes).toEqual({ imported: 2, skipped: 0 });
    expect(await storage.getRecord("notes", "notes:r1")).toMatchObject({ title: "Restored meeting notes" });
  });

  it("names the rejected record when the server returns per-mutation errors", async () => {
    const storage = await readyStorage();
    vi.spyOn(DefaultHttpTransport.prototype, "push").mockImplementation((async (body: {
      mutations: Array<{ mutationId: string }>;
    }) => ({
      ok: true,
      result: {
        ok: false,
        errors: [
          {
            mutationId: body.mutations[0].mutationId,
            code: "FK_VIOLATION",
            message: "parent missing",
            path: "$",
          },
        ],
      },
    })) as any);
    const client = createDatafnClient({
      schema,
      clientId: "import-push-client-2",
      storage,
      sync: { remote: "http://example.com", offlinability: true },
    });
    clients.push(client as any);

    const result = await client.importData(payload, { triggerCloneUp: true });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { resource: "notes", id: "notes:old", code: "FK_VIOLATION", message: "parent missing" },
    ]);
  });
});

describe("importData edge cases", () => {
  it("does not overwrite an edit made while the import waited for a rebuild", async () => {
    const storage = await readyStorage();
    const provider = createPersistentProvider();
    let releaseRebuild!: () => void;
    const rebuildGate = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    const upsert = provider.updateIndices.getMockImplementation()!;
    provider.updateIndices.mockImplementationOnce(async (params) => {
      await rebuildGate;
      return upsert(params);
    });
    const client = localClient(storage, provider);

    const searching = searchIds(client, "shopping");
    await vi.waitFor(() => expect(provider.updateIndices).toHaveBeenCalledTimes(1));
    const importing = client.importData({
      ...payload,
      resources: { notes: [{ id: "notes:new", title: "Imported" }] },
    });
    await vi.waitFor(async () => expect(await storage.getRecord("notes", "notes:new")).toBeTruthy());
    // The edit indexes itself once the rebuild has settled.
    const editing = client.table("notes").mutate({
      operation: "merge",
      id: "notes:new",
      record: { title: "Newest" },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseRebuild();
    await Promise.all([searching, importing, editing]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await storage.getRecord("notes", "notes:new")).toMatchObject({ title: "Newest" });
    expect(provider.documents.get("notes")?.get("notes:new")).toBe("newest");
  });

  it("indexes the import only after the search provider has initialised", async () => {
    const storage = await readyStorage();
    let releaseInit!: () => void;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const provider = Object.assign(createPersistentProvider(), {
      initialize: vi.fn(() => initGate),
    });
    const client = localClient(storage, provider);

    const importing = client.importData(payload);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(provider.updateIndices).not.toHaveBeenCalled();
    releaseInit();
    expect((await importing).ok).toBe(true);
    expect(provider.updateIndices).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "notes", operation: "upsert" }),
    );
  });

  it("resolves ok: false when cloneUp throws", async () => {
    const storage = await readyStorage();
    vi.spyOn(DefaultHttpTransport.prototype, "push").mockRejectedValue(
      Object.assign(new Error("server unreachable"), { code: "PUSH_FAILED" }),
    );
    const client = createDatafnClient({
      schema,
      clientId: "import-throw-client",
      storage,
      sync: { remote: "http://example.com", offlinability: true },
    });
    clients.push(client as any);

    const result = await client.importData(payload, { triggerCloneUp: true });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: "PUSH_FAILED", message: "server unreachable" }),
    ]);
    expect(result.stats.resources.notes).toEqual({ imported: 2, skipped: 0 });
    expect(await storage.getRecord("notes", "notes:r2")).toMatchObject({ title: "Restored travel plan" });
  });

  it("refreshes live queries over both ends of an import that only has join rows", async () => {
    const joinSchema: DatafnSchema = {
      resources: [
        { name: "notes", version: 1, fields: [{ name: "title", type: "string", required: true }] },
        { name: "tags", version: 1, fields: [{ name: "label", type: "string", required: true }] },
      ],
      relations: [{ from: "notes", to: "tags", type: "many-many", relation: "tags", inverse: "notes" }],
    };
    const storage = new MemoryStorageAdapter(["notes", "tags"]);
    await storage.upsertRecord("notes", { id: "notes:1", title: "One" });
    await storage.upsertRecord("tags", { id: "tags:1", label: "Work" });
    for (const resource of ["notes", "tags"]) {
      await storage.setHydrationState(resource, "hydrating");
      await storage.setHydrationState(resource, "ready");
    }
    const client = createDatafnClient({
      schema: joinSchema,
      clientId: "import-join-client",
      storage,
      sync: { mode: "local-only", offlinability: true },
    });
    clients.push(client as any);
    const events: any[] = [];
    client.subscribe((event: any) => events.push(event));

    const signal = client.table("notes").signal({ select: ["id", "tags.*"] });
    const values: any[][] = [];
    signal.subscribe((value: any) => {
      if (value !== undefined) values.push(value);
    });
    await vi.waitFor(() => expect(values.length).toBeGreaterThan(0));
    expect(values.at(-1)![0].tags ?? []).toEqual([]);

    const result = await client.importData({
      version: 1,
      exportedAt: new Date(0).toISOString(),
      schema: [],
      resources: {},
      joins: { join_notes_tags_tags: [{ from: "notes:1", to: "tags:1" }] },
    });
    expect(result.ok).toBe(true);

    const applied = events.filter((event) => event.type === "mutation_applied");
    expect(applied.map((event) => [event.resource, event.action, event.ids])).toEqual([
      ["notes", "relate", ["notes:1"]],
      ["tags", "relate", ["tags:1"]],
    ]);
    await vi.waitFor(() =>
      expect((values.at(-1)![0].tags ?? []).map((tag: any) => tag.id)).toEqual(["tags:1"]),
    );
  });
});
