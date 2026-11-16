/**
 * DATA-17: a live query pinned to record ids (a KV signal reads one key) only
 * re-runs when one of its own records changes. In direct (remote) mode every
 * write to any KV key used to re-fetch every open KV signal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";

vi.mock("../src/offline/query.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/offline/query.js")>();
  return { ...original, executeLocalQuery: vi.fn(original.executeLocalQuery) };
});
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { DefaultHttpTransport } from "../src/transport/http.js";
import { resolvePinnedQueryIds } from "../src/signals/querySignal.js";
import { executeLocalQuery } from "../src/offline/query.js";

const executeSpy = vi.mocked(executeLocalQuery);

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const clients: Array<{ destroy?: () => Promise<void> | void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  executeSpy.mockClear();
  for (const client of clients.splice(0)) await client.destroy?.();
});

function mockRemote(schemaResource = "kv") {
  const queried: string[] = [];
  vi.spyOn(DefaultHttpTransport.prototype, "query").mockImplementation(async (q: any) => {
    const idFilter = q?.filters?.id ?? q?.filters?.$and?.[0]?.id;
    const id = idFilter?.eq ?? idFilter?.$in?.join(",") ?? idFilter;
    if (q?.resource === schemaResource) queried.push(String(id));
    return { ok: true, result: { data: [], nextCursor: null } } as any;
  });
  vi.spyOn(DefaultHttpTransport.prototype, "mutation").mockImplementation(
    async (m: any) =>
      ({
        ok: true,
        result: { ok: true, mutationId: m?.mutationId ?? "m", affectedIds: [], errors: [], deduped: false },
      }) as any,
  );
  return queried;
}

describe("signals pinned to ids (direct mode)", () => {
  it("a KV signal re-fetches only for writes to its own key", async () => {
    const queriedKeys = mockRemote();
    const client = createDatafnClient({
      schema: {
        resources: [{ name: "node", version: 1, fields: [{ name: "label", type: "string", required: false }] }],
      },
      sync: { remote: "http://example.com" },
      clientId: "test-client",
    });
    clients.push(client as any);
    const unsubA = client.kv.signal<number>("menu", { defaultValue: 0 }).subscribe(() => {});
    const unsubB = client.kv.signal<number>("theme", { defaultValue: 0 }).subscribe(() => {});
    await settle();
    queriedKeys.length = 0;

    for (let i = 0; i < 3; i++) {
      await client.kv.set("history", i);
    }
    await settle();
    expect(queriedKeys.filter((key) => key !== "kv:history")).toEqual([]);

    await client.kv.set("menu", 1);
    await settle();
    expect(queriedKeys).toContain("kv:menu");
    expect(queriedKeys).not.toContain("kv:theme");

    unsubA();
    unsubB();
  });

  it("still re-fetches a pinned record when another record of a related resource changes", async () => {
    const queried = mockRemote("folders");
    const schema: DatafnSchema = {
      resources: [
        {
          name: "folders",
          version: 1,
          fields: [
            { name: "name", type: "string", required: false },
            { name: "parentId", type: "string", required: false },
          ],
        },
      ],
      relations: [
        { from: "folders", to: "folders", type: "htree", relation: "children", inverse: "parent", fkField: "parentId" } as any,
      ],
    };
    const client = createDatafnClient({ schema, sync: { remote: "http://example.com" }, clientId: "tree" });
    clients.push(client as any);
    const folders = client.table("folders");
    const unsub = folders.signal({ filters: { id: "folders:a" } }).subscribe(() => {});
    await settle();

    // A remote merge may create the record it names, so it still refreshes.
    queried.length = 0;
    await folders.mutate({ operation: "merge", id: "folders:b", record: { name: "b" } } as any);
    await settle();
    expect(queried).toContain("folders:a");

    // Deleting another folder may cascade to this one.
    await folders.mutate({ operation: "delete", id: "folders:root" } as any);
    await settle();
    expect(queried).toContain("folders:a");

    // Archiving another folder may propagate to its descendants.
    queried.length = 0;
    await folders.mutate({ operation: "merge", id: "folders:root", record: { trashedAt: 1 } } as any);
    await settle();
    expect(queried).toContain("folders:a");

    unsub();
  });

  it("is not pinned when it filters through a relation or searches", async () => {
    const queried = mockRemote("folders");
    const schema: DatafnSchema = {
      resources: [
        {
          name: "folders",
          version: 1,
          fields: [
            { name: "name", type: "string", required: false },
            { name: "parentId", type: "string", required: false },
          ],
        },
      ],
      relations: [
        { from: "folders", to: "folders", type: "htree", relation: "children", inverse: "parent", fkField: "parentId" } as any,
      ],
    };
    const client = createDatafnClient({ schema, sync: { remote: "http://example.com" }, clientId: "tree" });
    clients.push(client as any);
    const folders = client.table("folders");
    const unsubPath = folders.signal({ filters: { id: "folders:a", "parent.name": "x" } }).subscribe(() => {});
    const unsubSorted = folders.signal({ filters: { id: { $in: ["folders:a", "folders:c"] } }, sort: ["parent.name"] }).subscribe(() => {});
    const unsubSearch = folders.signal({ filters: { id: "folders:d" }, search: { query: "x", topK: 1 } } as any).subscribe(() => {});
    await settle();

    // Renaming the parent changes whether a matches and how a and c sort;
    // another folder can outrank d in the search.
    queried.length = 0;
    await folders.mutate({ operation: "merge", id: "folders:root", record: { name: "x" } } as any);
    await settle();
    expect(queried).toContain("folders:a");
    expect(queried).toContain("folders:d");
    expect(queried).toContain("folders:a,folders:c");

    unsubPath();
    unsubSorted();
    unsubSearch();
  });
});

describe("signals pinned to ids (local)", () => {
  it("drops a pinned child when its ancestor is archived", async () => {
    const schema: DatafnSchema = {
      resources: [
        {
          name: "goals",
          version: 1,
          capabilities: ["archivable"],
          fields: [
            { name: "label", type: "string", required: false },
            { name: "parentId", type: "string", required: false },
            { name: "parentPath", type: "string", required: false },
          ],
        },
      ],
      relations: [
        {
          from: "goals",
          to: "goals",
          type: "htree",
          relation: "children",
          inverse: "parent",
          fkField: "parentId",
          pathField: "parentPath",
          inheritsInactive: true,
        } as any,
      ],
    };
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.upsertRecord("goals", { id: "goals:root", label: "Root", parentPath: "" });
    await storage.upsertRecord("goals", { id: "goals:child", label: "Child", parentId: "goals:root", parentPath: "goals:root" });
    await storage.setHydrationState("goals", "hydrating");
    await storage.setHydrationState("goals", "ready");
    const client = createDatafnClient({
      schema,
      clientId: "goals-client",
      storage,
      sync: { mode: "local-only", offlinability: true },
    });
    clients.push(client as any);
    const goals = client.table("goals");
    const values: any[] = [];
    const unsub = goals.signal({ filters: { id: "goals:child" } }).subscribe((value) => values.push(value));
    await vi.waitFor(() => expect(values.at(-1)?.map((r: any) => r.id)).toEqual(["goals:child"]));

    // Editing a plain field of another existing goal cannot change the child.
    // Full reads of the child's signal (record refreshes probe with $in).
    const childReads = () =>
      executeSpy.mock.calls.filter(([, , query]: any[]) => JSON.stringify(query?.filters ?? {}).includes('"id":"goals:child"')).length;
    executeSpy.mockClear();
    await goals.mutate({ operation: "merge", id: "goals:root", record: { label: "Renamed" } } as any);
    await settle();
    expect(childReads()).toBe(0);

    // Creating a goal can, through defaults the event does not list.
    await goals.mutate({ operation: "insert", id: "goals:other", record: { label: "Other" } } as any);
    await vi.waitFor(() => expect(childReads()).toBeGreaterThan(0));

    await goals.mutate({ operation: "merge", id: "goals:root", record: { isArchived: true } } as any);
    await vi.waitFor(() => expect(values.at(-1)).toEqual([]));
    unsub();
  });
});

describe("resolvePinnedQueryIds", () => {
  it("finds pinned ids in a value, eq, $in and a top-level $and", () => {
    expect(resolvePinnedQueryIds({ filters: { id: { eq: "a" } } })).toEqual(new Set(["a"]));
    expect(resolvePinnedQueryIds({ filters: { id: { $eq: "a" } } })).toEqual(new Set(["a"]));
    expect(resolvePinnedQueryIds({ filters: { id: "a" } })).toEqual(new Set(["a"]));
    expect(resolvePinnedQueryIds({ filters: { id: { in: ["a", "b"] } } })).toEqual(new Set(["a", "b"]));
    expect(resolvePinnedQueryIds({ filters: { id: { $in: ["a", "b"] } } })).toEqual(new Set(["a", "b"]));
    expect(
      resolvePinnedQueryIds({ filters: { $and: [{ trashedAt: { $is_null: true } }, { id: { eq: "a" } }] } }),
    ).toEqual(new Set(["a"]));
  });

  it("returns undefined when the query is not pinned", () => {
    expect(resolvePinnedQueryIds({ filters: { label: { eq: "a" } } })).toBeUndefined();
    expect(resolvePinnedQueryIds({ filters: { $or: [{ id: { eq: "a" } }, { id: { eq: "b" } }] } })).toBeUndefined();
    expect(resolvePinnedQueryIds({ filters: { id: { $in: ["a", 1] } } })).toBeUndefined();
    expect(resolvePinnedQueryIds({ filters: { id: { $ne: "a" } } })).toBeUndefined();
    expect(resolvePinnedQueryIds({ filters: { id: { eq: "a", $eq: "b" } } })).toBeUndefined();
    expect(resolvePinnedQueryIds({ filters: { id: { in: ["a"], $in: ["b"] } } })).toBeUndefined();
    expect(resolvePinnedQueryIds({})).toBeUndefined();
  });
});
