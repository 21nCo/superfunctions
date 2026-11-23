/**
 * Regression tests for the 2026-11-21 DataFn security audit (DATA-38):
 * DFN-01 (idempotency shared across tenants), DFN-04 (client-supplied actorId
 * on sync routes) and DFN-06 (relation write policy never enforced).
 */
import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../src/server.js";
import { DbIdempotencyStore } from "../src/execution/idempotency-db.js";
import {
  MemoryIdempotencyStore,
  idempotencyRecordId,
  scopeIdempotencyStore,
  type MutationResult,
} from "../src/execution/idempotency.js";

type Ctx = { ns: string; actor?: string };

const shareable = { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } };

const schema: any = {
  resources: [
    {
      name: "people",
      version: 1,
      fields: [
        { name: "name", type: "string", required: true },
        { name: "employerId", type: "string", required: false, nullable: true },
      ],
      permissions: { read: { fields: ["name", "employerId"] }, write: { fields: ["name"] } },
    },
    {
      name: "employers",
      version: 1,
      fields: [{ name: "name", type: "string", required: true }],
      permissions: { read: { fields: ["name"] }, write: { fields: ["name", "staff"] } },
    },
    {
      name: "notes",
      version: 1,
      capabilities: ["timestamps", "audit", shareable],
      fields: [{ name: "title", type: "string", required: true }],
      permissions: { read: { fields: ["title"] }, write: { fields: ["title"] } },
    },
    {
      name: "tags",
      version: 1,
      fields: [{ name: "label", type: "string", required: true }],
      permissions: { read: { fields: ["label"] }, write: { fields: ["label"] } },
    },
    {
      name: "projects",
      version: 1,
      fields: [{ name: "title", type: "string", required: true }],
      permissions: { read: { fields: ["title"] }, write: { fields: ["title", "tags"] } },
    },
  ],
  relations: [
    // "tags" is NOT in people.permissions.write.fields.
    { from: "people", to: "tags", type: "many-many", relation: "tags", inverse: "people" },
    // "tags" IS in projects.permissions.write.fields.
    { from: "projects", to: "tags", type: "many-many", relation: "tags", inverse: "projects" },
    // people hold the FK; only the employers side lists the relation as writable.
    { from: "people", to: "employers", type: "many-one", relation: "employer", inverse: "staff", fkField: "employerId" },
  ],
};

