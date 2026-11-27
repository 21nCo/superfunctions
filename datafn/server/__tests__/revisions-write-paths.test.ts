/**
 * DATA-41 slice 1: every committed write raises its record's revision by
 * exactly one, on push, /mutation and /transact, checked through the revision
 * ledger (no revision wire output). Runs on the memory adapter with and
 * without transactions, and on SQLite (Drizzle without transactions, Kysely
 * with them).
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { memoryAdapter, kyselyAdapter } from "@superfunctions/db/adapters";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import type { Adapter } from "@superfunctions/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { readRevisions } from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { conformanceSchema, createTableStatements, drizzleSchema, resourceTables } from "./drizzle-sqlite/fixture.js";

type Json = Record<string, any>;
const NS = "datafn";

const schema = {
  resources: [
    { name: "project", version: 1, fields: [{ name: "name", type: "string", required: false }] },
    {
      name: "task",
      version: 1,
      capabilities: ["trash", "archivable"],
      fields: [
        { name: "title", type: "string", required: false },
        { name: "projectId", type: "string", required: false },
      ],
    },
    {
      name: "step",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "goalId", type: "string", required: false },
      ],
    },
    { name: "goal", version: 1, capabilities: ["archivable"], fields: [{ name: "label", type: "string", required: false }] },
    {
      name: "comment",
      version: 1,
      fields: [
        { name: "body", type: "string", required: false },
        { name: "taskId", type: "string", required: false },
      ],
    },
  ],
  relations: [
    { from: "task", to: "project", type: "many-one", relation: "project", fkField: "projectId", onDelete: { to: "setNull" } },
    { from: "comment", to: "task", type: "many-one", relation: "task", fkField: "taskId", onDelete: { to: "cascade" } },
    { from: "step", to: "goal", type: "many-one", relation: "goal", fkField: "goalId", inheritsInactive: true },
  ],
} as any;

/** The memory adapter without transactions, as on D1. */
function withoutTransactions(db: Adapter): Adapter {
  return new Proxy(db as any, {
    get(target, key, receiver) {
      if (key === "capabilities") {
        return { ...target.capabilities, transactions: { supported: false, nested: false } };
      }
      if (key === "transaction") return undefined;
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Adapter;
}

async function serve(database: Adapter, serverSchema: unknown = schema) {
  const server = await createDatafnServer({
    schema: serverSchema as any,
    database,
    authorize: async () => true,
    allowUnknownResources: true,
  } as any);
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
  const push = async (mutation: Json, clientId = "client:a") => {
    const res = await send("push", {
      clientId,
      mutations: [{ version: 1, clientId, mutationId: `m${++seq}`, ...mutation }],
    });
    expect(res.body.result?.ok, JSON.stringify(res.body)).toBe(true);
    return res;
  };
  const mutate = async (mutation: Json) => {
    const res = await send("mutation", { version: 1, clientId: "c", mutationId: `d${++seq}`, ...mutation });
    expect(res.body.result?.ok, JSON.stringify(res.body)).toBe(true);
    return res;
  };
  const transact = async (mutation: Json, atomic = true) => {
    const res = await send("transact", { atomic, steps: [{ mutation: { version: 1, clientId: "c", mutationId: `t${++seq}`, ...mutation } }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/"ok":false/);
    return res;
  };
  const rev = async (resource: string, id: string) => (await readRevisions(database, NS, resource, [id])).get(id);
  return { server, send, push, mutate, transact, rev };
}

afterEach(() => {
  vi.useRealTimers();
});

const variants: Array<[string, () => Adapter]> = [
  ["memory", () => memoryAdapter() as Adapter],
  ["memory without transactions", () => withoutTransactions(memoryAdapter() as Adapter)],
];

describe.each(variants)("DATA-41 write paths raise revisions (%s)", (_name, makeDb) => {
  it("raises a record's revision by exactly one on each push operation and keeps a tombstone", async () => {
    const { push, rev } = await serve(makeDb());
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    const ops: Json[] = [
      { operation: "insert", record: { title: "a" } },
      { operation: "merge", record: { title: "b" } },
      { operation: "replace", record: { title: "c" } },
      { operation: "trash" },
      { operation: "restore" },
      { operation: "archive" },
      { operation: "unarchive" },
      { operation: "relate", relations: { project: "project:1" } },
      { operation: "unrelate", relations: { project: "project:1" } },
      { operation: "delete" },
      { operation: "insert", record: { title: "again" } },
    ];
    let expected = 0;
    for (const op of ops) {
      await push({ resource: "task", id: "task:1", ...op });
      expected += 1;
      expect(await rev("task", "task:1"), op.operation).toEqual({ rev: expected, deleted: op.operation === "delete" });
    }
  });

  it("gives two writes in the same millisecond two different, increasing revisions", async () => {
    const { push, rev } = await serve(makeDb());
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "c" } });
    expect(await rev("task", "task:1")).toEqual({ rev: 3, deleted: false });
  });

  it("raises revisions on /mutation, in /transact and on a KV merge", async () => {
    const { push, mutate, transact, rev } = await serve(makeDb());
    await mutate({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await mutate({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: false });
    await transact({ resource: "task", operation: "merge", id: "task:1", record: { title: "t" } }, _name === "memory");
    expect(await rev("task", "task:1")).toEqual({ rev: 3, deleted: false });

    await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } });
    await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } });
    expect(await rev("kv", "kv:prefs")).toEqual({ rev: 2, deleted: false });
  });

  it("raises the records a delete changes through setNull and cascade policies", async () => {
    const { push, rev } = await serve(makeDb());
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    await push({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } });

    await push({ resource: "project", operation: "delete", id: "project:1" });
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: false });

    await push({ resource: "task", operation: "delete", id: "task:1" });
    expect(await rev("comment", "comment:1")).toEqual({ rev: 2, deleted: true });
  });

  it("keeps revisions across change-log pruning and continues from the tombstone", async () => {
    const db = makeDb();
    const { push, rev } = await serve(db);
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "delete", id: "task:1" });
    await new ChangeTrackingService(db, NS).pruneChanges(0);
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "b" } });
    expect(await rev("task", "task:1")).toEqual({ rev: 3, deleted: false });
  });

  it("raises each record inactive propagation changes, and an insert under an archived parent once", async () => {
    const { push, mutate, rev } = await serve(makeDb());
    await push({ resource: "goal", operation: "insert", id: "goal:1", record: { label: "G" } });
    await push({ resource: "step", operation: "insert", id: "step:1", record: { title: "a", goalId: "goal:1" } });
    await push({ resource: "step", operation: "insert", id: "step:2", record: { title: "b", goalId: "goal:1" } });
    await push({ resource: "goal", operation: "archive", id: "goal:1" });
    expect(await rev("step", "step:1")).toEqual({ rev: 2, deleted: false });
    expect(await rev("step", "step:2")).toEqual({ rev: 2, deleted: false });
    expect(await rev("goal", "goal:1")).toEqual({ rev: 2, deleted: false });

    await push({ resource: "step", operation: "insert", id: "step:3", record: { title: "c", goalId: "goal:1" } });
    expect(await rev("step", "step:3")).toEqual({ rev: 1, deleted: false });
    await mutate({ resource: "step", operation: "insert", id: "step:4", record: { title: "d", goalId: "goal:1" } });
    expect(await rev("step", "step:4")).toEqual({ rev: 1, deleted: false });
    await push({ resource: "step", operation: "insert", id: "step:5", record: { title: "e" } });
    await push({ resource: "step", operation: "relate", id: "step:5", relations: { goal: "goal:1" } });
    expect(await rev("step", "step:5")).toEqual({ rev: 2, deleted: false });
  });

  it("raises revisions on every lifecycle and relation operation through /mutation and /transact", async () => {
    const { push, mutate, transact, rev } = await serve(makeDb());
    const atomic = _name === "memory";
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await mutate({ resource: "task", operation: "relate", id: "task:1", relations: { project: "project:1" } });
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: false });
    await transact({ resource: "task", operation: "unrelate", id: "task:1", relations: { project: "project:1" } }, atomic);
    expect(await rev("task", "task:1")).toEqual({ rev: 3, deleted: false });

    let expected = 3;
    let n = 0;
    for (const operation of ["trash", "restore", "archive", "unarchive", "replace", "delete"]) {
      const mutation = { resource: "task", operation, id: "task:1", ...(operation === "replace" ? { record: { title: "r" } } : {}) };
      if (n++ % 2 === 1) await transact(mutation, atomic);
      else await mutate(mutation);
      expected += 1;
      expect(await rev("task", "task:1"), operation).toEqual({ rev: expected, deleted: operation === "delete" });
    }
  });
});

