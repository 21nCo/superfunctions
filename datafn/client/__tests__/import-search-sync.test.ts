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

  it("clears the index marker when indexing the import fails, so the next client rebuilds", async () => {
    const storage = await readyStorage();
    const provider = createPersistentProvider();
    const first = localClient(storage, provider);
    expect(await searchIds(first, "shopping")).toEqual(["notes:old"]);

    provider.updateIndices.mockRejectedValueOnce(new Error("index unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await first.importData(payload)).ok).toBe(true);
    warn.mockRestore();

    // The same client rebuilds on its next search.
    expect(await searchIds(first, "restored")).toEqual(["notes:r1", "notes:r2"]);

    await first.destroy();
    clients.splice(clients.indexOf(first as any), 1);
    const second = localClient(storage, provider);
    expect(await searchIds(second, "restored")).toEqual(["notes:r1", "notes:r2"]);
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