async function harness() {
  const db = memoryAdapter();
  await db.initialize?.();
  const server = await createDatafnServer<Ctx>({
    schema,
    database: db,
    context: (request: Request) => ({
      ns: request.headers.get("x-ns") ?? "tenant:a",
      actor: request.headers.get("x-actor") ?? undefined,
    }),
    authorize: () => true,
    namespaceProvider: {
      getNamespace: (ctx) => ctx.ns,
      getActorId: (ctx) => ctx.actor,
    },
  });
  const call = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await server.router.handle(
      new Request(`http://localhost/datafn/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const rowsIn = (model: string, ns: string) =>
    db.findMany({ model, where: [{ field: "__ns", operator: "eq", value: ns }] } as any);
  return { db, server, call, rowsIn };
}

const tenantA = { "x-ns": "tenant:a", "x-actor": "alice" };
const tenantB = { "x-ns": "tenant:b", "x-actor": "bob" };

describe("DFN-01: idempotency records are scoped to namespace and actor", () => {
  it("/datafn/mutation: another tenant reusing clientId+mutationId gets its own write", async () => {
    const { call, rowsIn, server } = await harness();
    const insert = (id: string, name: string) => ({
      resource: "people", version: 1, operation: "insert", id,
      clientId: "device-1", mutationId: "m-1", record: { name },
    });

    const a = await call("mutation", insert("p-a", "A"), tenantA);
    expect(a.body.result).toMatchObject({ ok: true, deduped: false, affectedIds: ["p-a"] });

    const b = await call("mutation", insert("p-b", "B"), tenantB);
    expect(b.body.result).toMatchObject({ ok: true, deduped: false, affectedIds: ["p-b"] });
    expect(await rowsIn("people", "tenant:b")).toHaveLength(1);

    // A genuine retry from tenant A is still deduplicated.
    const retry = await call("mutation", insert("p-a", "A"), tenantA);
    expect(retry.body.result).toMatchObject({ ok: true, deduped: true, affectedIds: ["p-a"] });
    await server.close();
  });

  it("/datafn/mutation: another user in the same namespace is not deduplicated against", async () => {
    const { call, rowsIn, server } = await harness();
    const insert = (id: string) => ({
      resource: "people", version: 1, operation: "insert", id,
      clientId: "device-1", mutationId: "m-2", record: { name: id },
    });
    await call("mutation", insert("p-1"), tenantA);
    const other = await call("mutation", insert("p-2"), { "x-ns": "tenant:a", "x-actor": "carol" });
    expect(other.body.result).toMatchObject({ ok: true, deduped: false, affectedIds: ["p-2"] });
    expect(await rowsIn("people", "tenant:a")).toHaveLength(2);
    await server.close();
  });

  it("/datafn/push: another tenant's mutation is applied, not reported as a duplicate", async () => {
    const { call, rowsIn, server } = await harness();
    const push = (id: string) => ({
      clientId: "device-1",
      mutations: [{ resource: "people", version: 1, operation: "insert", id, clientId: "device-1", mutationId: "m-9", record: { name: id } }],
    });
    await call("push", push("p-a"), tenantA);
    const b = await call("push", push("p-b"), tenantB);
    expect(b.body.result.applied).toEqual(["m-9"]);
    expect((await rowsIn("people", "tenant:b")).map((r: any) => r.id)).toEqual(["p-b"]);
    await server.close();
  });

  it("/datafn/transact: steps are deduplicated per namespace", async () => {
    const { call, rowsIn, server } = await harness();
    const tx = (id: string) => ({
      atomic: true,
      steps: [{ mutation: { resource: "people", version: 1, operation: "insert", id, clientId: "device-1", mutationId: "m-tx", record: { name: id } } }],
    });
    await call("transact", tx("p-a"), tenantA);
    const b = await call("transact", tx("p-b"), tenantB);
    expect(b.status).toBe(200);
    expect((await rowsIn("people", "tenant:b")).map((r: any) => r.id)).toEqual(["p-b"]);
    await server.close();
  });

  it("DbIdempotencyStore keeps one record per namespace and actor", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const base = new DbIdempotencyStore(db, "datafn");
    const result = (id: string): MutationResult => ({ ok: true, mutationId: "m", affectedIds: [id], errors: [], deduped: false });

    const a = scopeIdempotencyStore(base, { namespace: "tenant:a", actorId: "alice" });
    const b = scopeIdempotencyStore(base, { namespace: "tenant:b", actorId: "alice" });
    const aBob = scopeIdempotencyStore(base, { namespace: "tenant:a", actorId: "bob" });
    await a.set("c", "m", result("a"));
    expect(await b.get("c", "m")).toBeNull();
    expect(await aBob.get("c", "m")).toBeNull();
    await b.set("c", "m", result("b"));
    expect((await a.get("c", "m"))?.affectedIds).toEqual(["a"]);
    expect((await b.get("c", "m"))?.affectedIds).toEqual(["b"]);
    // Scoping is idempotent for the same scope and refuses a different one.
    expect(scopeIdempotencyStore(a, { namespace: "tenant:a", actorId: "alice" })).toBe(a);
    expect(() => scopeIdempotencyStore(a, { namespace: "tenant:b" })).toThrow();

    // The retention pruner covers every namespace.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    for (const row of await db.internal.findMany("__datafn_idempotency", [])) {
      await db.internal.update("__datafn_idempotency", [{ field: "id", op: "eq", value: row.id }], { created_at: old });
    }
    expect(await base.pruneIdempotencyAllNamespaces(7)).toBe(2);
  });

  it("custom stores without scoped() are wrapped with a qualified client id", async () => {
    const store = new MemoryIdempotencyStore();
    const result: MutationResult = { ok: true, mutationId: "m", affectedIds: ["x"], errors: [], deduped: false };
    await scopeIdempotencyStore(store, { namespace: "tenant:a" }).set("c", "m", result);
    expect(await scopeIdempotencyStore(store, { namespace: "tenant:b" }).get("c", "m")).toBeNull();
    expect(await scopeIdempotencyStore(store, { namespace: "tenant:a" }).get("c", "m")).toEqual(result);
    store.destroy();
  });
});

describe("DFN-04: sync routes ignore a client-supplied actorId", () => {
  it("clone, pull and reconcile use the server actor, not the body's", async () => {
    const { db, call, server } = await harness();
    await db.create({ model: "notes", data: { __ns: "tenant:a", id: "n1", title: "alice private", createdBy: "alice" } } as any);
    const anon = { "x-ns": "tenant:a" }; // getActorId -> undefined

    for (const actorId of [undefined, "alice", "tenant:a"]) {
      const clone = await call("clone", { clientId: "c1", tables: ["notes"], ...(actorId ? { actorId } : {}) }, anon);
      expect(clone.body.result.data.notes).toHaveLength(0);
    }

    const reconcile = await call("reconcile", { clientId: "c1", resources: ["notes"], actorId: "alice" }, anon);
    expect(reconcile.body.result.counts.notes ?? 0).toBe(0);

    // A different authenticated user cannot claim alice's identity either.
    const asBob = await call("clone", { clientId: "c1", tables: ["notes"], actorId: "alice" }, { "x-ns": "tenant:a", "x-actor": "bob" });
    expect(asBob.body.result.data.notes).toHaveLength(0);

    // Alice herself still sees her note.
    const asAlice = await call("clone", { clientId: "c1", tables: ["notes"] }, tenantA);
    expect(asAlice.body.result.data.notes.map((r: any) => r.id)).toEqual(["n1"]);
    await server.close();
  });

  it("a throwing getActorId fails the request instead of continuing without an actor", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    await db.create({ model: "notes", data: { __ns: "tenant:a", id: "n1", title: "alice private", createdBy: "alice" } } as any);
    const server = await createDatafnServer<Ctx>({
      schema,
      database: db,
      context: () => ({ ns: "tenant:a" }),
      namespaceProvider: {
        getNamespace: (ctx) => ctx.ns,
        getActorId: () => {
          throw new Error("identity service unavailable");
        },
      },
    });
    const res = await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c1", tables: ["notes"], actorId: "alice" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).ok).toBe(false);
    await server.close();
  });
});

describe("DFN-06: relation write policy is enforced on relations", () => {
  it("relate is denied when the relation is not in permissions.write.fields", async () => {
    const { db, call, server } = await harness();
    await db.create({ model: "people", data: { __ns: "tenant:a", id: "p1", name: "Ann" } } as any);
    await db.create({ model: "tags", data: { __ns: "tenant:a", id: "t1", label: "vip" } } as any);
    for (const operation of ["relate", "modifyRelation", "unrelate"]) {
      const res = await call(
        "mutation",
        { resource: "people", version: 1, operation, id: "p1", relations: { tags: ["t1"] } },
        tenantA,
      );
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
    }
    await server.close();
  });

  it("relate is allowed when the relation is listed", async () => {
    const { db, call, server } = await harness();
    await db.create({ model: "projects", data: { __ns: "tenant:a", id: "pr1", title: "P" } } as any);
    await db.create({ model: "tags", data: { __ns: "tenant:a", id: "t1", label: "vip" } } as any);
    const res = await call(
      "mutation",
      { resource: "projects", version: 1, operation: "relate", id: "pr1", relations: { tags: ["t1"] } },
      tenantA,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.ok).toBe(true);
    await server.close();
  });

  it("listing the inverse relation name on the other side allows it there only", async () => {
    const { db, call, server } = await harness();
    await db.create({ model: "people", data: { __ns: "tenant:a", id: "p1", name: "Ann" } } as any);
    await db.create({ model: "employers", data: { __ns: "tenant:a", id: "e1", name: "Acme" } } as any);
    const fromEmployer = await call(
      "mutation",
      { resource: "employers", version: 1, operation: "relate", id: "e1", relations: { staff: ["p1"] } },
      tenantA,
    );
    expect(fromEmployer.status).toBe(200);
    const fromPerson = await call(
      "mutation",
      { resource: "people", version: 1, operation: "relate", id: "p1", relations: { employer: "e1" } },
      tenantA,
    );
    expect(fromPerson.status).toBe(403);
    await server.close();
  });

  it("push applies the same relation policy", async () => {
    const { db, call, server } = await harness();
    await db.create({ model: "people", data: { __ns: "tenant:a", id: "p1", name: "Ann" } } as any);
    await db.create({ model: "tags", data: { __ns: "tenant:a", id: "t1", label: "vip" } } as any);
    const res = await call(
      "push",
      { clientId: "c1", mutations: [{ resource: "people", version: 1, operation: "relate", id: "p1", clientId: "c1", mutationId: "m-r", relations: { tags: ["t1"] } }] },
      tenantA,
    );
    expect(res.body.result?.applied ?? []).not.toContain("m-r");
    await server.close();
  });
});

describe("DFN-01 follow-ups", () => {
  it("an anonymous caller cannot reproduce an actor's key through a crafted clientId", async () => {
    const { call, rowsIn, server } = await harness();
    const insert = (id: string, clientId: string) => ({
      resource: "people", version: 1, operation: "insert", id,
      clientId, mutationId: "m-anon", record: { name: id },
    });
    await call("mutation", insert("p-alice", "c1"), tenantA);
    const anon = await call("mutation", insert("p-anon", JSON.stringify(["alice", "c1"])), { "x-ns": "tenant:a" });
    expect(anon.body.result).toMatchObject({ ok: true, deduped: false, affectedIds: ["p-anon"] });
    expect((await rowsIn("people", "tenant:a")).map((r: any) => r.id).sort()).toEqual(["p-alice", "p-anon"]);
    await server.close();
  });

  it("DbIdempotencyStore.scoped() called directly is guarded too", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const direct = new DbIdempotencyStore(db, "datafn").scoped!({ namespace: "tenant:a" });
    expect(() => scopeIdempotencyStore(direct, { namespace: "tenant:b" })).toThrow();
    expect(() => direct.scoped!({ namespace: "tenant:b" })).toThrow();
    expect(() => scopeIdempotencyStore(direct.withDb!(db), { namespace: "tenant:b" })).toThrow();
  });

  it("0.2.x records are never matched, even when their columns equal a new key", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const base = new DbIdempotencyStore(db, "datafn");
    await base.ensureReady();
    const stale: MutationResult = { ok: true, mutationId: "m", affectedIds: ["other-tenant"], errors: [], deduped: false };
    // A legacy row whose raw client_id happens to equal the new encoding.
    await db.internal.create("__datafn_idempotency", {
      id: `datafn:${JSON.stringify([null, "c"])}:m`,
      namespace: "datafn",
      client_id: JSON.stringify([null, "c"]),
      mutation_id: "m",
      result: JSON.stringify(stale),
      created_at: new Date().toISOString(),
    });
    const scoped = scopeIdempotencyStore(base, { namespace: "datafn" });
    expect(await scoped.get("c", "m")).toBeNull();
    const fresh: MutationResult = { ok: true, mutationId: "m", affectedIds: ["mine"], errors: [], deduped: false };
    await scoped.set("c", "m", fresh);
    expect(await scoped.get("c", "m")).toEqual(fresh);
    const row = await db.internal.findOne("__datafn_idempotency", [
      { field: "id", op: "eq", value: idempotencyRecordId("datafn", undefined, "c", "m") },
    ]);
    // 0.2.x workers match on client_id/mutation_id, which stay NULL here.
    expect(row?.client_id ?? null).toBeNull();
    expect(row?.mutation_id ?? null).toBeNull();
  });

  it("a scoped store keeps its scope guard after withDb()", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const scoped = scopeIdempotencyStore(new DbIdempotencyStore(db, "datafn"), { namespace: "tenant:a", actorId: "alice" });
    const rebound = scoped.withDb!(db);
    expect(() => scopeIdempotencyStore(rebound, { namespace: "tenant:b" })).toThrow();
    expect(scopeIdempotencyStore(rebound, { namespace: "tenant:a", actorId: "alice" })).toBe(rebound);
  });
});

describe("DFN-04 follow-ups", () => {
  it("search reports a failing getActorId as a server error, not an unsupported query", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await createDatafnServer<Ctx>({
      schema,
      database: db,
      context: () => ({ ns: "tenant:a" }),
      namespaceProvider: {
        getNamespace: (ctx) => ctx.ns,
        getActorId: () => {
          throw new Error("identity service unavailable");
        },
      },
    });
    const res = await server.router.handle(
      new Request("http://localhost/datafn/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(((await res.json()) as any).error.code).toBe("INTERNAL");
    await server.close();
  });
});

describe("DFN-06 follow-ups: FK-named policies and relationWrites", () => {
  const fkSchema: any = {
    resources: [
      {
        name: "tasks",
        version: 1,
        fields: [
          { name: "title", type: "string", required: true },
          { name: "goalId", type: "string", required: false, nullable: true },
        ],
        permissions: { read: { fields: ["title", "goalId"] }, write: { fields: ["title", "goalId"] } },
      },
      {
        name: "goals",
        version: 1,
        fields: [{ name: "name", type: "string", required: true }],
        permissions: { read: { fields: ["name"] }, write: { fields: ["name"] } },
      },
      {
        name: "folders",
        version: 1,
        fields: [
          { name: "name", type: "string", required: true },
          { name: "parentId", type: "string", required: false, nullable: true },
        ],
        permissions: { read: { fields: ["name", "parentId"] }, write: { fields: ["name", "parentId"] } },
      },
    ],
    relations: [
      // Default FK name: goalId.
      { from: "tasks", to: "goals", type: "many-one", relation: "goal", inverse: "tasks" },
      { from: "folders", to: "folders", type: "htree", relation: "children", inverse: "parent", fkField: "parentId" },
    ],
  };

  async function fkHarness(schemaOverride: any) {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await createDatafnServer<Ctx>({
      schema: schemaOverride,
      database: db,
      context: () => ({ ns: "tenant:a", actor: "alice" }),
      namespaceProvider: { getNamespace: (ctx) => ctx.ns, getActorId: (ctx) => ctx.actor },
    });
    const call = async (body: unknown) => {
      const res = await server.router.handle(
        new Request("http://localhost/datafn/mutation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: (await res.json()) as any };
    };
    return { db, server, call };
  }

  it("a many-one relation is writable when write.fields lists its default FK field", async () => {
    const { db, server, call } = await fkHarness(fkSchema);
    await db.create({ model: "tasks", data: { __ns: "tenant:a", id: "t1", title: "T" } } as any);
    await db.create({ model: "goals", data: { __ns: "tenant:a", id: "g1", name: "G" } } as any);
    const res = await call({ resource: "tasks", version: 1, operation: "relate", id: "t1", relations: { goal: "g1" } });
    expect(res.status).toBe(200);
    expect(res.body.result.ok).toBe(true);
    await server.close();
  });

  it("relationWrites 'all' alone does not open a resource that has no other default", async () => {
    const onlyRelations = {
      ...fkSchema,
      defaultPermissions: { relationWrites: "all" },
      resources: fkSchema.resources.map(({ permissions: _p, ...r }: any) => r),
    };
    const { db, server, call } = await fkHarness(onlyRelations);
    await db.create({ model: "tasks", data: { __ns: "tenant:a", id: "t1", title: "T" } } as any);
    const res = await server.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "tasks", version: 1 }),
      }),
    );
    expect(res.status).toBe(403);
    const del = await call({ resource: "tasks", version: 1, operation: "delete", id: "t1" });
    expect(del.status).toBe(403);
    await server.close();
  });

  it("an htree children relation is not writable through the FK field name", async () => {
    const { db, server, call } = await fkHarness(fkSchema);
    await db.create({ model: "folders", data: { __ns: "tenant:a", id: "f1", name: "root" } } as any);
    await db.create({ model: "folders", data: { __ns: "tenant:a", id: "f2", name: "child" } } as any);
    const res = await call({ resource: "folders", version: 1, operation: "relate", id: "f1", relations: { children: ["f2"] } });
    expect(res.status).toBe(403);
    await server.close();
  });

  it("an htree with distinct endpoints does not accept the FK field name as a relation grant", async () => {
    const distinct = {
      resources: [
        {
          name: "sections",
          version: 1,
          fields: [{ name: "name", type: "string", required: true }, { name: "parentId", type: "string", required: false, nullable: true }],
          permissions: { read: { fields: ["name", "parentId"] }, write: { fields: ["name"] } },
        },
        {
          name: "pages",
          version: 1,
          fields: [{ name: "name", type: "string", required: true }, { name: "parentId", type: "string", required: false, nullable: true }],
          permissions: { read: { fields: ["name", "parentId"] }, write: { fields: ["name", "parentId"] } },
        },
      ],
      relations: [{ from: "sections", to: "pages", type: "htree", relation: "children", inverse: "parent", fkField: "parentId" }],
    };
    const { db, server, call } = await fkHarness(distinct);
    await db.create({ model: "sections", data: { __ns: "tenant:a", id: "s1", name: "S" } } as any);
    await db.create({ model: "pages", data: { __ns: "tenant:a", id: "g1", name: "G" } } as any);
    const res = await call({ resource: "pages", version: 1, operation: "relate", id: "g1", relations: { parent: "s1" } });
    expect(res.status).toBe(403);
    await server.close();
  });

  it("an htree with a polymorphic child endpoint does not accept the FK field name as a relation grant", async () => {
    const folderFields = [
      { name: "name", type: "string", required: true },
      { name: "parentId", type: "string", required: false, nullable: true },
      { name: "parentResource", type: "string", required: false, nullable: true },
      { name: "parentPath", type: "string", required: false, nullable: true },
    ];
    const polymorphic = {
      resources: [
        {
          name: "folders",
          version: 1,
          fields: folderFields,
          permissions: { read: { fields: ["name", "parentId"] }, write: { fields: ["name", "parentId"] } },
        },
        {
          name: "sections",
          version: 1,
          fields: folderFields,
          permissions: { read: { fields: ["name", "parentId"] }, write: { fields: ["name", "parentId"] } },
        },
      ],
      relations: [{ from: ["folders", "sections"], to: "folders", type: "htree", relation: "children", inverse: "parent", fkField: "parentId" }],
    };
    const { db, server, call } = await fkHarness(polymorphic);
    await db.create({ model: "folders", data: { __ns: "tenant:a", id: "folders:f1", name: "root" } } as any);
    await db.create({ model: "folders", data: { __ns: "tenant:a", id: "folders:f2", name: "child" } } as any);
    const res = await call({ resource: "folders", version: 1, operation: "relate", id: "folders:f2", relations: { parent: "folders:f1" } });
    // The executor would also write the parentResource discriminator, which
    // a grant on parentId alone does not cover.
    expect(res.status).toBe(403);
    await server.close();
  });

  it("an htree parent relation is writable when write.fields lists its FK field", async () => {
    const { db, server, call } = await fkHarness(fkSchema);
    await db.create({ model: "folders", data: { __ns: "tenant:a", id: "f1", name: "root" } } as any);
    await db.create({ model: "folders", data: { __ns: "tenant:a", id: "f2", name: "child" } } as any);
    const res = await call({ resource: "folders", version: 1, operation: "relate", id: "f2", relations: { parent: "f1" } });
    expect(res.status).toBe(200);
    await server.close();
  });

  it("defaultPermissions.relationWrites 'all' allows relation writes without scalar write defaults", async () => {
    const withDefaults = {
      ...fkSchema,
      defaultPermissions: { read: "allResourceFields", relationWrites: "all" },
      resources: fkSchema.resources.map(({ permissions: _p, ...r }: any) => r),
    };
    const { db, server, call } = await fkHarness(withDefaults);
    await db.create({ model: "tasks", data: { __ns: "tenant:a", id: "t1", title: "T" } } as any);
    await db.create({ model: "goals", data: { __ns: "tenant:a", id: "g1", name: "G" } } as any);
    const relate = await call({ resource: "tasks", version: 1, operation: "relate", id: "t1", relations: { goal: "g1" } });
    expect(relate.status).toBe(200);
    // Scalar writes stay denied without a write default.
    const merge = await call({ resource: "tasks", version: 1, operation: "merge", id: "t1", record: { title: "x" } });
    expect(merge.status).toBe(403);
    await server.close();
  });
});

describe("Idempotency record ids and in-process search context", () => {
  it("record ids have a fixed length regardless of namespace and actor length", () => {
    const short = idempotencyRecordId("a", "b", "c", "d");
    const long = idempotencyRecordId("n".repeat(5000), "a".repeat(5000), "c", "d");
    expect(long).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(long).toHaveLength(short.length);
    expect(idempotencyRecordId("a", undefined, "c", "d")).not.toBe(idempotencyRecordId("a", "null", "c", "d"));
  });

  it("server.search() without ctx uses a static configured context, and runs anonymous without one", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const searchProvider = {
      name: "fake",
      async searchAll() { return []; },
      async search() { return []; },
      async updateIndices() {},
    };
    const staticServer = await createDatafnServer<Ctx & { userId?: string }>({
      schema,
      database: db,
      searchProvider,
      context: { ns: "tenant:a", userId: "alice" },
      namespaceProvider: { getNamespace: (ctx) => ctx.ns, getActorId: (ctx) => ctx.userId },
    });
    await expect(staticServer.search({ query: "x", namespace: "tenant:a" })).resolves.toEqual({ results: [] });
    await staticServer.close();

    const fnServer = await createDatafnServer<Ctx & { userId?: string }>({
      schema,
      database: db,
      searchProvider,
      context: (request: Request) => ({ ns: "tenant:a", userId: request.headers.get("x-actor") ?? undefined }),
      namespaceProvider: { getNamespace: (ctx) => ctx.ns, getActorId: (ctx) => ctx.userId },
    });
    await expect(fnServer.search({ query: "x", namespace: "tenant:a" })).resolves.toEqual({ results: [] });
    await fnServer.close();

    // A resolver that throws on the fallback context still fails closed.
    const throwingServer = await createDatafnServer<Ctx>({
      schema,
      database: db,
      searchProvider,
      namespaceProvider: {
        getNamespace: () => "tenant:a",
        getActorId: () => {
          throw new Error("no request scope");
        },
      },
    });
    await expect(throwingServer.search({ query: "x" })).rejects.toThrow();
    await throwingServer.close();
  });
});
