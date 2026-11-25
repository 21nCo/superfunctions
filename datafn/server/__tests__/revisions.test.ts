/**
 * DATA-41: server-managed per-record revisions.
 */

import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "../src/server.js";
import {
  READ_CHUNK,
  bumpRevision,
  configureRevisions,
  ensureRevisionsTable,
  readRevisions,
  readWithRevisions,
} from "../src/execution/revisions.js";
import { executeClone } from "../src/execution/sync/clone.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { INTERNAL_TABLE_SCHEMAS } from "../src/execution/internal-tables.js";
import { resolveNamespaceStoragePlan } from "../src/namespace-storage.js";

type Json = Record<string, any>;
const NS = "datafn";

const schema = {
  resources: [
    { name: "project", version: 1, fields: [{ name: "name", type: "string" as const, required: false }] },
    {
      name: "task",
      version: 1,
      capabilities: ["trash", "archivable"] as any,
      fields: [
        { name: "title", type: "string" as const, required: false },
        { name: "projectId", type: "string" as const, required: false },
      ],
    },
    {
      name: "step",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: false },
        { name: "goalId", type: "string" as const, required: false },
      ],
    },
    { name: "goal", version: 1, capabilities: ["archivable"] as any, fields: [{ name: "label", type: "string" as const, required: false }] },
    {
      name: "comment",
      version: 1,
      fields: [
        { name: "body", type: "string" as const, required: false },
        { name: "taskId", type: "string" as const, required: false },
      ],
    },
    {
      name: "secretive",
      version: 1,
      fields: [
        { name: "title", type: "string" as const, required: false },
        { name: "hidden", type: "string" as const, required: false },
      ],
      permissions: { read: { fields: ["title"] }, write: { fields: ["title", "hidden"] } },
    },
    {
      name: "legacy",
      version: 1,
      fields: [{ name: "$rev", type: "string" as const, required: false }],
    },
  ],
  relations: [
    { from: "task", to: "project", type: "many-one", relation: "project", fkField: "projectId", onDelete: { to: "setNull" } },
    { from: "comment", to: "task", type: "many-one", relation: "task", fkField: "taskId", onDelete: { to: "cascade" } },
    { from: "step", to: "goal", type: "many-one", relation: "goal", fkField: "goalId", inheritsInactive: true },
  ],
} as any;

async function serve(options: { enabled?: boolean; database?: Adapter; schema?: unknown } = {}) {
  const database = options.database ?? memoryAdapter();
  const server = await createDatafnServer({
    schema: (options.schema ?? schema) as any,
    database,
    allowUnknownResources: true,
    ...(options.enabled === false ? {} : { revisions: { enabled: true } }),
  });
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
    seq += 1;
    const mutationId = mutation.mutationId ?? `m${seq}`;
    const res = await send("push", {
      clientId,
      mutations: [{ version: 1, clientId, mutationId, ...mutation }],
    });
    return { ...res, mutationId };
  };
  const rev = async (resource: string, id: string) =>
    (await readRevisions(database, NS, resource, [id])).get(id);
  return { database, server, send, push, rev };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DATA-41 revisions: every committed write bumps", () => {
  it("raises a record's revision by exactly one on each push operation and keeps a tombstone", async () => {
    const { push, rev } = await serve();
    const steps: Array<[Json, number, boolean]> = [
      [{ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } }, 1, false],
    ];
    for (const [mutation] of steps) await push(mutation);
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
      const before = (await rev("task", "task:1"))?.rev ?? 0;
      const result = await push({ resource: "task", id: "task:1", ...op });
      expect(result.body.result.ok, op.operation).toBe(true);
      expected += 1;
      const after = await rev("task", "task:1");
      expect(after?.rev, op.operation).toBe(before + 1);
      expect(after?.rev).toBe(expected);
      expect(after?.deleted).toBe(op.operation === "delete");
      expect(result.body.result.revisions[result.mutationId].rev, op.operation).toBe(expected);
    }
  });

  it("gives two writes in the same millisecond two different, increasing revisions", async () => {
    const { push, rev } = await serve();
    // Hold the clock (Date.now and new Date()) so both writes share updatedAt.
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_000 });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    const first = (await rev("task", "task:1"))!.rev;
    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "c" } });
    expect((await rev("task", "task:1"))!.rev).toBe(first + 1);
  });

  it("bumps on the direct /mutation path, in /transact and on a KV merge", async () => {
    const { send, push, rev } = await serve();
    const insert = await send("mutation", {
      resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "a" },
      clientId: "c", mutationId: "direct-1",
    });
    expect(insert.body.result.rev).toBe(1);
    const merge = await send("mutation", {
      resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "b" },
      clientId: "c", mutationId: "direct-2",
    });
    expect(merge.body.result.rev).toBe(2);
    const transact = await send("transact", {
      atomic: true,
      steps: [
        { mutation: { resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "t" }, clientId: "c", mutationId: "tx-1" } },
      ],
    });
    expect(transact.status).toBe(200);
    expect((await rev("task", "task:1"))!.rev).toBe(3);

    await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } });
    await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } });
    expect((await rev("kv", "kv:prefs"))!.rev).toBe(2);
  });

  it("bumps the records a delete changes through setNull and cascade policies", async () => {
    const { push, rev } = await serve();
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    await push({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } });

    await push({ resource: "project", operation: "delete", id: "project:1" });
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: false });

    await push({ resource: "task", operation: "delete", id: "task:1" });
    expect(await rev("comment", "comment:1")).toEqual({ rev: 2, deleted: true });
  });

  it("orders a record's revisions by commit, not by the sequences a batch reserved", async () => {
    const database = memoryAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atGate = new Promise<void>((resolve) => (reached = resolve));
    // The memory adapter serializes whole transactions; without them a push
    // keeps its reserved sequences across mutations, so requests interleave.
    // Change rows for task:y wait at a gate.
    const gated = (method: "create" | "createMany") => async (table: string, data: any) => {
      const rows = Array.isArray(data) ? data : [data];
      if (table === "__datafn_changes" && rows.some((row: any) => row.record_id === "task:y")) {
        reached();
        await gate;
      }
      return (database.internal as any)[method](table, data);
    };
    const nonTransactional = {
      ...database,
      capabilities: { ...database.capabilities, transactions: { supported: false, nested: false } },
      internal: new Proxy(database.internal, {
        get: (target, property, receiver) =>
          property === "create" || property === "createMany"
            ? gated(property)
            : Reflect.get(target, property, receiver),
      }),
    } as Adapter;
    const { send, push, rev } = await serve({ database: nonTransactional });
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
    release();
    expect((await pushA).body.result.ok).toBe(true);

    const changes = (await database.internal.findMany("__datafn_changes", []))
      .filter((row) => row.record_id === "task:x" && row.op === "merge")
      .sort((left, right) => Number(left.server_seq) - Number(right.server_seq));
    const [fromA, fromB] = changes.map((row) => ({ title: JSON.parse(String(row.record)).title, rev: row.rev }));
    // A's change has the lower (reserved) sequence but committed last.
    expect(fromA).toEqual({ title: "from-a", rev: 3 });
    expect(fromB).toEqual({ title: "from-b", rev: 2 });
    expect(await rev("task", "task:x")).toEqual({ rev: 3, deleted: false });
  });

  it("keeps revisions across change-log pruning and continues from the tombstone", async () => {
    const { database, push, rev } = await serve();
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "delete", id: "task:1" });
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await new ChangeTrackingService(database, NS).pruneChanges(0);
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "b" } });
    expect(await rev("task", "task:1")).toEqual({ rev: 3, deleted: false });
  });
});

/**
 * Runs A's batch [insert task:y, `opA` on task:x] with reserved sequences and
 * B's `opB` on task:x committed while A waits, so A's change of task:x has
 * the lower sequence but commits last.
 */
