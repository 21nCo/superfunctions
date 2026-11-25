/**
 * Push-down of `$is_empty` / `$is_not_empty` and `$any` / `$none` relation
 * filters, filters on a field named like its many-one relation, and relation
 * expansion by name for in-memory queries.
 *
 * Every push-down case is compared with the in-memory evaluator: the same
 * query plus an always-true filter the adapter cannot express
 * (`id not_like "__never__"`) is evaluated in memory.
 */

import { describe, it, expect, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnServer } from "../src/server.js";
import { classifyQuery, MAX_PUSHDOWN_IN_VALUES } from "../src/execution/query/planner.js";
import { buildPrefilterWhere, canPushDownFilters, planFilterPushdown } from "../src/execution/query/filter-plan.js";

/** Relations mirror Nucleum's schema (features.ts) for node, collection, objective and task. */
const SCHEMA: DatafnSchema = {
  resources: [
    {
      name: "node",
      version: 1,
      idPrefix: "node",
      fields: [
        { name: "label", type: "string", required: false, nullable: true },
        { name: "metaType", type: "string", required: false, nullable: true },
        { name: "creationContext", type: "string", required: false, nullable: true },
        { name: "parent", type: "string", required: false, nullable: true },
        { name: "parentPath", type: "string", required: false, nullable: true },
        { name: "sortOrder", type: "number", required: false, nullable: true },
        { name: "mdParent", type: "array", required: false, nullable: true },
      ],
    },
    {
      name: "collection",
      version: 1,
      idPrefix: "collection",
      fields: [{ name: "label", type: "string", required: false, nullable: true }],
    },
    {
      name: "objective",
      version: 1,
      idPrefix: "objective",
      fields: [
        { name: "label", type: "string", required: false, nullable: true },
        { name: "parentId", type: "string", required: false, nullable: true },
        { name: "parentPath", type: "string", required: false, nullable: true },
      ],
    },
    {
      name: "task",
      version: 1,
      idPrefix: "task",
      fields: [
        { name: "label", type: "string", required: false, nullable: true },
        { name: "objectiveId", type: "string", required: false, nullable: true },
      ],
    },
  ],
  relations: [
    {
      from: "node",
      to: "node",
      type: "many-one",
      relation: "parent",
      inverse: "childNodes",
      fkField: "parent",
    },
    {
      from: ["node", "objective"],
      to: "collection",
      type: "many-many",
      relation: "collections",
      inverse: "items",
      joinTable: "collection_items",
      joinColumns: { from: "itemId", to: "collectionId" },
    },
    // Declared before task.objective, as in Nucleum: the first relation
    // between task and objective is this many-many one.
    {
      from: ["node", "objective", "task"],
      to: ["node", "objective", "task"],
      type: "many-many",
      relation: "links",
      inverse: "backlinks",
      joinTable: "record_links",
      joinColumns: { from: "in", to: "out" },
    },
    {
      from: "objective",
      to: "objective",
      type: "htree",
      relation: "children",
      inverse: "parent",
      fkField: "parentId",
      pathField: "parentPath",
    },
    {
      from: "task",
      to: "objective",
      type: "many-one",
      relation: "objective",
      inverse: "tasks",
      fkField: "objectiveId",
    },
  ] as DatafnSchema["relations"],
};

const NODES = [
  { id: "node:1", label: "Alpha", metaType: null, creationContext: null, sortOrder: 1 },
  { id: "node:2", label: "Bravo", metaType: "", creationContext: "import", sortOrder: null, parent: "node:1" },
  { id: "node:3", label: "Charlie", metaType: "daily", creationContext: "", sortOrder: 3, parent: "node:1" },
  { id: "node:4", label: "Delta" },
  { id: "node:5", label: "Echo", metaType: "", creationContext: "", sortOrder: 5, parent: "node:2" },
  { id: "node:6", label: "", metaType: "page", creationContext: "web", sortOrder: 6, parent: "" },
  { id: "node:7", label: null, metaType: null, creationContext: "", sortOrder: 7, parent: "node:3" },
  { id: "node:8", label: "Golf", metaType: "", creationContext: null, mdParent: [] },
];

async function createServer(options: { schema?: DatafnSchema } = {}) {
  const db = memoryAdapter();
  await db.initialize();
  const seed = (model: string, data: Record<string, unknown>) =>
    db.create({ model, data, namespace: "datafn" });
  for (const node of NODES) await seed("node", node);
  await seed("collection", { id: "collection:work", label: "Work" });
  await seed("collection", { id: "collection:home", label: "Home" });
  await seed("collection", { id: "collection:empty", label: "Empty" });
  await seed("collection", { id: "collection:unnamed", label: null });
  await seed("objective", { id: "objective:goal", label: "Goal" });
  await seed("objective", { id: "objective:other", label: "Other" });
  await seed("task", { id: "task:1", label: "One", objectiveId: "objective:goal" });
  await seed("task", { id: "task:2", label: "Two", objectiveId: "objective:other" });
  await seed("task", { id: "task:3", label: "Three", objectiveId: null });
  await seed("task", { id: "task:4", label: "Four", objectiveId: "objective:missing" });
  const join = (id: string, itemId: string, collectionId: string) =>
    seed("collection_items", { id, itemId, collectionId });
  await join("ci1", "node:1", "collection:work");
  await join("ci2", "node:3", "collection:work");
  await join("ci3", "node:3", "collection:home");
  await join("ci4", "node:6", "collection:home");
  await join("ci5", "objective:goal", "collection:work");
  await join("ci6", "node:missing", "collection:work");
  await join("ci7", "node:4", "collection:unnamed");
  // task:1 links to objective:other, so a lookup through `links` finds a
  // different objective than task:1's many-one `objective`.
  await seed("record_links", { id: "rl1", in: "task:1", out: "objective:other" });
  await seed("record_links", { id: "rl2", in: "task:2", out: "objective:goal" });

  const server = await createDatafnServer({
    debug: true,
    allowUnknownResources: true,
    schema: options.schema ?? SCHEMA,
    limits: { maxLimit: 100 },
    database: db,
  });
  return { db, server };
}

type Json = Record<string, any>;

async function query(server: Awaited<ReturnType<typeof createDatafnServer>>, body: Json) {
  const res = await server.router.handle(
    new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, ...body }),
    }),
    {},
  );
  const json = (await res.json()) as Json;
  return { status: res.status, body: json };
}

/** An always-true filter the adapter cannot express: forces in-memory evaluation. */
const FORCE_IN_MEMORY = { id: { not_like: "__never__" } };

function withForcedInMemory(body: Json): Json {
  const filters = body.filters ? { $and: [body.filters, FORCE_IN_MEMORY] } : FORCE_IN_MEMORY;
  return { ...body, filters };
}

/** A push-down read of the primary resource passes orderBy; in-memory loads do not. */
function pushdownReads(spy: ReturnType<typeof vi.spyOn>, model: string) {
  return spy.mock.calls
    .map(([params]: any[]) => params)
    .filter((params: Json) => params.model === model && Array.isArray(params.orderBy));
}

/**
 * Fields compared by the parity checks. Without a select, in-memory results
 * leave out many-one foreign keys and push-down results keep them (an
 * existing difference this file does not cover), so parity selects fields.
 */
