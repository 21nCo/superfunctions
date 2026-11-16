/**
 * Direct-mode query costs and limits:
 * - the namespace owner's query on a private shareable resource reads no
 *   owned-row id list and adds no `id IN` filter, and sees rows whose
 *   createdBy is unset;
 * - other actors are still limited to their own and granted rows;
 * - an `$in` list too long for one bound-parameter list stays in memory;
 * - a temporal storage hint that cannot match a numeric field is rejected.
 */

import { afterEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { createDatafnServer } from "../../server.js";
import type { DatafnSchema } from "../../core-types.js";
import {
  MAX_PUSHDOWN_IN_VALUES,
  classifyQuery,
  convertDfqlFilters,
  extractPushableFilters,
} from "../../execution/query/planner.js";
import { validateQuery } from "../../validation/query.js";
import { buildSchemaIndex } from "../../validation/index.js";
import { validateSchema } from "@datafn/core";

const NAMESPACE = "user:alice";

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      capabilities: [
        "timestamps",
        "audit",
        { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } },
      ] as any,
      fields: [
        { name: "title", type: "string", required: true },
        { name: "score", type: "number", required: false },
        { name: "dueOn", type: "string", required: false },
        { name: "remindAt", type: "date", required: false },
      ],
    },
  ],
  relations: [],
};

type FindManyCall = { model: string; where?: Array<{ field: string; operator: string; value: unknown }> };