async function reservedSequenceInterleave(
  opA: Json,
  opB: Json,
  options: { enabled?: boolean; setup?: Json[] } = {},
) {
  const database = memoryAdapter();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  const gated = (method: "create" | "createMany") => async (table: string, data: any) => {
    const rows = Array.isArray(data) ? data : [data];
    if (table === "__datafn_changes" && rows.some((row: any) => row.record_id === "task:y")) {
      reached();
      await gate;
    }
    return (database.internal as any)[method](table, data);
  };
  const nonTransactional = {
    ...database,
    capabilities: { ...database.capabilities, transactions: { supported: false, nested: false } },
    internal: new Proxy(database.internal, {
      get: (target, property, receiver) =>
        property === "create" || property === "createMany" ? gated(property) : Reflect.get(target, property, receiver),
    }),
  } as Adapter;
  const served = await serve({ database: nonTransactional, enabled: options.enabled });
  for (const mutation of options.setup ?? [{ resource: "task", operation: "insert", id: "task:x", record: { title: "x" } }]) {
    await served.push(mutation);
  }
  const batch = [
    { version: 1, clientId: "client:a", mutationId: "a1", resource: "task", operation: "insert", id: "task:y", record: { title: "y" } },
    { version: 1, clientId: "client:a", mutationId: "a2", resource: "task", id: "task:x", ...opA },
  ];
  const pushA = served.send("push", { clientId: "client:a", mutations: batch });
  await atGate;
  expect((await served.push({ resource: "task", id: "task:x", ...opB }, "client:b")).body.result.ok).toBe(true);
  release();
  expect((await pushA).body.result.ok).toBe(true);
  return served;
}

/** Applies a canonical pull as clients do: rows, then patches, then deletes. */
function applyCanonical(cache: Map<string, Json>, result: Json): void {
  for (const row of result.records?.task ?? []) cache.set(row.id, { ...row });
  for (const patch of result.merged?.task ?? []) cache.set(patch.id, { ...(cache.get(patch.id) ?? {}), ...patch });
  for (const id of result.deleted?.task ?? []) cache.delete(id);
}

describe("DATA-41 revisions: canonical pull follows commit order", () => {
  const cases: Array<[string, Json, Json, string | null]> = [
    ["a replace, then a lower-sequence merge", { operation: "merge", record: { title: "from-a" } }, { operation: "replace", record: { title: "from-b" } }, "from-a"],
    ["a replace, then a lower-sequence delete", { operation: "delete" }, { operation: "replace", record: { title: "from-b" } }, null],
  ];
  for (const enabled of [true, false]) {
    for (const [name, opA, opB, expected] of cases) {
      it(`keeps the last committed state after ${name} (revisions ${enabled ? "on" : "off"})`, async () => {
        const { database, send } = await reservedSequenceInterleave(opA, opB, { enabled });
        const stored = await database.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:x" }], namespace: NS }) as Json | null;
        expect(stored?.title ?? null).toBe(expected);
        const pull = await send("pull", { clientId: "client:c", cursors: { task: "0" } });
        const cache = new Map<string, Json>();
        applyCanonical(cache, pull.body.result);
        expect(cache.get("task:x")?.title ?? null).toBe(expected);
      });
    }
  }

  it("delivers a delete and a later re-creating merge as base pull does, the patch without a revision", async () => {
    const { send, push } = await serve();
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "delete", id: "task:1" });
    const recreated = await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "again" } });
    expect(recreated.body.result.revisions[recreated.mutationId].rev).toBe(3);
    const pull = await send("pull", { clientId: "client:c", cursors: { task: "0" } });
    // Every change is delivered in its base bucket; nothing is reordered or
    // dropped. The patch carries no revision, so a client pairs none.
    expect(pull.body.result.records.task).toEqual([expect.objectContaining({ id: "task:1", title: "a", $rev: 1 })]);
    expect(pull.body.result.merged.task).toEqual([{ id: "task:1", title: "again" }]);
    expect(pull.body.result.deleted.task).toEqual(["task:1"]);
    expect(pull.body.result.deletedRevisions).toEqual({ task: { "task:1": 2 } });
  });
});

describe("DATA-41 revisions: wire format", () => {
  it("returns revisions on clone, pull and push with capabilities", async () => {
    const { database, send, push } = await serve();
    const inserted = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(inserted.body.capabilities).toEqual({ revisions: true });
    expect(inserted.body.result.revisions[inserted.mutationId]).toMatchObject({
      resource: "task", id: "task:1", rev: 1, record: { id: "task:1", title: "a" },
    });
    await push({ resource: "task", operation: "insert", id: "task:2", record: { title: "b" } });
    const deleted = await push({ resource: "task", operation: "delete", id: "task:2" });
    expect(deleted.body.result.revisions[deleted.mutationId]).toEqual({
      resource: "task", id: "task:2", rev: 2, deleted: true,
    });

    const clone = await send("clone", { clientId: "client:b", tables: ["task"] });
    expect(clone.body.capabilities).toEqual({ revisions: true });
    expect(clone.body.result.data.task).toEqual([expect.objectContaining({ id: "task:1", $rev: 1 })]);
    // Revisions are metadata on returned rows, never stored in the record.
    const stored = await database.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS });
    expect(stored).not.toHaveProperty("$rev");

    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "m" } });
    const pull = await send("pull", { clientId: "client:b", cursors: { task: "0" } });
    expect(pull.body.result.records.task).toEqual([
      expect.objectContaining({ id: "task:1", $rev: 1 }),
      expect.objectContaining({ id: "task:2", $rev: 1 }),
    ]);
    expect(pull.body.result.deleted.task).toEqual(["task:2"]);
    // A partial patch never carries a revision: clients pair one only with a
    // complete row.
    expect(pull.body.result.merged.task).toEqual([{ id: "task:1", title: "m" }]);
    expect(pull.body.result.deletedRevisions).toEqual({ task: { "task:2": 2 } });

    const query = await send("query", { resource: "task", version: 1, withRevisions: true });
    expect(query.body.result.data).toEqual([expect.objectContaining({ id: "task:1", title: "m", $rev: 2 })]);
    const projected = await send("query", { resource: "task", version: 1, select: ["id"], withRevisions: true });
    expect(projected.body.result.data[0].$rev).toBeUndefined();
  });

  it("with revisions off still bumps but issues none and records no rev on change rows", async () => {
    const { database, send, push, rev } = await serve({ enabled: false });
    const inserted = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(inserted.body.result.revisions).toBeUndefined();
    expect(inserted.body.capabilities).toBeUndefined();
    await push({ resource: "task", operation: "delete", id: "task:1" });
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    const changes = await database.internal.findMany("__datafn_changes", []);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((row) => row.rev === undefined || row.rev === null)).toBe(true);

    await push({ resource: "task", operation: "insert", id: "task:3", record: { title: "c" } });
    const clone = await send("clone", { clientId: "client:b", tables: ["task"] });
    expect(clone.body.result.data.task[0].$rev).toBeUndefined();
    const pull = await send("pull", { clientId: "client:b", cursors: { task: "0" } });
    expect(pull.body.result.records.task[0].$rev).toBeUndefined();
    expect(pull.body.result.deletedRevisions).toBeUndefined();
    const query = await send("query", { resource: "task", version: 1, withRevisions: true });
    expect(query.body.result.data[0].$rev).toBeUndefined();
  });

  it("after enablement, changes written while it was off still carry no revision", async () => {
    const database = memoryAdapter();
    const off = await serve({ enabled: false, database });
    await off.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await off.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    const on = await serve({ database });
    const pull = await on.send("pull", { clientId: "client:b", cursors: { task: "0" } });
    expect(pull.body.capabilities).toEqual({ revisions: true });
    expect(pull.body.result.records.task[0].$rev).toBeUndefined();
    expect(pull.body.result.merged.task[0].$rev).toBeUndefined();
  });

  it("returns rev without the row when the caller cannot read every field, also on a replay", async () => {
    const { send, push } = await serve();
    await push({ resource: "secretive", operation: "insert", id: "secretive:1", record: { title: "t", hidden: "h" } });
    const merged = await push({ resource: "secretive", operation: "merge", id: "secretive:1", record: { title: "u" }, mutationId: "replayed" });
    expect(merged.body.result.revisions.replayed).toEqual({ resource: "secretive", id: "secretive:1", rev: 2 });
    const replay = await push({ resource: "secretive", operation: "merge", id: "secretive:1", record: { title: "u" }, mutationId: "replayed" });
    expect(replay.body.result.revisions.replayed).toEqual({ resource: "secretive", id: "secretive:1", rev: 2 });
    const query = await send("query", { resource: "secretive", version: 1, select: ["*"], withRevisions: true });
    expect(query.body.result.data[0].$rev).toBeUndefined();
  });

  it("issues no revisions for a resource with its own $rev field and keeps the field's value", async () => {
    const { send, push } = await serve();
    const inserted = await push({ resource: "legacy", operation: "insert", id: "legacy:1", record: { $rev: "app-value" } });
    expect(inserted.body.result.revisions).toBeUndefined();
    const clone = await send("clone", { clientId: "client:b", tables: ["legacy"] });
    expect(clone.body.result.data.legacy[0].$rev).toBe("app-value");
    const pull = await send("pull", { clientId: "client:b", cursors: { legacy: "0" } });
    expect(pull.body.result.records.legacy[0].$rev).toBe("app-value");
  });
});

