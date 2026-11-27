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
import {
  assignWriteRevisions,
  bumpRevision,
  bumpTombstone,
  configureRevisions,
  readRevisions,
  revisionsEnabled,
  withWriteEvidence,
} from "../src/execution/revisions.js";
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
    await bumpTombstone(base, NS, "task", "task:1", false);

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
      await bumpRevision(target, NS, "kv", "kv:prefs", false, false);
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
      await bumpTombstone(target, NS, "kv", "kv:prefs", false);
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
            await bumpTombstone(target, NS, "kv", "kv:prefs", false);
          }
          return out;
        }])),
        async findOne(p: any) {
          const out = await target.findOne(p);
          if (p.model === "kv" && stage === "recreateAfterSample" && out === null) {
            stage = "done";
            // Writer 3 re-creates it and raises it live, after this write sampled it absent.
            await target.create({ model: "kv", data: { id: "kv:prefs", value: { c: 3 } }, namespace: NS } as any);
            await bumpRevision(target, NS, "kv", "kv:prefs", false, false);
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
            await bumpTombstone(target, NS, "kv", "kv:prefs", false);
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
      await bumpRevision(base, NS, "task", "task:1", false, false);
      // A setNull update, then a cascade delete a BEFORE DELETE trigger suppresses.
      const db = withWriteEvidence(overriding(base, () => ({ delete: async () => undefined })), transactional);
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
    const db = withWriteEvidence(withoutTransactions(base), false);
    await db.create({ model: "kv", data: { id: "kv:prefs", value: { a: 1 } }, namespace: NS } as any);
    // Another writer deletes the record before this write's change is read,
    // so the change is rewritten to the stored state: a delete.
    await base.delete({ model: "kv", where: kvWhere, namespace: NS } as any);
    await bumpTombstone(base, NS, "kv", "kv:prefs", false);
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
                await bumpRevision(target, NS, "task", "task:1", false, false);
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

const okOf = (route: string, body: Json) =>
  route === "transact"
    ? body.ok !== false && !body.error && body.result?.ok !== false && body.result?.results?.[0]?.ok !== false
    : body.ok;

/** Sends one mutation by `route` to a server on `db`; /transact applies its step without an atomic transaction. */
async function nonAtomicRoutes(db: Adapter, route: "push" | "mutation" | "transact", serverSchema: unknown = schema) {
  const served = await serve(db, serverSchema);
  let seq = 0;
  return (mutation: Json) =>
    route === "push"
      ? served.push(mutation)
      : route === "mutation"
        ? served.mutate(mutation)
        : served.send("transact", {
            atomic: false,
            steps: [{ mutation: { version: 1, clientId: "client:a", mutationId: `n${++seq}`, ...mutation } }],
          });
}

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
    await bumpRevision(base, NS, "task", "task:1", false, false);
    return base;
  }

  it("raises a count-less delete after a merge that observed its absence and raised first", async () => {
    for (const mergeFirst of [true, false]) {
      const base = await insertedTask();
      const dbA = withWriteEvidence(countless(base), false);
      const dbB = withWriteEvidence(countless(base), false);
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
              other = withWriteEvidence(countless(base), false);
              await other.delete({ model: resource, where: byId, namespace: NS } as any);
            }
            return out;
          }])),
        }));
        const record = resource === "kv" ? { value: { a: 1 } } : { title: "a" };
        await base.create({ model: resource, data: { id, ...record }, namespace: NS } as any);
        await bumpRevision(base, NS, resource, id, false, false);
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

  it("raises a first revision again, never not at all, when many other raises drop its mark", async () => {
    for (const route of ["push", "mutation"] as const) {
      const base = memoryAdapter() as Adapter;
      let loseAck = true;
      const db = withoutTransactions(overriding(base, (target) => ({
        internal: new Proxy(target.internal as any, {
          get(internal, key, receiver) {
            const value = Reflect.get(internal, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "create") return value.bind(internal);
            return async (table: string, ...args: unknown[]) => {
              const out = await value.apply(internal, [table, ...args]);
              if (table === "__datafn_revisions" && loseAck) {
                loseAck = false;
                for (let i = 0; i < 12; i++) await bumpRevision(target, NS, "task", "task:1", false, false);
                throw new Error("connection lost after commit");
              }
              return out;
            };
          },
        }),
      })));
      const served = await serve(db);
      const send = (mutation: Json) => (route === "push" ? served.push(mutation) : served.mutate(mutation));
      const inserted = await send({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });

      expect(loseAck, route).toBe(false);
      expect(inserted.body.ok, route).toBe(true);
      // The insert (1) and the 12 other raises; the insert's dropped mark
      // cannot prove its raise, so it is raised again (14): a skipped value,
      // never an uncounted write.
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 14, deleted: false });
      expect(await changeRows(base, "task:1"), route).toHaveLength(1);
    }
  });

  it("raises nothing for a delete that removed nothing after another delete's tombstone, in a transaction", async () => {
    const base = await insertedTask();
    // Deletes that report no count, in transactions: the second removes nothing.
    const db = overriding(base, (target) => ({
      delete: async (p: any) => {
        await target.deleteMany(p);
      },
    }));
    const entries = [deleteEntry(), deleteEntry()];
    for (const entry of entries) {
      await db.transaction(async (tx: Adapter) => {
        const write = withWriteEvidence(tx, true);
        await write.delete({ model: "task", where, namespace: NS } as any);
        await assignWriteRevisions(write, NS, entry as any, () => false, schema, true);
      });
    }

    expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect(entries.map((entry) => entry[0].rev)).toEqual([2, undefined]);
  });

  it("raises once for two count-less deletes of the same row", async () => {
    for (const firstRaisesFirst of [true, false]) {
      const base = await insertedTask();
      const dbs = [withWriteEvidence(countless(base), false), withWriteEvidence(countless(base), false)];
      for (const db of dbs) await db.delete({ model: "task", where, namespace: NS } as any);
      for (const db of firstRaisesFirst ? dbs : [...dbs].reverse()) {
        await assignWriteRevisions(db, NS, deleteEntry() as any, () => false, schema, false);
      }

      expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: true });
    }
  });

  it("counts a write of unknown outcome exactly once while its mark is kept, and at least once after", async () => {
    // [other raises, whether the lost raise applied, the expected revision]
    const cases = [[3, true, 5], [3, false, 5], [12, true, 15], [30, true, 33], [13, false, 15]] as const;
    for (const [others, applies, expected] of cases) {
      for (const route of ["push", "mutation", "transact"] as const) {
        const base = memoryAdapter() as Adapter;
        let loseAck = false;
        const db = withoutTransactions(overriding(base, (target) => ({
          internal: new Proxy(target.internal as any, {
            get(internal, key, receiver) {
              const value = Reflect.get(internal, key, receiver);
              if (typeof value !== "function") return value;
              if (key !== "update") return value.bind(internal);
              return async (table: string, ...args: unknown[]) => {
                if (table !== "__datafn_revisions" || !loseAck || !("rev" in (args[1] as Json))) {
                  return value.apply(internal, [table, ...args]);
                }
                loseAck = false;
                // The raise is applied (or not), then other writers raise the record before the failure is seen.
                if (applies) await value.apply(internal, [table, ...args]);
                for (let i = 0; i < others; i++) await bumpRevision(target, NS, "task", "task:1", false, false);
                throw new Error("connection lost");
              };
            },
          }),
        })));
        const send = await nonAtomicRoutes(db, route);
        expect(okOf(route, (await send({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body)).toBe(true);
        loseAck = true;
        const merged = await send({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
        const label = `${route} others=${others} applies=${applies}`;

        // A raise found by its kept mark is adopted. Once its mark is
        // dropped, whether it applied is unknown and the merge is raised
        // again: the revision may skip a value, but every write is counted.
        expect(loseAck, label).toBe(false);
        expect(okOf(route, merged.body), label).toBe(true);
        expect(await rev(base, "task", "task:1"), label).toEqual({ rev: expected, deleted: false });
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
    // Round 9: the change left without a sequence still raises its record.
    expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect(await rev(base, "comment", "comment:1")).toEqual({ rev: 2, deleted: true });
  });

  it("never fails a write whose read before its delete fails, after its cascade committed, on every route", async () => {
    for (const route of ["push", "mutation", "transact"] as const) {
      const base = memoryAdapter() as Adapter;
      let armed = false;
      let failed = false;
      const db = withoutTransactions(overriding(base, (target) => ({
        async delete(p: any) {
          const out = await target.delete(p);
          // After the cascade removed the comment, the next read of the task fails once.
          if (p.model === "comment") armed = true;
          return out;
        },
        async findOne(p: any) {
          if (armed && p.model === "task") {
            armed = false;
            failed = true;
            throw new Error("connection lost");
          }
          return target.findOne(p);
        },
      })));
      const routes = await cascadeServer(db);
      const result = await routes[route]({ resource: "task", operation: "delete", id: "task:1" });

      expect(failed, route).toBe(true);
      expect(okOf(route, result.body), `${route} ${JSON.stringify(result.body).slice(0, 300)}`).toBe(true);
      expect(await deleteChanges(base), route).toEqual(["comment:1", "task:1"]);
      expect(await rev(base, "comment", "comment:1"), route).toEqual({ rev: 2, deleted: true });
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 2, deleted: true });
    }
  });

  it("raises every record a committed write changed when its sequence allocation fails, on every route", async () => {
    for (const route of ["push", "mutation", "transact"] as const) {
      const base = memoryAdapter() as Adapter;
      let armed = false;
      const db = withoutTransactions(overriding(base, (target) => ({
        async delete(p: any) {
          const out = await target.delete(p);
          // After the write, every sequence allocation fails.
          if (p.model === "task") armed = true;
          return out;
        },
        internal: new Proxy(target.internal as any, {
          get(internal, key, receiver) {
            const value = Reflect.get(internal, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "create" && key !== "update") return value.bind(internal);
            return async (table: string, ...args: unknown[]) => {
              if (table === "__datafn_meta" && armed) throw new Error("forced sequence failure");
              return value.apply(internal, [table, ...args]);
            };
          },
        }),
      })));
      const routes = await cascadeServer(db);
      const result = await routes[route]({ resource: "task", operation: "delete", id: "task:1" });

      expect(armed, route).toBe(true);
      expect(okOf(route, result.body), `${route} ${JSON.stringify(result.body).slice(0, 400)}`).toBeFalsy();
      expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 2, deleted: true });
      expect(await rev(base, "comment", "comment:1"), route).toEqual({ rev: 2, deleted: true });
    }
  });

  describe("PR review round 9", () => {
    const insertEntry = () => [{ resource: "task", id: "task:1", op: "insert", record: null }] as Json[];
    const assign = (db: Adapter, entries: Json[]) =>
      assignWriteRevisions(db, NS, entries as any, () => false, schema, false);

    it("raises a write again after a swap that changed no row and a failed read, on every route", async () => {
      for (const route of ["push", "mutation", "transact"] as const) {
        const base = memoryAdapter() as Adapter;
        let armed = false;
        let failRead = false;
        const db = withoutTransactions(overriding(base, (target) => ({
          internal: new Proxy(target.internal as any, {
            get(internal, key, receiver) {
              const value = Reflect.get(internal, key, receiver);
              if (typeof value !== "function") return value;
              if (key === "findOne") {
                return async (table: string, ...args: unknown[]) => {
                  if (table === "__datafn_revisions" && failRead) {
                    failRead = false;
                    throw new Error("connection lost");
                  }
                  return value.apply(internal, [table, ...args]);
                };
              }
              if (key !== "update") return value.bind(internal);
              return async (table: string, ...args: unknown[]) => {
                if (table !== "__datafn_revisions" || !armed || !("rev" in (args[1] as Json))) {
                  return value.apply(internal, [table, ...args]);
                }
                armed = false;
                // 13 other raises land between this write's read and its
                // swap, which then changes no row; the next read fails.
                for (let i = 0; i < 13; i++) await bumpRevision(target, NS, "task", "task:1", false, false);
                const out = await value.apply(internal, [table, ...args]);
                failRead = true;
                return out;
              };
            },
          }),
        })));
        const send = await nonAtomicRoutes(db, route);
        expect(okOf(route, (await send({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } })).body), route).toBe(true);
        armed = true;
        const merged = await send({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });

        expect(armed || failRead, route).toBe(false);
        expect(okOf(route, merged.body), route).toBe(true);
        // insert (1), the 13 other raises, the merge (15).
        expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 15, deleted: false });
        expect(await changeRows(base, "task:1"), route).toHaveLength(2);
      }
    });

    it("counts a merge and a delete once each, and a delete that found no row never, in every raise order", async () => {
      const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
      for (const order of orders) {
        const base = await insertedTask();
        const dbs = [0, 1, 2].map(() => withWriteEvidence(countless(base), false));
        await dbs[0].update({ model: "task", where, data: { title: "b" }, namespace: NS } as any);
        await dbs[1].delete({ model: "task", where, namespace: NS } as any);
        // The second delete finds no row.
        await dbs[2].delete({ model: "task", where, namespace: NS } as any);
        const entries = [mergeEntry(), deleteEntry(), deleteEntry()];
        for (const i of order) await assign(dbs[i], entries[i]);

        // insert (1), the merge (2), the delete (3).
        expect(await rev(base, "task", "task:1"), `order=${order}`).toEqual({ rev: 3, deleted: true });
        expect(entries[2][0].rev, `order=${order}`).toBeUndefined();
      }
    });

    it("raises a delete that removed a re-inserted row after another delete's tombstone, in either raise order", async () => {
      for (const deleteFirst of [true, false]) {
        const base = await insertedTask();
        const first = withWriteEvidence(countless(base), false);
        await first.delete({ model: "task", where, namespace: NS } as any);
        await assign(first, deleteEntry());
        const insert = withWriteEvidence(countless(base), false);
        await insert.create({ model: "task", data: { id: "task:1", title: "c" }, namespace: NS } as any);
        const second = withWriteEvidence(countless(base), false);
        await second.delete({ model: "task", where, namespace: NS } as any);
        const raises = [() => assign(second, deleteEntry()), () => assign(insert, insertEntry())];
        for (const raise of deleteFirst ? raises : [...raises].reverse()) await raise();

        // insert (1), delete (2), re-insert (3), delete (4).
        expect(await rev(base, "task", "task:1"), `deleteFirst=${deleteFirst}`).toEqual({ rev: 4, deleted: true });
      }
    });

    it("raises a delete that found no row when a re-insert it removed raised in between", async () => {
      const base = await insertedTask();
      const first = withWriteEvidence(countless(base), false);
      await first.delete({ model: "task", where, namespace: NS } as any);
      await assign(first, deleteEntry());
      const racing = withWriteEvidence(overriding(countless(base), (target) => ({
        delete: async (p: any) => {
          // After this delete's read found no row, another request re-inserts
          // the record and raises it; then this delete removes it.
          const insert = withWriteEvidence(countless(base), false);
          await insert.create({ model: "task", data: { id: "task:1", title: "c" }, namespace: NS } as any);
          await assign(insert, insertEntry());
          // The re-insert's writer stamped the revision row with a clock far behind.
          const [stored] = await base.internal.findMany("__datafn_revisions", []);
          const marks = String(stored.updated_at).split("#")[1];
          await base.internal.update("__datafn_revisions", [{ field: "id", op: "eq", value: stored.id }], {
            updated_at: `2000-01-01T00:00:00.000Z#${marks}`,
          });
          await target.delete(p);
        },
      })), false);
      await racing.delete({ model: "task", where, namespace: NS } as any);
      expect(await rev(base, "task", "task:1")).toEqual({ rev: 3, deleted: false });
      await assign(racing, deleteEntry());

      // The ledger ends in the latest state: the row is absent.
      expect(await rev(base, "task", "task:1")).toEqual({ rev: 4, deleted: true });
    });

    it("raises once for two count-less deletes that both found the row, in either raise order", async () => {
      for (const firstRaisesFirst of [true, false]) {
        const base = await insertedTask();
        // Both deletes read the row before either statement runs; the second removes nothing.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let statements = 0;
        const paused = overriding(countless(base), (target) => ({
          delete: async (p: any) => {
            if (++statements === 2) release();
            await gate;
            await target.delete(p);
          },
        }));
        const writes = [withWriteEvidence(paused, false), withWriteEvidence(paused, false)];
        await Promise.all(writes.map((db) => db.delete({ model: "task", where, namespace: NS } as any)));
        for (const db of firstRaisesFirst ? writes : [...writes].reverse()) await assign(db, deleteEntry());

        expect(await rev(base, "task", "task:1"), `firstRaisesFirst=${firstRaisesFirst}`).toEqual({ rev: 2, deleted: true });
      }
    });

    it("raises a delete that removed a re-insert whose raise observed the absence first", async () => {
      const base = await insertedTask();
      const first = withWriteEvidence(countless(base), false);
      let reinsert: Adapter | undefined;
      const late = withWriteEvidence(overriding(countless(base), (target) => ({
        delete: async (p: any) => {
          // After this delete's reads, the id is re-inserted; this delete removes it.
          reinsert = withWriteEvidence(countless(base), false);
          await reinsert.create({ model: "task", data: { id: "task:1", title: "c" }, namespace: NS } as any);
          await target.delete(p);
        },
      })), false);
      await first.delete({ model: "task", where, namespace: NS } as any);
      await assign(first, deleteEntry());
      // `late` reads no row under a tombstone, then removes the re-inserted row.
      await late.delete({ model: "task", where, namespace: NS } as any);
      await assign(reinsert!, insertEntry());
      // The re-insert finds its row removed under `late`'s intent: it counts
      // its live state (3) and that delete's tombstone (4).
      expect(await rev(base, "task", "task:1")).toEqual({ rev: 4, deleted: true });
      await assign(late, deleteEntry());

      // insert (1), delete (2), re-insert (3), its delete (4).
      expect(await rev(base, "task", "task:1")).toEqual({ rev: 4, deleted: true });
    });

    it("keeps the push cursor where it started when no change of the push was stored", async () => {
      const base = memoryAdapter() as Adapter;
      let armed = false;
      let foreign: (() => Promise<unknown>) | undefined;
      const db = withoutTransactions(overriding(base, (target) => ({
        internal: new Proxy(target.internal as any, {
          get(internal, key, receiver) {
            const value = Reflect.get(internal, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "create" && key !== "createMany") return value.bind(internal);
            return async (table: string, data: Json | Json[]) => {
              const rows = Array.isArray(data) ? data : [data];
              if (table === "__datafn_changes" && armed && rows.some((row) => row.record_id === "task:1")) {
                // Another request stores a change while this one fails.
                const run = foreign;
                foreign = undefined;
                await run?.();
                throw new Error("forced change failure");
              }
              return value.apply(internal, [table, data]);
            };
          },
        }),
      })));
      const served = await serve(db);
      await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
      foreign = () => served.push({ resource: "task", operation: "insert", id: "task:9", record: { title: "z" } });
      armed = true;
      const result = await served.push({ resource: "task", operation: "delete", id: "task:1" });

      expect(foreign).toBeUndefined();
      expect(JSON.stringify(result.body)).toContain("INTERNAL");
      expect(await changeRows(base, "task:9")).toHaveLength(1);
      expect(result.body.result.cursor).toBe(result.body.result.cursorBefore);
    });

    it("returns push cursors that cover only the changes stored", async () => {
      const base = memoryAdapter() as Adapter;
      let armed = false;
      const db = withoutTransactions(overriding(base, (target) => ({
        internal: new Proxy(target.internal as any, {
          get(internal, key, receiver) {
            const value = Reflect.get(internal, key, receiver);
            if (typeof value !== "function") return value;
            if (key !== "create" && key !== "createMany") return value.bind(internal);
            return async (table: string, data: Json | Json[]) => {
              const rows = Array.isArray(data) ? data : [data];
              if (table === "__datafn_changes" && armed && rows.some((row) => row.record_id === "comment:1")) {
                throw new Error("forced change failure");
              }
              return value.apply(internal, [table, data]);
            };
          },
        }),
      })));
      const routes = await cascadeServer(db);
      armed = true;
      const result = await routes.push({ resource: "task", operation: "delete", id: "task:1" });

      expect(JSON.stringify(result.body)).toContain("INTERNAL");
      expect(await deleteChanges(base)).toEqual(["task:1"]);
      const stored = (await base.internal.findMany("__datafn_changes", []))
        .filter((row: Json) => row.op === "delete")
        .map((row: Json) => Number(row.server_seq));
      expect(result.body.result.cursor).toBe(String(Math.max(...stored)));
      expect(result.body.result.cursors.comment).toBeUndefined();
      // The comment's committed delete still raised its revision.
      expect(await rev(base, "comment", "comment:1")).toEqual({ rev: 2, deleted: true });
    });

  describe("PR review round 10", () => {
    it("counts a delete that removed a re-insert it found absent when the re-insert raises after it, on every route", async () => {
      for (const route of ["push", "mutation", "transact"] as const) {
        const base = await insertedTask();
        let phase = 0;
        let reinsert: Adapter | undefined;
        const db = withoutTransactions(overriding(base, (target) => ({
          internal: new Proxy(target.internal as any, {
            get(internal, key, receiver) {
              const value = Reflect.get(internal, key, receiver);
              if (typeof value !== "function") return value;
              if (key !== "findMany") return value.bind(internal);
              return async (table: string, ...args: unknown[]) => {
                if (table === "__datafn_revisions" && phase === 1) {
                  phase = 2;
                  // Before the delete's reads, another request deletes the task and raises its tombstone (2).
                  await target.delete({ model: "task", where, namespace: NS } as any);
                  await bumpTombstone(target, NS, "task", "task:1", false);
                }
                return value.apply(internal, [table, ...args]);
              };
            },
          }),
          async delete(p: any) {
            if (phase === 2 && p.model === "task") {
              phase = 3;
              // After the delete's reads found no row, a third request
              // re-inserts the task; this delete's statement removes it.
              reinsert = withWriteEvidence(countless(base), false);
              await reinsert.create({ model: "task", data: { id: "task:1", title: "c" }, namespace: NS } as any);
            }
            return target.delete(p);
          },
        })));
        const send = await nonAtomicRoutes(db, route);
        phase = 1;
        const deleted = await send({ resource: "task", operation: "delete", id: "task:1" });

        expect(phase, route).toBe(3);
        expect(okOf(route, deleted.body), `${route} ${JSON.stringify(deleted.body).slice(0, 300)}`).toBe(true);
        // The delete found no row and its revision row unchanged: it raised nothing.
        expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 2, deleted: true });
        // The re-insert raises after the delete decided, and counts that delete.
        await assign(reinsert!, insertEntry());
        // insert (1), delete (2), re-insert (3), delete (4): no revision names two states.
        expect(await rev(base, "task", "task:1"), route).toEqual({ rev: 4, deleted: true });
      }
    });

    it("keeps a revision for a delete that found no row and removed nothing", async () => {
      const base = await insertedTask();
      const first = withWriteEvidence(countless(base), false);
      await first.delete({ model: "task", where, namespace: NS } as any);
      await assign(first, deleteEntry());
      const again = withWriteEvidence(countless(base), false);
      await again.delete({ model: "task", where, namespace: NS } as any);
      await assign(again, deleteEntry());
      // A later write that finds the row present is raised once, live.
      const insert = withWriteEvidence(countless(base), false);
      await insert.create({ model: "task", data: { id: "task:1", title: "c" }, namespace: NS } as any);
      await assign(insert, insertEntry());

      expect(await rev(base, "task", "task:1")).toEqual({ rev: 3, deleted: false });
    });

    it("issues no revision read before a delete's statement inside a transaction, on every route", async () => {
      for (const nested of [false, true]) {
        for (const route of ["push", "mutation", "transact"] as const) {
          const base = await insertedTask();
          const early: string[] = [];
          let removed = false;
          let aborted = false;
          // A transaction that a failed statement aborts, as on PostgreSQL;
          // its adapter exposes a nested `transaction` only when `nested`.
          const tracked = (tx: Adapter): Adapter =>
            overriding(tx, (target, self) => ({
              transaction: nested ? (fn: (inner: Adapter) => Promise<unknown>) => fn(self()) : undefined,
              internal: new Proxy(target.internal as any, {
                get(internal, key, receiver) {
                  const value = Reflect.get(internal, key, receiver);
                  if (typeof value !== "function") return value;
                  return async (table: string, ...args: unknown[]) => {
                    if (aborted) throw new Error("current transaction is aborted");
                    if (!removed && table === "__datafn_revisions" && (key === "findOne" || key === "findMany")) {
                      early.push(`${String(key)}:${table}`);
                      aborted = true;
                      throw new Error("forced read failure");
                    }
                    return value.apply(internal, [table, ...args]);
                  };
                },
              }),
              async delete(p: any) {
                if (aborted) throw new Error("current transaction is aborted");
                const out = await target.delete(p);
                if (p.model === "task") removed = true;
                return out;
              },
            }));
          const db = overriding(base, (target) => ({
            transaction: (fn: (tx: Adapter) => Promise<unknown>, ...rest: unknown[]) =>
              (target.transaction as any)((tx: Adapter) => fn(tracked(tx)), ...rest),
          }));
          const served = await serve(db);
          const send = { push: served.push, mutation: served.mutate, transact: served.transact }[route];
          const result = await send({ resource: "task", operation: "delete", id: "task:1" });
          const label = `nested=${nested} ${route}`;

          expect(early, label).toEqual([]);
          expect(okOf(route, result.body), `${label} ${JSON.stringify(result.body).slice(0, 300)}`).toBe(true);
          expect(await rev(base, "task", "task:1"), label).toEqual({ rev: 2, deleted: true });
        }
      }
    });

    it("raises once for two deletes that found the row when a later delete stamps its intent in between", async () => {
      const base = await insertedTask();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let statements = 0;
      const paused = overriding(countless(base), (target) => ({
        delete: async (p: any) => {
          if (++statements === 2) release();
          await gate;
          await target.delete(p);
        },
      }));
      const [a, b] = [withWriteEvidence(paused, false), withWriteEvidence(paused, false)];
      await Promise.all([a, b].map((db) => db.delete({ model: "task", where, namespace: NS } as any)));
      await assign(a, deleteEntry());
      // A third delete finds no row and stamps its intent before `b` raises.
      const third = withWriteEvidence(countless(base), false);
      await third.delete({ model: "task", where, namespace: NS } as any);
      await assign(b, deleteEntry());
      await assign(third, deleteEntry());

      expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: true });
    });

    it("leaves the revision of a delete that found no row unchanged when its intent cannot be stamped", async () => {
      const base = await insertedTask();
      const first = withWriteEvidence(countless(base), false);
      await first.delete({ model: "task", where, namespace: NS } as any);
      await assign(first, deleteEntry());
      let failing = true;
      const again = withWriteEvidence(failingInternal(countless(base), "__datafn_revisions", () => failing), false);
      await again.delete({ model: "task", where, namespace: NS } as any);
      failing = false;
      await assign(again, deleteEntry());

      expect(await rev(base, "task", "task:1")).toEqual({ rev: 2, deleted: true });
    });

    it("keeps every raise mark when a delete stamps its intent", async () => {
      const base = await insertedTask();
      const first = withWriteEvidence(countless(base), false);
      await first.delete({ model: "task", where, namespace: NS } as any);
      await assign(first, deleteEntry());
      for (let i = 0; i < 10; i++) await bumpTombstone(base, NS, "task", "task:1", false);
      const marks = async () => {
        const [row] = await base.internal.findMany("__datafn_revisions", []);
        return String(row.updated_at).split("#")[1].split(" ");
      };
      const raised = await marks();
      const late = withWriteEvidence(countless(base), false);
      await late.delete({ model: "task", where, namespace: NS } as any);

      expect(raised).toHaveLength(12);
      expect((await marks()).slice(1)).toEqual(raised);
      expect(await rev(base, "task", "task:1")).toEqual({ rev: 12, deleted: true });
    });

    it("counts a merge once when a delete raised its removal before a later no-op delete stamped its intent", async () => {
      for (const throws of [false, true]) {
        const base = await insertedTask();
        const merge = withWriteEvidence(countless(base), false);
        await merge.update({ model: "task", where, data: { title: "b" }, namespace: NS } as any);
        // A delete removes the merged row and raises its tombstone (2).
        const removing = withWriteEvidence(countless(base), false);
        await removing.delete({ model: "task", where, namespace: NS } as any);
        await assign(removing, deleteEntry());
        // A later delete finds no row and stamps its intent, then removes
        // nothing (or fails after the stamp).
        const late = withWriteEvidence(overriding(countless(base), (target) => ({
          delete: async (p: any) => {
            if (throws) throw new Error("connection lost");
            await target.delete(p);
          },
        })), false);
        await late.delete({ model: "task", where, namespace: NS } as any).catch(() => undefined);
        if (!throws) await assign(late, deleteEntry());
        await assign(merge, [{ resource: "task", id: "task:1", op: "merge", record: null }]);

        // insert (1), merge and delete: one revision each (3).
        expect(await rev(base, "task", "task:1"), `throws=${throws}`).toEqual({ rev: 3, deleted: true });
      }
    });

    it("refuses to enable revisions for a schema whose relation writes the record id", () => {
      const writesId = {
        resources: [...schema.resources, { name: "comment", version: 1, fields: [] }],
        relations: [{ from: "comment", to: "task", type: "many-one", relation: "task", fkField: "id" }],
      } as any;

      expect(() => configureRevisions(writesId, { enabled: true })).toThrow(/DATAFN_REVISIONS_UNSUPPORTED/);
      expect(revisionsEnabled(writesId)).toBe(false);
      expect(() => configureRevisions(writesId, { enabled: false })).not.toThrow();
      expect(() => configureRevisions(schema, { enabled: true })).not.toThrow();
      expect(revisionsEnabled(schema)).toBe(true);
      configureRevisions(schema, undefined);
    });
  });
  });
});
