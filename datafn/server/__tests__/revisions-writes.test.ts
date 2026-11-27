/**
 * DATA-41 slice 1: a write raises revisions only on the evidence of its own
 * statements, through the adapter's own write methods, and revision
 * assignment stays retryable without replaying the write. Exercised through
 * push, /mutation and /transact.
 */

import { memoryAdapter } from "@superfunctions/db/adapters";
import { NotFoundError, type Adapter } from "@superfunctions/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { assignWriteRevisions, bumpRevision, bumpTombstone, readRevisions, withWriteEvidence } from "../src/execution/revisions.js";
import { CHANGES_REV_COLUMN_RECHECK_MS, ensureChangesRevColumn } from "../src/execution/internal-tables.js";

type Json = Record<string, any>;
const NS = "datafn";

const schema = {
  resources: [{ name: "task", version: 1, fields: [{ name: "title", type: "string", required: false }] }],
  relations: [],
} as any;

async function serve(database: Adapter, serverSchema: unknown = schema) {
  const server = await createDatafnServer({ schema: serverSchema, database, allowUnknownResources: true } as any);
  const send = async (route: string, body: unknown): Promise<{ status: number; body: Json }> => {
    const res = await server.router.handle(
      new Request(`http://localhost/datafn/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Json };
  };
  let seq = 0;
  const push = async (mutation: Json, mutationId = `m${++seq}`) =>
    send("push", { clientId: "client:a", mutations: [{ version: 1, clientId: "client:a", mutationId, ...mutation }] });
  const mutate = async (mutation: Json, mutationId = `d${++seq}`) =>
    send("mutation", { version: 1, clientId: "client:a", mutationId, ...mutation });
  const transact = async (mutation: Json, mutationId = `t${++seq}`) =>
    send("transact", { atomic: true, steps: [{ mutation: { version: 1, clientId: "client:a", mutationId, ...mutation } }] });
  return { push, mutate, transact, send };
}

const rev = async (db: Adapter, resource: string, id: string) =>
  (await readRevisions(db, NS, resource, [id])).get(id);

const changeRows = async (db: Adapter, id: string) =>
  (await db.internal.findMany("__datafn_changes", [])).filter((row: Json) => row.record_id === id);

/** Overrides properties of `db` (and of every transaction it opens). */
function overriding(
  db: Adapter,
  overrides: (target: Adapter, self: () => Adapter) => Record<string, unknown>,
): Adapter {
  let proxy: Adapter | undefined;
  const own = overrides(db, () => proxy!);
  proxy = new Proxy(db as any, {
    get(target, key, receiver) {
      if (key === "transaction" && typeof target.transaction === "function" && !("transaction" in own)) {
        return (fn: (tx: Adapter) => Promise<unknown>, ...rest: unknown[]) =>
          target.transaction((tx: Adapter) => fn(overriding(tx, overrides)), ...rest);
      }
      if (typeof key === "string" && key in own) return own[key];
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Adapter;
  return proxy;
}

/** `db` without transactions. */
const withoutTransactions = (db: Adapter) =>
  overriding(db, (target) => ({
    capabilities: { ...target.capabilities, transactions: { supported: false, nested: false } },
    transaction: undefined,
  }));

/** `db` whose internal writes to `table` throw while `failures()` says so. */
function failingInternal(db: Adapter, table: string, failures: () => boolean): Adapter {
  return overriding(db, (target) => ({
    internal: new Proxy(target.internal as any, {
      get(internal, key, receiver) {
        const value = Reflect.get(internal, key, receiver);
        if (typeof value !== "function") return value;
        if (key !== "create" && key !== "createMany" && key !== "update") return value.bind(internal);
        return async (name: string, ...args: unknown[]) => {
          if (name === table && failures()) throw new Error(`forced ${table} failure`);
          return value.apply(internal, [name, ...args]);
        };
      },
    }),
  }));
}

/**
 * A database whose reads inside a transaction may be a snapshot: plain reads
 * of `stale` ids return the snapshot row. With `returning: false` it behaves
 * like MySQL: update re-selects the row through that read, and updateMany
 * counts only rows whose values changed.
 */
function snapshotDatabase(base: Adapter, options: { returning: boolean; stale?: Map<string, Json> }): Adapter {
  return overriding(base, (target, self) => {
    // A transaction's adapter reports transactions too (nested calls run in
    // it), as a SQL adapter's transaction does, so its reads count as a
    // possible snapshot.
    const nested = typeof target.transaction === "function"
      ? {}
      : { transaction: (fn: (tx: Adapter) => Promise<unknown>) => fn(self()) };
    const findOne = async (p: any) => {
      const id = p.where?.find((c: any) => c.field === "id")?.value;
      if (p.model === "task" && options.stale?.has(id)) return options.stale.get(id);
      return target.findOne(p);
    };
    const changedRows = async (p: any) =>
      (await target.findMany({ model: p.model, where: p.where, namespace: p.namespace }))
        .filter((row: Json) => Object.entries(p.data).some(([key, value]) => row[key] !== value)).length;
    return {
      ...nested,
      id: "snapshot-test",
      capabilities: {
        ...target.capabilities,
        operations: { ...target.capabilities.operations, returning: options.returning },
      },
      findOne,
      ...(options.returning ? {} : {
        async update(p: any) {
          await target.updateMany({ model: p.model, where: p.where, data: p.data, namespace: p.namespace });
          const row = await findOne(p);
          if (!row) throw new NotFoundError(p.model, p.where);
          return row;
        },
        async updateMany(p: any) {
          const changed = await changedRows(p);
          await target.updateMany(p);
          return changed;
        },
      }),
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DATA-41 write evidence comes from the adapter's own write methods", () => {
  it("calls the adapter's own update and delete on push, /mutation and /transact, never a substitute", async () => {
    const base = memoryAdapter() as Adapter;
    const calls: string[] = [];
    const db = overriding(base, (target) => Object.fromEntries(
      ["update", "updateMany", "delete", "deleteMany"].map((name) => [name, async (p: any) => {
        if (p.model === "task") calls.push(name);
        return (target as any)[name](p);
      }]),
    ));
    const { push, mutate, transact } = await serve(db);
    for (const id of ["task:1", "task:2", "task:3"]) {
      expect((await push({ resource: "task", operation: "insert", id, record: { title: "a" } })).body.ok).toBe(true);
    }
    expect((await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } })).body.ok).toBe(true);
    expect((await push({ resource: "task", operation: "delete", id: "task:1" })).body.ok).toBe(true);
    expect((await mutate({ resource: "task", operation: "delete", id: "task:2" })).status).toBe(200);
    expect((await transact({ resource: "task", operation: "delete", id: "task:3" })).status).toBe(200);

    expect(calls).toEqual(["update", "delete", "delete", "delete"]);
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 3, deleted: true });
    expect(await rev(base, "task", "task:2")).toEqual({ rev: 2, deleted: true });
    expect(await rev(base, "task", "task:3")).toEqual({ rev: 2, deleted: true });
  });

  it("raises a live revision for an update that leaves its row unchanged where counts are changed rows", async () => {
    const base = memoryAdapter() as Adapter;
    const { push } = await serve(snapshotDatabase(base, { returning: false }));
    expect((await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "same" } })).body.ok).toBe(true);
    const merge = await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "same" } });

    expect(merge.body.ok).toBe(true);
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: false });
  });

  it("takes the create path for a merge whose row another writer deleted after the snapshot", async () => {
    const base = memoryAdapter() as Adapter;
    const stale = new Map<string, Json>();
    const { push } = await serve(snapshotDatabase(base, { returning: true, stale }));
    expect((await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok).toBe(true);
    const where = [{ field: "id", operator: "eq" as const, value: "task:1" }];
    stale.set("task:1", await base.findOne({ model: "task", where, namespace: NS }));
    // Another transaction deletes the record and commits its tombstone.
    await base.delete({ model: "task", where, namespace: NS } as any);
    await bumpTombstone(base, NS, "task", "task:1");

    const merge = await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "m" } });

    expect(merge.body.ok).toBe(true);
    expect(await base.findOne({ model: "task", where, namespace: NS })).toMatchObject({ title: "m" });
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 3, deleted: false });
  });

  it("records a KV delete that another writer overtook as the stored record, without turning it into a tombstone", async () => {
    const base = memoryAdapter() as Adapter;
    const recreate = async (target: Adapter) => {
      // Between this write's DELETE and its change read, another writer
      // re-creates the record and raises its revision.
      await target.create({ model: "kv", data: { id: "kv:prefs", value: { b: 2 } }, namespace: NS } as any);
      await bumpRevision(target, NS, "kv", "kv:prefs", false);
    };
    const db = withoutTransactions(overriding(base, (target) => ({
      async delete(p: any) {
        await target.delete(p);
        if (p.model === "kv") await recreate(target);
      },
      async deleteMany(p: any) {
        const count = await target.deleteMany(p);
        if (p.model === "kv") await recreate(target);
        return count;
      },
    })));
    const { push } = await serve(db);
    expect((await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } })).body.ok).toBe(true);
    expect((await push({ resource: "kv", operation: "delete", id: "kv:prefs" })).body.ok).toBe(true);

    const last = (await changeRows(base, "kv:prefs")).at(-1);
    expect(last).toMatchObject({ op: "upsert" });
    // The re-creating writer's revision stands; the rewritten change raises nothing.
    expect(await rev(base, "kv", "kv:prefs")).toEqual({ rev: 2, deleted: false });
  });

  it("never turns a live record into a tombstone from a delete it cannot verify on a snapshot database", async () => {
    const base = memoryAdapter() as Adapter;
    // A delete the database suppresses (a BEFORE DELETE trigger) on an
    // adapter whose delete reports no count and whose reads may be a snapshot.
    const db = snapshotDatabase(overriding(base, () => ({ delete: async () => undefined })), { returning: false });
    const { push } = await serve(db);
    expect((await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok).toBe(true);
    expect((await push({ resource: "task", operation: "delete", id: "task:1" })).body.ok).toBe(true);

    expect(await base.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any)).not.toBeNull();
    // Neither a tombstone nor a live bump: the delete proved nothing.
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 1, deleted: false });
  });

  it("counts a KV merge once when another writer deletes the record before its change is read", async () => {
    const base = memoryAdapter() as Adapter;
    let overtake = false;
    const after = async (target: Adapter, p: any) => {
      if (p.model !== "kv" || !overtake) return;
      overtake = false;
      await target.delete({ model: "kv", where: [{ field: "id", operator: "eq", value: "kv:prefs" }], namespace: NS } as any);
      await bumpTombstone(target, NS, "kv", "kv:prefs");
    };
    const db = withoutTransactions(overriding(base, (target) => Object.fromEntries(
      ["create", "update", "upsert"].map((name) => [name, async (p: any) => {
        const out = await (target as any)[name](p);
        await after(target, p);
        return out;
      }]),
    )));
    const { push } = await serve(db);
    expect((await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } })).body.ok).toBe(true);
    overtake = true;
    expect((await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } })).body.ok).toBe(true);

    expect((await changeRows(base, "kv:prefs")).at(-1)).toMatchObject({ op: "delete" });
    // merge (1), the other writer's delete (2), this merge counted once in the state that writer left (3).
    expect(await rev(base, "kv", "kv:prefs")).toEqual({ rev: 3, deleted: true });
  });
});

describe("DATA-41 revision assignment stays retryable", () => {
  it("retries a transient revision write without a transaction, recording the change once", async () => {
    for (const route of ["push", "mutation"] as const) {
      const base = memoryAdapter() as Adapter;
      let revisionFailures = 1;
      let changeFailures = 1;
      const db = withoutTransactions(failingInternal(
        failingInternal(base, "__datafn_revisions", () => revisionFailures-- > 0),
        "__datafn_changes",
        () => changeFailures-- > 0,
      ));
      const served = await serve(db);
      const insert = { resource: "task", operation: "insert", id: "task:1", record: { title: "a" } };
      const result = route === "push" ? await served.push(insert, "m-1") : await served.mutate(insert, "m-1");

      expect(result.body.ok, route).toBe(true);
      expect(await changeRows(base, "task:1"), route).toHaveLength(1);
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 1, deleted: false });
      const replay = route === "push" ? await served.push(insert, "m-1") : await served.mutate(insert, "m-1");
      expect(replay.body.ok, route).toBe(true);
      expect(await changeRows(base, "task:1"), route).toHaveLength(1);
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 1, deleted: false });
    }
  });

  it("adopts a revision whose write committed before the adapter failed, instead of raising it again", async () => {
    const base = memoryAdapter() as Adapter;
    let failAfterWrite = false;
    const db = withoutTransactions(overriding(base, (target) => ({
      internal: new Proxy(target.internal as any, {
        get(internal, key, receiver) {
          const value = Reflect.get(internal, key, receiver);
          if (typeof value !== "function") return value;
          if (key !== "update") return value.bind(internal);
          return async (table: string, ...args: unknown[]) => {
            const out = await value.apply(internal, [table, ...args]);
            const data = args[1] as Json;
            if (table === "__datafn_revisions" && failAfterWrite && "rev" in data) {
              failAfterWrite = false;
              throw new Error("connection lost after commit");
            }
            return out;
          };
        },
      }),
    })));
    const { push } = await serve(db);
    expect((await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok).toBe(true);
    failAfterWrite = true;
    const merge = await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });

    expect(merge.body.ok).toBe(true);
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: false });
    expect(await changeRows(base, "task:1")).toHaveLength(2);
  });

  it("adopts a first revision row whose insert was stored before the adapter failed", async () => {
    const base = memoryAdapter() as Adapter;
    let failAfterInsert = true;
    const db = withoutTransactions(overriding(base, (target) => ({
      internal: new Proxy(target.internal as any, {
        get(internal, key, receiver) {
          const value = Reflect.get(internal, key, receiver);
          if (typeof value !== "function") return value;
          if (key !== "create") return value.bind(internal);
          return async (table: string, ...args: unknown[]) => {
            const out = await value.apply(internal, [table, ...args]);
            if (table === "__datafn_revisions" && failAfterInsert) {
              failAfterInsert = false;
              throw new Error("connection lost after commit");
            }
            return out;
          };
        },
      }),
    })));
    const { push } = await serve(db);
    expect((await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok).toBe(true);
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 1, deleted: false });
  });

  it("reports a retryable INTERNAL after three attempts when revision writes keep failing without a transaction", async () => {
    const base = memoryAdapter() as Adapter;
    let attempts = 0;
    const db = withoutTransactions(failingInternal(base, "__datafn_revisions", () => {
      attempts += 1;
      return true;
    }));
    const { push } = await serve(db);
    const result = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });

    expect(result.body.ok).toBe(false);
    expect(JSON.stringify(result.body)).toContain('"retryable":true');
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(await changeRows(base, "task:1")).toHaveLength(0);
    expect(await rev(base, "task", "task:1")).toBeUndefined();
  });

  it("rolls a transaction back on a transient revision failure; a retry of the same mutation commits once", async () => {
    for (const route of ["push", "mutation", "transact"] as const) {
      const base = memoryAdapter() as Adapter;
      let failures = 1;
      const db = overriding(base, (target) => ({
        transaction: (fn: (tx: Adapter) => Promise<unknown>) =>
          (target.transaction as any)((tx: Adapter) => fn(failingInternal(tx, "__datafn_revisions", () => failures-- > 0))),
      }));
      const served = await serve(db);
      const insert = { resource: "task", operation: "insert", id: "task:1", record: { title: "a" } };
      const send = () =>
        route === "push" ? served.push(insert, "m-1") : route === "mutation" ? served.mutate(insert, "m-1") : served.transact(insert, "m-1");

      const first = await send();
      // The mutation failed (the route envelope may still be ok) and nothing persisted.
      expect(JSON.stringify(first.body), route).toMatch(/"ok":false/);
      expect(await base.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any), route).toBeNull();
      expect(await changeRows(base, "task:1"), route).toHaveLength(0);
      expect(await rev(base, "task", "task:1"), route).toBeUndefined();

      const retry = await send();
      expect(retry.status, route).toBe(200);
      expect(await changeRows(base, "task:1"), route).toHaveLength(1);
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 1, deleted: false });
    }
  });
});

describe("DATA-41 change-row revision columns", () => {
  it("probes again for missing rev columns after the recheck interval", async () => {
    let columns = false;
    const db = {
      capabilities: { schema: { constraints: true } },
      internal: {
        async findMany(_table: string, where: Array<{ field: string }>) {
          if (where[0]?.field === "__datafn_absent_column_probe" || !columns) throw new Error("no such column");
          return [];
        },
      },
    } as unknown as Adapter;
    const t0 = 1_000_000;
    expect(await ensureChangesRevColumn(db, t0)).toBe(false);
    columns = true;
    expect(await ensureChangesRevColumn(db, t0 + 1_000)).toBe(false);
    expect(await ensureChangesRevColumn(db, t0 + CHANGES_REV_COLUMN_RECHECK_MS + 1)).toBe(true);
    columns = false;
    expect(await ensureChangesRevColumn(db, t0 + 10 * CHANGES_REV_COLUMN_RECHECK_MS)).toBe(true);
  });
});

describe("DATA-41 PR review round 7: every committed write moves the ledger once, to the latest committed state", () => {
  const kvWhere = [{ field: "id", operator: "eq" as const, value: "kv:prefs" }];

  it("leaves a KV merge overtaken by a delete and a re-create live, on push and /mutation", async () => {
    for (const route of ["push", "mutation"] as const) {
      const base = memoryAdapter() as Adapter;
      let stage: "idle" | "deleteAfterWrite" | "recreateAfterSample" | "done" = "idle";
      const db = withoutTransactions(overriding(base, (target) => ({
        ...Object.fromEntries(["create", "update", "upsert"].map((name) => [name, async (p: any) => {
          const out = await (target as any)[name](p);
          if (p.model === "kv" && stage === "deleteAfterWrite") {
            stage = "recreateAfterSample";
            // Writer 2 deletes the record and raises its tombstone.
            await target.delete({ model: "kv", where: kvWhere, namespace: NS } as any);
            await bumpTombstone(target, NS, "kv", "kv:prefs");
          }
          return out;
        }])),
        async findOne(p: any) {
          const out = await target.findOne(p);
          if (p.model === "kv" && stage === "recreateAfterSample" && out === null) {
            stage = "done";
            // Writer 3 re-creates it and raises it live, after this write sampled it absent.
            await target.create({ model: "kv", data: { id: "kv:prefs", value: { c: 3 } }, namespace: NS } as any);
            await bumpRevision(target, NS, "kv", "kv:prefs", false);
          }
          return out;
        },
      })));
      const served = await serve(db);
      const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
      expect((await send({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } })).body.ok, route).toBe(true);
      stage = "deleteAfterWrite";
      expect((await send({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } })).body.ok, route).toBe(true);

      expect(stage, route).toBe("done");
      expect(await base.findOne({ model: "kv", where: kvWhere, namespace: NS } as any), route).not.toBeNull();
      // merge (1), delete (2), re-create (3), this merge once in the latest state: live (4).
      expect(await rev(base, "kv", "kv:prefs"), route).toEqual({ rev: 4, deleted: false });
    }
  });

  it("leaves the ledger a tombstone when the row a write sampled live is deleted before the raise", async () => {
    for (const route of ["push", "mutation"] as const) {
      const base = memoryAdapter() as Adapter;
      let stage: "idle" | "armed" | "deleteAfterSample" | "done" = "idle";
      const db = withoutTransactions(overriding(base, (target) => ({
        ...Object.fromEntries(["create", "update", "upsert"].map((name) => [name, async (p: any) => {
          const out = await (target as any)[name](p);
          if (p.model === "kv" && stage === "armed") stage = "deleteAfterSample";
          return out;
        }])),
        async findOne(p: any) {
          const out = await target.findOne(p);
          if (p.model === "kv" && stage === "deleteAfterSample" && out !== null) {
            stage = "done";
            // Another writer deletes the record after this write sampled it live.
            await target.delete({ model: "kv", where: kvWhere, namespace: NS } as any);
            await bumpTombstone(target, NS, "kv", "kv:prefs");
          }
          return out;
        },
      })));
      const served = await serve(db);
      const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
      expect((await send({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } })).body.ok, route).toBe(true);
      stage = "armed";
      expect((await send({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } })).body.ok, route).toBe(true);

      expect(stage, route).toBe("done");
      expect(await base.findOne({ model: "kv", where: kvWhere, namespace: NS } as any), route).toBeNull();
      // merge (1), the other writer's delete (2), this merge once in the latest state: a tombstone (3).
      expect(await rev(base, "kv", "kv:prefs"), route).toEqual({ rev: 3, deleted: true });
    }
  });

  it("leaves the revision of a record a delete did not remove unchanged without a transaction", async () => {
    for (const route of ["push", "mutation"] as const) {
      const base = memoryAdapter() as Adapter;
      // A delete the database suppresses (a BEFORE DELETE trigger) on an
      // adapter whose delete reports no count.
      const served = await serve(withoutTransactions(overriding(base, () => ({ delete: async () => undefined }))));
      const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
      expect((await send({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok, route).toBe(true);
      await send({ resource: "task", operation: "delete", id: "task:1" });

      expect(await base.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any), route).not.toBeNull();
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 1, deleted: false });
    }
  });

  it("raises a record once, live, when a delete of the same write that changed it removed nothing", async () => {
    for (const transactional of [true, false]) {
      const base = memoryAdapter() as Adapter;
      const where = [{ field: "id", operator: "eq" as const, value: "task:1" }];
      await base.create({ model: "task", data: { id: "task:1", title: "a" }, namespace: NS } as any);
      await bumpRevision(base, NS, "task", "task:1", false);
      // A setNull update, then a cascade delete a BEFORE DELETE trigger suppresses.
      const db = withWriteEvidence(overriding(base, () => ({ delete: async () => undefined })));
      await db.update({ model: "task", where, data: { title: "b" }, namespace: NS } as any);
      await db.delete({ model: "task", where, namespace: NS } as any);
      const entries: Array<{ resource: string; id: string; op: string; record: null; rev?: number }> = [
        { resource: "task", id: "task:1", op: "merge", record: null },
        { resource: "task", id: "task:1", op: "delete", record: null },
      ];

      await assignWriteRevisions(db, NS, entries, () => false, schema, transactional);

      expect(await rev(base, "task", "task:1"), `transactional=${transactional}`).toEqual({ rev: 2, deleted: false });
    }
  });

  it("gives a rewritten KV entry no revision while raising the ledger once to the latest state", async () => {
    const base = memoryAdapter() as Adapter;
    const db = withWriteEvidence(withoutTransactions(base));
    await db.create({ model: "kv", data: { id: "kv:prefs", value: { a: 1 } }, namespace: NS } as any);
    // Another writer deletes the record before this write's change is read,
    // so the change is rewritten to the stored state: a delete.
    await base.delete({ model: "kv", where: kvWhere, namespace: NS } as any);
    await bumpTombstone(base, NS, "kv", "kv:prefs");
    const entries: Array<{ resource: string; id: string; op: string; record: null; rev?: number }> = [
      { resource: "kv", id: "kv:prefs", op: "delete", record: null },
    ];

    await assignWriteRevisions(db, NS, entries, () => false, schema, false);

    expect(entries[0].rev).toBeUndefined();
    expect(await rev(base, "kv", "kv:prefs")).toEqual({ rev: 2, deleted: true });
  });

  it("tombstones deletes and cascades on snapshot adapters through push, /mutation and /transact", async () => {
    const cascadeSchema = {
      resources: [
        ...schema.resources,
        {
          name: "comment",
          version: 1,
          fields: [
            { name: "body", type: "string", required: false },
            { name: "taskId", type: "string", required: false },
          ],
        },
      ],
      relations: [{ from: "comment", to: "task", type: "many-one", relation: "task", fkField: "taskId", onDelete: { to: "cascade" } }],
    };
    // MySQL-style (update re-selects, counts are changed rows) and Prisma-style (returns the row).
    for (const returning of [false, true]) {
      for (const route of ["push", "mutation", "transact"] as const) {
        const label = `${route} returning=${returning}`;
        const base = memoryAdapter() as Adapter;
        const served = await serve(snapshotDatabase(base, { returning }), cascadeSchema);
        const send = (mutation: Json) =>
          route === "push" ? served.push(mutation) : route === "mutation" ? served.mutate(mutation) : served.transact(mutation);
        const insert = { resource: "task", operation: "insert", id: "task:1", record: { title: "a" } };
        expect((await send(insert)).status, label).toBe(200);
        expect(await rev(base, "task", "task:1"), label).toEqual({ rev: 1, deleted: false });
        expect((await send({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } })).status, label).toBe(200);

        expect((await send({ resource: "task", operation: "delete", id: "task:1" })).status, label).toBe(200);
        expect(await rev(base, "task", "task:1"), label).toEqual({ rev: 2, deleted: true });
        expect(await rev(base, "comment", "comment:1"), label).toEqual({ rev: 2, deleted: true });

        expect((await send({ ...insert, record: { title: "b" } })).status, label).toBe(200);
        expect(await rev(base, "task", "task:1"), label).toEqual({ rev: 3, deleted: false });
      }
    }
  });

  it("adopts a raise whose acknowledgement was lost after another writer advanced the record", async () => {
    for (const route of ["push", "mutation"] as const) {
      const base = memoryAdapter() as Adapter;
      let loseAck = false;
      const db = withoutTransactions(overriding(base, (target) => ({
        internal: new Proxy(target.internal as any, {
          get(internal, key, receiver) {
            const value = Reflect.get(internal, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "update") return value.bind(internal);
            return async (table: string, ...args: unknown[]) => {
              const out = await value.apply(internal, [table, ...args]);
              if (table === "__datafn_revisions" && loseAck && "rev" in (args[1] as Json)) {
                loseAck = false;
                // The raise committed; a second writer advances the record
                // before this writer learns the outcome.
                await bumpRevision(target, NS, "task", "task:1", false);
                throw new Error("connection lost after commit");
              }
              return out;
            };
          },
        }),
      })));
      const served = await serve(db);
      const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
      expect((await send({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok, route).toBe(true);
      loseAck = true;
      expect((await send({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } })).body.ok, route).toBe(true);

      expect(loseAck, route).toBe(false);
      // insert (1), the merge whose acknowledgement was lost (2), the second writer (3).
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 3, deleted: false });
      expect(await changeRows(base, "task:1"), route).toHaveLength(2);
    }
  });
});

describe("DATA-41 PR review round 8: non-transactional writes are counted and recorded exactly once", () => {
  const where = [{ field: "id", operator: "eq" as const, value: "task:1" }];
  /** An adapter without transactions whose delete reports no count. */
  const countless = (base: Adapter) =>
    withoutTransactions(overriding(base, (target) => ({
      delete: async (p: any) => {
        await target.deleteMany(p);
      },
    })));
  const deleteEntry = () => [{ resource: "task", id: "task:1", op: "delete", record: null }] as Json[];
  const mergeEntry = () => [{ resource: "task", id: "task:1", op: "merge", record: null }] as Json[];

  async function insertedTask(): Promise<Adapter> {
    const base = memoryAdapter() as Adapter;
    await base.create({ model: "task", data: { id: "task:1", title: "a" }, namespace: NS } as any);
    await bumpRevision(base, NS, "task", "task:1", false);
    return base;
  }

  it("raises a count-less delete after a merge that observed its absence and raised first", async () => {
    for (const mergeFirst of [true, false]) {
      const base = await insertedTask();
      const dbA = withWriteEvidence(countless(base));
      const dbB = withWriteEvidence(countless(base));
      await dbA.update({ model: "task", where, data: { title: "b" }, namespace: NS } as any);
      await dbB.delete({ model: "task", where, namespace: NS } as any);
      const raises = [() => assignWriteRevisions(dbA, NS, mergeEntry() as any, () => false, schema, false),
        () => assignWriteRevisions(dbB, NS, deleteEntry() as any, () => false, schema, false)];
      for (const raise of mergeFirst ? raises : raises.reverse()) await raise();

      // insert (1), the merge (2), the delete (3), in either raise order.
      expect(await rev(base, "task", "task:1"), `mergeFirst=${mergeFirst}`).toEqual({ rev: 3, deleted: true });
    }
  });

  it("raises a count-less delete that removed a row another request merged, on push and /mutation", async () => {
    for (const resource of ["task", "kv"] as const) {
      for (const route of ["push", "mutation"] as const) {
        const base = memoryAdapter() as Adapter;
        const id = resource === "kv" ? "kv:prefs" : "task:1";
        const byId = [{ field: "id", operator: "eq" as const, value: id }];
        let other: Adapter | undefined;
        const db = overriding(countless(base), (target) => ({
          ...Object.fromEntries(["update", "upsert"].map((name) => [name, async (p: any) => {
            const out = await (target as any)[name](p);
            if (p.model === resource && other === undefined) {
              // Another request's count-less delete removes the row; it raises after this write.
              other = withWriteEvidence(countless(base));
              await other.delete({ model: resource, where: byId, namespace: NS } as any);
            }
            return out;
          }])),
        }));
        const record = resource === "kv" ? { value: { a: 1 } } : { title: "a" };
        await base.create({ model: resource, data: { id, ...record }, namespace: NS } as any);
        await bumpRevision(base, NS, resource, id, false);
        const served = await serve(db);
        const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
        const merged = resource === "kv" ? { value: { b: 2 } } : { title: "b" };
        expect((await send({ resource, operation: "merge", id, record: merged })).body.ok, `${resource} ${route}`).toBe(true);
        await assignWriteRevisions(other!, NS, [{ resource, id, op: "delete", record: null }] as any, () => false, schema, false);

        // insert (1), the merge (2), the other request's delete (3).
        expect(await rev(base, resource, id), `${resource} ${route}`).toEqual({ rev: 3, deleted: true });
      }
    }
  });

  it("raises once for two count-less deletes of the same row", async () => {
    for (const firstRaisesFirst of [true, false]) {
      const base = await insertedTask();
      const dbs = [withWriteEvidence(countless(base)), withWriteEvidence(countless(base))];
      for (const db of dbs) await db.delete({ model: "task", where, namespace: NS } as any);
      for (const db of firstRaisesFirst ? dbs : [...dbs].reverse()) {
        await assignWriteRevisions(db, NS, deleteEntry() as any, () => false, schema, false);
      }

      expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: true });
    }
  });

  it("never raises a write twice when its lost acknowledgement is followed by many other raises", async () => {
    for (const others of [12, 30]) {
      for (const route of ["push", "mutation"] as const) {
        const base = memoryAdapter() as Adapter;
        let loseAck = false;
        const db = withoutTransactions(overriding(base, (target) => ({
          internal: new Proxy(target.internal as any, {
            get(internal, key, receiver) {
              const value = Reflect.get(internal, key, receiver);
              if (typeof value !== "function") return value;
              if (key !== "update") return value.bind(internal);
              return async (table: string, ...args: unknown[]) => {
                const out = await value.apply(internal, [table, ...args]);
                if (table === "__datafn_revisions" && loseAck && "rev" in (args[1] as Json)) {
                  loseAck = false;
                  for (let i = 0; i < others; i++) await bumpRevision(target, NS, "task", "task:1", false);
                  throw new Error("connection lost after commit");
                }
                return out;
              };
            },
          }),
        })));
        const served = await serve(db);
        const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
        expect((await send({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body.ok).toBe(true);
        loseAck = true;
        const merged = await send({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
        const label = `${route} others=${others}`;

        expect(merged.body.ok, label).toBe(true);
        // insert (1), the merge whose acknowledgement was lost (2), the other raises.
        expect(await rev(base, "task", "task:1"), label).toEqual({ rev: 2 + others, deleted: false });
        expect(await changeRows(base, "task:1"), label).toHaveLength(2);
      }
    }
  });

  const cascadeSchema = {
    resources: [
      ...schema.resources,
      { name: "comment", version: 1, fields: [{ name: "body", type: "string", required: false }, { name: "taskId", type: "string", required: false }] },
    ],
    relations: [{ from: "comment", to: "task", type: "many-one", relation: "task", fkField: "taskId", onDelete: { to: "cascade" } }],
  } as any;

  /** Serves `db` with the cascade schema and inserts task:1 with comment:1. */
  async function cascadeServer(db: Adapter) {
    const served = await serve(db, cascadeSchema);
    // Without database transactions, /transact applies its steps one at a time.
    const transact = (mutation: Json) => served.send("transact", {
      atomic: false,
      steps: [{ mutation: { version: 1, clientId: "client:a", mutationId: "t-delete", ...mutation } }],
    });
    const routes = { push: served.push, mutation: served.mutate, transact };
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } });
    return routes;
  }

  const deleteChanges = async (base: Adapter) =>
    (await base.internal.findMany("__datafn_changes", []))
      .filter((row: Json) => row.op === "delete")
      .map((row: Json) => row.record_id)
      .sort();

  const okOf = (route: string, body: Json) =>
    route === "transact" ? body.ok !== false && !body.error : body.ok;

  it("gives each change of a write its own retries, recording a cascade delete's every change", async () => {
    for (const route of ["push", "mutation", "transact"] as const) {
      const base = memoryAdapter() as Adapter;
      let call = 0;
      let armed = false;
      // While armed, change inserts #1, #2 and #4 fail.
      const db = failingInternal(withoutTransactions(base), "__datafn_changes", () => armed && [1, 2, 4].includes(++call));
      const routes = await cascadeServer(db);
      armed = true;
      const result = await routes[route]({ resource: "task", operation: "delete", id: "task:1" });
      armed = false;

      expect(okOf(route, result.body), `${route} ${JSON.stringify(result.body).slice(0, 200)}`).toBe(true);
      expect(await deleteChanges(base), route).toEqual(["comment:1", "task:1"]);
    }
  });

  it("records a change whose insert was stored before the adapter failed once, on every route", async () => {
    for (const route of ["push", "mutation", "transact"] as const) {
      const base = memoryAdapter() as Adapter;
      let armed = false;
      let inserts = 0;
      const db = withoutTransactions(overriding(base, (target) => ({
        internal: new Proxy(target.internal as any, {
          get(internal, key, receiver) {
            const value = Reflect.get(internal, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "create" && key !== "createMany") return value.bind(internal);
            return async (table: string, data: Json | Json[]) => {
              if (table !== "__datafn_changes") return value.apply(internal, [table, data]);
              for (const row of Array.isArray(data) ? data : [data]) {
                if (await internal.findOne(table, [{ field: "id", op: "eq", value: row.id }])) {
                  throw new Error(`duplicate key ${row.id}`);
                }
              }
              const out = await value.apply(internal, [table, data]);
              // The last insert of the write is stored, then its acknowledgement is lost.
              if (armed && ++inserts === (key === "createMany" ? 1 : 2)) throw new Error("connection lost after commit");
              return out;
            };
          },
        }),
      })));
      const routes = await cascadeServer(db);
      armed = true;
      const result = await routes[route]({ resource: "task", operation: "delete", id: "task:1" });

      expect(inserts, route).toBeGreaterThan(0);
      expect(okOf(route, result.body), `${route} ${JSON.stringify(result.body).slice(0, 200)}`).toBe(true);
      expect(await deleteChanges(base), route).toEqual(["comment:1", "task:1"]);
    }
  });

  it("records the changes already sequenced when sequencing a later change fails", async () => {
    const base = memoryAdapter() as Adapter;
    let armed = false;
    let allocations = 0;
    const db = withoutTransactions(overriding(base, (target) => ({
      async delete(p: any) {
        const out = await target.delete(p);
        // After the write, the first sequence allocation succeeds and later ones fail.
        if (p.model === "task") armed = true;
        return out;
      },
      internal: new Proxy(target.internal as any, {
        get(internal, key, receiver) {
          const value = Reflect.get(internal, key, receiver);
          if (typeof value !== "function") return value;
          if (key !== "create" && key !== "update") return value.bind(internal);
          return async (table: string, ...args: unknown[]) => {
            if (table === "__datafn_meta" && armed && ++allocations > 1) throw new Error("forced sequence failure");
            return value.apply(internal, [table, ...args]);
          };
        },
      }),
    })));
    const routes = await cascadeServer(db);
    const result = await routes.push({ resource: "task", operation: "delete", id: "task:1" });

    expect(JSON.stringify(result.body)).toContain("INTERNAL");
    expect(JSON.stringify(result.body)).toContain('"retryable":true');
    expect((await deleteChanges(base)).length).toBe(1);
  });
});