describe("DATA-41 revisions: namespace storage", () => {
  it("plans __datafn_revisions for copy, backup and cleanup, and accepts a change table without rev", () => {
    const relation = (name: string, columns: string[]) => ({
      name,
      columns,
      indexes: [{ columns: ["id"], unique: true, primary: true }],
    });
    const plan = resolveNamespaceStoragePlan({
      schema: { resources: [] } as any,
      catalog: {
        dialect: "postgres",
        relations: [
          relation("__datafn_revisions", INTERNAL_TABLE_SCHEMAS.__datafn_revisions.map((c) => c.name)),
          // Created before DATA-41: no rev column yet.
          relation("__datafn_changes", ["id", "namespace", "server_seq", "resource", "record_id", "op", "record", "created_at"]),
        ],
      },
    });
    const entry = plan.entries.find((candidate) => candidate.relation === "__datafn_revisions");
    expect(entry).toMatchObject({ logicalRole: "revisions", namespaceColumn: "namespace" });
    expect(entry!.operations).toEqual(expect.arrayContaining(["copy", "backup", "cleanup"]));
    expect(plan.entries.some((candidate) => candidate.relation === "__datafn_changes")).toBe(true);
  });
});

describe("DATA-41 revisions: one bump per write, complete change rows", () => {
  const changeRows = async (database: Adapter, id: string) =>
    (await database.internal.findMany("__datafn_changes", []))
      .filter((row) => row.record_id === id)
      .sort((left, right) => Number(left.server_seq) - Number(right.server_seq))
      .map((row) => ({ op: row.op, rev: row.rev ?? undefined, record: row.record ? JSON.parse(String(row.record)) : null }));
  const stored = async (database: Adapter, model: string, id: string) =>
    database.findOne({ model, where: [{ field: "id", operator: "eq", value: id }], namespace: NS });

  it("bumps a record once for an insert under an archived inheritsInactive parent, on push and /mutation", async () => {
    const { database, send, push, rev } = await serve();
    await push({ resource: "goal", operation: "insert", id: "goal:1", record: { label: "G" } });
    await push({ resource: "goal", operation: "archive", id: "goal:1" });

    const inserted = await push({ resource: "step", operation: "insert", id: "step:1", record: { title: "a", goalId: "goal:1" } });
    expect(await rev("step", "step:1")).toEqual({ rev: 1, deleted: false });
    const rows = await changeRows(database, "step:1");
    // Only the write's last change row carries the revision, with the exact committed row.
    expect(rows.slice(0, -1).every((row) => row.rev === undefined)).toBe(true);
    expect(rows[rows.length - 1].rev).toBe(1);
    const committed = await stored(database, "step", "step:1");
    expect(committed).toHaveProperty("isAncestorInactive", true);
    if (rows[rows.length - 1].op !== "merge") expect(rows[rows.length - 1].record).toEqual(committed);
    expect(inserted.body.result.revisions[inserted.mutationId]).toMatchObject({ rev: 1, record: { ...committed, $rev: 1 } });

    const direct = await send("mutation", {
      resource: "step", version: 1, operation: "insert", id: "step:2", record: { title: "b", goalId: "goal:1" },
      clientId: "c", mutationId: "direct-under-archived",
    });
    expect(direct.body.result.rev).toBe(1);
    expect(await rev("step", "step:2")).toEqual({ rev: 1, deleted: false });

    const related = await push({ resource: "step", operation: "insert", id: "step:3", record: { title: "c" } });
    expect(related.body.result.ok).toBe(true);
    await push({ resource: "step", operation: "relate", id: "step:3", relations: { goal: "goal:1" } });
    expect(await rev("step", "step:3")).toEqual({ rev: 2, deleted: false });
  });

  it("bumps each record inactive propagation changes", async () => {
    const { database, push, rev } = await serve();
    await push({ resource: "goal", operation: "insert", id: "goal:1", record: { label: "G" } });
    await push({ resource: "step", operation: "insert", id: "step:1", record: { title: "a", goalId: "goal:1" } });
    await push({ resource: "step", operation: "insert", id: "step:2", record: { title: "b", goalId: "goal:1" } });
    await push({ resource: "goal", operation: "archive", id: "goal:1" });
    expect(await rev("step", "step:1")).toEqual({ rev: 2, deleted: false });
    expect(await rev("step", "step:2")).toEqual({ rev: 2, deleted: false });
    expect(await rev("goal", "goal:1")).toEqual({ rev: 2, deleted: false });
  });

  it("records the stored row, with database defaults, on an insert change that carries a revision", async () => {
    // A database that fills a column default the payload does not carry.
    const base = memoryAdapter();
    const withDefault = (adapter: Adapter): Adapter => ({
      ...adapter,
      create: (args: any) => adapter.create(args.model === "project" ? { ...args, data: { name: "db-default", ...args.data } } : args),
      transaction: (callback: any) => adapter.transaction((tx: Adapter) => callback(withDefault(tx))),
    }) as Adapter;
    const { database, push } = await serve({ database: withDefault(base) });
    await push({ resource: "project", operation: "insert", id: "project:1", record: {} });
    const [insert] = await changeRows(database, "project:1");
    expect(insert).toEqual({ op: "insert", rev: 1, record: { id: "project:1", name: "db-default" } });
  });

  it("bumps on every lifecycle and relation operation through /mutation and /transact", async () => {
    // modifyRelation edits many-many join metadata only (no record changes).
    const { send, push, rev } = await serve();
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    const related = await send("mutation", {
      resource: "task", version: 1, operation: "relate", id: "task:1", relations: { project: "project:1" },
      clientId: "c", mutationId: "direct-relate",
    });
    expect(related.body.result.rev).toBe(2);
    const unrelated = await send("transact", { atomic: true, steps: [{ mutation: {
      resource: "task", version: 1, operation: "unrelate", id: "task:1", relations: { project: "project:1" },
      clientId: "c", mutationId: "tx-unrelate",
    } }] });
    expect(unrelated.status).toBe(200);
    expect((await rev("task", "task:1"))!.rev).toBe(3);

    let expected = 3;
    let n = 0;
    for (const operation of ["trash", "restore", "archive", "unarchive", "replace", "delete"]) {
      const mutation = { resource: "task", version: 1, operation, id: "task:1", clientId: "c", ...(operation === "replace" ? { record: { title: "r" } } : {}) };
      const viaTransact = n++ % 2 === 1;
      const response = viaTransact
        ? await send("transact", { atomic: true, steps: [{ mutation: { ...mutation, mutationId: `tx-${operation}` } }] })
        : await send("mutation", { ...mutation, mutationId: `direct-${operation}` });
      expect(response.status, operation).toBe(200);
      expected += 1;
      expect(await rev("task", "task:1"), operation).toEqual({ rev: expected, deleted: operation === "delete" });
    }
  });

  it("creates the revisions table before the in-process /transact executor opens its transaction", async () => {
    const database = memoryAdapter();
    let inTransaction = false;
    const ensured: string[] = [];
    const tracked = {
      ...database,
      internal: new Proxy(database.internal, {
        get: (target, property, receiver) =>
          property === "ensureTable"
            ? async (table: string, columns: unknown) => {
                if (inTransaction && table === "__datafn_revisions") throw new Error("DDL inside the transaction");
                ensured.push(table);
                return (target as any).ensureTable(table, columns);
              }
            : Reflect.get(target, property, receiver),
      }),
      transaction: async (callback: (tx: Adapter) => Promise<unknown>) => {
        inTransaction = true;
        try {
          return await database.transaction(callback as any);
        } finally {
          inTransaction = false;
        }
      },
    } as Adapter;
    const server = await createDatafnServer({ schema, database: tracked, allowUnknownResources: true, revisions: { enabled: true } });
    await (server as any).executor.transact({
      atomic: true,
      steps: [{ mutation: { resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "a" }, clientId: "c", mutationId: "m1" } }],
    });
    expect(ensured).toContain("__datafn_revisions");
    expect((await readRevisions(database, NS, "task", ["task:1"])).get("task:1")?.rev).toBe(1);
  });
});