const PARITY_SELECT: Record<string, string[]> = {
  node: ["id", "label", "metaType", "creationContext", "sortOrder", "parent"],
  collection: ["id", "label"],
  objective: ["id", "label"],
  task: ["id", "label", "objectiveId"],
};

async function expectParity(input: Json) {
  const body = { select: PARITY_SELECT[input.resource], ...input };
  const { db, server } = await createServer();
  const spy = vi.spyOn(db as Adapter, "findMany");
  const pushed = await query(server, body);
  expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
  expect(pushdownReads(spy, body.resource).length).toBeGreaterThan(0);

  const inMemory = await query(server, withForcedInMemory(body));
  expect(inMemory.status, JSON.stringify(inMemory.body)).toBe(200);
  expect(pushed.body.result).toEqual(inMemory.body.result);
  return pushed.body.result as Json;
}

const ids = (result: Json) => (result.data as Json[]).map((row) => row.id);

describe("$is_empty / $is_not_empty push-down", () => {
  it("classifies emptiness filters on string, number and boolean fields for push-down", () => {
    expect(classifyQuery({ resource: "node", filters: { metaType: { $is_empty: true } } }, SCHEMA)).toBe("FULL_PUSHDOWN");
    expect(classifyQuery({ resource: "node", filters: { sortOrder: { $is_not_empty: true } } }, SCHEMA)).toBe("FULL_PUSHDOWN");
    // Array fields can hold [] and stay in memory.
    expect(classifyQuery({ resource: "node", filters: { mdParent: { $is_empty: true } } }, SCHEMA)).toBe("IN_MEMORY");
    // Without a schema the planner keeps its legacy classification.
    expect(classifyQuery({ resource: "node", filters: { metaType: { $is_empty: true } } })).toBe("IN_MEMORY");
  });

  it("keeps $in lists past one statement's parameter budget out of planned and pre-filter clauses", () => {
    const ids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `node:${prefix}${i}`);
    const oversized = ids(MAX_PUSHDOWN_IN_VALUES + 1, "a");
    // Beside an emptiness filter, an oversized list is not planned.
    expect(canPushDownFilters({ metaType: { $is_empty: true }, id: { $in: oversized } }, "node", SCHEMA)).toBe(false);
    expect(canPushDownFilters({ metaType: { $is_empty: true }, id: oversized }, "node", SCHEMA)).toBe(false);
    expect(
      classifyQuery({ resource: "node", filters: { metaType: { $is_empty: true }, id: { $in: oversized } } }, SCHEMA),
    ).toBe("IN_MEMORY");
    // The pre-filter drops the lists past the budget (a wider pre-filter);
    // the full filter is still evaluated in memory.
    const half = Math.floor(MAX_PUSHDOWN_IN_VALUES / 2) + 1;
    const where = buildPrefilterWhere(
      { metaType: { $is_empty: true }, id: { $in: ids(half, "b") }, label: { $in: ids(half, "c") } },
      "node",
      SCHEMA,
    );
    const inLists = where.filter((c) => c.operator === "in");
    expect(inLists).toHaveLength(1);
    expect((inLists[0].value as unknown[]).length).toBe(half);
    expect(where.some((c) => c.field === "metaType")).toBe(true);
  });

  it("$is_empty on a string matches null, missing and empty string", async () => {
    const result = await expectParity({
      resource: "node",
      filters: { metaType: { $is_empty: true } },
      sort: ["id:asc"],
    });
    expect(ids(result)).toEqual(["node:1", "node:2", "node:4", "node:5", "node:7", "node:8"]);
  });

  it("$is_not_empty on a string excludes null, missing and empty string", async () => {
    const result = await expectParity({
      resource: "node",
      filters: { metaType: { $is_not_empty: true } },
      sort: ["id:asc"],
    });
    expect(ids(result)).toEqual(["node:3", "node:6"]);
  });

  it("false operands invert, and a non-boolean operand constrains nothing", async () => {
    expect(ids(await expectParity({
      resource: "node",
      filters: { creationContext: { $is_not_empty: false } },
      sort: ["id:asc"],
    }))).toEqual(["node:1", "node:3", "node:4", "node:5", "node:7", "node:8"]);
    expect(ids(await expectParity({
      resource: "node",
      filters: { creationContext: { $is_empty: false } },
      sort: ["id:asc"],
    }))).toEqual(["node:2", "node:6"]);
    expect(ids(await expectParity({
      resource: "node",
      filters: { metaType: { $is_empty: "yes" } },
      sort: ["id:asc"],
    }))).toHaveLength(NODES.length);
  });

  it("number fields: empty means null or missing", async () => {
    const result = await expectParity({
      resource: "node",
      filters: { sortOrder: { $is_empty: true } },
      sort: ["id:asc"],
    });
    expect(ids(result)).toEqual(["node:2", "node:4", "node:8"]);
  });

  it("boolean fields: empty means null or missing, false is not empty", async () => {
    const schema: DatafnSchema = {
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "node"
          ? { ...resource, fields: [...resource.fields, { name: "pinned", type: "boolean", required: false, nullable: true }] }
          : resource,
      ) as DatafnSchema["resources"],
    };
    expect(classifyQuery({ resource: "node", filters: { pinned: { $is_empty: true } } }, schema)).toBe("FULL_PUSHDOWN");
    const { db, server } = await createServer({ schema });
    for (const [id, pinned] of [["node:b1", true], ["node:b2", false], ["node:b3", null]] as const) {
      await db.create({ model: "node", data: { id, label: id, pinned }, namespace: "datafn" });
    }
    const spy = vi.spyOn(db as Adapter, "findMany");
    for (const [filters, expected] of [
      [{ pinned: { $is_empty: true } }, (all: string[]) => all.filter((id) => id !== "node:b1" && id !== "node:b2")],
      [{ pinned: { $is_not_empty: true } }, () => ["node:b1", "node:b2"]],
      [{ pinned: { $is_empty: false } }, () => ["node:b1", "node:b2"]],
    ] as const) {
      const body = { resource: "node", filters, select: ["id", "pinned"], sort: ["id:asc"] };
      spy.mockClear();
      const pushed = await query(server, body);
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
      expect(pushdownReads(spy, "node").length).toBeGreaterThan(0);
      const inMemory = await query(server, withForcedInMemory(body));
      expect(pushed.body.result).toEqual(inMemory.body.result);
      const all = ids((await query(server, { resource: "node", select: ["id"], sort: ["id:asc"] })).body.result);
      expect(ids(pushed.body.result)).toEqual(expected(all));
    }
  });

  it("two emptiness filters (two OR groups) run as disjoint branches", async () => {
    const { db, server } = await createServer();
    const spy = vi.spyOn(db as Adapter, "findMany");
    const body = {
      resource: "node",
      filters: { metaType: { $is_empty: true }, creationContext: { $is_empty: true } },
      select: PARITY_SELECT.node,
      sort: ["label:asc", "id:asc"],
      count: true,
    };
    const pushed = await query(server, body);
    expect(pushed.status).toBe(200);
    const reads = pushdownReads(spy, "node");
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      // The first group leads through the OR connector; the second is split.
      expect(read.where[0]).toEqual({ field: "metaType", operator: "eq", value: null });
      expect(read.where[1]).toEqual({ field: "metaType", operator: "eq", value: "", connector: "OR" });
    }
    // Branches are read in full and paged after the merge.
    for (const read of reads) expect(read.limit).toBeUndefined();
    expect(reads.map((read: Json) => read.where[2])).toEqual([
      { field: "creationContext", operator: "eq", value: null },
      { field: "creationContext", operator: "eq", value: "" },
    ]);

    const inMemory = await query(server, withForcedInMemory(body));
    expect(pushed.body.result).toEqual(inMemory.body.result);
    expect(ids(pushed.body.result).sort()).toEqual(["node:1", "node:4", "node:5", "node:7", "node:8"]);
    expect(pushed.body.result.count).toBe(5);
  });

  it("a record read by two branches (written between the reads) fills one page position", async () => {
    const { db, server } = await createServer();
    const original = db.findMany.bind(db);
    let branchReads = 0;
    vi.spyOn(db as Adapter, "findMany").mockImplementation(async (params: any) => {
      const rows = (await original(params)) as Json[];
      if (params.model !== "node" || !Array.isArray(params.orderBy)) return rows;
      branchReads += 1;
      // The second branch also returns node:1, as if it changed in between.
      if (branchReads === 2) return [...rows, (await original({ model: "node", where: [{ field: "id", operator: "eq", value: "node:1" }], namespace: "datafn" }))[0]];
      return rows;
    });
    const res = await query(server, {
      resource: "node",
      filters: { metaType: { $is_empty: true }, creationContext: { $is_empty: true } },
      select: ["id"],
      sort: ["id:asc"],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(branchReads).toBeGreaterThan(1);
    const resultIds = ids(res.body.result);
    expect(new Set(resultIds).size).toBe(resultIds.length);
  });

  it("limit, offset and count match in-memory evaluation across branches", async () => {
    for (const [limit, offset] of [[2, 0], [2, 1], [3, 2], [10, 4]]) {
      await expectParity({
        resource: "node",
        filters: {
          metaType: { $is_empty: true },
          creationContext: { $is_empty: true },
          label: { $is_not_empty: true },
        },
        sort: ["-sortOrder", "id:asc"],
        limit,
        offset,
        count: true,
      });
      await expectParity({
        resource: "node",
        filters: {
          metaType: { $is_empty: true },
          creationContext: { $is_empty: true },
          label: { $is_empty: true },
        },
        sort: ["label:asc", "id:desc"],
        limit,
        offset,
        count: true,
      });
    }
  });

  it("cursor pagination across branches returns the same pages as in-memory evaluation", async () => {
    const { server } = await createServer();
    const base = {
      resource: "node",
      filters: { metaType: { $is_empty: true }, creationContext: { $is_empty: true } },
      select: PARITY_SELECT.node,
      sort: ["-sortOrder", "id:asc"],
    };
    const pages = async (forceInMemory: boolean) => {
      const out: Json[] = [];
      let cursor: Json | null = null;
      for (let page = 0; page < 10; page++) {
        const body = { ...base, limit: 2, ...(cursor ? { cursor: { after: cursor } } : {}) };
        const res = await query(server, forceInMemory ? withForcedInMemory(body) : body);
        expect(res.status).toBe(200);
        out.push(res.body.result);
        cursor = res.body.result.nextCursor;
        if (!cursor) break;
      }
      return out;
    };
    const pushed = await pages(false);
    expect(pushed.length).toBeGreaterThan(1);
    expect(pushed).toEqual(await pages(true));
  });
});