describe("DATA-41 write paths: commit order", () => {
  it("raises a record's revisions in commit order, not in the order of the sequences a batch reserved", async () => {
    const database = memoryAdapter() as Adapter;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    // Without transactions a push keeps its reserved sequences across
    // mutations, so requests interleave. Change rows for task:y wait at a gate.
    const gated = (method: "create" | "createMany") => async (table: string, data: any) => {
      const rows = Array.isArray(data) ? data : [data];
      if (table === "__datafn_changes" && rows.some((row: any) => row.record_id === "task:y")) {
        reached();
        await gate;
      }
      return (database.internal as any)[method](table, data);
    };
    const nonTransactional = new Proxy(withoutTransactions(database) as any, {
      get(target, key, receiver) {
        if (key !== "internal") return Reflect.get(target, key, receiver);
        return new Proxy(database.internal, {
          get: (internal, property, r) =>
            property === "create" || property === "createMany" ? gated(property) : Reflect.get(internal, property, r),
        });
      },
    }) as Adapter;
    const { send, push, rev } = await serve(nonTransactional);
    await push({ resource: "task", operation: "insert", id: "task:x", record: { title: "x" } });

    // A reserves two sequences, records task:y and pauses before writing task:x.
    const batch = (["a1", "a2"] as const).map((mutationId, i) => ({
      version: 1, clientId: "client:a", mutationId, resource: "task",
      ...(i === 0
        ? { operation: "insert", id: "task:y", record: { title: "y" } }
        : { operation: "merge", id: "task:x", record: { title: "from-a" } }),
    }));
    const pushA = send("push", { clientId: "client:a", mutations: batch });
    await atGate;
    await push({ resource: "task", operation: "merge", id: "task:x", record: { title: "from-b" } }, "client:b");
    expect(await rev("task", "task:x")).toEqual({ rev: 2, deleted: false });
    release();
    expect((await pushA).body.result.ok).toBe(true);
    // A's merge has the lower (reserved) sequence but committed last.
    expect(await rev("task", "task:x")).toEqual({ rev: 3, deleted: false });
  });
});