describe("DATA-41 revisions: reads", () => {
  it("reads revisions in id lists D1 can bind, also for a clone page and a versioned query over many rows", async () => {
    const base = memoryAdapter();
    const longest: number[] = [];
    // Rejects revision lookups binding more than D1's 100 parameters.
    const limitBinds = (adapter: Adapter): Adapter => ({
      ...adapter,
      internal: new Proxy(adapter.internal, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver);
          if (property !== "findMany") return value;
          return async (table: string, where: any[], ...rest: unknown[]) => {
            for (const clause of table === "__datafn_revisions" ? where ?? [] : []) {
              if (clause.op !== "in") continue;
              longest.push(clause.value.length);
              if (clause.value.length > 100) throw new Error("too many SQL variables");
            }
            return value.call(target, table, where, ...rest);
          };
        },
      }),
      transaction: (callback: any) => adapter.transaction((tx: Adapter) => callback(limitBinds(tx))),
    }) as Adapter;
    const database = limitBinds(base);
    const { send } = await serve({ database });
    expect(READ_CHUNK).toBeLessThanOrEqual(90);
    const mutations = Array.from({ length: 150 }, (_, i) => ({
      version: 1, clientId: "client:a", mutationId: `bulk-${i}`, resource: "project", operation: "insert",
      id: `project:${String(i).padStart(3, "0")}`, record: { name: `p${i}` },
    }));
    expect((await send("push", { clientId: "client:a", mutations })).body.result.ok).toBe(true);
    const page = await send("clone", { clientId: "client:b", tables: ["project"], page: { table: "project", limit: 150 } });
    expect(page.status).toBe(200);
    expect(page.body.result.data.project).toHaveLength(150);
    expect(page.body.result.data.project.every((row: Json) => row.$rev === 1)).toBe(true);
    const query = await send("query", { resource: "project", version: 1, limit: 100, withRevisions: true });
    expect(query.body.result.data).toHaveLength(100);
    expect(query.body.result.data.every((row: Json) => row.$rev === 1)).toBe(true);
    expect(Math.max(...longest)).toBeLessThanOrEqual(90);
  }, 30_000);

  it("without transactions attaches no revision, since a write and its revision are separate statements", async () => {
    const database = memoryAdapter();
    await ensureRevisionsTable(database);
    const nonTransactional = {
      ...database,
      capabilities: { ...database.capabilities, transactions: { supported: false, nested: false } },
    } as Adapter;
    await bumpRevision(database, NS, "task", "task:1", false);
    const rows = await readWithRevisions(
      nonTransactional,
      NS,
      "task",
      async () => [{ id: "task:1", title: "at-rev-1" }],
      (result) => result,
    );
    expect(rows).toEqual([{ id: "task:1", title: "at-rev-1" }]);
  });

  it("without a verified snapshot attaches a revision only when no write committed around the row read", async () => {
    // The memory adapter has transactions but no raw SQL, so its isolation
    // is unknown: revisions are read before and after the returned rows.
    const database = memoryAdapter();
    await ensureRevisionsTable(database);
    await bumpRevision(database, NS, "task", "task:1", false);
    await bumpRevision(database, NS, "task", "task:2", false);
    let reads = 0;
    let title = "at-rev-1";
    const rows = await readWithRevisions(
      database,
      NS,
      "task",
      async () => {
        reads += 1;
        const result = [{ id: "task:1", title }, { id: "task:2", title: "steady" }];
        // A write to task:1 commits after the revision read that precedes
        // the returned rows, and before those rows are read.
        if (reads === 2) {
          await bumpRevision(database, NS, "task", "task:1", false);
          title = "at-rev-2";
          result[0] = { id: "task:1", title };
        }
        return result;
      },
      (result) => result,
    );
    expect(rows).toEqual([{ id: "task:1", title: "at-rev-2" }, { id: "task:2", title: "steady", $rev: 1 }]);
  });

  it("gives a record written before revisions existed revision 0 on clone and a versioned query", async () => {
    const { database, send } = await serve();
    await database.create({ model: "task", data: { id: "task:old", title: "legacy" }, namespace: NS } as any);
    const clone = await send("clone", { clientId: "client:b", tables: ["task"] });
    expect(clone.body.result.data.task).toEqual([expect.objectContaining({ id: "task:old", $rev: 0 })]);
    const query = await send("query", { resource: "task", version: 1, withRevisions: true });
    expect(query.body.result.data).toEqual([expect.objectContaining({ id: "task:old", $rev: 0 })]);
  });

  it("decides read eligibility from the policy, so an unset hidden field still withholds the row and $rev", async () => {
    const { send, push } = await serve();
    const inserted = await push({ resource: "secretive", operation: "insert", id: "secretive:1", record: { title: "t" } });
    expect(inserted.body.result.revisions[inserted.mutationId]).toEqual({ resource: "secretive", id: "secretive:1", rev: 1 });
    expect(JSON.stringify(inserted.body.result)).not.toContain("hidden");
    const query = await send("query", { resource: "secretive", version: 1, withRevisions: true });
    expect(query.body.result.data[0]).not.toHaveProperty("$rev");
  });

  it("returns no revisions for a relation traversal, whose rows belong to another resource", async () => {
    const { send, push } = await serve();
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    const related = await send("query", { resource: "task", version: 1, id: "task:1", relation: "project", withRevisions: true });
    expect(JSON.stringify(related.body)).not.toContain("$rev");
  });

  it("announces capabilities on every DataFn envelope, including seed, status and auth errors", async () => {
    const database = memoryAdapter();
    const server = await createDatafnServer({
      schema,
      database,
      allowUnknownResources: true,
      revisions: { enabled: true },
      authorize: async (_ctx: unknown, action: string) => action !== "query",
    } as any);
    const call = async (route: string, body?: unknown) => {
      const res = await server.router.handle(new Request(`http://localhost/datafn/${route}`, body === undefined
        ? { method: "GET" }
        : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
      return (await res.json()) as Json;
    };
    expect((await call("status")).capabilities).toEqual({ revisions: true });
    expect((await call("seed", { clientId: "c", seed: {} })).capabilities).toEqual({ revisions: true });
    const denied = await call("query", { resource: "task", version: 1 });
    expect(denied.ok).toBe(false);
    expect(denied.capabilities).toEqual({ revisions: true });
  });
});