describe("$any / $none relation filter push-down", () => {
  it("many-many forward $any (collection items) reads the join table instead of every node", async () => {
    const { db, server } = await createServer();
    const spy = vi.spyOn(db as Adapter, "findMany");
    const body = {
      resource: "node",
      filters: { collections: { $any: { id: "collection:work" } } },
      select: PARITY_SELECT.node,
      sort: ["id:asc"],
      count: true,
    };
    expect(classifyQuery({ resource: body.resource, filters: body.filters }, SCHEMA)).toBe("FULL_PUSHDOWN");
    const pushed = await query(server, body);
    expect(pushed.status).toBe(200);
    expect(ids(pushed.body.result)).toEqual(["node:1", "node:3"]);
    expect(pushed.body.result.count).toBe(2);
    const [read] = pushdownReads(spy, "node");
    expect(read.where).toContainEqual({ field: "id", operator: "in", value: expect.arrayContaining(["node:1", "node:3"]) });
    // No unfiltered node read.
    expect(spy.mock.calls.filter(([p]: any[]) => p.model === "node" && p.where.length === 0)).toHaveLength(0);

    const inMemory = await query(server, withForcedInMemory(body));
    expect(pushed.body.result).toEqual(inMemory.body.result);
  });

  it("matches in-memory evaluation for each relation shape", async () => {
    const cases: Json[] = [
      { resource: "node", filters: { collections: { $any: { label: "Home" } } } },
      { resource: "node", filters: { collections: { $any: { label: { $in: ["Home", "Work"] } } } } },
      { resource: "node", filters: { collections: { $none: { id: "collection:work" } } } },
      { resource: "node", filters: { metaType: { $is_empty: true }, label: { $ne: "Alpha" } } },
      { resource: "node", filters: { metaType: { $is_empty: true }, label: { $ne: null } } },
      { resource: "objective", filters: { collections: { $any: { id: "collection:work" } } } },
      // Inverse many-many with a multi-resource source endpoint.
      { resource: "collection", filters: { items: { $any: { label: "Charlie" } } } },
      { resource: "collection", filters: { items: { $any: { label: { $is_empty: true } } } } },
      { resource: "collection", filters: { items: { $none: { label: "Charlie" } } } },
      { resource: "node", filters: { collections: { $any: { label: ["Home", "Empty"] } } } },
      { resource: "objective", filters: { tasks: { $none: { objectiveId: { $in: ["objective:goal"] } } } } },
      // many-one forward (fk on the primary).
      { resource: "task", filters: { objective: { $any: { label: "Goal" } } } },
      // A number `$ne` keeps in-memory null semantics (null sortOrder matches).
      { resource: "node", filters: { childNodes: { $any: { sortOrder: { $ne: 3 } } } } },
      // many-one inverse (fk on the related records).
      { resource: "objective", filters: { tasks: { $any: { label: "Two" } } } },
      { resource: "objective", filters: { tasks: { $none: { label: "Two" } } } },
      { resource: "node", filters: { childNodes: { $any: { metaType: { $is_empty: true } } } } },
      { resource: "node", filters: { childNodes: { $none: { label: "Echo" } }, metaType: { $is_empty: true } } },
      // Combined with emptiness and a second quantifier.
      {
        resource: "node",
        filters: {
          collections: { $any: { label: "Home" } },
          creationContext: { $is_empty: false },
          $and: [{ childNodes: { $none: { label: "Nope" } } }],
        },
      },
    ];
    for (const body of cases) {
      await expectParity({ ...body, sort: ["id:asc"], count: true });
    }
  });

  it("keeps strict string equality when the database compares strings case-insensitively", async () => {
    // String inequality in a sub-filter stays in memory: such a database
    // would leave out rows that differ only in case.
    expect(classifyQuery({ resource: "task", filters: { objective: { $any: { label: { $ne: "goal" } } } } }, SCHEMA)).toBe("IN_MEMORY");
    const { db, server } = await createServer();
    const original = db.findMany.bind(db);
    // The related read behaves like a case-insensitive collation.
    vi.spyOn(db as Adapter, "findMany").mockImplementation(async (params: any) => {
      const where = params.where as Json[] | undefined;
      const label = where?.find((c) => c.field === "label" && c.operator === "eq");
      if (params.model !== "task" || !label) return original(params);
      const rest = where!.filter((c) => c !== label);
      const rows = (await original({ ...params, where: rest, limit: undefined })) as Json[];
      return rows.filter((row) => String(row.label).toLowerCase() === String(label.value).toLowerCase());
    });
    // So does a string `$is_not_empty`: `<> ''` would leave out values a
    // padding collation compares equal to ''.
    expect(classifyQuery({ resource: "task", filters: { objective: { $any: { label: { $is_not_empty: true } } } } }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "task", filters: { objective: { $any: { label: { $is_empty: false } } } } }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "task", filters: { objective: { $any: { label: { $is_empty: true } } } } }, SCHEMA)).toBe("FULL_PUSHDOWN");
    for (const [filters, expected] of [
      [{ tasks: { $any: { label: "two" } } }, []],
      [{ tasks: { $any: { label: "Two" } } }, ["objective:other"]],
      [{ tasks: { $none: { label: "two" } } }, ["objective:goal", "objective:other"]],
    ] as const) {
      const res = await query(server, { resource: "objective", filters, select: ["id"], sort: ["id:asc"] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(ids(res.body.result), JSON.stringify(filters)).toEqual(expected);
    }
  });

  it("re-checks related rows against sub-filters with $and and array shorthand", async () => {
    for (const filters of [
      { objective: { $any: { $and: [{ label: "Goal" }, { label: ["Goal", "Other"] }] } } },
      { objective: { $any: { $and: [{ label: ["Other"] }] } } },
      { objective: { $any: { label: ["Goal", "Other"] } } },
    ]) {
      await expectParity({ resource: "task", filters, sort: ["id:asc"], count: true });
    }
    // `and` / `or` without `$` are field names; their array shorthand is a value list.
    const schema: DatafnSchema = {
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "objective"
          ? { ...resource, fields: [...resource.fields, { name: "or", type: "string", required: false, nullable: true }] }
          : resource,
      ) as DatafnSchema["resources"],
    };
    const { db, server } = await createServer({ schema });
    await db.update({ model: "objective", where: [{ field: "id", operator: "eq", value: "objective:goal" }], data: { or: "P" }, namespace: "datafn" });
    const spy = vi.spyOn(db as Adapter, "findMany");
    const body = { resource: "task", filters: { objective: { $any: { or: ["P"] } } }, select: ["id"], sort: ["id:asc"], count: true };
    const pushed = await query(server, body);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushdownReads(spy, "task").length).toBeGreaterThan(0);
    expect(ids(pushed.body.result)).toEqual(["task:1"]);
    expect(pushed.body.result.count).toBe(1);
    expect(ids(await expectParity({
      resource: "task",
      filters: { objective: { $any: { $and: [{ label: "Goal" }, { label: ["Goal", "Other"] }] } } },
      sort: ["id:asc"],
    }))).toEqual(["task:1"]);
  });

  it("a relation filter that matches nothing returns an empty page and count", async () => {
    const { db, server } = await createServer();
    const spy = vi.spyOn(db as Adapter, "findMany");
    const res = await query(server, {
      resource: "node",
      filters: { collections: { $any: { id: "collection:empty" } } },
      count: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ data: [], count: 0, nextCursor: null });
    expect(spy.mock.calls.filter(([p]: any[]) => p.model === "node")).toHaveLength(0);
  });

  it("only readable related records count for a private shareable related resource", async () => {
    const schema: DatafnSchema = {
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "collection"
          ? {
              ...resource,
              capabilities: ["audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
            }
          : resource,
      ) as DatafnSchema["resources"],
    };
    const { server } = await createServer({ schema });
    // No actor: no collection is readable, so `$any` matches nothing in both paths.
    const body = { resource: "node", filters: { collections: { $any: { id: "collection:work" } } }, sort: ["id:asc"] };
    const pushed = await query(server, body);
    const inMemory = await query(server, withForcedInMemory(body));
    expect(pushed.status).toBe(200);
    expect(pushed.body.result).toEqual(inMemory.body.result);
    expect(pushed.body.result.data).toEqual([]);
  });

  it("the namespace owner sees every related record without per-record access lookups", async () => {
    const schema: DatafnSchema = {
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "collection"
          ? {
              ...resource,
              capabilities: ["audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
            }
          : resource,
      ) as DatafnSchema["resources"],
    };
    const { db } = await createServer({ schema });
    const findOne = vi.spyOn(db as Adapter, "findOne");
    const filters = { collections: { $any: { label: ["Work", "Home"] } } };
    const owner = await planFilterPushdown(filters, "node", schema, { db: db as Adapter, namespace: "user:owner", actorId: "user:owner" });
    expect(findOne).not.toHaveBeenCalled();
    expect(owner).toMatchObject({ kind: "where" });
    // Another actor still has every related record checked.
    await planFilterPushdown(filters, "node", schema, { db: db as Adapter, namespace: "user:owner", actorId: "user:other" });
    expect(findOne).toHaveBeenCalled();
  });

  it("range operators and fields some polymorphic targets lack stay in memory in relation sub-filters", async () => {
    const { server } = await createServer();
    // In memory `null <= 0` holds (JS coerces null to 0); SQL never matches NULL.
    const range = { resource: "collection", filters: { items: { $any: { sortOrder: { $lte: 0 } } } }, select: ["id"], sort: ["id:asc"] };
    expect(classifyQuery(range, SCHEMA)).toBe("IN_MEMORY");
    // objective declares no metaType; the in-memory evaluator reads it as missing.
    const polymorphic = { resource: "collection", filters: { items: { $none: { metaType: "page" } } }, select: ["id"], sort: ["id:asc"] };
    expect(classifyQuery(polymorphic, SCHEMA)).toBe("IN_MEMORY");
    const res = await query(server, polymorphic);
    expect(res.status).toBe(200);
    expect(ids(res.body.result)).toEqual(["collection:empty", "collection:unnamed", "collection:work"]);
  });

  it("relation sub-filter operands SQL would compare differently stay in memory", async () => {
    // Objects/arrays (identity in memory), null (memory tells null from
    // missing), and types other than the field's (SQL coerces "3" to 3).
    for (const label of [
      { $eq: { k: "v" } }, { $ne: ["a"] }, { $in: [{ k: "v" }] }, [["a"]],
      null, { $eq: null }, { $ne: null }, { $in: ["Work", null] }, [null],
      3, { $eq: 3 }, { $in: ["Work", 3] }, { $ne: true },
    ]) {
      expect(classifyQuery({ resource: "node", filters: { collections: { $any: { label } } } }, SCHEMA), JSON.stringify(label)).toBe("IN_MEMORY");
    }
    expect(classifyQuery({ resource: "node", filters: { childNodes: { $any: { sortOrder: { $eq: "3" } } } } }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "node", filters: { childNodes: { $any: { sortOrder: 3 } } } }, SCHEMA)).toBe("FULL_PUSHDOWN");
    const { server } = await createServer();
    const res = await query(server, { resource: "node", filters: { collections: { $any: { label: { $in: ["Home", null] } } } }, select: ["id"], sort: ["id:asc"] });
    expect(res.status).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:3", "node:4", "node:6"]);
  });

  it("evaluates in memory when the database rejects a pushed-down relation filter", async () => {
    const { db, server } = await createServer();
    const findMany = (db as Adapter).findMany.bind(db);
    // Like D1's bound-parameter limit: reject the join-table id list.
    vi.spyOn(db as Adapter, "findMany").mockImplementation(async (params: any) => {
      if (params.model === "collection_items" && params.where?.some((c: any) => c.field === "collectionId" && c.operator === "in")) {
        throw new Error("D1_ERROR: too many SQL variables");
      }
      return findMany(params);
    });
    const body = { resource: "node", filters: { collections: { $any: { label: "Work" } } }, select: ["id"], sort: ["id:asc"], count: true };
    expect(classifyQuery(body, SCHEMA)).toBe("FULL_PUSHDOWN");
    const res = await query(server, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:1", "node:3"]);
    expect(res.body.result.count).toBe(2);
  });

  it("a nested relation path back to the primary resource keeps the in-memory store unfiltered", async () => {
    const { db, server } = await createServer();
    await db.create({ model: "task", data: { id: "task:5", label: "Five", objectiveId: "objective:goal" }, namespace: "datafn" });
    // task:1 and task:5 share objective:goal; a label pre-filter would drop task:5.
    const res = await query(server, {
      resource: "task",
      filters: { label: "One", objective: { $any: { tasks: { $any: { label: "Five" } } } } },
      select: ["id"],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ids(res.body.result)).toEqual(["task:1"]);
  });

  it("a many-many related record's visibility is checked on the resource its id resolves to", async () => {
    const schema: DatafnSchema = {
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "objective"
          ? {
              ...resource,
              capabilities: ["audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
            }
          : resource,
      ) as DatafnSchema["resources"],
    };
    const { db, server } = await createServer({ schema });
    const seed = (model: string, data: Json) => db.create({ model, data, namespace: "datafn" });
    // A readable node holds the same id as the unreadable objective task:3 links to.
    await seed("objective", { id: "objective:secret", label: "Shared" });
    await seed("node", { id: "objective:secret", label: "Shared" });
    await seed("record_links", { id: "rl3", in: "task:3", out: "objective:secret" });
    const body = { resource: "task", filters: { links: { $any: { label: "Shared" } } }, select: ["id"], sort: ["id:asc"] };
    expect(classifyQuery(body, schema)).toBe("FULL_PUSHDOWN");
    const pushed = await query(server, body);
    const inMemory = await query(server, withForcedInMemory(body));
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect(pushed.body.result).toEqual(inMemory.body.result);
    expect(pushed.body.result.data).toEqual([]);
  });

  it("$like in a relation sub-filter stays in memory and still matches", async () => {
    const body = { resource: "node", filters: { collections: { $any: { label: { $like: "Wo%" } } } }, select: ["id"], sort: ["id:asc"] };
    expect(classifyQuery(body, SCHEMA)).toBe("IN_MEMORY");
    const { server } = await createServer();
    const res = await query(server, body);
    expect(res.status).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:1", "node:3"]);
  });

  it("an in-memory self-relation filter sees primary records the other filters exclude", async () => {
    const { server } = await createServer();
    // node:1 (empty metaType) has children Bravo and Charlie; Charlie's
    // metaType is not empty, so pre-filtering the nodes would hide it.
    const res = await query(server, {
      resource: "node",
      filters: { metaType: { $is_empty: true }, childNodes: { $all: { label: "Bravo" } } },
      select: ["id"],
    });
    expect(res.status).toBe(200);
    expect(res.body.result.data).toEqual([]);
  });

  it("an in-memory query selecting a self relation sees primary records the filters exclude", async () => {
    const { server } = await createServer();
    // `$all` keeps the query in memory; node:3 (metaType "daily") is a child
    // of node:1 that a metaType pre-filter would drop from the store.
    const res = await query(server, {
      resource: "node",
      filters: { metaType: { $is_empty: true }, label: "Alpha", collections: { $all: { label: "Work" } } },
      select: ["id", "childNodes.*"],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:1"]);
    const children = (res.body.result.data[0].childNodes as Json[]).map((row) => row.id).sort();
    expect(children).toEqual(["node:2", "node:3"]);
  });

  it("$all, multi-quantifier objects and dot paths stay in memory", () => {
    expect(classifyQuery({ resource: "node", filters: { collections: { $all: { label: "Work" } } } }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "node", filters: { collections: { $any: { label: "Work" }, $none: { label: "Home" } } } }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "task", filters: { "objective.label": "Goal" } }, SCHEMA)).toBe("IN_MEMORY");
    // `$none` with the foreign key on the primary needs `fk IS NULL OR fk NOT IN`.
    expect(classifyQuery({ resource: "task", filters: { objective: { $none: { label: "Goal" } } } }, SCHEMA)).toBe("IN_MEMORY");
  });
});

