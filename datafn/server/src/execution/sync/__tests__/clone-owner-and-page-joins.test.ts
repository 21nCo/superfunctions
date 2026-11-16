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

  it("reads the join table once when a page's id lookups exceed the budget", async () => {
    const selfSchema: DatafnSchema = {
      resources: [schema.resources[1]],
      relations: [{ from: "tags", to: "tags", type: "many-many", relation: "links" } as any],
    };
    const base = memoryAdapter();
    const ids = Array.from({ length: 1000 }, (_, i) => `t${String(i).padStart(4, "0")}`);
    for (const id of ids) {
      await base.create({ model: "tags", data: { id, name: id }, namespace: NAMESPACE });
    }
    for (const [id, from, to] of [
      ["l1", "t0001", "t0002"],
      ["l2", "t0999", "x_outside"],
    ]) {
      await base.create({
        model: "__datafn_join_tags_links",
        data: { id, from, to },
        namespace: NAMESPACE,
      });
    }
    let joinQueries = 0;
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "findMany") {
          return (args: { model: string }) => {
            if (args.model === "__datafn_join_tags_links") joinQueries += 1;
            return value.call(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Adapter;

    const page = await executeClone(
      {
        clientId: "c1",
        tables: ["tags"],
        includeJoins: true,
        page: { table: "tags", afterId: null, limit: 1000 },
      },
      selfSchema,
      db,
      NAMESPACE,
    );

    expect(page.data.tags).toHaveLength(1000);
    expect(joinQueries).toBe(1);
    expect(page.joins?.join_tags_links_tags?.map((r) => r.id)).toEqual(["l1", "l2"]);
  });

  it("reads each join table once for a page that covers several tables", async () => {
    const selfSchema: DatafnSchema = {
      resources: [schema.resources[0], schema.resources[1]],
      relations: [{ from: "tags", to: "tags", type: "many-many", relation: "links" } as any],
    };
    const base = memoryAdapter();
    for (const id of ["t1", "t2", "t3"]) {
      await base.create({ model: "tags", data: { id, name: id }, namespace: NAMESPACE });
    }
    await base.create({
      model: "__datafn_join_tags_links",
      data: { id: "l1", from: "t1", to: "t2" },
      namespace: NAMESPACE,
    });
    let joinQueries = 0;
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "findMany") {
          return (args: { model: string }) => {
            if (args.model === "__datafn_join_tags_links") joinQueries += 1;
            return value.call(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Adapter;
    const pageOf = (tables: string[] | undefined) =>
      executeClone(
        {
          clientId: "c1",
          ...(tables ? { tables } : {}),
          includeJoins: true,
          page: { table: "tags", afterId: null, limit: 10 },
        },
        selfSchema,
        db,
        NAMESPACE,
      );

    // No `tables`: every resource is cloned, so cursor reads already spend a
    // query per table and the join table is read once.
    const multi = await pageOf(undefined);
    expect(joinQueries).toBe(1);
    expect(multi.joins?.join_tags_links_tags?.map((r) => r.id)).toEqual(["l1"]);

    // A single-table page still looks its join rows up by id.
    joinQueries = 0;
    const single = await pageOf(["tags"]);
    expect(joinQueries).toBeGreaterThan(1);
    expect(single.joins?.join_tags_links_tags?.map((r) => r.id)).toEqual(["l1"]);
  });

  it("hides join rows whose private endpoint another actor cannot see", async () => {
    const db = await seed();
    await db.update({
      model: "notes",
      where: [{ field: "id", operator: "eq", value: "n3" }],
      data: { createdBy: "bob" },
      namespace: NAMESPACE,
    });
    const page = await executeClone(
      {
        clientId: "c1",
        tables: ["tags"],
        actorId: "bob",
        includeJoins: true,
        page: { table: "tags", afterId: null, limit: 1 },
      },
      schema,
      db,
      NAMESPACE,
    );
    expect(page.data.tags.map((r) => r.id)).toEqual(["t1"]);
    // t1 links n1 (alice's, hidden from bob) and n3 (bob's).
    expect(page.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n3_t1"]);

    const unpaged = await executeClone(
      { clientId: "c1", tables: ["tags"], actorId: "bob", includeJoins: true },
      schema,
      db,
      NAMESPACE,
    );
    expect(unpaged.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n3_t1"]);
  });

  it("an unpaginated clone doesn't re-check endpoints of tables it fully loaded", async () => {
    const base = await seed();
    await base.update({
      model: "notes",
      where: [{ field: "id", operator: "eq", value: "n3" }],
      data: { createdBy: "bob" },
      namespace: NAMESPACE,
    });
    const { db, counts } = countingAdapter(base);
    const request = { clientId: "c1", tables: ["notes", "tags"], actorId: "bob" };
    await executeClone(request, schema, db, NAMESPACE);
    const withoutJoins = counts.findOne;
    counts.findOne = 0;
    const clone = await executeClone({ ...request, includeJoins: true }, schema, db, NAMESPACE);
    expect(clone.data.notes.map((r) => r.id)).toEqual(["n3"]);
    expect(clone.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n3_t1"]);
    // Loading the join rows adds no lookups for their hidden endpoints.
    expect(counts.findOne).toBe(withoutJoins);
  });

  it("reconcile counts the join rows a clone returns to the actor", async () => {
    const db = await seed();
    await db.update({
      model: "notes",
      where: [{ field: "id", operator: "eq", value: "n3" }],
      data: { createdBy: "bob" },
      namespace: NAMESPACE,
    });
    const clone = await executeClone(
      { clientId: "c1", tables: ["notes", "tags"], actorId: "bob", includeJoins: true },
      schema,
      db,
      NAMESPACE,
    );
    const reconcile = await executeReconcile(
      { clientId: "c1", resources: ["notes", "tags"], actorId: "bob", includeJoins: true } as any,
      schema,
      db,
      NAMESPACE,
    );
    expect(clone.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n3_t1"]);
    expect(reconcile.joinCounts?.[joinKey]).toBe(1);

    const owner = await executeReconcile(
      { clientId: "c1", resources: ["notes", "tags"], actorId: "alice", includeJoins: true } as any,
      schema,
      db,
      NAMESPACE,
    );
    // The namespace owner sees every row.
    expect(owner.joinCounts?.[joinKey]).toBe(5);
  });

  it("a table that exactly fills the cap doesn't re-check hidden join endpoints", async () => {
    const base = await seed();
    await base.update({
      model: "notes",
      where: [{ field: "id", operator: "eq", value: "n3" }],
      data: { createdBy: "bob" },
      namespace: NAMESPACE,
    });
    const withExtras: DatafnSchema = {
      ...schema,
      resources: [
        ...schema.resources,
        { name: "extras", version: 1, fields: [{ name: "name", type: "string" }] } as any,
      ],
    };
    for (let i = 1; i <= 5; i++) {
      await base.create({ model: "extras", data: { id: `e${i}`, name: `e${i}` }, namespace: NAMESPACE });
    }
    const { db, counts } = countingAdapter(base);
    // Cap 9: tags (3) then notes (6) fill it exactly; extras are deferred.
    const request = { clientId: "c1", tables: ["tags", "notes", "extras"], actorId: "bob" };
    await executeClone(request, withExtras, db, NAMESPACE, undefined, 9);
    const withoutJoins = counts.findOne;
    counts.findOne = 0;
    const capped = await executeClone(
      { ...request, includeJoins: true },
      withExtras,
      db,
      NAMESPACE,
      undefined,
      9,
    );
    expect(capped.paginated).toBe(true);
    expect(capped.data.notes.map((r) => r.id)).toEqual(["n3"]);
    expect(capped.joins?.[joinKey]?.map((r) => r.id)).toEqual(["j_n3_t1"]);
    expect(counts.findOne).toBe(withoutJoins);
  });

  it("reconcile reuses the access checks it made while counting", async () => {
    const base = await seed();
    await base.update({
      model: "notes",
      where: [{ field: "id", operator: "eq", value: "n3" }],
      data: { createdBy: "bob" },
      namespace: NAMESPACE,
    });
    const { db, counts } = countingAdapter(base);
    const request = { clientId: "c1", resources: ["notes", "tags"], actorId: "bob" };
    await executeReconcile(request as any, schema, db, NAMESPACE);
    const withoutJoins = counts.findOne;
    counts.findOne = 0;
    const reconcile = await executeReconcile(
      { ...request, includeJoins: true } as any,
      schema,
      db,
      NAMESPACE,
    );
    expect(reconcile.counts?.notes).toBe(1);
    expect(reconcile.joinCounts?.[joinKey]).toBe(1);
    // The join pass reuses the checks made while counting.
    expect(counts.findOne).toBe(withoutJoins);
  });

  it("reconcile counts nothing for a join store whose access check fails", async () => {
    const base = await seed();
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "findOne") {
          return async () => {
            throw new Error("lookup failed");
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Adapter;
    // Only tags are reconciled, so the private note endpoints are looked up.
    const reconcile = await executeReconcile(
      { clientId: "c1", resources: ["tags"], actorId: "bob", includeJoins: true } as any,
      schema,
      db,
      NAMESPACE,
    );
    expect(reconcile.ok).toBe(true);
    expect(reconcile.joinCounts?.[joinKey]).toBe(0);
  });

  it("a capped read cut short isn't treated as fully loaded when its count failed", async () => {
    const base = await seed();
    await base.update({
      model: "notes",
      where: [{ field: "id", operator: "eq", value: "n3" }],
      data: { createdBy: "bob" },
      namespace: NAMESPACE,
    });
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "count") {
          return async (args: { model: string }) => {
            if (args.model === "notes") throw new Error("count failed");
            return value.call(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Adapter;
    // An extra table makes the clone exceed the cap even though the notes
    // count failed; tags fill 3 of the 4-record cap and the notes read stops
    // after n1.
    const withExtras: DatafnSchema = {
      ...schema,
      resources: [
        ...schema.resources,
        { name: "extras", version: 1, fields: [{ name: "name", type: "string" }] } as any,
      ],
    };
    for (let i = 1; i <= 5; i++) {
      await base.create({ model: "extras", data: { id: `e${i}`, name: `e${i}` }, namespace: NAMESPACE });
    }
    const capped = await executeClone(
      { clientId: "c1", tables: ["tags", "notes", "extras"], actorId: "bob", includeJoins: true },
      withExtras,
      db,
      NAMESPACE,
      undefined,
      4,
    );
    expect(capped.data.tags.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
    // n3 (bob's) wasn't read, but its join to t1 is still checked and kept.
    expect(capped.joins?.[joinKey]?.map((r) => r.id)).toContain("j_n3_t1");
    // The cut-short notes read reports where to continue.
    expect(capped.next?.notes).toBe("n1");
  });

  it("fails the clone when a join endpoint's access check fails", async () => {
    const base = await seed();
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "findOne") {
          return async () => {
            throw new Error("database unavailable");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Adapter;

    await expect(
      executeClone(
        {
          clientId: "c1",
          tables: ["tags"],
          actorId: "bob",
          includeJoins: true,
          page: { table: "tags", afterId: null, limit: 1 },
        },
        schema,
        db,
        NAMESPACE,
      ),
    ).rejects.toThrow("database unavailable");
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