describe("DATA-41 revisions: retries, rollbacks and replays", () => {
  it("completes every record's bump when change tracking retries after a bump failed part-way", async () => {
    const database = memoryAdapter();
    let revisionUpdates = 0;
    let failAt = 0;
    const flaky = {
      ...database,
      capabilities: { ...database.capabilities, transactions: { supported: false, nested: false } },
      internal: new Proxy(database.internal, {
        get: (target, property, receiver) =>
          property === "update"
            ? async (table: string, where: unknown, data: unknown) => {
                if (table === "__datafn_revisions" && ++revisionUpdates === failAt) {
                  throw new Error("transient adapter error");
                }
                return (target as any).update(table, where, data);
              }
            : Reflect.get(target, property, receiver),
      }),
    } as Adapter;
    const { send, rev } = await serve({ database: flaky });
    const mutate = (mutation: Json) =>
      send("mutation", { version: 1, clientId: "c", ...mutation });
    await mutate({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" }, mutationId: "i1" });
    await mutate({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" }, mutationId: "i2" });
    await mutate({ resource: "comment", operation: "insert", id: "comment:2", record: { body: "y", taskId: "task:1" }, mutationId: "i3" });

    // The delete bumps three records; the second bump fails once.
    revisionUpdates = 0;
    failAt = 2;
    const deleted = await mutate({ resource: "task", operation: "delete", id: "task:1", mutationId: "d1" });
    expect(deleted.body.result.ok).toBe(true);
    expect(await rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect(await rev("comment", "comment:1")).toEqual({ rev: 2, deleted: true });
    expect(await rev("comment", "comment:2")).toEqual({ rev: 2, deleted: true });
    expect(deleted.body.result.rev).toBe(2);
  });

  it("returns no revision for a step of a rolled-back transaction", async () => {
    const { send, rev } = await serve();
    await send("mutation", { resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "a" }, clientId: "c", mutationId: "i1" });
    const transact = await send("transact", {
      atomic: true,
      steps: [
        { mutation: { resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "t" }, clientId: "c", mutationId: "tx-1" } },
        // Inserting an existing id fails, which rolls back the first step.
        { mutation: { resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "x" }, clientId: "c", mutationId: "tx-2" } },
      ],
    });
    const results = transact.body.result.results;
    expect(results[0]).toMatchObject({ ok: false, rolledBack: true });
    expect(results[0].result).not.toHaveProperty("rev");
    expect((await rev("task", "task:1"))!.rev).toBe(1);
  });

  it("replays a stored direct mutation result without its revision once revisions are off", async () => {
    const database = memoryAdapter();
    const on = await serve({ database });
    const first = await on.send("mutation", {
      resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "a" }, clientId: "c", mutationId: "once",
    });
    expect(first.body.result.rev).toBe(1);
    const off = await serve({ database, enabled: false });
    const replay = await off.send("mutation", {
      resource: "task", version: 1, operation: "insert", id: "task:1", record: { title: "a" }, clientId: "c", mutationId: "once",
    });
    expect(replay.body.result.deduped).toBe(true);
    expect(replay.body.result).not.toHaveProperty("rev");
  });
});

describe("DATA-41 revisions: complete rows only", () => {
  it("returns the complete stored row with $rev from a versioned query the in-memory strategy runs", async () => {
    const { send, push } = await serve();
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    const query = await send("query", {
      resource: "task", version: 1, withRevisions: true, filters: { title: { not_ilike: "z" } },
    });
    expect(query.status).toBe(200);
    const [row] = query.body.result.data;
    expect(row).toMatchObject({ id: "task:1", projectId: "project:1", $rev: 1 });
  });

  it("returns no hidden field and no $rev from a versioned query of a read-restricted resource", async () => {
    const { send, push } = await serve();
    await push({ resource: "secretive", operation: "insert", id: "secretive:1", record: { title: "t", hidden: "h" } });
    for (const select of [undefined, ["*"]]) {
      const shape = { resource: "secretive", version: 1, ...(select ? { select } : {}) };
      const query = await send("query", { ...shape, withRevisions: true });
      expect(query.status).toBe(200);
      const [row] = query.body.result.data;
      expect(row).toMatchObject({ id: "secretive:1", title: "t" });
      expect(row).not.toHaveProperty("hidden");
      expect(row).not.toHaveProperty("$rev");
    }
  });

  it("returns each versioned row exactly as clone returns it, on every query strategy", async () => {
    const { send, push } = await serve();
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    const clone = await send("clone", { clientId: "client:b", tables: ["task"] });
    const [cloned] = clone.body.result.data.task;
    expect(cloned).toMatchObject({ id: "task:1", projectId: "project:1", $rev: 2 });
    for (const filters of [
      undefined, // push-down
      { title: { not_ilike: "z" } }, // in memory
      { "project.name": { eq: "P" } }, // through a relation
      { id: { in: Array.from({ length: 150 }, (_, i) => (i === 0 ? "task:1" : `task:none-${i}`)) } },
    ]) {
      const query = await send("query", { resource: "task", version: 1, withRevisions: true, ...(filters ? { filters } : {}) });
      expect(query.status).toBe(200);
      expect(query.body.result.data).toEqual([cloned]);
    }
  });

  it("reruns a versioned query that fails inside the PostgreSQL snapshot outside it, without revisions", async () => {
    const database = memoryAdapter();
    const { push } = await serve({ database });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    // A PostgreSQL adapter whose snapshot transaction aborts on the query's
    // read, as a push-down fallback does inside a transaction.
    const rawSql = { dialect: "postgres", execute: async () => undefined, query: async () => [] };
    let snapshots = 0;
    const postgresLike = {
      ...database,
      rawSql,
      transaction: async (fn: (tx: Adapter) => Promise<unknown>) => {
        snapshots += 1;
        return fn({
          ...database,
          rawSql,
          findMany: async (args: any) => {
            if (args.model === "task") throw new Error("current transaction is aborted");
            return database.findMany(args);
          },
        } as Adapter);
      },
    } as unknown as Adapter;
    const reader = await serve({ database: postgresLike });
    const query = await reader.send("query", { resource: "task", version: 1, withRevisions: true });
    expect(snapshots).toBeGreaterThan(0);
    expect(query.status).toBe(200);
    expect(query.body.result.data).toEqual([expect.objectContaining({ id: "task:1", title: "a" })]);
    expect(query.body.result.data[0]).not.toHaveProperty("$rev");
  });

  it("never pairs a versioned row with a revision of another state when a write commits during the query", async () => {
    const database = memoryAdapter();
    let inject: { call: number; write: () => Promise<unknown> } | undefined;
    let calls = 0;
    const racing = {
      ...database,
      findMany: async (args: any) => {
        if (inject && args.model === "task") {
          if (calls++ === inject.call) {
            const { write } = inject;
            inject = undefined;
            const rows = await database.findMany(args);
            await write();
            return rows;
          }
        }
        return database.findMany(args);
      },
    } as Adapter;
    const { send, push, rev } = await serve({ database: racing });
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "project", operation: "insert", id: "project:2", record: { name: "Q" } });
    // Each state a revision belongs to, keyed by revision.
    const states = new Map<number, Json>();
    const record = async () => {
      const stored = (await database.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS })) as Json;
      states.set((await rev("task", "task:1"))!.rev, { ...stored });
    };
    const writes: Json[] = [
      { operation: "merge", record: { title: "changed" } },
      { operation: "trash" },
      { operation: "unrelate", relations: { project: "project:1" } },
      { operation: "relate", relations: { project: "project:2" } },
    ];
    const queries: Json[] = [
      { filters: { title: { eq: "a" } } },
      { filters: { projectId: { eq: "project:1" }, title: { not_ilike: "z" } } },
      { filters: { "project.name": { eq: "P" } } },
      { sort: ["title"], limit: 1 },
    ];
    for (const write of writes) {
      for (const shape of queries) {
        for (const call of [0, 1]) {
          await push({ resource: "task", operation: "replace", id: "task:1", record: { title: "a", projectId: "project:1" } });
          await record();
          calls = 0;
          inject = { call, write: async () => {
            await push({ resource: "task", id: "task:1", ...write });
            await record();
          } };
          const query = await send("query", { resource: "task", version: 1, withRevisions: true, ...shape });
          expect(query.status).toBe(200);
          inject = undefined;
          for (const row of query.body.result.data) {
            if (row.$rev === undefined) continue;
            const { $rev, ...state } = row;
            expect(state).toEqual(JSON.parse(JSON.stringify(states.get($rev))));
          }
        }
      }
    }
  });

  it("returns shared rows of a versioned query without hidden fields or revisions", async () => {
    const shared = {
      resources: [{
        name: "notebook",
        version: 1,
        capabilities: ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
        fields: [
          { name: "title", type: "string" as const, required: false },
          { name: "hidden", type: "string" as const, required: false },
        ],
        permissions: { read: { fields: ["title"] }, write: { fields: ["title", "hidden"] } },
      }],
      relations: [],
    } as any;
    const database = memoryAdapter();
    const server = await createDatafnServer({
      schema: shared,
      database,
      allowUnknownResources: true,
      revisions: { enabled: true },
      namespaceProvider: { getNamespace: () => "user:bob", getActorId: () => "bob" as any },
    });
    await database.create({
      model: "notebook",
      data: { id: "notebook:1", title: "Trip", hidden: "owner-only", createdBy: "alice", __ns: "user:alice" },
      namespace: "user:alice",
    });
    await database.create({
      model: "__datafn_permissions_global",
      data: {
        id: "grant-1", resourceType: "notebook", resourceNs: "user:alice", resourceId: "notebook:1",
        principalId: "user:bob", level: "viewer", grantKind: "record", sourceRef: null,
        grantedBy: "user:alice", grantedAt: 1, revokedAt: null, __ns: "user:alice",
      },
      namespace: "user:alice",
    });
    for (const select of [undefined, ["*"]]) {
      const res = await server.router.handle(new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "notebook", version: 1, withRevisions: true, ...(select ? { select } : {}),
          metadata: { accessMode: "sharedWithMe", namespaceFilter: ["user:alice"] },
        }),
      }));
      const body = (await res.json()) as Json;
      expect(res.status).toBe(200);
      expect(body.result.data).toEqual([expect.objectContaining({ id: "notebook:1", title: "Trip" })]);
      expect(body.result.data[0]).not.toHaveProperty("hidden");
      expect(body.result.data[0]).not.toHaveProperty("$rev");
    }
  });

  it("returns no post-write row on push when the caller lost record access after the pre-write check", async () => {
    const shared = {
      resources: [{
        name: "notebook",
        version: 1,
        capabilities: ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
        fields: [{ name: "title", type: "string" as const, required: false }, { name: "note", type: "string" as const, required: false }],
      }],
      relations: [],
    } as any;
    const base = memoryAdapter();
    let revokeOnWrite = false;
    // Ownership moves to alice after push checked bob's access: another
    // writer commits just before bob's merge writes the row.
    const database = {
      ...base,
      transaction: (callback: any) => base.transaction((tx: Adapter) => callback({
        ...tx,
        update: async (args: any) => {
          if (revokeOnWrite && args.model === "notebook") {
            revokeOnWrite = false;
            await tx.update({ ...args, data: { createdBy: "alice", note: "alice-only" } });
          }
          return tx.update(args);
        },
      })),
    } as Adapter;
    const server = await createDatafnServer({
      schema: shared,
      database,
      allowUnknownResources: true,
      revisions: { enabled: true },
      namespaceProvider: { getNamespace: () => "team", getActorId: () => "bob" as any },
    });
    const push = async (mutation: Json) => {
      const res = await server.router.handle(new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "client:bob", mutations: [{ version: 1, clientId: "client:bob", ...mutation }] }),
      }));
      return (await res.json()) as Json;
    };
    const inserted = await push({ mutationId: "n1", resource: "notebook", operation: "insert", id: "notebook:1", record: { title: "t" } });
    expect(inserted.result.revisions.n1.record).toMatchObject({ id: "notebook:1", title: "t", $rev: 1 });
    revokeOnWrite = true;
    const merged = await push({ mutationId: "n2", resource: "notebook", operation: "merge", id: "notebook:1", record: { title: "u" } });
    expect(merged.result.ok, JSON.stringify(merged)).toBe(true);
    expect(merged.result.revisions.n2).toEqual({ resource: "notebook", id: "notebook:1", rev: 2 });
    expect(JSON.stringify(merged)).not.toContain("alice-only");
  });

  it("withholds unreadable stored fields from revisioned pull rows, on both pull formats", async () => {
    const base = memoryAdapter();
    const withDefault = (adapter: Adapter): Adapter => ({
      ...adapter,
      create: (args: any) =>
        adapter.create(args.model === "secretive" ? { ...args, data: { hidden: "db-secret", ...args.data } } : args),
      transaction: (callback: any) => adapter.transaction((tx: Adapter) => callback(withDefault(tx))),
    }) as Adapter;
    const { send, push } = await serve({ database: withDefault(base) });
    await push({ resource: "secretive", operation: "insert", id: "secretive:1", record: { title: "t" } });
    const canonical = await send("pull", { clientId: "client:b", cursors: { secretive: "0" } });
    expect(canonical.body.result.records.secretive).toEqual([{ id: "secretive:1", title: "t" }]);
    const global = await send("pull", { clientId: "client:b", cursor: "0" });
    const change = global.body.result.changes.find((entry: Json) => entry.id === "secretive:1");
    expect(change).toMatchObject({ rev: 1, record: { id: "secretive:1", title: "t" } });
    expect(JSON.stringify(global.body.result)).not.toContain("db-secret");
    expect(change.record).not.toHaveProperty("$rev");
  });

  it("marks complete rows with $rev on a global-cursor pull and gives partial patches rev only", async () => {
    const { send, push } = await serve();
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    const pull = await send("pull", { clientId: "client:b", cursor: "0" });
    const changes = pull.body.result.changes.filter((entry: Json) => entry.id === "task:1");
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ rev: 1, record: { id: "task:1", title: "a", $rev: 1 } });
    expect(changes[1]).toMatchObject({ rev: 2, record: { title: "b" } });
    expect(changes[1].record).not.toHaveProperty("$rev");
  });

  it("delivers a delete then re-insert in one canonical pull as base pull does, each with its own revision", async () => {
    const { send, push } = await serve();
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await push({ resource: "task", operation: "delete", id: "task:1" });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "again" } });
    const pull = await send("pull", { clientId: "client:b", cursors: { task: "0" } });
    expect(pull.body.result.records.task).toEqual([expect.objectContaining({ id: "task:1", title: "again", $rev: 3 })]);
    expect(pull.body.result.deleted.task).toEqual(["task:1"]);
    expect(pull.body.result.deletedRevisions).toEqual({ task: { "task:1": 2 } });
  });

  it("returns no post-write row for a record a later mutation of the same push changed", async () => {
    const { send, push, rev } = await serve();
    await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    await push({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } });
    const batch = (mutations: Json[]) =>
      send("push", { clientId: "client:a", mutations: mutations.map((m) => ({ version: 1, clientId: "client:a", ...m })) });

    const cascade = await batch([
      { mutationId: "b1", resource: "comment", operation: "merge", id: "comment:1", record: { body: "y" } },
      { mutationId: "b2", resource: "project", operation: "insert", id: "project:2", record: { name: "Q" } },
    ]);
    // Nothing later in this push changed the comment: its row is returned.
    expect(cascade.body.result.revisions.b1.record).toMatchObject({ id: "comment:1", body: "y", $rev: 2 });

    const setNull = await batch([
      { mutationId: "c1", resource: "task", operation: "merge", id: "task:1", record: { title: "m" } },
      { mutationId: "c2", resource: "project", operation: "delete", id: "project:1" },
    ]);
    expect(setNull.body.result.revisions.c1).toEqual({ resource: "task", id: "task:1", rev: 2 });

    // A merge of the child, then a cascade delete of its parent.
    const cascaded = await batch([
      { mutationId: "d1", resource: "comment", operation: "merge", id: "comment:1", record: { body: "z" } },
      { mutationId: "d2", resource: "task", operation: "delete", id: "task:1" },
    ]);
    expect(cascaded.body.result.revisions.d1).toEqual({ resource: "comment", id: "comment:1", rev: 3 });
    expect((await rev("comment", "comment:1"))).toEqual({ rev: 4, deleted: true });
    expect(cascaded.body.result.revisions.d2).toMatchObject({ resource: "task", id: "task:1", deleted: true });
  });
});