describe("DATA-41 write paths on SQLite", () => {
  const open: Database.Database[] = [];
  afterEach(() => {
    for (const sqlite of open.splice(0)) sqlite.close();
  });

  const sqliteDatabase = (transactional: boolean): Adapter => {
    const sqlite = new Database(":memory:");
    open.push(sqlite);
    for (const statement of createTableStatements(resourceTables)) sqlite.exec(statement);
    const adapter = transactional
      ? kyselyAdapter({ db: new Kysely<any>({ dialect: new SqliteDialect({ database: sqlite }) }), dialect: "sqlite", schema: { task: "task", project: "project", tag: "tag", kv: "kv" } })
      : drizzleAdapter({ db: drizzle(sqlite, { schema: drizzleSchema }), dialect: "sqlite" });
    expect(adapter.capabilities?.transactions?.supported).toBe(transactional);
    return adapter as Adapter;
  };

  it.each([false, true])("raises revisions on push, /mutation and /transact (transactions: %s)", async (transactional) => {
    const { push, mutate, transact, rev } = await serve(sqliteDatabase(transactional), conformanceSchema);
    // `project` has only a string field (Kysely's SQLite driver binds no booleans).
    const insert = { resource: "project", operation: "insert", id: "project:a", record: { name: "Alpha" } };
    await push(insert);
    await mutate({ resource: "project", operation: "merge", id: "project:a", record: { name: "Bravo" } });
    // An update that leaves the row as it is still raises the revision.
    await mutate({ resource: "project", operation: "merge", id: "project:a", record: { name: "Bravo" } });
    await transact({ resource: "project", operation: "merge", id: "project:a", record: { name: "Charlie" } }, transactional);
    expect(await rev("project", "project:a")).toEqual({ rev: 4, deleted: false });
    await push({ resource: "project", operation: "delete", id: "project:a" });
    expect(await rev("project", "project:a")).toEqual({ rev: 5, deleted: true });
    await push(insert);
    expect(await rev("project", "project:a")).toEqual({ rev: 6, deleted: false });
  });
});