async function createHarness(actor: string) {
  const base = memoryAdapter();
  await base.initialize?.();
  await base.create({
    model: "notes",
    data: { __ns: NAMESPACE, id: "n_owned", title: "owned", createdBy: "alice" },
    namespace: NAMESPACE,
  });
  await base.create({
    model: "notes",
    data: { __ns: NAMESPACE, id: "n_migrated", title: "migrated", createdBy: null },
    namespace: NAMESPACE,
  });
  await base.create({
    model: "notes",
    data: { __ns: NAMESPACE, id: "n_bob", title: "bob's", createdBy: "bob" },
    namespace: NAMESPACE,
  });

  const calls: FindManyCall[] = [];
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "findMany") {
        return (args: FindManyCall) => {
          calls.push(args);
          return (value as Function).call(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Adapter;

  const server = await createDatafnServer({
    allowUnknownResources: true,
    schema,
    database: db,
    namespaceProvider: {
      getNamespace: () => NAMESPACE,
      getActorId: () => actor as any,
    },
  });
  return { server, calls, base };
}

async function query(server: any, payload: Record<string, unknown>) {
  const res = await server.router.handle(
    new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    {},
  );
  return { status: res.status as number, body: (await res.json()) as any };
}

function idInFilters(calls: FindManyCall[]) {
  return calls.flatMap((call) =>
    (call.where ?? []).filter((clause) => clause.field === "id" && clause.operator === "in"),
  );
}

describe("query access for the namespace owner", () => {
  let server: any;
  afterEach(async () => {
    await server?.close?.();
  });

  it("reads no owned-row list, adds no id filter and returns rows without createdBy", async () => {
    const harness = await createHarness("alice");
    server = harness.server;

    const { status, body } = await query(server, { resource: "notes", version: 1 });

    expect(status).toBe(200);
    const ids = (body.result.data as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual(["n_bob", "n_migrated", "n_owned"]);
    expect(
      harness.calls.filter((call) => call.where?.some((clause) => clause.field === "createdBy")),
    ).toEqual([]);
    expect(idInFilters(harness.calls)).toEqual([]);
  });

  it("still limits another actor to the rows it created", async () => {
    const harness = await createHarness("bob");
    server = harness.server;

    const { status, body } = await query(server, { resource: "notes", version: 1 });

    expect(status).toBe(200);
    expect((body.result.data as Array<{ id: string }>).map((r) => r.id)).toEqual(["n_bob"]);
  });
});

describe("non-owner access lists", () => {
  let server: any;
  afterEach(async () => {
    await server?.close?.();
  });

  it("pushes an access list of 1,500 ids down as one filter", async () => {
    const harness = await createHarness("bob");
    server = harness.server;
    const extra = 1500;
    for (let i = 0; i < extra; i++) {
      await harness.base.create({
        model: "notes",
        data: { __ns: NAMESPACE, id: `n_bob_${String(i).padStart(5, "0")}`, title: "b", createdBy: "bob" },
        namespace: NAMESPACE,
      });
    }
    harness.calls.length = 0;

    const { status, body } = await query(server, {
      resource: "notes",
      version: 1,
      filters: { title: "b" },
      sort: ["id:desc"],
      limit: 3,
    });

    expect(status).toBe(200);
    expect((body.result.data as Array<{ id: string }>).map((r) => r.id)).toEqual([
      `n_bob_${String(extra - 1).padStart(5, "0")}`,
      `n_bob_${String(extra - 2).padStart(5, "0")}`,
      `n_bob_${String(extra - 3).padStart(5, "0")}`,
    ]);
    // One owned-row read plus the pushed-down query; no full-table load.
    const noteReads = harness.calls.filter((call) => call.model === "notes");
    expect(noteReads.every((call) => (call.where ?? []).some((c) => c.field !== "__ns"))).toBe(true);
    // The pushed-down statement carries the complete access list (every
    // clause holds all of bob's ids; none is split or truncated).
    const accessFilters = idInFilters(harness.calls);
    expect(accessFilters.length).toBeGreaterThan(0);
    for (const clause of accessFilters) {
      expect(clause.value).toHaveLength(extra + 1);
    }
  });

  it("ignores access fields a client puts in query metadata", async () => {
    const harness = await createHarness("bob");
    server = harness.server;

    const { status, body } = await query(server, {
      resource: "notes",
      version: 1,
      metadata: { hasShareableScopeAccess: true, shareableAccessIds: ["n_owned"] },
    });

    expect(status).toBe(200);
    expect((body.result.data as Array<{ id: string }>).map((r) => r.id)).toEqual(["n_bob"]);
  });
});

describe("oversized $in lists", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id_${i}`);

  it("pushes an $in list up to the limit", () => {
    expect(convertDfqlFilters({ id: { $in: ids(MAX_PUSHDOWN_IN_VALUES) } })).toEqual([
      { field: "id", operator: "in", value: ids(MAX_PUSHDOWN_IN_VALUES) },
    ]);
  });

  it("keeps $in lists that together exceed the budget in memory", () => {
    const half = Math.floor(MAX_PUSHDOWN_IN_VALUES / 2) + 1;
    const filters = { $and: [{ id: { $in: ids(half) } }, { title: { $in: ids(half) } }] };
    expect(classifyQuery({ resource: "notes", filters })).toBe("IN_MEMORY");
    const split = extractPushableFilters(filters);
    expect(split.pushable).toEqual([{ field: "id", operator: "in", value: ids(half) }]);
    expect(split.remaining).toEqual({ $and: [{ title: { $in: ids(half) } }] });
  });

  it("classifies filters the pushdown converter cannot express as in-memory", () => {
    const relSchema = {
      resources: [
        { name: "notes", version: 1, fields: [] },
        { name: "tags", version: 1, fields: [] },
      ],
      relations: [{ from: "notes", to: "tags", type: "many-many", relation: "tags" }],
    };
    expect(classifyQuery({ resource: "notes", filters: { tags: "t1" } }, relSchema)).toBe("IN_MEMORY");
    expect(classifyQuery({ resource: "notes", filters: { $and: "x" } }, relSchema)).toBe("IN_MEMORY");
  });

  it("keeps a longer $in list in memory", () => {
    const long = ids(MAX_PUSHDOWN_IN_VALUES + 1);
    expect(convertDfqlFilters({ id: { $in: long } })).toBeNull();
    const split = extractPushableFilters({
      $and: [{ title: "a" }, { id: { $in: long } }],
    });
    expect(split.pushable).toEqual([{ field: "title", operator: "eq", value: "a" }]);
    expect(split.remaining).toEqual({ $and: [{ id: { $in: long } }] });
  });
});

describe("temporal storage hints", () => {
  function validate(temporal: Record<string, unknown>) {
    return validateQuery({ resource: "notes", version: 1, temporal }, buildSchemaIndex(schema));
  }

  it("rejects a date or iso hint on a capability date field", async () => {
    for (const storage of ["date", "iso"]) {
      const result: any = validate({
        field: "createdAt",
        storage,
        period: { scale: "day" },
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("DFQL_INVALID");
      expect(result.error.path).toBe("temporal.storage");
    }
  });

  it("rejects a mismatched hint on a capability date field in the normalized schema", () => {
    // validateSchema copies capability fields into resource.fields, as the
    // server does before building its schema index.
    const normalized: any = validateSchema(schema as any);
    expect(normalized.ok).toBe(true);
    for (const storage of ["date", "iso", "unix-s"]) {
      const result: any = validateQuery(
        {
          resource: "notes",
          version: 1,
          temporal: { field: "createdAt", storage, period: { scale: "day" } },
        },
        buildSchemaIndex(normalized.result),
      );
      expect(result.ok).toBe(false);
      expect(result.error.path).toBe("temporal.storage");
    }
  });

  it("rejects unix-s on a capability date field", () => {
    const result: any = validate({ field: "createdAt", storage: "unix-s", period: { scale: "day" } });
    expect(result.ok).toBe(false);
  });

  it("accepts any storage hint on a user-declared date field", () => {
    for (const storage of ["date", "iso", "unix-s", "unix-ms"]) {
      const result: any = validate({ field: "remindAt", storage, period: { scale: "day" } });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects a date hint on a number field", async () => {
    const result: any = validate({ field: "score", storage: "date", period: { scale: "day" } });
    expect(result.ok).toBe(false);
  });

  it("accepts the default and unix hints on a date field and iso on a string field", async () => {
    for (const temporal of [
      { field: "createdAt", period: { scale: "day" } },
      { field: "createdAt", storage: "unix-ms", period: { scale: "day" } },
      { field: "dueOn", storage: "iso", period: { scale: "day" } },
    ]) {
      const result: any = validate(temporal);
      expect(result.ok).toBe(true);
    }
  });
});

describe("relation loading for an in-memory query", () => {
  it("chunks related-record lookups so an oversized $in still loads every relation", async () => {
    const relSchema: DatafnSchema = {
      resources: [
        { name: "projects", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "tasks",
          version: 1,
          fields: [
            { name: "title", type: "string", required: false },
            { name: "projectId", type: "string", required: false },
          ],
        },
      ],
      relations: [
        {
          from: "tasks",
          to: "projects",
          type: "many-one",
          relation: "project",
          fkField: "projectId",
        } as any,
      ],
    };
    const base = memoryAdapter();
    await base.initialize?.();
    // More tasks (each with its own project) than one bound-parameter chunk.
    const total = 30_005;
    for (let i = 0; i < total; i++) {
      await base.create({ model: "projects", data: { __ns: NAMESPACE, id: `p${i}`, name: `p${i}` }, namespace: NAMESPACE });
      await base.create({
        model: "tasks",
        data: { __ns: NAMESPACE, id: `t${i}`, title: `t${i}`, projectId: `p${i}` },
        namespace: NAMESPACE,
      });
    }
    let largestInList = 0;
    const db = new Proxy(base, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "findMany") {
          return (args: FindManyCall) => {
            for (const clause of args.where ?? []) {
              if (clause.operator === "in" && Array.isArray(clause.value)) {
                largestInList = Math.max(largestInList, clause.value.length);
              }
            }
            return (value as Function).call(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Adapter;
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: relSchema,
      database: db,
      namespaceProvider: { getNamespace: () => NAMESPACE, getActorId: () => "alice" as any },
    });
    try {
      const ids = Array.from({ length: total }, (_, i) => `t${i}`);
      const { status, body } = await query(server, {
        resource: "tasks",
        version: 1,
        filters: { id: { $in: ids } },
        select: ["id", "project.*"],
        sort: ["id"],
        limit: 1,
      });
      expect(status).toBe(200);
      expect(body.result.data[0].project?.id).toBe("p0");
      expect(largestInList).toBeLessThanOrEqual(30_000);
    } finally {
      await (server as any)?.close?.();
    }
  }, 120_000);

  it("loads a nested relation for a query an oversized $in keeps in memory", async () => {
    const relSchema: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "projects",
          version: 1,
          fields: [
            { name: "name", type: "string", required: false },
            { name: "ownerId", type: "string", required: false },
          ],
        },
        {
          name: "tasks",
          version: 1,
          fields: [
            { name: "title", type: "string", required: false },
            { name: "projectId", type: "string", required: false },
          ],
        },
      ],
      relations: [
        { from: "tasks", to: "projects", type: "many-one", relation: "project", fkField: "projectId" } as any,
        { from: "projects", to: "users", type: "many-one", relation: "owner", fkField: "ownerId" } as any,
      ],
    };
    const db = memoryAdapter();
    await db.initialize?.();
    await db.create({ model: "users", data: { __ns: NAMESPACE, id: "u1", name: "Uma" }, namespace: NAMESPACE });
    await db.create({
      model: "projects",
      data: { __ns: NAMESPACE, id: "p1", name: "P1", ownerId: "u1" },
      namespace: NAMESPACE,
    });
    await db.create({
      model: "tasks",
      data: { __ns: NAMESPACE, id: "t1", title: "T1", projectId: "p1" },
      namespace: NAMESPACE,
    });
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema: relSchema,
      database: db,
      namespaceProvider: { getNamespace: () => NAMESPACE, getActorId: () => "alice" as any },
    });
    try {
      const ids = ["t1", ...Array.from({ length: MAX_PUSHDOWN_IN_VALUES }, (_, i) => `missing${i}`)];
      const filters = { id: { $in: ids } };
      expect(classifyQuery({ resource: "tasks", filters }, relSchema)).toBe("IN_MEMORY");
      const { status, body } = await query(server, {
        resource: "tasks",
        version: 1,
        filters,
        select: ["id", "project.*", "project.owner.*"],
      });
      expect(status).toBe(200);
      expect(body.result.data).toHaveLength(1);
      expect(body.result.data[0].project?.id).toBe("p1");
      expect(body.result.data[0].project?.owner?.id).toBe("u1");
    } finally {
      await (server as any)?.close?.();
    }
  });
});