describe("DATA-41 revisions: SQL without raw SQL access", () => {
  it.each([
    ["a probe of the missing column fails", false],
    ["the driver accepts a filter on any column name", true],
  ])("records no rev on change rows of a SQL table it cannot verify (%s), and the write still succeeds", async (_label, lax) => {
    const database = memoryAdapter();
    const prismaLike = {
      ...database,
      capabilities: { ...database.capabilities, schema: { migrations: true, constraints: true, indexes: true } },
      internal: new Proxy(database.internal, {
        get: (target, property, receiver) => {
          if (property === "findMany") {
            return async (table: string, where: Array<{ field: string }>, opts?: unknown) => {
              if (!lax && table === "__datafn_changes" && where.some((clause) => clause.field === "rev")) {
                throw new Error('column "rev" does not exist');
              }
              return (target as any).findMany(table, where, opts);
            };
          }
          if (property === "create" || property === "createMany") {
            return async (table: string, data: any) => {
              const rows = Array.isArray(data) ? data : [data];
              if (table === "__datafn_changes" && rows.some((row) => "rev" in row)) {
                throw new Error('column "rev" does not exist');
              }
              return (target as any)[property](table, data);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    } as Adapter;
    const { push, send, rev } = await serve({ database: prismaLike });
    const inserted = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(inserted.body.result.ok).toBe(true);
    expect(await rev("task", "task:1")).toEqual({ rev: 1, deleted: false });
    const pull = await send("pull", { clientId: "client:b", cursors: { task: "0" } });
    expect(pull.body.result.records.task[0]).not.toHaveProperty("$rev");
  });

  it("reads revisions before the returned rows inside a transaction of unknown isolation", async () => {
    const database = memoryAdapter();
    await ensureRevisionsTable(database);
    await bumpRevision(database, NS, "task", "task:1", false);
    let title = "at-rev-1";
    let reads = 0;
    const rows = await readWithRevisions(
      database,
      NS,
      "task",
      async () => {
        const row = [{ id: "task:1", title }];
        // A write commits right after the first read.
        if (reads++ === 0) {
          await bumpRevision(database, NS, "task", "task:1", false);
          title = "at-rev-2";
        }
        return row;
      },
      (result) => result,
    );
    expect(rows).toEqual([{ id: "task:1", title: "at-rev-2", $rev: 2 }]);
  });
});

describe("DATA-41 revisions: round 3", () => {
  it("withholds unreadable stored fields from revisioned change rows after revisions are turned off", async () => {
    const base = memoryAdapter();
    const withDefault = (adapter: Adapter): Adapter => ({
      ...adapter,
      create: (args: any) =>
        adapter.create(args.model === "secretive" ? { ...args, data: { hidden: "db-secret", ...args.data } } : args),
      transaction: (callback: any) => adapter.transaction((tx: Adapter) => callback(withDefault(tx))),
    }) as Adapter;
    const enabled = await serve({ database: withDefault(base) });
    await enabled.push({ resource: "secretive", operation: "insert", id: "secretive:1", record: { title: "t" } });
    // The same database, read by a server with revisions off.
    const disabled = await serve({ database: base, enabled: false });
    const canonical = await disabled.send("pull", { clientId: "client:b", cursors: { secretive: "0" } });
    expect(canonical.body.result.records.secretive).toEqual([{ id: "secretive:1", title: "t" }]);
    const global = await disabled.send("pull", { clientId: "client:b", cursor: "0" });
    expect(JSON.stringify(global.body.result)).not.toContain("db-secret");
    expect(JSON.stringify(global.body.result)).not.toContain("$rev");
  });

  it("drops an earlier KV $rev when a later merge without one coalesces over it in a per-table pull", async () => {
    const database = memoryAdapter();
    const enabled = await serve({ database });
    const disabled = await serve({ database, enabled: false });
    await enabled.push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } });
    // A worker with revisions off (during rollout) writes without a change-row rev.
    await disabled.push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 2 } } }, "client:c");
    const pull = await enabled.send("pull", { clientId: "client:b", cursors: { kv: "0" } });
    const rows = [...(pull.body.result.records.kv ?? []), ...(pull.body.result.merged?.kv ?? [])]
      .filter((row: Json) => row.id === "kv:prefs");
    expect(rows.length).toBeGreaterThan(0);
    const last = rows[rows.length - 1];
    expect(last.value).toEqual({ a: 2 });
    expect(last).not.toHaveProperty("$rev");
  });

  it("delivers a KV delete and a later complete KV write as base pull does, each with its own revision", async () => {
    const { push, send } = await serve();
    await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } });
    await push({ resource: "kv", operation: "delete", id: "kv:prefs" });
    await push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } });
    const pull = await send("pull", { clientId: "client:b", cursors: { kv: "0" } });
    expect(pull.body.result.deleted.kv).toEqual(["kv:prefs"]);
    expect(pull.body.result.deletedRevisions).toEqual({ kv: { "kv:prefs": 2 } });
    const rows = [...(pull.body.result.records.kv ?? []), ...(pull.body.result.merged?.kv ?? [])]
      .filter((row: Json) => row.id === "kv:prefs");
    expect(rows[rows.length - 1]).toMatchObject({ value: { b: 2 }, $rev: 3 });
  });

  it("returns a resource's own readable $rev field unchanged from a query sent with withRevisions", async () => {
    const declared = {
      ...schema,
      resources: [
        ...schema.resources,
        {
          name: "legacyRead",
          version: 1,
          fields: [
            { name: "$rev", type: "string" as const, required: false },
            { name: "title", type: "string" as const, required: false },
          ],
          permissions: { read: { fields: ["$rev", "title"] }, write: { fields: ["$rev", "title"] } },
        },
      ],
    } as any;
    const server = await createDatafnServer({
      schema: declared, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
    });
    const send = async (route: string, body: unknown) => {
      const res = await server.router.handle(new Request(`http://localhost/datafn/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      return (await res.json()) as Json;
    };
    await send("push", {
      clientId: "client:a",
      mutations: [{ version: 1, clientId: "client:a", mutationId: "m1", resource: "legacyRead", operation: "insert", id: "legacyRead:1", record: { $rev: "app-value", title: "t" } }],
    });
    for (const select of [undefined, ["$rev", "title"]]) {
      const query = await send("query", { resource: "legacyRead", version: 1, withRevisions: true, ...(select ? { select } : {}) });
      expect(query.result.data[0]).toMatchObject({ $rev: "app-value", title: "t" });
    }
  });

  it("keeps the query's own row, without $rev, when the stored row has a field the caller cannot read", async () => {
    const base = memoryAdapter();
    // A retained database column the read policy does not list.
    const withColumn = (adapter: Adapter): Adapter => ({
      ...adapter,
      findMany: async (args: any) => {
        const rows = await adapter.findMany(args);
        return args.model === "secretive" ? rows.map((row: any) => ({ ...row, retained: "col-secret" })) : rows;
      },
      transaction: (callback: any) => adapter.transaction((tx: Adapter) => callback(withColumn(tx))),
    }) as Adapter;
    const readable = {
      ...schema,
      resources: schema.resources.map((resource: any) =>
        resource.name === "secretive"
          ? { ...resource, permissions: { read: { fields: ["title", "hidden"] }, write: { fields: ["title", "hidden"] } } }
          : resource),
    } as any;
    const server = await createDatafnServer({
      schema: readable, database: withColumn(base), allowUnknownResources: true, revisions: { enabled: true },
    });
    const send = async (route: string, body: unknown) => {
      const res = await server.router.handle(new Request(`http://localhost/datafn/${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }));
      return (await res.json()) as Json;
    };
    await send("push", {
      clientId: "client:a",
      mutations: [{ version: 1, clientId: "client:a", mutationId: "m1", resource: "secretive", operation: "insert", id: "secretive:1", record: { title: "t" } }],
    });
    const plain = await send("query", { resource: "secretive", version: 1, filters: { id: "secretive:1" } });
    const query = await send("query", { resource: "secretive", version: 1, withRevisions: true, filters: { id: "secretive:1" } });
    expect(query.result.data).toEqual(plain.result.data);
    expect(query.result.data[0]).not.toHaveProperty("$rev");
  });
});

