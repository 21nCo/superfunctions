/**
 * DATA-15: live queries re-run at most once per frame, skip merges that
 * cannot change their result set, and limited or counted queries do not sort
 * or materialise the whole table.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";

vi.mock("../src/offline/query.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/offline/query.js")>();
  return { ...original, executeLocalQuery: vi.fn(original.executeLocalQuery) };
});
vi.mock("../src/offline/relations.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/offline/relations.js")>();
  return { ...original, materializeSelect: vi.fn(original.materializeSelect) };
});
vi.mock("@datafn/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@datafn/core")>();
  return { ...original, sortRecords: vi.fn(original.sortRecords) };
});

import { sortRecords } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { executeLocalQuery } from "../src/offline/query.js";
import { materializeSelect } from "../src/offline/relations.js";

const executeSpy = vi.mocked(executeLocalQuery);
const sortSpy = vi.mocked(sortRecords);
const materializeSpy = vi.mocked(materializeSelect);

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      capabilities: ["trash", "archivable"],
      fields: [
        { name: "title", type: "string", required: false },
        { name: "status", type: "string", required: false },
        { name: "body", type: "string", required: false },
      ],
    },
  ],
  relations: [],
};

const clients: Array<{ destroy?: () => Promise<void> | void }> = [];

afterEach(async () => {
  vi.useRealTimers();
  executeSpy.mockClear();
  sortSpy.mockClear();
  materializeSpy.mockClear();
  for (const client of clients.splice(0)) await client.destroy?.();
});

async function setup(count = 4) {
  const storage = new MemoryStorageAdapter(["notes"]);
  for (let i = 0; i < count; i++) {
    await storage.upsertRecord("notes", {
      id: `notes:${String(i).padStart(5, "0")}`,
      title: `Note ${String(i).padStart(5, "0")}`,
      status: i % 2 === 0 ? "open" : "done",
      body: "",
    });
  }
  await storage.setHydrationState("notes", "hydrating");
  await storage.setHydrationState("notes", "ready");
  const client = createDatafnClient({
    schema,
    clientId: "coalesce-client",
    storage,
    sync: { mode: "local-only", offlinability: true },
  });
  clients.push(client as any);
  return { client, storage };
}

function waitForValue<T>(signal: { subscribe(fn: (value: T) => void): () => void }): Promise<T> {
  return new Promise((resolve) => {
    const unsubscribe = signal.subscribe((value) => {
      if (value === undefined) return;
      queueMicrotask(() => unsubscribe());
      resolve(value);
    });
  });
}

function waitForMatch<T>(
  signal: { subscribe(fn: (value: T) => void): () => void },
  matches: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const unsubscribe = signal.subscribe((value) => {
      if (value === undefined || !matches(value)) return;
      queueMicrotask(() => unsubscribe());
      resolve(value);
    });
  });
}

function hasIdProbe(query: Record<string, unknown>): boolean {
  return JSON.stringify(query.filters ?? {}).includes('"id":{"$in"');
}

describe("refresh coalescing", () => {
  it("runs each open query at most once for many mutations in one frame", async () => {
    const { client } = await setup();
    const notes = client.table("notes");
    const signals = [
      notes.signal({}),
      notes.signal({ filters: { status: "open" } }),
      notes.signal({ sort: ["-title"], limit: 2 }),
    ];
    const latest: unknown[][] = signals.map(() => []);
    signals.forEach((signal, index) =>
      signal.subscribe((value: any) => {
        if (value !== undefined) latest[index] = value;
      }),
    );
    await Promise.all(signals.map((signal) => waitForValue(signal as any)));
    executeSpy.mockClear();

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    for (let i = 0; i < 25; i++) {
      await notes.mutate({
        operation: "insert",
        id: `notes:new${i}`,
        record: { title: `Zed ${i}`, status: "open" },
      } as any);
    }
    expect(executeSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executeSpy.mock.calls.length).toBeLessThanOrEqual(signals.length);
    expect(executeSpy.mock.calls.length).toBe(3);
    expect(latest[0]).toHaveLength(29);
    expect(latest[1]).toHaveLength(27);
    expect((latest[2] as any[]).map((r) => r.id)).toEqual(["notes:new9", "notes:new8"]);
  });
});

describe("merge that cannot change the result set", () => {
  it("does not re-run the query; shown records are re-read by id", async () => {
    const { client } = await setup();
    const notes = client.table("notes");
    const signal = notes.signal({ filters: { status: "open" }, sort: ["title"] });
    const values: any[][] = [];
    signal.subscribe((value: any) => {
      if (value !== undefined) values.push(value);
    });
    await waitForValue(signal as any);
    expect(values.at(-1)!.map((r) => r.id)).toEqual(["notes:00000", "notes:00002"]);
    executeSpy.mockClear();

    // An edit to a shown record, on a field the query neither filters nor sorts by.
    await notes.mutate({ operation: "merge", id: "notes:00002", record: { body: "edited" } } as any);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(executeSpy.mock.calls.every(([, , query]) => hasIdProbe(query))).toBe(true);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(values.at(-1)!.find((r) => r.id === "notes:00002")?.body).toBe("edited");

    // An edit to a record outside the result does nothing.
    executeSpy.mockClear();
    await notes.mutate({ operation: "merge", id: "notes:00001", record: { body: "edited" } } as any);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(executeSpy).not.toHaveBeenCalled();

    // A merge on a filtered field re-runs the query.
    await notes.mutate({ operation: "merge", id: "notes:00001", record: { status: "open" } } as any);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(executeSpy.mock.calls.some(([, , query]) => !hasIdProbe(query))).toBe(true);
    expect(values.at(-1)!.map((r) => r.id)).toEqual(["notes:00000", "notes:00001", "notes:00002"]);

    // A merge that creates a record re-runs the query.
    executeSpy.mockClear();
    await notes.mutate({ operation: "merge", id: "notes:created", record: { title: "A", status: "open" } } as any);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(executeSpy.mock.calls.some(([, , query]) => !hasIdProbe(query))).toBe(true);
    expect(values.at(-1)!.map((r) => r.id)[0]).toBe("notes:created");
  });

  it("re-runs when the merge trashes a shown record", async () => {
    const { client } = await setup();
    const notes = client.table("notes");
    const signal = notes.signal({});
    const values: any[][] = [];
    signal.subscribe((value: any) => {
      if (value !== undefined) values.push(value);
    });
    await waitForValue(signal as any);
    await notes.mutate({ operation: "trash", id: "notes:00001" } as any);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(values.at(-1)!.map((r) => r.id)).not.toContain("notes:00001");
  });
});

describe("limited and counted queries over a large table", () => {
  it("a limit: 1 sorted query does not sort the whole table", async () => {
    const { client } = await setup(2_000);
    sortSpy.mockClear();
    const result = await client.table("notes").query({ sort: ["-title"], limit: 1 });
    expect(result.data.map((r: any) => r.id)).toEqual(["notes:01999"]);
    const sortedSizes = sortSpy.mock.calls.map(([records]) => records.length);
    expect(sortedSizes.every((size) => size <= 1)).toBe(true);
  });

  it("matches a full sort for offset and limit windows", async () => {
    const { client } = await setup(300);
    const notes = client.table("notes");
    const page = await notes.query({ sort: ["status", "-title"], offset: 20, limit: 15 });
    const all = await notes.query({ sort: ["status", "-title"] });
    expect(page.data.map((r: any) => r.id)).toEqual(all.data.slice(20, 35).map((r: any) => r.id));
  });

  // Applying the default trash and archive filters reads each record once
  // from storage; what a count must not do is materialise (select and
  // expand) or sort them.
  it("counts 35,000 records without materialising or sorting them", async () => {
    const { client, storage } = await setup(35_000);
    await storage.upsertRecord("notes", { id: "notes:trashed", title: "x", trashedAt: 1 });
    sortSpy.mockClear();
    materializeSpy.mockClear();
    const listSpy = vi.spyOn(storage, "listRecords");

    const counts = await waitForMatch<Record<string, number>>(
      client.resourceCountsSignal({ resources: ["notes"] }) as any,
      (value) => value.notes > 0,
    );
    expect(counts).toEqual({ notes: 35_000 });

    const counted = await client.table("notes").query({
      count: true,
      filters: { status: "open" },
      limit: 1,
    } as any);
    expect((counted as any).count).toBe(17_500);

    const materialised = materializeSpy.mock.calls.map(([, , , records]) => records.length);
    expect(Math.max(0, ...materialised)).toBeLessThanOrEqual(1);
    const sortedSizes = sortSpy.mock.calls.map(([records]) => records.length);
    expect(Math.max(0, ...sortedSizes)).toBeLessThanOrEqual(1);
    // One storage read per count, none for timezone data.
    expect(listSpy.mock.calls.map(([resource]) => resource)).toEqual(["notes", "notes"]);
  }, 60_000);
});

describe("merge skipping with query plugins and relation selects", () => {
  it("re-runs when a merge touches a filter that a plugin adds", async () => {
    const hookCalls: any[] = [];
    const storage = new MemoryStorageAdapter(["notes"]);
    for (const [id, status] of [["notes:a", "open"], ["notes:b", "done"], ["notes:c", "open"]]) {
      await storage.upsertRecord("notes", { id, title: id, status, body: "" });
    }
    await storage.setHydrationState("notes", "hydrating");
    await storage.setHydrationState("notes", "ready");
    const client = createDatafnClient({
      schema,
      clientId: "plugin-client",
      storage,
      sync: { mode: "local-only", offlinability: true },
      plugins: [
        {
          name: "open-only",
          runsOn: ["client"],
          beforeQuery(_ctx: unknown, q: any) {
            hookCalls.push(q);
            if (Array.isArray(q) || q.resource !== "notes") return q;
            const filters = q.filters
              ? { $and: [q.filters, { status: "open" }] }
              : { status: "open" };
            return { ...q, filters };
          },
        },
      ],
    });
    clients.push(client as any);
    const notes = client.table("notes");
    const signal = notes.signal({ sort: ["title"], limit: 10 });
    const values: any[][] = [];
    signal.subscribe((value: any) => {
      if (value !== undefined) values.push(value);
    });
    await waitForValue(signal as any);
    expect(values.at(-1)!.map((r) => r.id)).toEqual(["notes:a", "notes:c"]);
    // The plugin runs once per read; the signal reuses the query it produced.
    expect(hookCalls).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A field neither the query nor the plugin reads still skips the re-run.
    executeSpy.mockClear();
    await notes.mutate({ operation: "merge", id: "notes:b", record: { body: "x" } } as any);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(executeSpy).not.toHaveBeenCalled();

    await notes.mutate({ operation: "merge", id: "notes:b", record: { status: "open" } } as any);
    await vi.waitFor(() =>
      expect(values.at(-1)!.map((r) => r.id)).toEqual(["notes:a", "notes:b", "notes:c"]),
    );
  });

  it("re-runs a query that selects a bare relation when another record of the resource changes", async () => {
    const treeSchema: DatafnSchema = {
      resources: [
        {
          name: "folders",
          version: 1,
          fields: [
            { name: "name", type: "string", required: false },
            { name: "sortOrder", type: "number", required: false },
            { name: "parentId", type: "string", required: false },
          ],
        },
      ],
      relations: [
        {
          from: "folders",
          to: "folders",
          type: "htree",
          relation: "children",
          inverse: "parent",
          fkField: "parentId",
        } as any,
      ],
    };
    const storage = new MemoryStorageAdapter(["folders"]);
    await storage.upsertRecord("folders", { id: "folders:root", name: "root", sortOrder: 0 });
    await storage.upsertRecord("folders", { id: "folders:a", name: "a", sortOrder: 1, parentId: "folders:root" });
    await storage.upsertRecord("folders", { id: "folders:b", name: "b", sortOrder: 2, parentId: "folders:root" });
    await storage.setHydrationState("folders", "hydrating");
    await storage.setHydrationState("folders", "ready");
    const client = createDatafnClient({
      schema: treeSchema,
      clientId: "tree-client",
      storage,
      sync: { mode: "local-only", offlinability: true },
    });
    clients.push(client as any);
    const folders = client.table("folders");
    const signal = folders.signal({ filters: { id: "folders:root" }, select: ["id", "children"] });
    await waitForValue(signal as any);
    executeSpy.mockClear();

    await folders.mutate({ operation: "merge", id: "folders:a", record: { sortOrder: 5 } } as any);
    await vi.waitFor(() =>
      expect(executeSpy.mock.calls.some(([, , query]) => !hasIdProbe(query))).toBe(true),
    );
  });
});

describe("merge creation reported by the storage write", () => {
  it("marks a merge as created when a delete lands just before its write", async () => {
    const { client, storage } = await setup(1);
    const events: any[] = [];
    client.subscribe((event: any) => {
      if (event.type === "mutation_applied" && event.action === "merge") events.push(event);
    });
    // Delete the record between any earlier read and the merge's atomic write.
    const merge = storage.mergeRecord.bind(storage);
    storage.mergeRecord = (async (resource: string, id: string, partial: any, options: any) => {
      await storage.deleteRecord(resource, id);
      return merge(resource, id, partial, options);
    }) as typeof storage.mergeRecord;

    await client.table("notes").mutate({
      operation: "merge",
      id: "notes:00000",
      record: { body: "edited" },
    } as any);
    expect(events.at(-1)?.created).toBe(true);
  });

  it("leaves created unknown when the adapter does not report it, and refreshes", async () => {
    const { client, storage } = await setup(2);
    const merge = storage.mergeRecord.bind(storage);
    storage.mergeRecord = (async (resource: string, id: string, partial: any, options: any) =>
      merge(resource, id, partial, { ifMissing: options?.ifMissing })) as typeof storage.mergeRecord;
    const events: any[] = [];
    client.subscribe((event: any) => {
      if (event.type === "mutation_applied" && event.action === "merge") events.push(event);
    });
    const notes = client.table("notes");
    const signal = notes.signal({ limit: 10 });
    await waitForValue(signal as any);
    executeSpy.mockClear();

    await notes.mutate({ operation: "merge", id: "notes:new", record: { body: "x" } } as any);
    expect(events.at(-1)?.created).toBeUndefined();
    await vi.waitFor(() =>
      expect(executeSpy.mock.calls.some(([, , query]) => !hasIdProbe(query))).toBe(true),
    );
  });
});

describe("merge outcome scoping", () => {
  it("keeps outcomes of clients with their own stores apart when they reuse a mutation id", async () => {
    const a = await setup(1);
    const b = await setup(2);
    const created: Record<string, unknown> = {};
    a.client.subscribe((event: any) => {
      if (event.type === "mutation_applied" && event.action === "merge") created.a = event.created;
    });
    b.client.subscribe((event: any) => {
      if (event.type === "mutation_applied" && event.action === "merge") created.b = event.created;
    });
    // notes:00001 is missing in A's store and present in B's.
    await Promise.all([
      a.client.table("notes").mutate({
        operation: "merge",
        id: "notes:00001",
        mutationId: "m1",
        record: { body: "a" },
      } as any),
      b.client.table("notes").mutate({
        operation: "merge",
        id: "notes:00001",
        mutationId: "m1",
        record: { body: "b" },
      } as any),
    ]);
    expect(created).toEqual({ a: true, b: false });
  });

  it("passes no callback to an adapter that does not report merge outcomes", async () => {
    const { client, storage } = await setup(1);
    (storage as any).capabilities = { atomicMergeIfMissing: true };
    const seen: unknown[] = [];
    const merge = storage.mergeRecord.bind(storage);
    storage.mergeRecord = (async (resource: string, id: string, partial: any, options: any) => {
      seen.push(options);
      return merge(resource, id, partial, options);
    }) as typeof storage.mergeRecord;

    await client.table("notes").mutate({
      operation: "merge",
      id: "notes:00000",
      record: { body: "x" },
    } as any);
    const options = seen.find((entry: any) => entry && "ifMissing" in entry) as Record<string, unknown>;
    expect(options).toBeDefined();
    expect(Object.values(options).some((value) => typeof value === "function")).toBe(false);
  });
});