describe("filter on a field named like its many-one relation (node.parent)", () => {
  it("filters the parent field by value instead of rejecting the query", async () => {
    const { db, server } = await createServer();
    const spy = vi.spyOn(db as Adapter, "findMany");
    const res = await query(server, { resource: "node", filters: { parent: "node:1" }, sort: ["id:asc"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:2", "node:3"]);
    expect(pushdownReads(spy, "node")[0].where).toEqual([{ field: "parent", operator: "eq", value: "node:1" }]);
  });

  it("supports operators on the field", async () => {
    expect(ids(await expectParity({
      resource: "node",
      filters: { parent: { $in: ["node:1", "node:2"] } },
      sort: ["id:asc"],
    }))).toEqual(["node:2", "node:3", "node:5"]);
    expect(ids(await expectParity({
      resource: "node",
      filters: { parent: { $is_empty: true } },
      sort: ["id:asc"],
    }))).toEqual(["node:1", "node:4", "node:6", "node:8"]);
  });

  it("treats array shorthand on the field as a value list", async () => {
    const { db, server } = await createServer();
    const spy = vi.spyOn(db as Adapter, "findMany");
    const res = await query(server, { resource: "node", filters: { parent: ["node:1", "node:2"] }, sort: ["id:asc"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:2", "node:3", "node:5"]);
    expect(pushdownReads(spy, "node")[0].where).toEqual([{ field: "parent", operator: "in", value: ["node:1", "node:2"] }]);
    expect(ids(await expectParity({ resource: "node", filters: { parent: ["node:1", "node:2"] }, sort: ["id:asc"] })))
      .toEqual(["node:2", "node:3", "node:5"]);
  });

  it("keeps quantifier objects as relation filters", async () => {
    const result = await expectParity({
      resource: "node",
      filters: { parent: { $any: { label: "Alpha" } } },
      sort: ["id:asc"],
    });
    expect(ids(result)).toEqual(["node:2", "node:3"]);
  });

  it("still rejects a scalar value for a relation without a same-named foreign key", async () => {
    const { server } = await createServer();
    const res = await query(server, { resource: "node", filters: { collections: "collection:work" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Relation filter must be object");
  });

  it("selects `parent.*` of a many-one relation through push-down", async () => {
    const { server } = await createServer();
    const body = {
      resource: "node",
      filters: { collections: { $any: { id: "collection:work" } } },
      select: ["id", "label", "parent.*"],
      sort: ["id:asc"],
    };
    expect(classifyQuery(body, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
    const pushed = await query(server, body);
    expect(pushed.status).toBe(200);
    const inMemory = await query(server, withForcedInMemory(body));
    expect(pushed.body.result).toEqual(inMemory.body.result);
    const node3 = (pushed.body.result.data as Json[]).find((row) => row.id === "node:3");
    expect(node3?.parent).toMatchObject({ id: "node:1", label: "Alpha" });
  });

  it("selects `parent.*` beside the self inverse `childNodes.*` without losing the parent", async () => {
    const { server } = await createServer();
    // node:5 has parent node:2 and no children.
    for (const select of [["id", "parent.*", "childNodes.*"], ["id", "childNodes.*", "parent.*"]]) {
      const body = { resource: "node", filters: { label: "Echo" }, select };
      expect(classifyQuery(body, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
      const pushed = await query(server, body);
      expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
      const [row] = pushed.body.result.data as Json[];
      expect(row.parent).toMatchObject({ id: "node:2", label: "Bravo" });
      expect(row.childNodes).toEqual([]);
    }
  });

  it("selects `parent.childNodes.*` through push-down with every sibling", async () => {
    const { server } = await createServer();
    // node:3's parent node:1 has children node:2 and node:3.
    const body = { resource: "node", filters: { label: "Charlie" }, select: ["id", "parent.childNodes.*"] };
    expect(classifyQuery(body, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
    const pushed = await query(server, body);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    const inMemory = await query(server, withForcedInMemory(body));
    expect(pushed.body.result).toEqual(inMemory.body.result);
    const siblings = (pushed.body.result.data[0].parent.childNodes as Json[]).map((row) => row.id).sort();
    expect(siblings).toEqual(["node:2", "node:3"]);
  });

  it("selects the inverse of a many-one relation without fkField through its default foreign key", async () => {
    // Without fkField the foreign key is `${relation}Id` (objectiveId).
    const schema: DatafnSchema = {
      ...SCHEMA,
      relations: SCHEMA.relations!.map((relation: any) =>
        relation.relation === "objective" ? { ...relation, fkField: undefined } : relation,
      ) as DatafnSchema["relations"],
    };
    const { server } = await createServer({ schema });
    const body = { resource: "objective", filters: { id: "objective:goal" }, select: ["id", "tasks.*"] };
    expect(classifyQuery(body, schema)).toBe("PARTIAL_PUSHDOWN");
    const pushed = await query(server, body);
    expect(pushed.status, JSON.stringify(pushed.body)).toBe(200);
    expect((pushed.body.result.data[0].tasks as Json[]).map((row) => row.id)).toEqual(["task:1"]);
  });

  it("loads inverse one-many relations through the default `${inverse}Id` foreign key", async () => {
    // objective.tasks as a one-many without fkField: tasks store objectiveId.
    const schema: DatafnSchema = {
      ...SCHEMA,
      relations: SCHEMA.relations!.map((relation: any) =>
        relation.relation === "objective"
          ? { from: "objective", to: "task", type: "one-many", relation: "tasks", inverse: "objective" }
          : relation,
      ) as DatafnSchema["relations"],
    };
    const { server } = await createServer({ schema });
    const tasks = { resource: "task", filters: { id: "task:1" }, select: ["id", "objective.*"] };
    expect(classifyQuery(tasks, schema)).toBe("PARTIAL_PUSHDOWN");
    const res = await query(server, tasks);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.data[0].objective).toMatchObject({ id: "objective:goal" });
    const nested = { resource: "objective", filters: { id: "objective:other" }, select: ["id", "tasks.objective.*"] };
    expect(classifyQuery(nested, schema)).toBe("PARTIAL_PUSHDOWN");
    const res2 = await query(server, nested);
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    expect(res2.body.result.data[0].tasks[0].objective).toMatchObject({ id: "objective:other" });
  });

  it("accepts a scalar filter on an undeclared field named like its many-one relation", async () => {
    const schema: DatafnSchema = {
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "node" ? { ...resource, fields: resource.fields.filter((f) => f.name !== "parent") } : resource,
      ) as DatafnSchema["resources"],
    };
    const { server } = await createServer({ schema });
    const res = await query(server, { resource: "node", filters: { parent: "node:1" }, select: ["id"], sort: ["id:asc"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(ids(res.body.result)).toEqual(["node:2", "node:3"]);
  });

  it("an in-memory groupBy through a self relation keeps related primary records", async () => {
    const schema: DatafnSchema = {
      ...SCHEMA,
      relations: [
        ...SCHEMA.relations!,
        { from: "node", to: "node", type: "many-one", relation: "manager", inverse: "reports", fkField: "managerId" },
      ] as DatafnSchema["relations"],
    };
    const { db, server } = await createServer({ schema });
    // node:7 (empty metaType) reports to node:3, whose metaType "daily" a
    // metaType pre-filter would drop.
    await db.update({ model: "node", where: [{ field: "id", operator: "eq", value: "node:7" }], data: { managerId: "node:3" }, namespace: "datafn" });
    const res = await query(server, {
      resource: "node",
      filters: { metaType: { $is_empty: true }, label: { $is_null: true } },
      groupBy: ["manager.label"],
      aggregations: { n: { op: "count", field: "id" } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.groups).toEqual([{ "manager.label": "Charlie", n: 1 }]);
  });

  it("detects self-relation paths in groupBy, string and object sort terms, and aggregation fields", async () => {
    const { queryPathsReadPrimaryThroughRelation } = await import("../src/execution/query/filter-plan.js");
    const detects = (query: Json) => queryPathsReadPrimaryThroughRelation(query, "node", SCHEMA);
    expect(detects({ groupBy: ["childNodes.label"] })).toBe(true);
    expect(detects({ sort: ["-childNodes.label:desc"] })).toBe(true);
    expect(detects({ sort: [{ field: "childNodes.label", direction: "asc" }] })).toBe(true);
    expect(detects({ aggregations: { n: { op: "count", field: "childNodes.id" } } })).toBe(true);
    expect(detects({ groupBy: ["collections.label"], sort: [{ field: "label", direction: "asc" }] })).toBe(false);
  });

  it("expands a select path deeper than two relations in memory", async () => {
    const { server } = await createServer();
    // node:7 → node:3 → node:1; node:5 → node:2 → node:1.
    expect(classifyQuery({ resource: "node", select: ["id", "parent.parent.*"] }, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
    // An ids-only terminal many-one reads the foreign key of the second level.
    expect(classifyQuery({ resource: "node", select: ["id", "parent.parent.parent"] }, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
    expect(classifyQuery({ resource: "node", select: ["id", "parent.parent.childNodes"] }, SCHEMA)).toBe("IN_MEMORY");
    // A deep path through other resources keeps the partial push-down
    // loader; one that leads back to the primary resource runs in memory.
    expect(classifyQuery({ resource: "task", select: ["id", "objective.collections.items.*"] }, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
    expect(classifyQuery({ resource: "task", select: ["id", "objective.tasks.objective.*"] }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "node", select: ["id", "parent.collections.items.*"] }, SCHEMA)).toBe("IN_MEMORY");
    // `links` can target task, but task has no `collections`: only the node
    // and objective routes continue, and they never return to task.
    expect(classifyQuery({ resource: "task", select: ["id", "links.collections.items.*"] }, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
    // A terminal ids-only many-one back to the primary reads a foreign key of
    // the second level and loads nothing more.
    const chain = {
      resources: ["a", "b", "c"].map((name) => ({ name, version: 1, fields: [] })),
      relations: [
        { from: "a", to: "b", type: "many-one", relation: "target", inverse: "sources", fkField: "targetId" },
        { from: "b", to: "c", type: "many-one", relation: "c", inverse: "bs", fkField: "cId" },
        { from: "c", to: "b", type: "many-one", relation: "d", inverse: "cs", fkField: "dId" },
        { from: "b", to: "a", type: "many-one", relation: "owner", inverse: "owned", fkField: "ownerId" },
      ],
    } as unknown as DatafnSchema;
    expect(classifyQuery({ resource: "a", select: ["id", "target.c.d.owner"] }, chain)).toBe("PARTIAL_PUSHDOWN");
    expect(classifyQuery({ resource: "a", select: ["id", "target.c.d.owner.*"] }, chain)).toBe("IN_MEMORY");
    const body = { resource: "node", filters: { label: { $in: ["Echo"] } }, select: ["id", "parent.parent.childNodes.*"] };
    expect(classifyQuery(body, SCHEMA)).toBe("IN_MEMORY");
    const res = await query(server, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const grandchildren = (res.body.result.data[0].parent.parent.childNodes as Json[]).map((row) => row.id).sort();
    expect(grandchildren).toEqual(["node:2", "node:3"]);
  });

  it("selecting a relation stored under its own field name needs read access to that field", async () => {
    const withPolicy = (readFields: string[]): DatafnSchema => ({
      ...SCHEMA,
      resources: SCHEMA.resources.map((resource) =>
        resource.name === "node"
          ? { ...resource, permissions: { read: { fields: readFields }, write: { fields: [] } } }
          : resource,
      ) as DatafnSchema["resources"],
    });
    const denied = await createServer({ schema: withPolicy(["id", "label"]) });
    for (const select of [["id", "parent"], ["id", "parent.*"], ["id", "parent.label"]]) {
      const res = await query(denied.server, { resource: "node", filters: { label: "Echo" }, select });
      expect(res.status, JSON.stringify(select)).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }
    // Other relations are unaffected.
    const childNodes = await query(denied.server, { resource: "node", filters: { label: "Alpha" }, select: ["id", "childNodes"] });
    expect(childNodes.status).toBe(200);
    // Both scalar and quantified predicates need read access to the key.
    const policy = withPolicy(["id", "label"]);
    const withoutDeclaration = {
      ...policy,
      resources: policy.resources.map((r) =>
        r.name === "node" ? { ...r, fields: r.fields.filter((f) => f.name !== "parent") } : r),
    };
    for (const schema of [policy, withoutDeclaration]) {
      const { server } = await createServer({ schema });
      const res = await query(server, { resource: "node", filters: { parent: "node:1" }, select: ["id"], count: true });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      const quantified = await query(server, { resource: "node", filters: { parent: { $any: { label: "Alpha" } } }, select: ["id"] });
      expect(quantified.status, JSON.stringify(quantified.body)).toBe(403);
    }
    const allowed = await createServer({ schema: withPolicy(["id", "label", "parent"]) });
    const res = await query(allowed.server, { resource: "node", filters: { label: "Echo" }, select: ["id", "parent.*"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result.data[0].parent).toMatchObject({ id: "node:2" });
  });

  it("an HTREE `parent.*` token still runs in memory", () => {
    expect(classifyQuery({ resource: "objective", select: ["*", "parent.*"] }, SCHEMA)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "node", select: ["*", "parent.*"] }, SCHEMA)).toBe("PARTIAL_PUSHDOWN");
  });
});

it("uses the same declared endpoint for legacy IDs in query and transact", async () => {
  const schema: DatafnSchema = {
    ...SCHEMA,
    relations: [...(SCHEMA.relations ?? []), {
      type: "many-one",
      from: "task",
      to: ["node", "objective"],
      relation: "relatedItem",
      inverse: "relatedTasks",
      fkField: "itemId",
      fkResourceField: "itemResource",
    }, {
      type: "many-one",
      from: "task",
      to: ["node", "objective"],
      inverse: "linkedTasks",
    }, {
      type: "one-many",
      from: ["node", "objective"],
      to: "task",
      relation: "containedTasks",
      inverse: "container",
      fkField: "container",
    }],
  };
  const { db, server } = await createServer({ schema });
  await db.create({ model: "objective", namespace: "datafn", data: { id: "legacy-item", label: "Goal" } });
  await db.create({ model: "node", namespace: "datafn", data: { id: "legacy-item", label: "Node" } });
  await db.create({ model: "task", namespace: "datafn", data: { id: "task:legacy", label: "Unqualified", itemId: "legacy-item" } });
  await db.create({ model: "task", namespace: "datafn", data: {
    id: "task:explicit",
    label: "Linked",
    itemId: "legacy-item",
    itemResource: "objective",
    nodeId: "legacy-item",
    targetResource: "objective",
    container: "legacy-item",
    containerResource: "objective",
  } });
  await db.create({ model: "task", namespace: "datafn", data: { id: "task:qualified", itemId: "objective:goal" } });
  const body = {
    resource: "task",
    version: 1,
    select: ["id"],
    sort: ["id:asc"],
    filters: { relatedItem: { $any: { label: "Goal" } } },
  };
  const inverse = {
    version: 1,
    select: ["id"],
    filters: { relatedTasks: { $any: { label: "Linked" } } },
  };
  for (const [request, data] of [
    [body, [{ id: "task:explicit" }, { id: "task:qualified" }]],
    [{ ...inverse, resource: "objective" }, [{ id: "legacy-item" }]],
    [{ ...inverse, resource: "node" }, []],
    [{ ...inverse, resource: "objective", filters: { linkedTasks: { $any: { label: "Linked" } } } }, [{ id: "legacy-item" }]],
    [{ ...inverse, resource: "node", filters: { linkedTasks: { $any: { label: "Linked" } } } }, []],
    [{ ...body, filters: { container: { $any: { label: "Goal" } } } }, [{ id: "task:explicit" }]],
    [{ ...inverse, resource: "objective", filters: { containedTasks: { $any: { label: "Linked" } } } }, [{ id: "legacy-item" }]],
    [{ ...inverse, resource: "node", filters: { containedTasks: { $any: { label: "Linked" } } } }, []],
  ] as const) {
    const standalone = await query(server, request);
    const response = await server.router.handle(new Request("http://localhost/datafn/transact", {
      method: "POST",
      body: JSON.stringify({ atomic: false, steps: [{ query: request }] }),
    }));
    const transaction = await response.json();
    expect(standalone.status).toBe(200);
    expect(response.status).toBe(200);
    expect(standalone.body.result.data).toEqual(data);
    expect(transaction.result.results[0].data).toEqual(data);
  }

  const owner = { resource: "task", version: 1, filters: { id: "task:explicit" } };
  const forward = { ...owner, select: ["id", "relatedItem.label", "container.*"] };
  expect(classifyQuery(forward, schema)).toBe("PARTIAL_PUSHDOWN");
  const inverseSelect = ["id", "linkedTasks", "containedTasks.*"];
  for (const [request, expected] of [
    [forward, { relatedItem: { id: "legacy-item", label: "Goal" }, container: { id: "legacy-item", label: "Goal" } }],
    [{ ...forward, filters: { $and: [owner.filters, body.filters] } },
      { relatedItem: { id: "legacy-item", label: "Goal" }, container: { id: "legacy-item", label: "Goal" } }],
    [{ resource: "objective", version: 1, filters: { id: "legacy-item" }, select: inverseSelect },
      { linkedTasks: ["task:explicit"], containedTasks: [{ id: "task:explicit" }] }],
    [{ resource: "node", version: 1, filters: { id: "legacy-item" }, select: inverseSelect },
      { linkedTasks: [], containedTasks: [] }],
  ] as const) {
    const standalone = await query(server, request);
    const response = await server.router.handle(new Request("http://localhost/datafn/transact", {
      method: "POST",
      body: JSON.stringify({ atomic: false, steps: [{ query: request }] }),
    }));
    const transaction = await response.json();
    expect(standalone.status).toBe(200);
    expect(response.status).toBe(200);
    expect(standalone.body.result.data[0]).toMatchObject(expected);
    expect(transaction.result.results[0].data).toEqual(standalone.body.result.data);
  }
});

it("preserves both resource discriminators on inverse predicates", async () => {
  const schema: DatafnSchema = {
    ...SCHEMA,
    resources: SCHEMA.resources.map((resource) => {
      if (resource.name === "objective") return { ...resource, permissions: { read: { fields: ["label"] } } };
      if (resource.name === "node") return { ...resource, permissions: { read: { fields: ["label", "metaType"] } } };
      return resource;
    }),
    relations: [...(SCHEMA.relations ?? []), {
      type: "many-many",
      from: ["node", "objective", "collection"],
      to: ["task", "collection"],
      relation: "entryGroups",
      inverse: "entries",
      joinTable: "test_entries",
    }],
  };
  const { db, server } = await createServer({ schema });
  const seed = (model: string, data: Record<string, unknown>) =>
    db.create({ model, namespace: "datafn", data });
  await seed("objective", { id: "legacy-entry", label: "Legacy entry", parentId: "objective:parent" });
  await seed("node", { id: "legacy-entry", label: "Node entry", metaType: "note" });
  await seed("collection", { id: "legacy-target", label: "Linked collection" });
  await seed("task", { id: "legacy-target", label: "Unlinked task" });
  await seed("test_entries", {
    id: "test-join",
    from: "legacy-entry",
    fromResource: "objective",
    to: "legacy-target",
    toResource: "collection",
  });
  await seed("test_entries", {
    id: "test-node-join",
    from: "legacy-entry",
    fromResource: "node",
    to: "legacy-target",
    toResource: "collection",
  });

  for (const resource of ["collection", "task"]) {
    const body = {
      resource,
      version: 1,
      select: ["id"],
      filters: { entries: { $any: { label: "Legacy entry" } } },
    };
    const expected = resource === "collection" ? [{ id: "legacy-target" }] : [];
    const pushed = await query(server, body);
    const response = await server.router.handle(new Request("http://localhost/datafn/transact", {
      method: "POST",
      body: JSON.stringify({ atomic: false, steps: [{ query: body }] }),
    }));
    const transaction = await response.json();
    expect(pushed.status).toBe(200);
    expect(response.status).toBe(200);
    expect(pushed.body.result.data).toEqual(expected);
    expect(transaction.result.results[0].data).toEqual(expected);
  }

  const forward = {
    resource: "objective",
    version: 1,
    select: ["id"],
    filters: { entryGroups: { $any: { label: "Linked collection" } } },
  };
  const pushed = await query(server, forward);
  expect(pushed.status).toBe(200);
  expect(pushed.body.result.data).toEqual([{ id: "legacy-entry" }]);

  const linked = { resource: "collection", version: 1, filters: { id: "legacy-target" } };
  const selections = [
    ["id", "entries.#"],
    ["id", "entries.*"],
    ["id", "entries.*#"],
    ["id", "entries.id", "entries.label"],
  ];
  const response = await server.router.handle(new Request("http://localhost/datafn/transact", {
    method: "POST",
    body: JSON.stringify({
      atomic: false,
      steps: [
        { query: forward },
        { query: { resource: "task", version: 1, select: ["id", "entries.#"], filters: { id: "legacy-target" } } },
        ...selections.map((select) => ({ query: { ...linked, select } })),
      ],
    }),
  }));
  const transaction = await response.json();
  expect(response.status).toBe(200);
  expect(transaction.result.results[0].data).toEqual(pushed.body.result.data);
  expect(transaction.result.results[1].data).toEqual([{ id: "legacy-target", entries: [] }]);
  expect(transaction.result.results[2].data[0].entries).toHaveLength(2);
  for (const result of transaction.result.results.slice(3)) {
    expect(result.data[0].entries.map((entry: { label: string }) => entry.label).sort())
      .toEqual(["Legacy entry", "Node entry"]);
  }
  expect(classifyQuery({ ...linked, select: selections[1] }, schema)).toBe("PARTIAL_PUSHDOWN");
  for (const [index, select] of selections.entries()) {
    const result = await query(server, { ...linked, select });
    expect(result.status).toBe(200);
    expect(result.body.result.data).toEqual(transaction.result.results[index + 2].data);
    if (index === 1 || index === 2) {
      const entries = result.body.result.data[0].entries as Json[];
      expect(entries.find((entry) => entry.label === "Legacy entry")).not.toHaveProperty("parentId");
      expect(entries.find((entry) => entry.label === "Node entry")).toHaveProperty("metaType", "note");
    }
  }

  const join = { from: "legacy-entry", to: "legacy-target" };
  for (const [resource, relation, id, data] of [
    ["objective", "entryGroups", "legacy-entry", [join]],
    ["collection", "entries", "legacy-target", [join, join]],
    ["task", "entries", "legacy-target", []],
  ] as const) {
    const result = await query(server, { resource, relation, id, version: 1, select: ["#"], count: true });
    expect(result.status).toBe(200);
    expect(result.body.result).toEqual({ data, nextCursor: null, count: data.length });
  }
});

describe("relation expansion by name for in-memory queries", () => {
  it("expands task.objective (many-one) although a many-many relation to objective is declared first", async () => {
    const { server } = await createServer();
    const body = { resource: "task", select: ["*", "objective.*"], sort: ["id:asc"] };
    const expected = [
      { id: "task:1", objective: { id: "objective:goal", label: "Goal" } },
      { id: "task:2", objective: { id: "objective:other", label: "Other" } },
    ];
    // In memory (forced) and through partial push-down.
    for (const request of [withForcedInMemory(body), body]) {
      const res = await query(server, request);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.result.data.slice(0, 2)).toMatchObject(expected);
    }
  });

  it("loads both relations when a query selects a many-one and a many-many to the same resource", async () => {
    const { server } = await createServer();
    // Only task:1, whose link points at a different objective than its many-one.
    const res = await query(server, withForcedInMemory({
      resource: "task",
      filters: { id: "task:1" },
      select: ["id", "objective.*", "links.*"],
    }));
    expect(res.status).toBe(200);
    expect(res.body.result.data[0]).toMatchObject({
      id: "task:1",
      objective: { id: "objective:goal" },
      links: [{ id: "objective:other" }],
    });
  });
});