describe("DATA-41 revisions: canonical pull coalescing (round 7)", () => {
  for (const enabled of [true, false]) {
    it(`keeps a resource's own $rev value through coalescing (revisions ${enabled ? "on" : "off"})`, async () => {
      const { push, send } = await serve({ enabled });
      await push({ resource: "legacy", operation: "insert", id: "legacy:1", record: { $rev: "v1" } });
      await push({ resource: "legacy", operation: "replace", id: "legacy:1", record: { $rev: "v2" } });
      await push({ resource: "legacy", operation: "merge", id: "legacy:1", record: { $rev: "m1" } });
      await push({ resource: "legacy", operation: "merge", id: "legacy:1", record: { $rev: "m2" } });
      const pull = await send("pull", { clientId: "client:b", cursors: { legacy: "0" } });
      expect(pull.body.ok).toBe(true);
      expect(pull.body.result.records.legacy).toEqual([expect.objectContaining({ id: "legacy:1", $rev: "v2" })]);
      expect(pull.body.result.merged.legacy).toEqual([expect.objectContaining({ id: "legacy:1", $rev: "m2" })]);
    });
  }

  it("attaches no revision to a row whose stored id the pull rewrites or merges with another id", async () => {
    const { push, send, rev } = await serve();
    const spaced = await push({ resource: "task", operation: "insert", id: "task:x ", record: { title: "spaced" } });
    expect(spaced.body.ok).toBe(true);
    expect(await rev("task", "task:x ")).toMatchObject({ rev: 1 });
    await push({ resource: "task", operation: "insert", id: "task:y", record: { title: "plain" } });
    await push({ resource: "task", operation: "insert", id: "task:y ", record: { title: "spaced" } });
    await push({ resource: "task", operation: "insert", id: "task:z", record: { title: "plain" } });
    const pull = await send("pull", { clientId: "client:b", cursors: { task: "0" } });
    const rows = pull.body.result.records.task as Json[];
    expect(rows.find((row) => row.id === "task:x")).not.toHaveProperty("$rev");
    expect(rows.find((row) => row.id === "task:y")).not.toHaveProperty("$rev");
    expect(rows.find((row) => row.id === "task:z")).toMatchObject({ $rev: 1 });
  });
});

