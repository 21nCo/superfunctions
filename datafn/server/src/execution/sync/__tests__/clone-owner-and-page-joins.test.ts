/**
 * Full clone ("first sync") server costs:
 * - the namespace owner's clone, reconcile and query visibility filters keep
 *   every row without a per-row access lookup (no findOne per row);
 * - other actors are still filtered row by row;
 * - a paginated clone returns only the join rows of the page's records.
 */

import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import type { DatafnSchema } from "../../../core-types.js";
import { executeClone } from "../clone.js";
import { executeReconcile } from "../reconcile.js";
import { DbDataStore } from "../../db-store.js";

const NAMESPACE = "user:alice";

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      capabilities: [
        { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } },
      ] as any,
      fields: [{ name: "title", type: "string", required: true }],
    },
    {
      name: "tags",
      version: 1,
      fields: [{ name: "name", type: "string", required: true }],
    },
  ],
  relations: [
    {
      from: "notes",
      to: "tags",
      type: "many-many",
      relation: "tags",
    } as any,
  ],
};

const JOIN_TABLE = "__datafn_join_notes_tags";

function countingAdapter(db: Adapter) {
  const counts = { findOne: 0 };
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "findOne" && typeof value === "function") {
        return (...args: unknown[]) => {
          counts.findOne += 1;
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Adapter;
  return { db: wrapped, counts };
}

async function seed() {
  const db = memoryAdapter();
  await db.initialize?.();
  for (let i = 1; i <= 6; i++) {
    await db.create({
      model: "notes",
      data: { id: `n${i}`, title: `Note ${i}` },
      namespace: NAMESPACE,
    });
  }
  for (const id of ["t1", "t2", "t3"]) {
    await db.create({ model: "tags", data: { id, name: id }, namespace: NAMESPACE });
  }
  const links: Array<[string, string]> = [
    ["n1", "t1"],
    ["n2", "t2"],
    ["n3", "t1"],
    ["n4", "t3"],
    ["n6", "t2"],
  ];
  for (const [from, to] of links) {
    await db.create({
      model: JOIN_TABLE,
      data: { id: `j_${from}_${to}`, from, to },
      namespace: NAMESPACE,
    });
  }
  return db;
}

describe("clone, reconcile and query visibility for the namespace owner", () => {
  it("clone keeps every row of the owner without per-row lookups", async () => {
    const { db, counts } = countingAdapter(await seed());
    const result = await executeClone(
      { clientId: "c1", tables: ["notes"], actorId: "alice" },
      schema,
      db,
      NAMESPACE,
    );
    expect(result.ok).toBe(true);
    expect(result.data.notes).toHaveLength(6);
    expect(counts.findOne).toBe(0);
  });

  it("paginated clone keeps every row of the owner without per-row lookups", async () => {
    const { db, counts } = countingAdapter(await seed());
    const result = await executeClone(
      {
        clientId: "c1",
        tables: ["notes"],
        actorId: "alice",
        page: { table: "notes", afterId: null, limit: 4 },
      },
      schema,
      db,
      NAMESPACE,
    );
    expect(result.data.notes.map((r) => r.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(counts.findOne).toBe(0);
  });

  it("clone still filters another actor's private rows", async () => {
    const { db, counts } = countingAdapter(await seed());
    const result = await executeClone(
      { clientId: "c1", tables: ["notes"], actorId: "bob" },
      schema,
      db,
      NAMESPACE,
    );
    expect(result.data.notes).toEqual([]);
    expect(counts.findOne).toBeGreaterThan(0);
  });

  it("reconcile counts the owner's rows without per-row lookups", async () => {
    const { db, counts } = countingAdapter(await seed());
    const owner = await executeReconcile(
      { clientId: "c1", resources: ["notes"], actorId: "alice" } as any,
      schema,
      db,
      NAMESPACE,
    );
    expect(owner.ok).toBe(true);
    expect(owner.counts?.notes).toBe(6);
    expect(counts.findOne).toBe(0);

    const other = await executeReconcile(
      { clientId: "c1", resources: ["notes"], actorId: "bob" } as any,
      schema,
      db,
      NAMESPACE,
    );
    expect(other.counts?.notes).toBe(0);
  });

  it("the query visibility filter keeps the owner's rows without per-row lookups", async () => {
    const seeded = await seed();
    const rows = await seeded.findMany({ model: "notes", where: [], namespace: NAMESPACE });
    const { db, counts } = countingAdapter(seeded);

    const ownerStore = await DbDataStore.forPushdownResult(
      db,
      rows,
      "notes",
      {},
      schema,
      NAMESPACE,
      undefined,
      "alice",
    );
    expect(ownerStore.getRecords("notes")).toHaveLength(6);
    expect(counts.findOne).toBe(0);

    const otherStore = await DbDataStore.forPushdownResult(
      db,
      rows,
      "notes",
      {},
      schema,
      NAMESPACE,
      undefined,
      "bob",
    );
    expect(otherStore.getRecords("notes")).toHaveLength(0);
  });
});

describe("paginated clone join rows", () => {
  const joinKey = "join_notes_tags_tags";

  it("returns only the join rows whose records are on the page", async () => {
    const db = await seed();
    const page1 = await executeClone(
      {
        clientId: "c1",
        tables: ["notes"],
        actorId: "alice",
        includeJoins: true,
        page: { table: "notes", afterId: null, limit: 3 },
      },
      schema,
      db,
      NAMESPACE,
    );
    expect(page1.joins?.[joinKey]?.map((r) => r.id)).toEqual([
      "j_n1_t1",
      "j_n2_t2",
      "j_n3_t1",
    ]);

    const page2 = await executeClone(
      {
        clientId: "c1",
        tables: ["notes"],
        actorId: "alice",
        includeJoins: true,
        page: { table: "notes", afterId: "n3", limit: 3 },
      },
      schema,
      db,
      NAMESPACE,
    );
    expect(page2.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n4_t3", "j_n6_t2"]);
  });

  it("returns the join rows of to-side records when paging the to resource", async () => {
    const db = await seed();
    const page = await executeClone(
      {
        clientId: "c1",
        tables: ["tags"],
        actorId: "alice",
        includeJoins: true,
        page: { table: "tags", afterId: null, limit: 1 },
      },
      schema,
      db,
      NAMESPACE,
    );
    expect(page.data.tags.map((r) => r.id)).toEqual(["t1"]);
    expect(page.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n1_t1", "j_n3_t1"]);
  });

  it("a capped clone carries the join rows of the records it returned", async () => {
    const db = await seed();
    const capped = await executeClone(
      { clientId: "c1", tables: ["notes", "tags"], actorId: "alice", includeJoins: true },
      schema,
      db,
      NAMESPACE,
      undefined,
      4,
    );
    expect(capped.paginated).toBe(true);
    expect(capped.data.notes.map((r) => r.id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(capped.data.tags).toEqual([]);
    expect(capped.joins?.[joinKey]?.map((r) => r.id)).toEqual([
      "j_n1_t1",
      "j_n2_t2",
      "j_n3_t1",
      "j_n4_t3",
    ]);
  });

  it("covers a self relation from both sides across pages", async () => {
    const selfSchema: DatafnSchema = {
      resources: [schema.resources[1]],
      relations: [{ from: "tags", to: "tags", type: "many-many", relation: "links" } as any],
    };
    const db = memoryAdapter();
    for (const id of ["a", "b", "c"]) {
      await db.create({ model: "tags", data: { id, name: id }, namespace: NAMESPACE });
    }
    await db.create({
      model: "__datafn_join_tags_links",
      data: { id: "l_c_a", from: "c", to: "a" },
      namespace: NAMESPACE,
    });
    const page = (afterId: string | null) =>
      executeClone(
        {
          clientId: "c1",
          tables: ["tags"],
          includeJoins: true,
          page: { table: "tags", afterId, limit: 2 },
        },
        selfSchema,
        db,
        NAMESPACE,
      );
    const first = await page(null);
    const second = await page("b");
    expect(first.joins?.join_tags_links_tags?.map((r) => r.id)).toEqual(["l_c_a"]);
    expect(second.joins?.join_tags_links_tags?.map((r) => r.id)).toEqual(["l_c_a"]);
  });

  it("still returns the whole join table for an unpaginated clone", async () => {
    const db = await seed();
    const result = await executeClone(
      { clientId: "c1", tables: ["notes"], actorId: "alice", includeJoins: true },
      schema,
      db,
      NAMESPACE,
    );
    expect(result.joins?.[joinKey]).toHaveLength(5);
  });
});