describe("DATA-41 revisions: versioned query snapshot failures (round 7)", () => {
  it("reruns outside the snapshot when a planned filter is rejected inside it and the fallback reads an aborted transaction", async () => {
    const database = memoryAdapter();
    const { push } = await serve({ database });
    await push({ resource: "project", operation: "insert", id: "project:p", record: { name: "P" } });
    await push({ resource: "project", operation: "insert", id: "project:q", record: { name: "Q" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:p" } });
    await push({ resource: "task", operation: "insert", id: "task:2", record: { title: "b", projectId: "project:q" } });
    await push({ resource: "task", operation: "insert", id: "task:3", record: { title: "c", projectId: "project:p" } });
    // PostgreSQL-like: the first failed statement aborts the snapshot
    // transaction, and every later statement in it fails (25P02).
    const rawSql = { dialect: "postgres", execute: async () => undefined, query: async () => [] };
    let snapshots = 0;
    let rejected = 0;
    const postgresLike = {
      ...database,
      rawSql,
      transaction: async (fn: (tx: Adapter) => Promise<unknown>) => {
        snapshots += 1;
        let aborted = false;
        const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A) => {
          if (aborted) throw new Error("current transaction is aborted, commands ignored until end of transaction block");
          return call(...args);
        };
        return fn({
          ...database,
          rawSql: { ...rawSql, execute: guard(rawSql.execute), query: guard(rawSql.query) },
          findOne: guard(database.findOne.bind(database)),
          count: guard(database.count.bind(database)),
          findMany: guard(async (args: any) => {
            // The planned relation filter's statement is rejected.
            if (args.model === "project" && Array.isArray(args.where) && args.where.length > 0) {
              rejected += 1;
              aborted = true;
              throw new Error("syntax error at or near planned filter");
            }
            return database.findMany(args);
          }),
        } as Adapter);
      },
    } as unknown as Adapter;
    const reader = await serve({ database: postgresLike });
    const query = await reader.send("query", {
      resource: "task",
      version: 1,
      withRevisions: true,
      filters: { "project.name": { eq: "P" } },
    });
    expect(snapshots).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
    expect(query.status).toBe(200);
    const data = query.body.result.data as Json[];
    expect(data.map((row) => row.id).sort()).toEqual(["task:1", "task:3"]);
    for (const row of data) expect(row).not.toHaveProperty("$rev");
  });
});

describe("DATA-41 revisions: push revision map keys (round 7)", () => {
  it("returns the revision of a mutation whose id is __proto__", async () => {
    const { push } = await serve();
    const result = await push({ resource: "task", operation: "insert", id: "task:proto", record: { title: "a" }, mutationId: "__proto__" });
    expect(result.body.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result.body.result.revisions, "__proto__")).toBe(true);
    expect(result.body.result.revisions["__proto__"]).toMatchObject({ resource: "task", id: "task:proto", rev: 1 });
  });
});

/** An adapter whose revision storage fails as `mode` says; rows read normally. */
function failingRevisions(database: Adapter, mode: "ddl" | "read"): Adapter {
  const internal = new Proxy(database.internal, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (table: string, ...rest: unknown[]) => {
        if (table === "__datafn_revisions") {
          if (mode === "ddl" && property === "ensureTable") throw new Error("permission denied to create table");
          if (mode === "read" && property === "findMany") throw new Error("revision read failed");
        }
        return (value as (...args: unknown[]) => unknown).call(target, table, ...rest);
      };
    },
  });
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "internal") return internal;
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("DATA-41 revisions: clone without revision storage (round 8)", () => {
  for (const mode of ["ddl", "read"] as const) {
    it(`returns the rows without $rev and a real cursor when the revision ${mode === "ddl" ? "table cannot be created" : "read fails"}`, async () => {
      const database = memoryAdapter();
      const { push } = await serve({ database });
      for (const id of ["task:1", "task:2", "task:3"]) {
        expect((await push({ resource: "task", operation: "insert", id, record: { title: id } })).body.ok).toBe(true);
      }
      configureRevisions(schema, { enabled: true });
      const db = failingRevisions(database, mode);
      const ids = (rows: Array<Record<string, unknown>>) => rows.map((row) => row.id);

      // Explicit page.
      const page = await executeClone(
        { clientId: "client:b", tables: ["task"], page: { table: "task", limit: 2 } } as any,
        schema,
        db,
        NS,
      );
      expect(page.ok).toBe(true);
      expect(ids(page.data.task)).toEqual(["task:1", "task:2"]);
      expect(page.next).not.toBeNull();
      for (const row of page.data.task) expect(row).not.toHaveProperty("$rev");

      // Auto-paginated (more rows than the clone cap).
      const capped = await executeClone({ clientId: "client:b", tables: ["task"] } as any, schema, db, NS, undefined, 2);
      expect(capped.ok).toBe(true);
      expect(capped.paginated).toBe(true);
      expect(ids(capped.data.task)).toEqual(["task:1", "task:2"]);
      for (const row of capped.data.task) expect(row).not.toHaveProperty("$rev");

      // Full clone.
      const full = await executeClone({ clientId: "client:b", tables: ["task"] } as any, schema, db, NS);
      expect(full.ok).toBe(true);
      expect(ids(full.data.task)).toEqual(["task:1", "task:2", "task:3"]);
      expect(full.cursors.task).not.toBe("0");
      for (const row of full.data.task) expect(row).not.toHaveProperty("$rev");

      // With working revision storage the same clone pairs every row.
      const paired = await executeClone({ clientId: "client:b", tables: ["task"] } as any, schema, database, NS);
      expect(paired.data.task.map((row) => row.$rev)).toEqual([1, 1, 1]);
    });
  }
});

describe("DATA-41 revisions: versioned query without revision storage (round 8)", () => {
  for (const mode of ["ddl", "read"] as const) {
    it(`returns the projected rows without $rev when the revision ${mode === "ddl" ? "table cannot be created" : "read fails"}`, async () => {
      const database = memoryAdapter();
      const { push } = await serve({ database });
      await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
      const reader = await serve({ database: failingRevisions(database, mode) });
      const query = await reader.send("query", { resource: "task", version: 1, withRevisions: true });
      expect(query.status).toBe(200);
      expect(query.body.result.data).toEqual([expect.objectContaining({ id: "task:1", title: "a" })]);
      expect(query.body.result.data[0]).not.toHaveProperty("$rev");
    });
  }
});

describe("DATA-41 revisions: legacy $rev values are never revisions (round 8)", () => {
  // The resource once declared its own `$rev` field and a field it later
  // dropped, with revisions off; it now issues revisions under a read policy
  // for `title`.
  const before = {
    resources: [
      {
        name: "evolving",
        version: 1,
        fields: [
          { name: "title", type: "string" as const, required: false },
          { name: "$rev", type: "number" as const, required: false },
          { name: "secretNote", type: "string" as const, required: false },
        ],
      },
    ],
    relations: [],
  };
  const after = {
    resources: [
      {
        name: "evolving",
        version: 1,
        fields: [{ name: "title", type: "string" as const, required: false }],
        permissions: { read: { fields: ["title"] }, write: { fields: ["title"] } },
      },
    ],
    relations: [],
  };

  async function evolve() {
    const database = memoryAdapter();
    const old = await serve({ database, schema: before, enabled: false });
    const insert = await old.push({ resource: "evolving", operation: "insert", id: "evolving:1", record: { title: "t", $rev: 7, secretNote: "s" } });
    expect(insert.body.ok).toBe(true);
    const merge = await old.push({ resource: "evolving", operation: "merge", id: "evolving:1", record: { $rev: 8 } });
    expect(merge.body.ok).toBe(true);
    return serve({ database, schema: after });
  }

  it("projects a versioned row whose stored $rev the server did not pair, so no legacy $rev or hidden field leaks", async () => {
    const current = await evolve();
    const query = await current.send("query", { resource: "evolving", version: 1, withRevisions: true });
    expect(query.status).toBe(200);
    expect(query.body.result.data).toEqual([{ id: "evolving:1", title: "t" }]);
  });

  it("sends no legacy $rev from changes written before the resource issued revisions, on both pull formats and clone", async () => {
    const current = await evolve();
    const canonical = await current.send("pull", { clientId: "client:b", cursors: { evolving: "0" } });
    expect(canonical.body.ok).toBe(true);
    for (const bucket of ["records", "merged"] as const) {
      for (const row of canonical.body.result[bucket].evolving ?? []) expect(row).not.toHaveProperty("$rev");
    }
    expect(canonical.body.result.records.evolving).toHaveLength(1);
    const global = await current.send("pull", { clientId: "client:b", cursor: "0" });
    expect(global.body.ok).toBe(true);
    const changes = global.body.result.changes as Json[];
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(change).not.toHaveProperty("rev");
      expect(change.record ?? {}).not.toHaveProperty("$rev");
    }
    const clone = await current.send("clone", { clientId: "client:b", tables: ["evolving"] });
    expect(clone.body.result.data.evolving).toHaveLength(1);
    // Clone pairs the row with the server's revision (bumped by both writes
    // while revisions were off), never the stored application value 8.
    expect(clone.body.result.data.evolving[0].$rev).toBe(2);
  });
});
