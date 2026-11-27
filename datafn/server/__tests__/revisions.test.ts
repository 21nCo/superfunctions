/**
 * DATA-41: server-managed per-record revisions.
 */

import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { createDatafnPublicLinksPlugin } from "../src/index.js";
import {
  READ_CHUNK,
  assignWriteRevisions,
  bumpRevision,
  bumpTombstone,
  configureRevisions,
  ensureRevisionsTable,
  readRevisions,
  readWithRevisions,
  revisionRowId,
  withWriteEvidence,
} from "../src/execution/revisions.js";
import { executeClone } from "../src/execution/sync/clone.js";
import { executePull } from "../src/execution/sync/pull.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { INTERNAL_TABLE_SCHEMAS } from "../src/execution/internal-tables.js";
import { resolveNamespaceStoragePlan } from "../src/namespace-storage.js";
import { createMemoryIndexedDirectoryStore } from "@superfunctions/db/adapters";
import { datafnMultiRegionPlugin } from "../src/plugins/multi-region.js";
import { createDatafnHmacRouteTickets } from "../src/regional-tickets.js";
import {
  claimDatafnNamespacePlacement,
  createDatafnGatewayRouter,
  createDatafnHmacRoutingAssertions,
  createMemoryDatafnPlacementDirectory,
  createMemoryDatafnRoutingReplayStore,
  withDatafnRoutingAssertion,
} from "../src/multi-region-routing.js";

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

async function serve(options: { enabled?: boolean; database?: Adapter; schema?: unknown; config?: Json } = {}) {
  const database = options.database ?? memoryAdapter();
  const server = await createDatafnServer({
    schema: (options.schema ?? schema) as any,
    database,
    allowUnknownResources: true,
    ...options.config,
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
    await bumpRevision(database, NS, "task", "task:1", false, false);
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
    await bumpRevision(database, NS, "task", "task:1", false, false);
    await bumpRevision(database, NS, "task", "task:2", false, false);
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
          await bumpRevision(database, NS, "task", "task:1", false, false);
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
    await bumpRevision(database, NS, "task", "task:1", false, false);
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
          await bumpRevision(database, NS, "task", "task:1", false, false);
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

  async function evolve(next: unknown = after) {
    const database = memoryAdapter();
    const old = await serve({ database, schema: before, enabled: false });
    const insert = await old.push({ resource: "evolving", operation: "insert", id: "evolving:1", record: { title: "t", $rev: 7, secretNote: "s" } });
    expect(insert.body.ok).toBe(true);
    const merge = await old.push({ resource: "evolving", operation: "merge", id: "evolving:1", record: { $rev: 8 } });
    expect(merge.body.ok).toBe(true);
    return serve({ database, schema: next });
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
    // The stored row keeps a column the read policy does not list
    // (secretNote), so clone pairs it with no revision (round 12), and never
    // sends the stored application value 8.
    expect(clone.body.result.data.evolving[0]).not.toHaveProperty("$rev");
    // Without a read policy clone pairs the row with the server's revision
    // (bumped by both writes while revisions were off), not the value 8.
    const open = await evolve({ ...after, resources: [{ ...after.resources[0], permissions: undefined }] });
    const openClone = await open.send("clone", { clientId: "client:b", tables: ["evolving"] });
    expect(openClone.body.result.data.evolving[0].$rev).toBe(2);
  });
});

describe("DATA-41 revisions: a write names one record (round 9)", () => {
  async function tombstoned() {
    const served = await serve();
    await served.push({ resource: "task", operation: "insert", id: "task:B", record: { title: "b" } });
    await served.push({ resource: "task", operation: "delete", id: "task:B" });
    await served.push({ resource: "task", operation: "insert", id: "task:A", record: { title: "a" } });
    expect(await served.rev("task", "task:B")).toEqual({ rev: 2, deleted: true });
    return served;
  }

  async function unchanged(served: Awaited<ReturnType<typeof tombstoned>>) {
    const rows = await served.database.findMany({ model: "task", namespace: NS } as any);
    expect((rows as Json[]).map((row) => [row.id, row.title])).toEqual([["task:A", "a"]]);
    expect(await served.rev("task", "task:A")).toEqual({ rev: 1, deleted: false });
    expect(await served.rev("task", "task:B")).toEqual({ rev: 2, deleted: true });
  }

  const writes: Json[] = [
    { resource: "task", operation: "insert", id: "task:C", record: { id: "task:B", title: "x" } },
    { resource: "task", operation: "merge", id: "task:A", record: { id: "task:B", title: "x" } },
    { resource: "task", operation: "replace", id: "task:A", record: { id: "task:B", title: "x" } },
  ];

  it.each(writes)("rejects a push $operation whose record.id differs from its id, writing nothing", async (mutation) => {
    const served = await tombstoned();
    const res = await served.push(mutation);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).toContain("record.id");
    expect(JSON.stringify(res.body)).toContain("DFQL_INVALID");
    await unchanged(served);
  });

  it.each(writes)("rejects a /mutation $operation whose record.id differs from its id, writing nothing", async (mutation) => {
    const served = await tombstoned();
    const res = await served.send("mutation", { ...mutation, version: 1, clientId: "c", mutationId: `direct-${mutation.operation}` });
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).toContain("record.id");
    await unchanged(served);
  });

  it.each(writes)("rejects a /transact $operation whose record.id differs from its id, writing nothing", async (mutation) => {
    const served = await tombstoned();
    const res = await served.send("transact", {
      atomic: true,
      steps: [{ mutation: { ...mutation, version: 1, clientId: "c", mutationId: `tx-${mutation.operation}` } }],
    });
    expect(res.body.result.ok).toBe(false);
    expect(JSON.stringify(res.body)).toContain("record.id");
    await unchanged(served);
  });

  it("accepts a record.id equal to the mutation id on every path", async () => {
    const served = await serve();
    const pushed = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { id: "task:1", title: "a" } });
    expect(pushed.body.ok).toBe(true);
    const direct = await served.send("mutation", {
      resource: "task", version: 1, operation: "merge", id: "task:1", record: { id: "task:1", title: "b" },
      clientId: "c", mutationId: "direct-same",
    });
    expect(direct.body.ok).toBe(true);
    const transact = await served.send("transact", {
      atomic: true,
      steps: [{ mutation: { resource: "task", version: 1, operation: "replace", id: "task:1", record: { id: "task:1", title: "c" }, clientId: "c", mutationId: "tx-same" } }],
    });
    expect(transact.status).toBe(200);
    expect(await served.rev("task", "task:1")).toEqual({ rev: 3, deleted: false });
  });
});

describe("DATA-41 revisions: change rows record rev only for certified records (round 9)", () => {
  const declared = {
    resources: [
      {
        name: "drifting",
        version: 1,
        fields: [
          { name: "title", type: "string" as const, required: false },
          { name: "$rev", type: "number" as const, required: false },
          { name: "status", type: "string" as const, required: false, default: "open" },
        ],
      },
    ],
    relations: [],
  };
  const dropped = {
    resources: [
      {
        name: "drifting",
        version: 1,
        fields: [
          { name: "title", type: "string" as const, required: false },
          { name: "status", type: "string" as const, required: false, default: "open" },
        ],
      },
    ],
    relations: [],
  };

  it("sends no rev or $rev for changes written while the resource declared $rev, and does after the drop", async () => {
    const database = memoryAdapter();
    const before = await serve({ database, schema: declared });
    expect((await before.push({ resource: "drifting", operation: "insert", id: "drifting:1", record: { title: "a", $rev: 5 } })).body.ok).toBe(true);
    expect((await before.push({ resource: "drifting", operation: "replace", id: "drifting:1", record: { title: "b", $rev: 6 } })).body.ok).toBe(true);
    expect((await before.push({ resource: "drifting", operation: "insert", id: "drifting:2", record: { title: "c" } })).body.ok).toBe(true);

    const after = await serve({ database, schema: dropped });
    expect((await after.push({ resource: "drifting", operation: "insert", id: "drifting:3", record: { title: "d" }, mutationId: "after-drop-insert" })).body.ok).toBe(true);

    const canonical = await after.send("pull", { clientId: "client:b", cursors: { drifting: "0" } });
    expect(canonical.body.ok).toBe(true);
    const rows = new Map<string, Json>();
    for (const bucket of ["records", "merged"] as const) {
      for (const row of canonical.body.result[bucket]?.drifting ?? []) rows.set(row.id, row);
    }
    expect(rows.get("drifting:1")).toBeDefined();
    expect(rows.get("drifting:1")).not.toHaveProperty("$rev");
    expect(rows.get("drifting:2")).toBeDefined();
    expect(rows.get("drifting:2")).not.toHaveProperty("$rev");
    expect(rows.get("drifting:3")?.$rev).toBe(1);

    const global = await after.send("pull", { clientId: "client:b", cursor: "0" });
    expect(global.body.ok).toBe(true);
    const changes = (global.body.result.changes as Json[]).filter((change) => change.resource === "drifting");
    for (const change of changes.filter((c) => c.id !== "drifting:3" && c.record?.id !== "drifting:3")) {
      expect(change).not.toHaveProperty("rev");
      expect(change.record ?? {}).not.toHaveProperty("$rev");
    }
    const later = changes.find((c) => c.id === "drifting:3" || c.record?.id === "drifting:3");
    expect(later?.rev).toBe(1);
    expect(later?.record?.$rev).toBe(1);
  });
});

describe("DATA-41 revisions: revisions follow the row storage partition (round 9)", () => {
  const provider = { namespaceProvider: { getNamespace: () => "tenant:a" } };

  it.each([
    ["rowLevelNamespace: false with a namespace provider", { ...provider, rowLevelNamespace: false }],
    ["rowLevelNamespace: false without a namespace provider", { rowLevelNamespace: false }],
    ["row-level isolation disabled with a namespace provider", { ...provider, rowLevelNamespace: { enabled: false, columnName: "__ns", mandatory: true } }],
  ])("refuses revisions.enabled when rows are shared across namespaces: %s", async (_label, extra) => {
    await expect(createDatafnServer({
      schema,
      database: memoryAdapter(),
      allowUnknownResources: true,
      revisions: { enabled: true },
      ...(extra as any),
    })).rejects.toThrow(/row-level namespace isolation/);
  });

  it("accepts revisions with row-level isolation, and shared rows with revisions off", async () => {
    await expect(createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true }, ...provider,
    })).resolves.toBeDefined();
    await expect(createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, ...provider, rowLevelNamespace: false,
    })).resolves.toBeDefined();
  });
});

describe("DATA-41 revisions: a tombstone needs an actual delete (round 10)", () => {
  /**
   * The record's DELETE matches nothing for `ids` (a concurrent writer
   * re-inserted the record after this write saw it), so the row stays.
   */
  function noOpDeletes(database: Adapter, ids: Set<string>): Adapter {
    const wrap = (db: Adapter): Adapter =>
      new Proxy(db, {
        get(target, property, receiver) {
          if (property === "delete" || property === "deleteMany") {
            return async (args: any) => {
              const id = (args.where ?? []).find((w: any) => w.field === "id")?.value;
              if (ids.has(id)) return property === "delete" ? undefined : 0;
              return (target as any)[property](args);
            };
          }
          if (property === "transaction") {
            return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(wrap(tx as Adapter)));
          }
          return Reflect.get(target, property, receiver);
        },
      });
    return wrap(database);
  }

  async function deleteChanges(send: (route: string, body: unknown) => Promise<{ body: Json }>, id: string) {
    const pull = await send("pull", { clientId: "client:p", cursor: "0" });
    expect(pull.body.ok).toBe(true);
    return (pull.body.result.changes as Json[]).filter((change) => change.id === id && change.op === "delete");
  }

  async function seeded(ids: string[]) {
    const database = memoryAdapter();
    const blocked = new Set<string>();
    const served = await serve({ database: noOpDeletes(database, blocked) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    for (const id of ids) blocked.add(id);
    return { ...served, database };
  }

  it("raises no tombstone for a push delete that left the record row present", async () => {
    const served = await seeded(["task:1"]);
    const res = await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(res.body.ok).toBe(true);
    expect(res.body.result.revisions?.[res.mutationId]).toBeUndefined();
    expect(await served.rev("task", "task:1")).toEqual({ rev: 1, deleted: false });
    const deletes = await deleteChanges(served.send, "task:1");
    expect(deletes.length).toBeGreaterThan(0);
    for (const change of deletes) expect(change).not.toHaveProperty("rev");
  });

  it("raises no tombstone for a /mutation delete that left the record row present", async () => {
    const served = await seeded(["task:1"]);
    const res = await served.send("mutation", { resource: "task", version: 1, operation: "delete", id: "task:1", clientId: "c", mutationId: "direct-del" });
    expect(res.body.result.ok).toBe(true);
    expect(res.body.result).not.toHaveProperty("rev");
    expect(await served.rev("task", "task:1")).toEqual({ rev: 1, deleted: false });
    for (const change of await deleteChanges(served.send, "task:1")) expect(change).not.toHaveProperty("rev");
  });

  it("raises no tombstone for a /transact delete that left the record row present", async () => {
    const served = await seeded(["task:1"]);
    const res = await served.send("transact", {
      atomic: true,
      steps: [{ mutation: { resource: "task", version: 1, operation: "delete", id: "task:1", clientId: "c", mutationId: "tx-del" } }],
    });
    expect(res.status).toBe(200);
    expect(res.body.result.results[0].ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('"rev"');
    expect(await served.rev("task", "task:1")).toEqual({ rev: 1, deleted: false });
    for (const change of await deleteChanges(served.send, "task:1")) expect(change).not.toHaveProperty("rev");
  });

  it("raises no tombstone for a cascade child that is present again, and still tombstones the parent", async () => {
    // comment:1 was deleted and re-inserted by another writer before the
    // cascade reached it, so the cascade's DELETE leaves its row in place.
    const blocked = await seeded(["comment:1"]);
    await blocked.push({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } });
    await blocked.push({ resource: "comment", operation: "insert", id: "comment:2", record: { body: "y", taskId: "task:1" } });
    const res = await blocked.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(res.body.ok).toBe(true);
    expect(res.body.result.revisions[res.mutationId]).toMatchObject({ rev: 2, deleted: true });
    expect(await blocked.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect(await blocked.rev("comment", "comment:2")).toEqual({ rev: 2, deleted: true });
    expect(await blocked.rev("comment", "comment:1")).toEqual({ rev: 1, deleted: false });
    for (const change of await deleteChanges(blocked.send, "comment:1")) expect(change).not.toHaveProperty("rev");
  });

  it("without transactions, raises no tombstone over a re-insert that commits before the delete's swap", async () => {
    const database = memoryAdapter();
    let reinsert: (() => Promise<void>) | undefined;
    const racing = {
      ...database,
      capabilities: { ...database.capabilities, transactions: { supported: false, nested: false } },
      internal: new Proxy(database.internal, {
        get: (target, property, receiver) =>
          property === "update"
            ? async (table: string, where: unknown, data: unknown) => {
                if (table === "__datafn_revisions" && reinsert) {
                  // Another writer re-inserts the record and commits its
                  // revision between this delete's read and its swap.
                  const write = reinsert;
                  reinsert = undefined;
                  await write();
                }
                return (target as any).update(table, where, data);
              }
            : Reflect.get(target, property, receiver),
      }),
    } as Adapter;
    const served = await serve({ database: racing });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    reinsert = async () => {
      await database.create({ model: "task", data: { id: "task:1", title: "again" }, namespace: NS } as any);
      await bumpRevision(database, NS, "task", "task:1", false, false);
    };
    const res = await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(res.body.ok).toBe(true);
    expect(reinsert).toBeUndefined();
    // DATA-41's merged write evidence: the adapter's delete reports no count,
    // so whether it removed the row is a current read at the raise. After the
    // re-insert the row is present: the record stays live at the re-insert's
    // revision, and the delete reports none (never a tombstone over a live row).
    expect(res.body.result.revisions?.[res.mutationId]).toBeUndefined();
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: false });
  });
});

describe("DATA-41 revisions: a tombstone needs a present-to-absent delete (round 11)", () => {
  /**
   * Replays a concurrent delete that committed first: this write's existence
   * read still returns the stale row for each id in `stale` (findOne once; a
   * listed row in every findMany until the test clears it, since the cascade
   * reads its children more than once), although the record is already deleted and its
   * revision row is already a tombstone, so this write's DELETE removes
   * nothing.
   */
  function staleReads(database: Adapter, stale: Map<string, Record<string, unknown>>): Adapter {
    const wrap = (db: Adapter): Adapter =>
      new Proxy(db, {
        get(target, property, receiver) {
          if (property === "findOne") {
            return async (args: any) => {
              const id = (args.where ?? []).find((w: any) => w.field === "id")?.value;
              const row = stale.get(id);
              if (row && row.__model === args.model && !row.__list) {
                stale.delete(id);
                return { ...row };
              }
              return target.findOne(args);
            };
          }
          if (property === "findMany") {
            return async (args: any) => {
              const rows = (await target.findMany(args)) as Record<string, unknown>[];
              for (const [id, row] of [...stale]) {
                if (row.__model !== args.model || !row.__list) continue;
                row.__seen = true;
                rows.push({ ...row, id });
              }
              return rows;
            };
          }
          if (property === "transaction") {
            return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(wrap(tx as Adapter)));
          }
          return Reflect.get(target, property, receiver);
        },
      });
    return wrap(database);
  }

  async function deleteChanges(send: (route: string, body: unknown) => Promise<{ body: Json }>, id: string) {
    const pull = await send("pull", { clientId: "client:p", cursor: "0" });
    expect(pull.body.ok).toBe(true);
    return (pull.body.result.changes as Json[]).filter((change) => change.id === id && change.op === "delete");
  }

  /** task:1 inserted (rev 1) and deleted (tombstone 2); its next existence read is stale. */
  async function tombstoned() {
    const stale = new Map<string, Record<string, unknown>>();
    const served = await serve({ database: staleReads(memoryAdapter(), stale) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    const first = await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(first.body.result.revisions[first.mutationId]).toMatchObject({ rev: 2, deleted: true });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    stale.set("task:1", { __model: "task", id: "task:1", title: "a" });
    return { ...served, stale };
  }

  async function expectOnlyFirstTombstoneHasRev(send: (route: string, body: unknown) => Promise<{ body: Json }>) {
    const revs = (await deleteChanges(send, "task:1")).map((change) => change.rev);
    expect(revs.filter((rev) => rev !== undefined)).toEqual([2]);
  }

  it("raises nothing for a push delete of a record a concurrent delete already tombstoned", async () => {
    const served = await tombstoned();
    const res = await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(res.body.ok).toBe(true);
    expect(served.stale.size).toBe(0);
    expect(res.body.result.revisions?.[res.mutationId]).toBeUndefined();
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await expectOnlyFirstTombstoneHasRev(served.send);
  });

  it("raises nothing for a /mutation delete of a record a concurrent delete already tombstoned", async () => {
    const served = await tombstoned();
    const res = await served.send("mutation", { resource: "task", version: 1, operation: "delete", id: "task:1", clientId: "c", mutationId: "direct-del-2" });
    expect(res.body.result.ok).toBe(true);
    expect(served.stale.size).toBe(0);
    expect(res.body.result).not.toHaveProperty("rev");
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await expectOnlyFirstTombstoneHasRev(served.send);
  });

  it("raises nothing for a /transact delete of a record a concurrent delete already tombstoned", async () => {
    const served = await tombstoned();
    const res = await served.send("transact", {
      atomic: true,
      steps: [{ mutation: { resource: "task", version: 1, operation: "delete", id: "task:1", clientId: "c", mutationId: "tx-del-2" } }],
    });
    expect(res.status).toBe(200);
    expect(res.body.result.results[0].ok).toBe(true);
    expect(served.stale.size).toBe(0);
    expect(JSON.stringify(res.body.result.results[0])).not.toContain('"rev"');
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await expectOnlyFirstTombstoneHasRev(served.send);
  });

  it("leaves an already-tombstoned cascade child unchanged and still tombstones the parent and its live sibling", async () => {
    const stale = new Map<string, Record<string, unknown>>();
    const served = await serve({ database: staleReads(memoryAdapter(), stale) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "comment", operation: "insert", id: "comment:1", record: { body: "x", taskId: "task:1" } });
    await served.push({ resource: "comment", operation: "insert", id: "comment:2", record: { body: "y", taskId: "task:1" } });
    await served.push({ resource: "comment", operation: "delete", id: "comment:1" });
    expect(await served.rev("comment", "comment:1")).toEqual({ rev: 2, deleted: true });
    // The cascade's child read still sees comment:1, which a concurrent
    // delete already removed and tombstoned.
    const staleChild: Record<string, unknown> = { __model: "comment", __list: true, id: "comment:1", body: "x", taskId: "task:1" };
    stale.set("comment:1", staleChild);
    const res = await served.push({ resource: "task", operation: "delete", id: "task:1" });
    stale.clear();
    expect(res.body.ok).toBe(true);
    expect(staleChild.__seen).toBe(true);
    expect(res.body.result.revisions[res.mutationId]).toMatchObject({ rev: 2, deleted: true });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect(await served.rev("comment", "comment:2")).toEqual({ rev: 2, deleted: true });
    expect(await served.rev("comment", "comment:1")).toEqual({ rev: 2, deleted: true });
    const revs = (await deleteChanges(served.send, "comment:1")).map((change) => change.rev);
    expect(revs.filter((rev) => rev !== undefined)).toEqual([2]);
  });

  it("bumps the tombstone once more when a concurrent delete removed the row and raised it first", async () => {
    const database = memoryAdapter();
    let concurrentDelete: (() => Promise<void>) | undefined;
    const racing = {
      ...database,
      capabilities: { ...database.capabilities, transactions: { supported: false, nested: false } },
      delete: async (args: any) => {
        if (args.model === "task" && concurrentDelete) {
          // Another delete of the record removes it and commits its
          // tombstone just before this delete's DELETE, which matches nothing.
          const write = concurrentDelete;
          concurrentDelete = undefined;
          await write();
        }
        return database.delete(args);
      },
    } as Adapter;
    const served = await serve({ database: racing });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    concurrentDelete = async () => {
      await database.delete({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any);
      await bumpRevision(database, NS, "task", "task:1", true, false);
    };
    const res = await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(res.body.ok).toBe(true);
    expect(concurrentDelete).toBeUndefined();
    // DATA-41's merged write evidence: the adapter's delete reports no count
    // and the row is absent after it, so its tombstone is raised again: an
    // extra bump of a tombstone, never a live revision.
    expect(res.body.result.revisions?.[res.mutationId]).toMatchObject({ rev: 3 });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 3, deleted: true });
  });
});

describe("DATA-41 revisions: round 12", () => {
  it("returns no $rev on clone rows the caller may not read in full, on every clone mode", async () => {
    const database = memoryAdapter();
    const { push } = await serve({ database });
    for (const id of ["secretive:1", "secretive:2", "secretive:3"]) {
      expect((await push({ resource: "secretive", operation: "insert", id, record: { title: id, hidden: "h" } })).body.ok).toBe(true);
    }
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "t" } });
    configureRevisions(schema, { enabled: true });
    const page = await executeClone(
      { clientId: "client:b", tables: ["secretive"], page: { table: "secretive", limit: 2 } } as any,
      schema,
      database,
      NS,
    );
    const capped = await executeClone({ clientId: "client:b", tables: ["secretive"] } as any, schema, database, NS, undefined, 2);
    const full = await executeClone({ clientId: "client:b", tables: ["secretive", "task"] } as any, schema, database, NS);
    for (const rows of [page.data.secretive, capped.data.secretive, full.data.secretive]) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toHaveProperty("$rev");
    }
    expect(full.data.secretive).toHaveLength(3);
    // A fully readable resource keeps its revisions.
    expect(full.data.task).toEqual([expect.objectContaining({ id: "task:1", $rev: 1 })]);
  });

  it("decides shareable access of a versioned query on its snapshot, not the state before it", async () => {
    const shared = {
      resources: [{
        name: "notebook",
        version: 1,
        capabilities: ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
        fields: [{ name: "title", type: "string" as const, required: false }],
      }],
      relations: [],
    } as any;
    const base = memoryAdapter();
    // PostgreSQL-like: the snapshot sees the grant revoked by a write that
    // committed after the request began but before the snapshot.
    const rawSql = { dialect: "postgres", execute: async () => undefined, query: async () => [] };
    let snapshots = 0;
    const database = {
      ...base,
      rawSql,
      transaction: async (fn: (tx: Adapter) => Promise<unknown>) => {
        snapshots += 1;
        return fn({
          ...base,
          rawSql,
          findMany: async (args: any) => {
            const rows = await base.findMany(args);
            return args.model === "__datafn_permissions_global"
              ? rows.map((row: Json) => ({ ...row, revokedAt: 2 }))
              : rows;
          },
        } as Adapter);
      },
    } as unknown as Adapter;
    const server = await createDatafnServer({
      schema: shared,
      database,
      allowUnknownResources: true,
      revisions: { enabled: true },
      namespaceProvider: { getNamespace: () => "team", getActorId: () => "bob" as any },
    });
    await base.create({
      model: "notebook",
      data: { id: "notebook:1", title: "Trip", createdBy: "alice", __ns: "team" },
      namespace: "team",
    });
    await base.create({
      model: "__datafn_permissions_global",
      data: {
        id: "grant-1", resourceType: "notebook", resourceNs: "team", resourceId: "notebook:1",
        principalId: "user:bob", level: "viewer", grantKind: "record", sourceRef: null,
        grantedBy: "alice", grantedAt: 1, revokedAt: null, __ns: "team",
      },
      namespace: "team",
    });
    const query = async (withRevisions: boolean) => {
      const res = await server.router.handle(new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "notebook", version: 1, ...(withRevisions ? { withRevisions: true } : {}) }),
      }));
      expect(res.status).toBe(200);
      return ((await res.json()) as Json).result.data as Json[];
    };
    // Outside the snapshot the grant is still active.
    expect((await query(false)).map((row) => row.id)).toEqual(["notebook:1"]);
    expect(await query(true)).toEqual([]);
    expect(snapshots).toBeGreaterThan(0);
  });

  it("gives an id no tombstone revision when a visibility delete collapses into its delete", async () => {
    const shared = {
      resources: [{
        name: "notebook",
        version: 1,
        capabilities: [{ shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
        fields: [{ name: "title", type: "string" as const, required: false }],
      }],
      relations: [],
    } as any;
    configureRevisions(shared, { enabled: true });
    const database = memoryAdapter();
    const tracking = new ChangeTrackingService(database, NS);
    tracking.useRevisionsOf(shared);
    await tracking.ensureReady();
    await tracking.ensureRevisionsReady();
    // Each change is recorded in the transaction that writes it, so the
    // change row certifies its revision (as push and /mutation record them).
    const record = (entries: any[], write?: (db: Adapter) => Promise<unknown>) =>
      database.transaction(async (tx) => {
        const writes = withWriteEvidence(tx as Adapter, true);
        await write?.(writes);
        await tracking.withDb(writes, true, true).recordChanges(entries);
      });
    const grant = {
      id: "grant-1", resourceType: "notebook", resourceNs: NS, resourceId: "notebook:1",
      principalId: "user:bob", level: "viewer", grantKind: "record", sourceRef: null,
      grantedBy: "alice", grantedAt: 1, revokedAt: null,
    };
    await record([{ serverSeq: 1, resource: "notebook", id: "notebook:1", op: "insert", record: { id: "notebook:1", title: "a" } }],
      (db) => db.create({ model: "notebook", data: { id: "notebook:1", title: "a" }, namespace: NS } as any));
    // A physical delete that recorded tombstone revision 2 (the row is gone).
    await record([{ serverSeq: 2, resource: "notebook", id: "notebook:1", op: "delete", record: null }],
      (db) => db.delete({ model: "notebook", where: [{ field: "id", operator: "eq", value: "notebook:1" }], namespace: NS } as any));
    const pull = () =>
      executePull({ clientId: "client:b", cursors: { notebook: "0" }, actorId: "bob" } as any, shared, database, NS) as Promise<Json>;

    const before = await pull();
    expect(before.ok).toBe(true);
    expect(before.deleted.notebook).toContain("notebook:1");
    expect(before.deletedRevisions).toEqual({ notebook: { "notebook:1": 2 } });

    // The grant is created and then revoked: a visibility delete for the
    // same id, which records no tombstone revision.
    await record([{ serverSeq: 3, resource: "__datafn_permissions_global", id: "grant-1", op: "insert", record: grant }]);
    await record([{ serverSeq: 4, resource: "__datafn_permissions_global", id: "grant-1", op: "delete", record: null }]);
    const after = await pull();
    expect(after.ok).toBe(true);
    expect(after.deleted.notebook).toContain("notebook:1");
    expect(after.deletedRevisions?.notebook?.["notebook:1"]).toBeUndefined();
  });
});

/**
 * A concurrent delete of each id in `ids` commits (row removed, tombstone
 * raised) just before this write's UPDATE of it, so the UPDATE matches no
 * row: the write changed nothing. The adapter reports that as a zero-row
 * update (like updateMany) instead of throwing, as an adapter may.
 */
function deletedBeforeUpdate(database: Adapter, ids: Set<string>): Adapter {
  const wrap = (db: Adapter): Adapter =>
    new Proxy(db, {
      get(target, property, receiver) {
        if (property === "update" || property === "updateMany") {
          return async (args: any) => {
            const value = (args.where ?? []).find((w: any) => w.field === "id")?.value;
            const raced = (Array.isArray(value) ? value : [value]).filter((id) => ids.has(id));
            const namespace = args.namespace ?? NS;
            for (const id of raced) {
              ids.delete(id);
              await target.delete({ model: args.model, where: [{ field: "id", operator: "eq", value: id }], namespace } as any);
              await bumpTombstone(target, namespace, args.model, id, false);
            }
            if (property === "update" && raced.length > 0) return null;
            return (target as any)[property](args);
          };
        }
        if (property === "transaction") {
          return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(wrap(tx as Adapter)));
        }
        return Reflect.get(target, property, receiver);
      },
    });
  return wrap(database);
}

describe("DATA-41 revisions: round 13", () => {
  async function seeded() {
    const raced = new Set<string>();
    const served = await serve({ database: deletedBeforeUpdate(memoryAdapter(), raced) });
    for (const id of ["project:1", "project:2"]) {
      await served.push({ resource: "project", operation: "insert", id, record: { name: id } });
    }
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 1, deleted: false });
    raced.add("task:1");
    return { ...served, raced };
  }

  async function revisionedChanges(send: (route: string, body: unknown) => Promise<{ body: Json }>, id: string) {
    const pull = await send("pull", { clientId: "client:p", cursor: "0" });
    expect(pull.body.ok).toBe(true);
    return (pull.body.result.changes as Json[]).filter((change) => change.id === id && change.rev !== undefined);
  }

  const lostWrites: Json[] = [
    { resource: "task", operation: "merge", id: "task:1", record: { title: "b" } },
    { resource: "task", operation: "relate", id: "task:1", relations: { project: "project:2" } },
    { resource: "task", operation: "unrelate", id: "task:1", relations: { project: "project:1" } },
  ];

  it.each(lostWrites)("raises nothing for a push $operation whose record a concurrent delete removed", async (mutation) => {
    const served = await seeded();
    const res = await served.push(mutation);
    expect(served.raced.size).toBe(0);
    expect(res.body.result?.revisions?.[res.mutationId]).toBeUndefined();
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect((await revisionedChanges(served.send, "task:1")).map((change) => change.rev)).toEqual([1]);
  });

  it.each(lostWrites)("raises nothing for a /mutation $operation whose record a concurrent delete removed", async (mutation) => {
    const served = await seeded();
    const res = await served.send("mutation", { ...mutation, version: 1, clientId: "c", mutationId: `direct-${mutation.operation}` });
    expect(served.raced.size).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('"rev"');
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect((await revisionedChanges(served.send, "task:1")).map((change) => change.rev)).toEqual([1]);
  });

  it.each(lostWrites)("raises nothing for a /transact $operation whose record a concurrent delete removed", async (mutation) => {
    const served = await seeded();
    const res = await served.send("transact", {
      atomic: true,
      steps: [{ mutation: { ...mutation, version: 1, clientId: "c", mutationId: `tx-${mutation.operation}` } }],
    });
    expect(served.raced.size).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('"rev"');
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect((await revisionedChanges(served.send, "task:1")).map((change) => change.rev)).toEqual([1]);
  });

  it("raises nothing for a setNull child a concurrent delete removed, and still tombstones the parent", async () => {
    const served = await seeded();
    const res = await served.push({ resource: "project", operation: "delete", id: "project:1" });
    expect(res.body.ok).toBe(true);
    expect(served.raced.size).toBe(0);
    expect(res.body.result.revisions[res.mutationId]).toMatchObject({ rev: 2, deleted: true });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect((await revisionedChanges(served.send, "task:1")).map((change) => change.rev)).toEqual([1]);
  });

  it.each(["relate", "unrelate"])("raises nothing for a batched one-many %s target a concurrent delete removed", async (operation) => {
    const batchSchema = {
      resources: [
        { name: "project", version: 1, fields: [{ name: "name", type: "string" as const, required: false }] },
        { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }, { name: "projectId", type: "string" as const, required: false }] },
      ],
      relations: [{ from: "project", to: "task", type: "one-many", relation: "tasks", fkField: "projectId" }],
    } as any;
    const raced = new Set<string>();
    const served = await serve({ schema: batchSchema, database: deletedBeforeUpdate(memoryAdapter(), raced) });
    await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
    for (const id of ["task:1", "task:2"]) {
      await served.push({ resource: "task", operation: "insert", id, record: { title: id, projectId: "project:1" } });
    }
    // task:2 is deleted (tombstone 2) after the target check and before the
    // batched updateMany, which then changes task:1 only.
    raced.add("task:2");
    const res = await served.push({ resource: "project", operation, id: "project:1", relations: { tasks: ["task:1", "task:2"] } });
    expect(res.body.result.ok, JSON.stringify(res.body)).toBe(true);
    expect(raced.size).toBe(0);
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: false });
    expect(await served.rev("task", "task:2")).toEqual({ rev: 2, deleted: true });
    expect((await revisionedChanges(served.send, "task:2")).map((change) => change.rev)).toEqual([1]);
  });

  it("still raises a present record's revision once for each of those writes", async () => {
    const served = await serve();
    await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    let expected = 1;
    for (const mutation of [
      lostWrites[0],
      { ...lostWrites[1], relations: { project: "project:1" } },
      lostWrites[2],
    ]) {
      const res = await served.push(mutation);
      expected += 1;
      expect(res.body.result.revisions[res.mutationId]).toMatchObject({ rev: expected });
    }
    expect(await served.rev("task", "task:1")).toEqual({ rev: 4, deleted: false });
  });

  const joinSchema = {
    resources: [
      { name: "join_notes", version: 1, fields: [{ name: "body", type: "string" as const, required: false }] },
      { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }] },
      { name: "tag", version: 1, fields: [{ name: "label", type: "string" as const, required: false }] },
    ],
    relations: [{ from: "task", to: "tag", type: "many-many", relation: "tags" }],
  } as any;

  it("tracks a declared resource named join_* like any resource, and gives a many-many join store none", async () => {
    const served = await serve({ schema: joinSchema });
    const revs: unknown[] = [];
    for (const mutation of [
      { operation: "insert", record: { body: "a" } },
      { operation: "merge", record: { body: "b" } },
      { operation: "delete" },
      { operation: "insert", record: { body: "c" } },
    ]) {
      const res = await served.push({ resource: "join_notes", id: "join_notes:1", ...mutation });
      expect(res.body.ok).toBe(true);
      revs.push(res.body.result.revisions[res.mutationId]);
    }
    expect(revs).toEqual([
      expect.objectContaining({ rev: 1 }),
      expect.objectContaining({ rev: 2 }),
      expect.objectContaining({ rev: 3, deleted: true }),
      expect.objectContaining({ rev: 4 }),
    ]);
    const clone = await served.send("clone", { clientId: "client:b", tables: ["join_notes"] });
    expect(clone.body.result.data.join_notes).toEqual([expect.objectContaining({ id: "join_notes:1", body: "c", $rev: 4 })]);

    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "t" } });
    await served.push({ resource: "tag", operation: "insert", id: "tag:1", record: { label: "l" } });
    const related = await served.push({ resource: "task", operation: "relate", id: "task:1", relations: { tags: { $ref: "tag:1" } } });
    expect(related.body.ok).toBe(true);
    const pull = await served.send("pull", { clientId: "client:p", cursor: "0" });
    const joinChanges = (pull.body.result.changes as Json[]).filter((change) => change.resource === "join_task_tags_tag");
    expect(joinChanges.length).toBeGreaterThan(0);
    for (const change of joinChanges) expect(change).not.toHaveProperty("rev");
    const ledger = (await served.database.internal.findMany("__datafn_revisions", [])) as Json[];
    expect(ledger.map((row) => row.resource).sort()).toEqual(["join_notes", "tag", "task"]);
  });

  it("warns that a server sharing rows across namespaces must not write next to a revision-issuing server", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await createDatafnServer({ schema, database: memoryAdapter(), allowUnknownResources: true, rowLevelNamespace: false });
    expect(warn.mock.calls.some(([message]) => String(message).includes("must not write to tables a server with revisions.enabled"))).toBe(true);
    warn.mockClear();
    await createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, namespaceProvider: { getNamespace: () => "tenant:a" },
    } as any);
    expect(warn.mock.calls.some(([message]) => String(message).includes("revisions.enabled"))).toBe(false);
    configureRevisions(schema, { enabled: true });
  });

  it("withholds unreadable fields from clone rows of a revision-issuing resource on every clone mode", async () => {
    const database = memoryAdapter();
    const { push } = await serve({ database });
    for (const id of ["secretive:1", "secretive:2", "secretive:3"]) {
      expect((await push({ resource: "secretive", operation: "insert", id, record: { title: id, hidden: "h" } })).body.ok).toBe(true);
    }
    configureRevisions(schema, { enabled: true });
    const clones = async (db: Adapter) => [
      (await executeClone({ clientId: "client:b", tables: ["secretive"], page: { table: "secretive", limit: 2 } } as any, schema, db, NS)).data.secretive,
      (await executeClone({ clientId: "client:b", tables: ["secretive"] } as any, schema, db, NS, undefined, 2)).data.secretive,
      (await executeClone({ clientId: "client:b", tables: ["secretive"] } as any, schema, db, NS)).data.secretive,
    ];
    for (const db of [database, failingRevisions(database, "read"), failingRevisions(database, "ddl")]) {
      for (const rows of await clones(db)) {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row).toHaveProperty("title");
          expect(row).not.toHaveProperty("hidden");
          expect(row).not.toHaveProperty("$rev");
        }
      }
    }
    // A resource that issues no revisions keeps the base clone rows.
    configureRevisions(schema, { enabled: false });
    try {
      const base = await executeClone({ clientId: "client:b", tables: ["secretive"] } as any, schema, database, NS);
      expect(base.data.secretive[0]).toHaveProperty("hidden", "h");
    } finally {
      configureRevisions(schema, { enabled: true });
    }
  });

  it("refuses revisions.enabled for a relation that writes a record's id, and accepts it otherwise", async () => {
    const idSchema = {
      resources: [
        { name: "project", version: 1, fields: [{ name: "name", type: "string" as const, required: false }] },
        { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }] },
      ],
      relations: [{ from: "task", to: "project", type: "many-one", relation: "project", fkField: "id" }],
    } as any;
    await expect(createDatafnServer({ schema: idSchema, database: memoryAdapter(), revisions: { enabled: true } }))
      .rejects.toThrow(/DATAFN_REVISIONS_UNSUPPORTED: revisions cannot be enabled/);
    await expect(createDatafnServer({ schema: idSchema, database: memoryAdapter() })).resolves.toBeDefined();
    const normal = { ...idSchema, relations: [{ ...idSchema.relations[0], fkField: "projectId" }] };
    await expect(createDatafnServer({ schema: normal, database: memoryAdapter(), revisions: { enabled: true } })).resolves.toBeDefined();
  });
});

describe("DATA-41 revisions: round 14", () => {
  const batchSchema = {
    resources: [
      { name: "project", version: 1, fields: [{ name: "name", type: "string" as const, required: false }] },
      { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }, { name: "projectId", type: "string" as const, required: false }] },
    ],
    relations: [{ from: "project", to: "task", type: "one-many", relation: "tasks", fkField: "projectId" }],
  } as any;

  it.each(["relate", "unrelate"])(
    "with revisions off, keeps the tombstone of a batched %s target a concurrent delete removed",
    async (operation) => {
      const raced = new Set<string>();
      const served = await serve({ enabled: false, schema: batchSchema, database: deletedBeforeUpdate(memoryAdapter(), raced) });
      await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
      for (const id of ["task:1", "task:2"]) {
        await served.push({ resource: "task", operation: "insert", id, record: { title: id, projectId: "project:1" } });
      }
      // task:2 is deleted (tombstone 2) after the target check and before the
      // batched updateMany, which then changes task:1 only.
      raced.add("task:2");
      const res = await served.push({ resource: "project", operation, id: "project:1", relations: { tasks: ["task:1", "task:2"] } });
      expect(res.body.result.ok, JSON.stringify(res.body)).toBe(true);
      expect(raced.size).toBe(0);
      expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: false });
      expect(await served.rev("task", "task:2")).toEqual({ rev: 2, deleted: true });
    },
  );

  it("with revisions off, keeps the tombstone of a merged record a concurrent delete removed", async () => {
    const raced = new Set<string>();
    const served = await serve({ enabled: false, database: deletedBeforeUpdate(memoryAdapter(), raced) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    raced.add("task:1");
    await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    expect(raced.size).toBe(0);
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
  });

  it("refuses revisions.enabled when a relation sharing another's foreign key writes the id as its resource field", async () => {
    const shared = {
      resources: [
        { name: "project", version: 1, fields: [{ name: "name", type: "string" as const, required: false }] },
        { name: "goal", version: 1, fields: [{ name: "label", type: "string" as const, required: false }] },
        { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }, { name: "targetId", type: "string" as const, required: false }] },
      ],
      relations: [
        { from: "task", to: "project", type: "many-one", relation: "project", fkField: "targetId" },
        { from: "task", to: ["project", "goal"], type: "many-one", relation: "target", fkField: "targetId", fkResourceField: "id" },
      ],
    } as any;
    await expect(createDatafnServer({ schema: shared, database: memoryAdapter(), revisions: { enabled: true } }))
      .rejects.toThrow(/DATAFN_REVISIONS_UNSUPPORTED: revisions cannot be enabled/);
    const safe = { ...shared, relations: [shared.relations[0], { ...shared.relations[1], fkResourceField: "targetResource" }] };
    await expect(createDatafnServer({ schema: safe, database: memoryAdapter(), revisions: { enabled: true } })).resolves.toBeDefined();
  });

  it("resolves access afresh when a versioned query falls back, not from a membership an earlier batch query cached", async () => {
    const team = "org:acme";
    const notes = {
      resources: [{
        name: "notes",
        version: 1,
        capabilities: ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
        fields: [{ name: "title", type: "string" as const, required: true }],
      }],
      relations: [],
    } as any;
    const base = memoryAdapter();
    await base.create({ model: "notes", data: { id: "note_shared", title: "Shared", createdBy: "alice", __ns: team }, namespace: team });
    await base.create({ model: "notes", data: { id: "note_own", title: "Own", createdBy: "bob", __ns: team }, namespace: team });
    await base.create({
      model: "__datafn_principal_memberships",
      data: { id: "m_bob", namespace: team, actorId: "bob", principalId: "team:eng", revokedAt: null, __ns: team },
      namespace: team,
    });
    await base.create({
      model: "__datafn_permissions_global",
      data: {
        id: "g_shared", resourceType: "notes", resourceNs: team, resourceId: "note_shared", principalId: "team:eng",
        level: "viewer", grantKind: "record", sourceRef: null, grantedBy: "alice", grantedAt: 1, revokedAt: null, __ns: team,
      },
      namespace: team,
    });
    // The revisions table cannot be created, so the versioned query falls
    // back to a plain read. The host revokes bob's membership after the
    // batch's first query resolved it.
    const failing = failingRevisions(base, "ddl");
    let membershipReads = 0;
    const database = new Proxy(failing, {
      get(target, property, receiver) {
        if (property === "findMany") {
          return async (args: any) => {
            const rows = await target.findMany(args);
            if (args.model !== "__datafn_principal_memberships") return rows;
            membershipReads += 1;
            return membershipReads === 1 ? rows : rows.map((row: Json) => ({ ...row, revokedAt: 2 }));
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Adapter;
    const server = await createDatafnServer({
      schema: notes,
      database,
      allowUnknownResources: true,
      revisions: { enabled: true },
      limits: { maxBatchQueryConcurrency: 1 },
      namespaceProvider: { getNamespace: () => team, getActorId: () => "bob" as any },
    } as any);
    const request = { resource: "notes", version: 1, operation: "find" };
    const res = await server.router.handle(new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([request, { ...request, withRevisions: true }]),
    }));
    expect(res.status).toBe(200);
    const batch = (await res.json()) as Json;
    const ids = (result: Json) => (result.data as Json[]).map((row) => row.id).sort();
    expect(ids(batch.result[0])).toEqual(["note_own", "note_shared"]);
    expect(ids(batch.result[1])).toEqual(["note_own"]);
    for (const row of batch.result[1].data as Json[]) expect(row).not.toHaveProperty("$rev");
    expect(membershipReads).toBe(2);
  });
});

describe("DATA-41 revisions: round 15", () => {
  const zonedSchema = {
    resources: [
      {
        name: "zoned",
        version: 1,
        fields: [
          { name: "title", type: "string" as const, required: false },
          { name: "__ns", type: "string" as const, required: false },
        ],
        permissions: { read: { fields: ["title"] }, write: { fields: ["title", "__ns"] } },
      },
      { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }] },
    ],
    relations: [],
  } as any;

  it("withholds a declared __ns field the read policy hides, with $rev, on push, clone, pull and versioned queries", async () => {
    const database = memoryAdapter();
    const { push, send } = await serve({ database, schema: zonedSchema });
    const hiddenValue = "zone-hidden-value";
    const inserted = await push({ resource: "zoned", operation: "insert", id: "zoned:1", record: { title: "t", __ns: hiddenValue } });
    expect(inserted.body.ok, JSON.stringify(inserted.body)).toBe(true);
    const merged = await push({ resource: "zoned", operation: "replace", id: "zoned:1", record: { title: "u", __ns: hiddenValue } });
    expect(merged.body.ok, JSON.stringify(merged.body)).toBe(true);
    await push({ resource: "zoned", operation: "insert", id: "zoned:2", record: { title: "v", __ns: hiddenValue } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "readable" } });

    // Push: rev only, no post-write row for the field-restricted record.
    for (const res of [inserted, merged]) {
      const entry = res.body.result.revisions[res.mutationId];
      expect(entry).toMatchObject({ resource: "zoned", id: "zoned:1" });
      expect(entry).not.toHaveProperty("record");
    }

    // Clone, every mode.
    configureRevisions(zonedSchema, { enabled: true });
    const cloneRows = [
      (await executeClone({ clientId: "client:b", tables: ["zoned"], page: { table: "zoned", limit: 1 } } as any, zonedSchema, database, NS)).data.zoned,
      (await executeClone({ clientId: "client:b", tables: ["zoned"] } as any, zonedSchema, database, NS, undefined, 1)).data.zoned,
      (await send("clone", { clientId: "client:b", tables: ["zoned", "task"] })).body.result.data.zoned,
    ];
    for (const rows of cloneRows) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toHaveProperty("title");
        expect(row).not.toHaveProperty("__ns");
        expect(row).not.toHaveProperty("$rev");
      }
    }

    // Pull, canonical and global.
    const canonical = await send("pull", { clientId: "client:b", cursors: { zoned: "0", task: "0" } });
    expect(canonical.status).toBe(200);
    expect(canonical.body.result.records.zoned.length).toBeGreaterThan(0);
    for (const row of canonical.body.result.records.zoned) {
      expect(row).not.toHaveProperty("__ns");
      expect(row).not.toHaveProperty("$rev");
    }
    const global = await send("pull", { clientId: "client:b", cursor: "0" });
    expect(global.status).toBe(200);
    const zonedChanges = (global.body.result.changes as Json[]).filter((change) => change.resource === "zoned");
    expect(zonedChanges.length).toBeGreaterThan(0);
    for (const change of zonedChanges) {
      if (change.record) {
        expect(change.record).not.toHaveProperty("__ns");
        expect(change.record).not.toHaveProperty("$rev");
      }
    }

    // Versioned query.
    const query = await send("query", { resource: "zoned", version: 1, withRevisions: true });
    expect(query.status).toBe(200);
    expect(query.body.result.data.length).toBeGreaterThan(0);
    for (const row of query.body.result.data as Json[]) {
      expect(row).not.toHaveProperty("__ns");
      expect(row).not.toHaveProperty("$rev");
    }

    for (const body of [inserted.body, merged.body, canonical.body, global.body, query.body]) {
      expect(JSON.stringify(body)).not.toContain(hiddenValue);
    }
    for (const rows of cloneRows) expect(JSON.stringify(rows)).not.toContain(hiddenValue);

    // A fully readable resource keeps its rows and revisions.
    const fullClone = await send("clone", { clientId: "client:b", tables: ["task"] });
    expect(fullClone.body.result.data.task).toEqual([expect.objectContaining({ id: "task:1", title: "readable", $rev: 1 })]);
    const readable = await send("query", { resource: "task", version: 1, withRevisions: true });
    expect(readable.body.result.data).toEqual([expect.objectContaining({ id: "task:1", $rev: 1 })]);
  });
});

describe("DATA-41 revisions: declared join_* resources on pull (round 15)", () => {
  const joinPullSchema = {
    resources: [
      { name: "join_notes", version: 1, fields: [{ name: "body", type: "string" as const, required: false }] },
      {
        name: "join_secrets",
        version: 1,
        capabilities: ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private" } }],
        fields: [{ name: "body", type: "string" as const, required: false }],
      },
      { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }] },
      { name: "tag", version: 1, fields: [{ name: "label", type: "string" as const, required: false }] },
    ],
    relations: [{ from: "task", to: "tag", type: "many-many", relation: "tags" }],
  } as any;

  async function serveAs() {
    let actor = "alice";
    const database = memoryAdapter();
    const server = await createDatafnServer({
      schema: joinPullSchema,
      database,
      allowUnknownResources: true,
      revisions: { enabled: true },
      namespaceProvider: { getNamespace: () => NS, getActorId: () => actor as any },
    } as any);
    const send = async (route: string, body: unknown, as: string) => {
      actor = as;
      const res = await server.router.handle(new Request(`http://localhost/datafn/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      return { status: res.status, body: (await res.json()) as Json };
    };
    let seq = 0;
    const push = async (mutation: Json, as = "alice") => {
      seq += 1;
      const res = await send("push", { clientId: "client:a", mutations: [{ version: 1, clientId: "client:a", mutationId: `m${seq}`, ...mutation }] }, as);
      expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
      return res;
    };
    return { send, push };
  }

  it("returns a declared join_* resource in its data bucket, applies its access checks, and keeps join stores in joins", async () => {
    const { send, push } = await serveAs();
    await push({ resource: "join_notes", operation: "insert", id: "join_notes:1", record: { body: "public" } });
    await push({ resource: "join_secrets", operation: "insert", id: "join_secrets:1", record: { body: "alice-only" } });
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "t" } });
    await push({ resource: "tag", operation: "insert", id: "tag:1", record: { label: "l" } });
    await push({ resource: "task", operation: "relate", id: "task:1", relations: { tags: { $ref: "tag:1" } } });

    const cursors = { join_notes: "0", join_secrets: "0", join_task_tags_tag: "0" };
    const canonical = await send("pull", { clientId: "client:b", cursors, includeJoins: true }, "alice");
    expect(canonical.status).toBe(200);
    const result = canonical.body.result;
    expect(result.records.join_notes).toEqual([expect.objectContaining({ id: "join_notes:1", body: "public", $rev: 1 })]);
    expect(result.records.join_secrets).toEqual([expect.objectContaining({ id: "join_secrets:1", body: "alice-only" })]);
    expect(result.joins?.join_notes).toBeUndefined();
    expect(result.joins?.join_secrets).toBeUndefined();
    // A real many-many join store keeps the joins branch.
    expect(result.joins.join_task_tags_tag.upsert.length).toBeGreaterThan(0);
    expect(result.records).not.toHaveProperty("join_task_tags_tag");

    // Bob may not read alice's private join_secrets row, on either pull.
    const bobCanonical = await send("pull", { clientId: "client:c", cursors, includeJoins: true }, "bob");
    expect(bobCanonical.status).toBe(200);
    expect(bobCanonical.body.result.records.join_notes).toEqual([expect.objectContaining({ id: "join_notes:1" })]);
    expect(bobCanonical.body.result.records.join_secrets).toEqual([]);
    const bobGlobal = await send("pull", { clientId: "client:c", cursor: "0" }, "bob");
    expect(bobGlobal.status).toBe(200);
    const bobIds = (bobGlobal.body.result.changes as Json[]).map((change) => change.id);
    expect(bobIds).toContain("join_notes:1");
    expect(bobIds).not.toContain("join_secrets:1");
    expect(JSON.stringify(bobGlobal.body.result)).not.toContain("alice-only");
    const aliceGlobal = await send("pull", { clientId: "client:b", cursor: "0" }, "alice");
    expect((aliceGlobal.body.result.changes as Json[]).map((change) => change.id)).toContain("join_secrets:1");
  });
});

describe("DATA-41 revisions: PR review round 1", () => {
  const denyReads = (action: string) => action !== "query" && action !== "pull" && action !== "clone";

  it("returns no post-write row to a caller whose host or plugin authorization denies reads", async () => {
    const plugin = { name: "no-reads", runsOn: ["server"], authorize: (input: Json) => denyReads(input.action) };
    for (const config of [{ authorize: (_ctx: unknown, action: string) => denyReads(action) }, { plugins: [plugin] }]) {
      const { push } = await serve({ config });
      const inserted = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
      expect(inserted.body.result.revisions[inserted.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
      const merged = await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" }, mutationId: "merge" });
      expect(merged.body.result.revisions.merge).toEqual({ resource: "task", id: "task:1", rev: 2 });
      const replay = await push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" }, mutationId: "merge" });
      expect(replay.body.result.revisions.merge).toEqual({ resource: "task", id: "task:1", rev: 2 });
      expect(JSON.stringify([inserted.body, merged.body, replay.body])).not.toContain("$rev");
    }
    const reader = await serve({ config: { authorize: () => true } });
    const inserted = await reader.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(inserted.body.result.revisions[inserted.mutationId].record).toMatchObject({ id: "task:1", title: "a", $rev: 1 });
  });

  it("replays a stored revision only to a retry of the same resource and id, on push and /mutation", async () => {
    const { push, send } = await serve();
    await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" }, mutationId: "reused" });
    const retry = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" }, mutationId: "reused" });
    expect(retry.body.result.revisions.reused).toEqual({ resource: "task", id: "task:1", rev: 1 });
    for (const target of [{ resource: "task", id: "task:2" }, { resource: "project", id: "task:1" }]) {
      const reused = await push({ ...target, operation: "insert", record: {}, mutationId: "reused" });
      expect(reused.body.result.applied).toContain("reused");
      expect(reused.body.result.revisions?.reused).toBeUndefined();
    }

    const mutation = { version: 1, operation: "insert", record: {}, clientId: "c", mutationId: "once" };
    const first = await send("mutation", { ...mutation, resource: "task", id: "task:3" });
    expect(first.body.result.rev).toBe(1);
    expect(first.body.result).not.toHaveProperty("revTarget");
    const again = await send("mutation", { ...mutation, resource: "task", id: "task:3" });
    expect(again.body.result).toMatchObject({ deduped: true, rev: 1 });
    expect(again.body.result).not.toHaveProperty("revTarget");
    for (const target of [{ resource: "task", id: "task:4" }, { resource: "project", id: "task:3" }]) {
      const reused = await send("mutation", { ...mutation, ...target });
      expect(reused.body.result.deduped).toBe(true);
      expect(reused.body.result).not.toHaveProperty("rev");
    }
  });

  it("decides post-write rows from a query-shaped request after the batch, and drops ambiguous mutation ids", async () => {
    // A plugin that tells reads from writes by the request path.
    const byPath = { name: "path-policy", runsOn: ["server"], authorize: (input: Json) => !new URL(input.request.url).pathname.endsWith("/query") };
    const path = await serve({ config: { plugins: [byPath] } });
    const inserted = await path.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(inserted.body.result.revisions[inserted.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });

    // A host read rule over application state that an earlier mutation of the same push revokes.
    const database = memoryAdapter();
    const readGranted = async () => Boolean(await database.findOne({
      model: "project", where: [{ field: "id", operator: "eq", value: "project:readers" }], namespace: NS,
    }));
    const host = await serve({ database, config: { authorize: async (_ctx: unknown, action: string) => action !== "query" || readGranted() } });
    await host.push({ resource: "project", operation: "insert", id: "project:readers", record: { name: "r" } });
    const revoked = await host.send("push", { clientId: "client:a", mutations: [
      { version: 1, clientId: "client:a", mutationId: "revoke", resource: "project", operation: "delete", id: "project:readers" },
      { version: 1, clientId: "client:a", mutationId: "later", resource: "task", operation: "insert", id: "task:2", record: { title: "b" } },
    ] });
    expect(revoked.body.result.revisions.later).toEqual({ resource: "task", id: "task:2", rev: 1 });

    // One mutation id used for two records in one push.
    const reused = await host.send("push", { clientId: "client:a", mutations: [
      { version: 1, clientId: "client:a", mutationId: "twice", resource: "task", operation: "insert", id: "task:3", record: {} },
      { version: 1, clientId: "client:a", mutationId: "twice", resource: "task", operation: "insert", id: "task:4", record: {} },
    ] });
    expect(reused.body.result.applied).toContain("twice");
    expect(reused.body.result.revisions?.twice).toBeUndefined();
  });

  it("returns a post-write row only with a route ticket that grants the query scope", async () => {
    const directory = createMemoryDatafnPlacementDirectory();
    const placement = await claimDatafnNamespacePlacement({ directory, namespace: "tenant", regionId: "eu" });
    const tickets = createDatafnHmacRouteTickets({ activeKeyId: "test", keys: { test: "x".repeat(32) } });
    const server = await createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
      context: () => ({ namespace: "tenant" }),
      namespaceProvider: { getNamespace: (context: { namespace: string }) => context.namespace },
      plugins: [datafnMultiRegionPlugin({ regionId: "eu", directory: createMemoryIndexedDirectoryStore(),
        placement: { directory, routeTickets: { verifier: tickets, issuer: "app", audience: "eu" } } })],
    } as any);
    const pushWith = async (scopes: string[], id: string) => {
      const now = Date.now();
      const ticket = await tickets.sign({
        version: 1, issuer: "app", audience: "eu", subject: "subject", namespace: "tenant", regionId: "eu",
        epoch: placement.placement.epoch, scopes: scopes as any, issuedAt: now, notBefore: now, expiresAt: now + 60_000, ticketId: `ticket-${id}`,
      });
      const res = await server.router.handle(new Request("http://localhost/datafn/push", {
        method: "POST",
        headers: { "content-type": "application/json", "x-datafn-route-ticket": ticket },
        body: JSON.stringify({ clientId: "c", mutations: [{ version: 1, clientId: "c", mutationId: id, resource: "task", operation: "insert", id, record: { title: "t" } }] }),
      }));
      return ((await res.json()) as Json).result?.revisions?.[id];
    };
    expect(await pushWith(["push"], "task:1")).toEqual({ resource: "task", id: "task:1", rev: 1 });
    expect((await pushWith(["push", "query"], "task:2")).record).toMatchObject({ id: "task:2", $rev: 1 });
  });

  it("builds the read check's context from the query request, and accepts the push route with a trailing slash", async () => {
    // The host authenticates per endpoint in its context factory: only a reader credential is a principal on /query.
    const server = await createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
      context: (request: Request) => ({
        principal: new URL(request.url).pathname.endsWith("/query")
          ? (request.headers.get("x-test-role") === "reader" ? "reader" : null)
          : "writer",
      }),
      authorize: (ctx: Json, action: string) => action !== "query" || ctx.principal !== null,
    } as any);
    const pushAs = async (role: string, id: string, path = "/datafn/push") => {
      const res = await server.router.handle(new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-role": role },
        body: JSON.stringify({ clientId: "c", mutations: [{ version: 1, clientId: "c", mutationId: id, resource: "task", operation: "insert", id, record: { title: "t" } }] }),
      }));
      return ((await res.json()) as Json).result?.revisions?.[id];
    };
    expect(await pushAs("writer", "task:1")).toEqual({ resource: "task", id: "task:1", rev: 1 });
    expect((await pushAs("reader", "task:2")).record).toMatchObject({ id: "task:2", $rev: 1 });
    expect((await pushAs("reader", "task:3", "/datafn/push/")).record).toMatchObject({ id: "task:3", $rev: 1 });
  });
});

describe("DATA-41 revisions: PR review round 2", () => {
  it("re-validates the route ticket for the read at settlement: revoked or unauthenticated reads get rev alone", async () => {
    const directory = createMemoryDatafnPlacementDirectory();
    const placement = await claimDatafnNamespacePlacement({ directory, namespace: "tenant", regionId: "eu" });
    const tickets = createDatafnHmacRouteTickets({ activeKeyId: "test", keys: { test: "x".repeat(32) } });
    // A ticket named revoked-* is revoked after its push was admitted.
    const checks = new Map<string, number>();
    const isActive = async (claims: Json) => {
      checks.set(claims.ticketId, (checks.get(claims.ticketId) ?? 0) + 1);
      return !claims.ticketId.startsWith("ticket-revoked") || checks.get(claims.ticketId) === 1;
    };
    // The host's session check rejects reads for a caller marked write-only.
    const authenticate = async (request: Request) =>
      request.headers.get("x-test-role") === "writer-only" && new URL(request.url).pathname.endsWith("/query")
        ? null
        : { subject: "subject", namespace: "tenant" };
    const server = await createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
      context: () => ({ namespace: "tenant" }),
      namespaceProvider: { getNamespace: (context: { namespace: string }) => context.namespace },
      plugins: [datafnMultiRegionPlugin({ regionId: "eu", directory: createMemoryIndexedDirectoryStore(),
        placement: { directory, routeTickets: { verifier: tickets, issuer: "app", audience: "eu", isActive, authenticate } } })],
    } as any);
    const call = async (route: string, ticketId: string, body: unknown, role = "reader") => {
      const now = Date.now();
      const ticket = await tickets.sign({
        version: 1, issuer: "app", audience: "eu", subject: "subject", namespace: "tenant", regionId: "eu",
        epoch: placement.placement.epoch, scopes: ["push", "query"], issuedAt: now, notBefore: now, expiresAt: now + 60_000, ticketId,
      });
      const res = await server.router.handle(new Request(`http://localhost/datafn/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-datafn-route-ticket": ticket, "x-test-role": role },
        body: JSON.stringify(body),
      }));
      return (await res.json()) as Json;
    };
    const insert = (id: string) => ({ clientId: "c", mutations: [{ version: 1, clientId: "c", mutationId: id, resource: "task", operation: "insert", id, record: { title: "t" } }] });

    const revoked = await call("push", "ticket-revoked-1", insert("task:1"));
    expect(revoked.ok).toBe(true);
    expect(revoked.result.revisions["task:1"]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    const unauthenticated = await call("push", "ticket-2", insert("task:2"), "writer-only");
    expect(unauthenticated.ok).toBe(true);
    expect(unauthenticated.result.revisions["task:2"]).toEqual({ resource: "task", id: "task:2", rev: 1 });

    // Control: a caller whose query is admitted gets exactly the row /query returns.
    const admitted = await call("push", "ticket-3", insert("task:3"));
    const queried = await call("query", "ticket-4", { version: 1, resource: "task", withRevisions: true, filters: { id: "task:3" } });
    expect(queried.result.data).toEqual([expect.objectContaining({ id: "task:3", $rev: 1 })]);
    expect(admitted.result.revisions["task:3"]).toEqual({ resource: "task", id: "task:3", rev: 1, record: queried.result.data[0] });
  });

  it("withholds a post-write row that a plugin query hook denies or filters out", async () => {
    const hooks = {
      name: "read-hooks",
      runsOn: ["server"],
      beforeQuery: (_ctx: unknown, query: Json) => {
        if (query.resource === "project") throw Object.assign(new Error("no project reads"), { code: "FORBIDDEN" });
        return query;
      },
      afterQuery: (_ctx: unknown, _query: unknown, result: Json) =>
        ({ ...result, data: result.data.filter((row: Json) => row.id !== "task:hidden") }),
    };
    const { push } = await serve({ config: { plugins: [hooks] } });
    const hidden = await push({ resource: "task", operation: "insert", id: "task:hidden", record: { title: "a" } });
    expect(hidden.body.result.revisions[hidden.mutationId]).toEqual({ resource: "task", id: "task:hidden", rev: 1 });
    const merged = await push({ resource: "task", operation: "merge", id: "task:hidden", record: { title: "b" } });
    expect(merged.body.result.revisions[merged.mutationId]).toEqual({ resource: "task", id: "task:hidden", rev: 2 });
    const denied = await push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
    expect(denied.body.result.revisions[denied.mutationId]).toEqual({ resource: "project", id: "project:1", rev: 1 });
    expect(JSON.stringify([hidden.body, merged.body, denied.body])).not.toContain("$rev");

    const shown = await push({ resource: "task", operation: "insert", id: "task:shown", record: { title: "c" } });
    expect(shown.body.result.revisions[shown.mutationId].record).toMatchObject({ id: "task:shown", title: "c", $rev: 1 });
  });

  it("returns the write's own row only when the caller's query returns exactly that row", async () => {
    // afterQuery rewrites a field but keeps id and $rev; beforeQuery redirects task:moved reads to project.
    const hooks = {
      name: "rewriting-hooks",
      runsOn: ["server"],
      beforeQuery: (_ctx: unknown, query: Json) =>
        JSON.stringify(query.filters ?? {}).includes("task:moved") ? { ...query, resource: "project" } : query,
      afterQuery: (_ctx: unknown, _query: unknown, result: Json) =>
        ({ ...result, data: result.data.map((row: Json) => (row.id === "task:redacted" ? { ...row, title: "[hidden]" } : row)) }),
    };
    const { push } = await serve({ config: { plugins: [hooks] } });
    const redacted = await push({ resource: "task", operation: "insert", id: "task:redacted", record: { title: "secret" } });
    expect(redacted.body.result.revisions[redacted.mutationId]).toEqual({ resource: "task", id: "task:redacted", rev: 1 });
    await push({ resource: "project", operation: "insert", id: "task:moved", record: { name: "other" } });
    const moved = await push({ resource: "task", operation: "insert", id: "task:moved", record: { title: "mine" } });
    expect(moved.body.result.revisions[moved.mutationId]).toEqual({ resource: "task", id: "task:moved", rev: 1 });
    const plain = await push({ resource: "task", operation: "insert", id: "task:plain", record: { title: "p" } });
    expect(plain.body.result.revisions[plain.mutationId].record).toMatchObject({ id: "task:plain", title: "p", $rev: 1 });

    // A namespace provider that picks another namespace for a parsed versioned query.
    const scoped = await serve({ config: { namespaceProvider: {
      getNamespace: (ctx: Json) => (ctx?.parsedBody?.withRevisions === true ? "elsewhere" : NS),
    } } });
    const elsewhere = await scoped.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(elsewhere.body.result.revisions[elsewhere.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("gives a push a gateway routing assertion admitted rev alone (PR review round 3)", async () => {
    const directory = createMemoryDatafnPlacementDirectory();
    await claimDatafnNamespacePlacement({ directory, namespace: "tenant", regionId: "eu" });
    const assertions = createDatafnHmacRoutingAssertions({ activeKeyId: "v1", keys: { v1: "test-only-secret" } });
    const server = await createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
      context: () => ({ namespace: "tenant" }),
      namespaceProvider: { getNamespace: (context: { namespace: string }) => context.namespace },
      plugins: [datafnMultiRegionPlugin({ regionId: "eu", directory: createMemoryIndexedDirectoryStore(),
        placement: { directory, requireRoutingAssertion: true, assertionVerifier: assertions, replayStore: createMemoryDatafnRoutingReplayStore() } })],
    } as any);
    const gateway = createDatafnGatewayRouter({
      directory,
      deriveNamespace: () => "tenant",
      cellRegistry: { resolve: () => (request: Request) => server.router.handle(request) },
      dispatcher: { dispatch: ({ target, request, assertion }) => target(withDatafnRoutingAssertion(request, assertion), "tenant") },
      assertionSigner: assertions,
    } as any);
    const res = await gateway.handle(new Request("https://data.example/datafn/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c", mutations: [{ version: 1, clientId: "c", mutationId: "m", resource: "task", operation: "insert", id: "task:1", record: { title: "t" } }] }),
    }));
    const body = (await res.json()) as Json;
    expect(body.ok).toBe(true);
    // The assertion is bound to the push request, so no /query the router
    // admits can back the row: the push returns the revision alone.
    expect(body.result.revisions.m).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("gives an assertion-admitted push rev alone where route tickets guard queries", async () => {
    const directory = createMemoryDatafnPlacementDirectory();
    await claimDatafnNamespacePlacement({ directory, namespace: "tenant", regionId: "eu" });
    const assertions = createDatafnHmacRoutingAssertions({ activeKeyId: "v1", keys: { v1: "test-only-secret" } });
    const tickets = createDatafnHmacRouteTickets({ activeKeyId: "test", keys: { test: "x".repeat(32) } });
    const server = await createDatafnServer({
      schema, database: memoryAdapter(), allowUnknownResources: true, revisions: { enabled: true },
      context: () => ({ namespace: "tenant" }),
      namespaceProvider: { getNamespace: (context: { namespace: string }) => context.namespace },
      plugins: [datafnMultiRegionPlugin({ regionId: "eu", directory: createMemoryIndexedDirectoryStore(),
        placement: { directory, assertionVerifier: assertions, replayStore: createMemoryDatafnRoutingReplayStore(),
          routeTickets: { verifier: tickets, issuer: "app", audience: "eu" } } })],
    } as any);
    const gateway = createDatafnGatewayRouter({
      directory,
      deriveNamespace: () => "tenant",
      cellRegistry: { resolve: () => (request: Request) => server.router.handle(request) },
      dispatcher: { dispatch: ({ target, request, assertion }) => target(withDatafnRoutingAssertion(request, assertion), "tenant") },
      assertionSigner: assertions,
    } as any);
    const res = await gateway.handle(new Request("https://data.example/datafn/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c", mutations: [{ version: 1, clientId: "c", mutationId: "m", resource: "task", operation: "insert", id: "task:1", record: { title: "t" } }] }),
    }));
    const body = (await res.json()) as Json;
    expect(body.ok).toBe(true);
    expect(body.result.revisions.m).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("withholds the row when a hook redirects the read to another resource holding an identical row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const twin = { version: 1, fields: [{ name: "title", type: "string" as const, required: false }] };
    const redirect = {
      name: "redirect",
      runsOn: ["server"],
      beforeQuery: (_ctx: unknown, query: Json) => (query.resource === "alpha" ? { ...query, resource: "beta" } : query),
    };
    const { push } = await serve({
      schema: { resources: [{ ...twin, name: "alpha" }, { ...twin, name: "beta" }] },
      config: { plugins: [redirect] },
    });
    const beta = await push({ resource: "beta", operation: "insert", id: "x:1", record: { title: "same" } });
    expect(beta.body.result.revisions[beta.mutationId].record).toMatchObject({ id: "x:1", title: "same", $rev: 1 });
    const alpha = await push({ resource: "alpha", operation: "insert", id: "x:1", record: { title: "same" } });
    expect(alpha.body.result.revisions[alpha.mutationId]).toEqual({ resource: "alpha", id: "x:1", rev: 1 });

    // An afterQuery hook that renames the executed query back does not change what was read.
    const restoring = {
      ...redirect,
      afterQuery: (_ctx: unknown, query: Json, result: unknown) => {
        if (query.resource === "beta") query.resource = "alpha";
        return result;
      },
    };
    const restored = await serve({
      schema: { resources: [{ ...twin, name: "alpha" }, { ...twin, name: "beta" }] },
      config: { plugins: [restoring] },
    });
    await restored.push({ resource: "beta", operation: "insert", id: "x:1", record: { title: "same" } });
    const renamed = await restored.push({ resource: "alpha", operation: "insert", id: "x:1", record: { title: "same" } });
    expect(renamed.body.result.revisions[renamed.mutationId]).toEqual({ resource: "alpha", id: "x:1", rev: 1 });
  });

  it("does not spend the caller's query rate limit on the post-write read", async () => {
    const { push, send } = await serve({ config: { rateLimit: { enabled: true, maxRequests: 1, windowSeconds: 60 } } });
    const inserted = await push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(inserted.body.result.revisions[inserted.mutationId].record).toMatchObject({ id: "task:1", $rev: 1 });
    expect((await send("query", { version: 1, resource: "task" })).status).toBe(200);
  });
});

describe("DATA-41 revisions: PR review round 3", () => {
  const isQuery = (request: Request) => new URL(request.url).pathname.endsWith("/query");

  it("applies router middleware, including middleware added later, to the post-write read", async () => {
    const served = await serve();
    const first = await served.push({ resource: "task", operation: "insert", id: "task:0", record: { title: "z" } });
    const row = first.body.result.revisions[first.mutationId].record;
    // Control: the row equals what the caller's own /query returns, $rev included.
    const read = await served.send("query", { version: 1, resource: "task", withRevisions: true, filters: { id: "task:0" } });
    expect(row).toEqual(read.body.result.data[0]);
    expect(row).toMatchObject({ id: "task:0", $rev: 1 });

    // Registered after the server was created and used.
    served.server.router.use(async (request, _ctx, next) =>
      isQuery(request) ? new Response(JSON.stringify({ ok: false }), { status: 403, headers: { "content-type": "application/json" } }) : next());
    expect((await served.send("query", { version: 1, resource: "task" })).status).toBe(403);
    const insert = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(insert.body.result.revisions[insert.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    const merge = await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" }, mutationId: "merge-1" });
    expect(merge.body.result.revisions["merge-1"]).toEqual({ resource: "task", id: "task:1", rev: 2 });
    const replay = await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" }, mutationId: "merge-1" });
    expect(replay.body.result.revisions?.["merge-1"]?.record).toBeUndefined();
  });

  it("withholds the row when router middleware redacts the /query response", async () => {
    const served = await serve();
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      const body = (await response.json()) as Json;
      for (const row of body.result?.data ?? []) row.title = "[redacted]";
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "secret" } });
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("exempts only the push's own read from the payload and rate limits", async () => {
    const pushBody = JSON.stringify({
      clientId: "client:a",
      mutations: [{ version: 1, clientId: "client:a", mutationId: "m1", resource: "task", operation: "insert", id: "task:1", record: { title: "a" } }],
    });
    const maxPayloadBytes = new TextEncoder().encode(pushBody).length + 8;
    const served = await serve({ config: {
      limits: { maxPayloadBytes },
      rateLimit: { enabled: true, maxRequests: 2, windowSeconds: 60 },
    } });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(res.body.result.revisions.m1.record).toMatchObject({ id: "task:1", title: "a", $rev: 1 });

    // A caller cannot claim the exemption with a header or body field.
    const forged = (body: Json) => served.server.router.handle(new Request("http://localhost/datafn/query", {
      method: "POST",
      headers: { "content-type": "application/json", "x-datafn-post-write-read": "1" },
      body: JSON.stringify({ ...body, postWriteRead: true }),
    }));
    expect((await forged({ version: 1, resource: "task", filters: { title: "x".repeat(maxPayloadBytes) } })).status).toBe(413);
    // The push's read-back used none of the query budget (2): the oversized query above took one.
    expect((await forged({ version: 1, resource: "task" })).status).toBe(200);
    expect((await forged({ version: 1, resource: "task" })).status).toBe(429);
  });

  it("runs at most maxBatchQueryConcurrency post-write reads at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const served = await serve({ config: {
      limits: { maxBatchQueryConcurrency: 1 },
      authorize: async (_ctx: unknown, action: string) => {
        if (action !== "query") return true;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return true;
      },
    } });
    await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    const res = await served.send("push", { clientId: "client:a", mutations: [
      { version: 1, clientId: "client:a", mutationId: "t", resource: "task", operation: "insert", id: "task:1", record: { title: "a" } },
      { version: 1, clientId: "client:a", mutationId: "p", resource: "project", operation: "merge", id: "project:1", record: { name: "Q" } },
    ] });
    expect(res.body.result.revisions.t.record).toMatchObject({ id: "task:1", $rev: 1 });
    expect(res.body.result.revisions.p.record).toMatchObject({ id: "project:1", name: "Q", $rev: 2 });
    expect(peak).toBe(1);
  });

  it("retries a revision swap with a current read when the transaction reads a stale snapshot", async () => {
    // A fixed clock: the concurrent bump and every retry write the same updated_at.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const database = memoryAdapter();
    const served = await serve({ database });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    // InnoDB REPEATABLE READ: a plain read returns the row as of the
    // transaction's first read until the transaction writes that row itself.
    const snapshot = new Map<string, Record<string, unknown>>();
    const internal = new Proxy(database.internal, {
      get(target, property, receiver) {
        if (property === "findOne") {
          return async (table: string, where: Array<{ value: unknown }>) => {
            const key = `${table}:${String(where[0]?.value)}`;
            if (!snapshot.has(key)) snapshot.set(key, await target.findOne(table, where as any));
            return snapshot.get(key) ?? null;
          };
        }
        if (property === "update") {
          // Only an update that changes a value gives the transaction its own
          // version of the row; one that writes the same values does not.
          return async (table: string, where: Array<{ value: unknown }>, data: Record<string, unknown>) => {
            const before = await target.findOne(table, [where[0]] as any);
            const affected = await target.update(table, where as any, data);
            const changed = before !== null && Object.entries(data).some(([key, value]) => before[key] !== value);
            if (affected > 0 && changed) snapshot.delete(`${table}:${String(where[0]?.value)}`);
            return affected;
          };
        }
        if (property === "create") {
          // The primary key is checked against the latest committed rows.
          return async (table: string, row: Record<string, unknown>) => {
            if (await target.findOne(table, [{ field: "id", op: "eq", value: row.id }] as any)) {
              throw new Error("Duplicate entry for key 'PRIMARY'");
            }
            return target.create(table, row);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const stale = new Proxy(database, { get: (target, property, receiver) => property === "internal" ? internal : Reflect.get(target, property, receiver) });
    // This transaction reads revision 1, then another writer commits revision 2.
    const ledgerId = (await database.internal.findMany("__datafn_revisions", [])).find((row) => row.record_id === "task:1")!.id;
    await stale.internal.findOne("__datafn_revisions", [{ field: "id", op: "eq", value: ledgerId }] as any);
    await bumpRevision(database, NS, "task", "task:1", false, false);
    expect(await bumpRevision(stale, NS, "task", "task:1", false, true)).toBe(3);
    expect(await served.rev("task", "task:1")).toEqual({ rev: 3, deleted: false });

    // A record with no revision row yet: this transaction's snapshot misses
    // the row another writer creates first, so its own insert is a duplicate.
    const firstId = revisionRowId(NS, "task", "task:legacy");
    await stale.internal.findOne("__datafn_revisions", [{ field: "id", op: "eq", value: firstId }] as any);
    expect(await bumpRevision(database, NS, "task", "task:legacy", false, false)).toBe(1);
    expect(await bumpRevision(stale, NS, "task", "task:legacy", false, true)).toBe(2);
    expect(await served.rev("task", "task:legacy")).toEqual({ rev: 2, deleted: false });
  });

  it("settles a push whose read-back router middleware would queue behind the push", async () => {
    const served = await serve();
    // Router middleware that serializes requests with a lock held across next().
    let lock: Promise<unknown> = Promise.resolve();
    served.server.router.use(async (_request, _ctx, next) => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await next();
      } finally {
        release();
      }
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(res.body.ok).toBe(true);
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    // The late read-back then runs and is discarded; later requests still pass.
    expect((await served.send("query", { version: 1, resource: "task" })).status).toBe(200);
  });

  it("leaves a caller's immutable executor context untouched", async () => {
    const { server } = await serve();
    class Caller { readonly user = "u1"; }
    const context = Object.freeze(new Caller());
    await expect(server.executor.query({ version: 1, resource: "task" }, context as any)).resolves.toMatchObject({ data: [] });
    await expect(server.executor.mutate(
      { version: 1, resource: "task", operation: "insert", id: "task:1", record: { title: "a" }, clientId: "c", mutationId: "x1" },
      context as any,
    )).resolves.toMatchObject({ ok: true });
    expect(Object.getOwnPropertySymbols(context)).toEqual([]);
  });

  it("bounds the read-back body by the deadline and cancels discarded bodies, even when cancel fails", async () => {
    const served = await serve();
    let mode: "stall" | "deny" = "stall";
    const cancelled: string[] = [];
    // A body that sends part of a JSON document, never closes, and whose cancel rejects.
    const stuckBody = (label: string) => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true,"result":{"data":[')); },
      cancel() {
        cancelled.push(label);
        throw new Error("cancel failed");
      },
    });
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      await response.body?.cancel();
      return new Response(stuckBody(mode), { status: mode === "stall" ? 200 : 403, headers: { "content-type": "application/json" } });
    });
    const stalled = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(stalled.body.result.revisions[stalled.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    mode = "deny";
    const denied = await served.push({ resource: "task", operation: "insert", id: "task:2", record: { title: "b" } });
    expect(denied.body.result.revisions[denied.mutationId]).toEqual({ resource: "task", id: "task:2", rev: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toEqual(["stall", "deny"]);
  });

  it("checks the read-back deadline on every body chunk, not only on the timer", async () => {
    const served = await serve();
    // A body that keeps chunks ready (each read resumes in a microtask) for
    // longer than the deadline, then completes a valid document holding the row.
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      const text = await response.text();
      const stopAt = Date.now() + 2_500;
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const busyUntil = Date.now() + 2;
          while (Date.now() < busyUntil) { /* keep the chunk ready */ }
          if (Date.now() < stopAt) return controller.enqueue(new TextEncoder().encode(" "));
          if (!sent) { sent = true; return controller.enqueue(new TextEncoder().encode(text)); }
          controller.close();
        },
      }), { status: response.status, headers: response.headers });
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("cancels a stalled route-hook body and skips a read-back admitted after its deadline", async () => {
    let stall = true;
    let cancelled = 0;
    let queries = 0;
    const served = await serve({ config: {
      routeHooks: {
        afterResponse: ({ action, response }: { action: string; response: Response }) => !stall || action !== "query" ? response
          : new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
            cancel() { cancelled += 1; },
          }), { status: 200, headers: { "content-type": "application/json" } }),
      },
      plugins: [{ name: "count", runsOn: ["server"], beforeQuery: (_ctx: unknown, query: unknown) => { queries += 1; return query; } }],
    } });
    const stalled = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(stalled.body.result.revisions[stalled.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(1);

    // Router middleware that holds /query requests past the deadline before admitting them.
    stall = false;
    queries = 0;
    let delayed: Promise<unknown> | undefined;
    served.server.router.use(async (request, _ctx, next) => {
      if (!isQuery(request)) return next();
      delayed = new Promise((resolve) => setTimeout(resolve, 2_300));
      await delayed;
      return next();
    });
    const late = await served.push({ resource: "task", operation: "insert", id: "task:2", record: { title: "b" } });
    expect(late.body.result.revisions[late.mutationId]).toEqual({ resource: "task", id: "task:2", rev: 1 });
    await delayed;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queries).toBe(0);
  });

  it("gives router middleware the same query envelope for the read-back as for an external query", async () => {
    const served = await serve();
    // Middleware that strips a field from revision-capable query responses only.
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      const body = (await response.json()) as Json;
      if (body.capabilities?.revisions) for (const row of body.result?.data ?? []) delete row.title;
      return new Response(JSON.stringify(body), { status: response.status, headers: { "content-type": "application/json" } });
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "secret" } });
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("reads back in the namespace the push already resolved, without asking the provider again", async () => {
    const database = memoryAdapter();
    let pushContexts = 0;
    const served = await serve({ database, config: { namespaceProvider: {
      getNamespace: async (ctx: Json) => {
        if (!ctx?.parsedBody?.mutations) return NS;
        // The push's own context: after its write commits, the provider stalls.
        pushContexts += 1;
        const written = await database.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any);
        return written ? new Promise<string>(() => undefined) : NS;
      },
    } } });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(pushContexts).toBeGreaterThan(0);
    expect(res.body.result.revisions[res.mutationId].record).toMatchObject({ id: "task:1", $rev: 1 });
  });

  it("aborts a read-back body that router middleware is still reading at the deadline", async () => {
    let middlewareRead: "pending" | "settled" = "pending";
    let cancelled = 0;
    const served = await serve({ config: {
      routeHooks: {
        afterResponse: ({ action, response }: { action: string; response: Response }) => action !== "query" ? response
          : new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
            cancel() { cancelled += 1; },
          }), { status: 200, headers: { "content-type": "application/json" } }),
      },
    } });
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      try {
        await response.json();
      } finally {
        middlewareRead = "settled";
      }
      return response;
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(middlewareRead).toBe("settled");
    expect(cancelled).toBe(1);
  });
});


describe("DATA-41 revisions: PR review round 4", () => {
  const isQuery = (request: Request) => new URL(request.url).pathname.endsWith("/query");
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const queryRoute = (served: { server: { router: { handle(request: Request): Promise<Response> } } }, body: unknown) =>
    served.server.router.handle(new Request("http://localhost/datafn/query", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));

  it("gives a BOM-prefixed read-back the same capability envelope as an external /query", async () => {
    const served = await serve({ config: { routeHooks: {
      afterResponse: async ({ action, response }: { action: string; response: Response }) =>
        action !== "query" ? response : json(`\uFEFF${await response.text()}`),
    } } });
    // Router middleware that redacts any envelope announcing revisions.
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      const body = JSON.parse(await response.text());
      if (!body.capabilities?.revisions) return json(body);
      return json({ ...body, result: { ...body.result, data: body.result.data.map((row: Json) => ({ ...row, title: "[redacted]" })) } });
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    const read = await served.send("query", { version: 1, resource: "task", withRevisions: true, filters: { id: "task:1" } });
    expect(read.body.result.data[0].title).toBe("[redacted]");
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
  });

  it("passes encoded bodies through unchanged and merges an existing capabilities object", async () => {
    let gzipped: Uint8Array | undefined;
    let mode: "gzip" | "merge" = "gzip";
    const served = await serve({ config: { routeHooks: {
      afterResponse: async ({ action, response }: { action: string; response: Response }) => {
        if (action !== "query") return response;
        const body = await response.json() as Json;
        if (mode === "merge") return json(JSON.stringify(body).replace(/^\{/, '{"capabilities":{"custom":true},"big":9007199254740993,'));
        gzipped = new Uint8Array(await new Response(new Blob([JSON.stringify(body)]).stream()
          .pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        return new Response(gzipped, { status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" } });
      },
    } } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    const encoded = await queryRoute(served, { version: 1, resource: "task" });
    expect(new Uint8Array(await encoded.arrayBuffer())).toEqual(gzipped);

    mode = "merge";
    const merged = await (await queryRoute(served, { version: 1, resource: "task", withRevisions: true })).text();
    expect(merged.match(/"capabilities"/g)).toHaveLength(1);
    expect(JSON.parse(merged).capabilities).toEqual({ custom: true, revisions: true });
    expect(merged).toContain('"big":9007199254740993');
    // Control: an authorized push row equals the caller's /query row.
    const res = await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    const read = await served.send("query", { version: 1, resource: "task", withRevisions: true, filters: { id: "task:1" } });
    expect(res.body.result.revisions[res.mutationId].record).toEqual(read.body.result.data[0]);
    expect(read.body.result.data[0]).toMatchObject({ title: "b", $rev: 2 });
  });

  it("aborts a read-back that ends late and stops serving its body past the deadline", async () => {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    let mode: "clone" | "drain" = "clone";
    let reading: Promise<string> | undefined;
    const served = await serve();
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request) || offset !== 0) return response;
      const reader = (mode === "clone" ? response.clone() : response).body!.getReader();
      await reader.read();
      offset = 5_000;
      // Reads the rest slowly (clone) or right away (drain), as middleware might.
      reading = (async () => {
        try {
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            if (mode === "clone") await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return "done";
        } catch {
          return "errored";
        }
      })();
      if (mode === "drain") await reading;
      return response;
    });
    const big = "x".repeat(64 * 1024);
    const cloned = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: big } });
    expect(cloned.body.result.revisions[cloned.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    expect(await reading).toBe("errored");

    offset = 0;
    mode = "drain";
    const drained = await served.push({ resource: "task", operation: "insert", id: "task:2", record: { title: big } });
    expect(drained.body.result.revisions[drained.mutationId]).toEqual({ resource: "task", id: "task:2", rev: 1 });
    expect(await reading).toBe("errored");
  });

  it("decides a retried bump from the current revision row where reads are a snapshot", async () => {
    // InnoDB REPEATABLE READ: a plain read returns the row as of the
    // transaction's first read until the transaction changes that row itself.
    const snapshotView = (database: Adapter): Adapter => {
      const seen = new Map<string, unknown>();
      const read = async (key: string, load: () => Promise<unknown>) => {
        if (!seen.has(key)) seen.set(key, await load());
        return seen.get(key) ?? null;
      };
      const internal = new Proxy(database.internal, {
        get(target, property, receiver) {
          if (property === "findOne") {
            return (table: string, where: any[]) => read(`${table}:${String(where[0]?.value)}`, () => target.findOne(table, where));
          }
          if (property === "update") {
            return async (table: string, where: any[], data: Json) => {
              const before = await target.findOne(table, [where[0]]);
              const affected = await target.update(table, where, data);
              if (affected > 0 && before && Object.entries(data).some(([key, value]) => before[key] !== value)) {
                seen.delete(`${table}:${String(where[0]?.value)}`);
              }
              return affected;
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return new Proxy(database, {
        get(target, property, receiver) {
          if (property === "internal") return internal;
          // SQL of a snapshot-per-transaction isolation, not the memory adapter.
          if (property === "id") return "snapshot-view";
          // Like the MySQL adapters, its update returns no row from the statement.
          if (property === "capabilities") {
            const capabilities = target.capabilities;
            return { ...capabilities, operations: { ...capabilities.operations, returning: false } };
          }
          if (property === "findOne") {
            return (args: any) => read(`${args.model}:${String(args.where[0]?.value)}`, () => target.findOne(args));
          }
          if (property === "update") {
            // The MySQL adapters' update: an UPDATE (a miss is not an error),
            // then a re-select of the row from the transaction's snapshot.
            return async (args: any) => {
              await target.updateMany({ model: args.model, where: args.where, data: args.data, namespace: args.namespace } as any);
              return read(`${args.model}:${String(args.where[0]?.value)}`, () =>
                target.findOne({ model: args.model, where: args.where, namespace: args.namespace } as any));
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as Adapter;
    };
    const ledger = (id: string) => [{ field: "id", op: "eq", value: revisionRowId(NS, "task", id) }] as any;
    const record = (id: string) => ({ model: "task", where: [{ field: "id", operator: "eq", value: id }], namespace: NS }) as any;
    const served = await serve();
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "task", operation: "insert", id: "task:2", record: { title: "a" } });

    // A delete commits after this transaction's snapshot; its relation write
    // matches no row (its UPDATE is a current read), so it raises nothing.
    const stale = snapshotView(served.database);
    await stale.internal.findOne("__datafn_revisions", ledger("task:1"));
    await stale.findOne(record("task:1"));
    await served.push({ resource: "task", operation: "delete", id: "task:1" });
    const lost = withWriteEvidence(stale, true);
    // Its UPDATE matches nothing; the re-select returns the snapshot row, as
    // the MySQL adapters' update does.
    await lost.update({ ...record("task:1"), data: { projectId: null } });
    const relationEntry: any[] = [{ resource: "task", id: "task:1", op: "merge", record: { id: "task:1", projectId: null } }];
    await assignWriteRevisions(lost, NS, relationEntry, () => true, schema, true);
    expect(relationEntry[0].rev).toBeUndefined();
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });

    // A re-insert that loses the swap to a later tombstone still raises it live.
    const again = snapshotView(served.database);
    await again.internal.findOne("__datafn_revisions", ledger("task:1"));
    await bumpRevision(served.database, NS, "task", "task:1", true, false);
    const reinsertion = withWriteEvidence(again, true);
    await reinsertion.create({ model: "task", data: { id: "task:1", title: "again" }, namespace: NS } as any);
    // An inherited-inactive update of the same record comes last.
    const reinsert: any[] = [
      { resource: "task", id: "task:1", op: "insert", record: { id: "task:1", title: "again" } },
      { resource: "task", id: "task:1", op: "merge", record: { id: "task:1", isAncestorInactive: true } },
    ];
    await assignWriteRevisions(reinsertion, NS, reinsert, () => true, schema, true);
    expect(reinsert[1]).toMatchObject({ rev: 4, revUncertified: true });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 4, deleted: false });

    // A bump recovered after a swap miss records no snapshot row at its revision.
    const later = snapshotView(served.database);
    await later.internal.findOne("__datafn_revisions", ledger("task:2"));
    await bumpRevision(served.database, NS, "task", "task:2", false, false);
    const replacement = withWriteEvidence(later, true);
    await replacement.update({ ...record("task:2"), data: { title: "r" } });
    const entries: any[] = [{ resource: "task", id: "task:2", op: "replace", record: { id: "task:2", title: "r" } }];
    await assignWriteRevisions(replacement, NS, entries, () => true, schema, true);
    // Its own whole-row write is read back (stored fields included), uncertified.
    expect(entries[0]).toMatchObject({ rev: 3, revUncertified: true, record: { id: "task:2", title: "r" } });
  });

  it("keeps a versioned query's $rev only on rows the afterQuery hooks left unchanged", async () => {
    const hooks = {
      name: "rewrite",
      runsOn: ["server"],
      afterQuery: (_ctx: unknown, _query: unknown, result: Json) => !Array.isArray(result?.data) ? result : ({
        ...result,
        data: [
          ...result.data.map((row: Json) => {
            if (row.id !== "task:trim") return { ...row };
            const { title: _title, ...rest } = row;
            return rest;
          }),
          { id: "task:made-up", title: "x", $rev: 7 },
        ],
      }),
    };
    const served = await serve({ config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:keep", record: { title: "a" } });
    await served.push({ resource: "task", operation: "insert", id: "task:trim", record: { title: "a" } });
    const read = await served.send("query", { version: 1, resource: "task", withRevisions: true, sort: ["id"] });
    const byId = new Map(read.body.result.data.map((row: Json) => [row.id, row]));
    expect(byId.get("task:keep")).toMatchObject({ $rev: 1 });
    expect(byId.get("task:trim")).not.toHaveProperty("$rev");
    expect(byId.get("task:made-up")).not.toHaveProperty("$rev");
  });

  it("rechecks afterQuery output without modifying it, and only on versioned queries", async () => {
    // A hook row whose wire form (toJSON) leaves out its title.
    class Redacted {
      constructor(row: Json) { Object.assign(this, row); }
      toJSON() { return { id: (this as Json).id, $rev: (this as Json).$rev }; }
    }
    const hooks = {
      name: "frozen",
      runsOn: ["server"],
      afterQuery: (_ctx: unknown, query: Json, result: Json) => !Array.isArray(result?.data) ? result : Object.freeze({
        ...result,
        data: Object.freeze(result.data.map((row: Json) =>
          Object.freeze(query.withRevisions ? new Redacted(row) : { ...row, $rev: "app" }))),
      }),
    };
    const served = await serve({ config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    const versioned = await served.send("query", { version: 1, resource: "task", withRevisions: true });
    expect(versioned.status).toBe(200);
    expect(versioned.body.result.data[0]).toEqual({ id: "task:1" });
    const plain = await served.send("query", { version: 1, resource: "task" });
    expect(plain.body.result.data[0]).toMatchObject({ id: "task:1", $rev: "app" });
  });

  it("applies a hook result's own serializers before removing a revision", async () => {
    const hooks = {
      name: "serializers",
      runsOn: ["server"],
      afterQuery: (_ctx: unknown, _query: unknown, result: Json) => !Array.isArray(result?.data) ? result : {
        ...result,
        data: [
          { ...result.data[0], toJSON: () => null },
          { id: "task:made-up", $rev: 9 },
        ],
        toJSON() { return { data: this.data.map((row: Json) => row.toJSON ? row.toJSON() : { id: row.id, $rev: row.$rev }) }; },
      },
    };
    const served = await serve({ config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "secret" } });
    const read = await served.send("query", { version: 1, resource: "task", withRevisions: true });
    expect(read.status).toBe(200);
    expect(read.body.result).toEqual({ data: [null, { id: "task:made-up" }] });
  });

  it("bounds an encoded read-back body that router middleware reads by the deadline", async () => {
    let cancelled = 0;
    const served = await serve({ config: { routeHooks: {
      afterResponse: ({ action, response }: { action: string; response: Response }) => action !== "query" ? response
        : new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array([31, 139])); },
          cancel() { cancelled += 1; },
        }), { status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip" } }),
    } } });
    let middleware: "pending" | "settled" = "pending";
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      await response.arrayBuffer().catch(() => undefined);
      middleware = "settled";
      return response;
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(middleware).toBe("settled");
    expect(cancelled).toBe(1);
  });
});

/**
 * InnoDB REPEATABLE READ over the memory adapter: inside a transaction a
 * plain read (record or revision row) returns what the transaction first read,
 * until the transaction itself changes that row; UPDATE and DELETE read the
 * current rows. `race.run` runs once, just before the transaction's first
 * write of record `race.id`, after the transaction has read that record and
 * its revision row: another writer commits first (on the shared store). An UPDATE that matched no
 * row returns null (`race.miss` "null") or throws not found ("throw").
 */
type Race = { id: string; run?: (db: Adapter) => Promise<void>; miss: "null" | "throw"; adapterId?: string };

function snapshotReads(database: Adapter, race: Race): Adapter {
  const idOf = (where: any[] | undefined) => String((where ?? []).find((w: any) => w.field === "id")?.value);
  const view = (tx: Adapter): Adapter => {
    const seen = new Map<string, unknown>();
    const read = async (key: string, load: () => Promise<unknown>) => {
      if (!seen.has(key)) seen.set(key, await load());
      return seen.get(key) ?? null;
    };
    const internal = new Proxy(tx.internal, {
      get(target, property, receiver) {
        if (property === "findOne") {
          return (table: string, where: any[]) => read(`${table}:${idOf(where)}`, () => target.findOne(table, where));
        }
        if (property === "update") {
          return async (table: string, where: any[], data: Json) => {
            const affected = await target.update(table, where, data);
            if (affected > 0) seen.delete(`${table}:${idOf(where)}`);
            return affected;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const ledger = (model: string, id: string) => [{ field: "id", op: "eq", value: revisionRowId(NS, model, id) }] as any;
    const beforeWrite = async (model: string, id: string) => {
      if (!race.run || race.id !== id) return;
      await internal.findOne("__datafn_revisions", ledger(model, id));
      await read(`${model}:${id}`, () => tx.findOne({ model, where: [{ field: "id", operator: "eq", value: id }], namespace: NS } as any));
      const run = race.run;
      race.run = undefined;
      // Through the transaction's adapter: the memory adapter queues others.
      await run(tx);
    };
    return new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "internal") return internal;
        if (property === "id" && race.adapterId) return race.adapterId;
        if (property === "findOne") {
          return (args: any) => read(`${args.model}:${idOf(args.where)}`, () => target.findOne(args));
        }
        if (property === "findMany") {
          return async (args: any) => {
            const rows = await target.findMany(args);
            for (const row of rows as Json[]) if (!seen.has(`${args.model}:${row.id}`)) seen.set(`${args.model}:${row.id}`, row);
            return rows;
          };
        }
        if (property === "update") {
          return async (args: any) => {
            await beforeWrite(args.model, idOf(args.where));
            const affected = await target.updateMany(args);
            if (affected > 0) {
              seen.delete(`${args.model}:${idOf(args.where)}`);
              return target.findOne(args);
            }
            if (race.miss === "throw") throw new Error(`Record not found in ${args.model}`);
            return null;
          };
        }
        if (["updateMany", "delete", "deleteMany", "create"].includes(String(property))) {
          return async (args: any) => {
            const id = property === "create" ? String(args.data?.id) : idOf(args.where);
            await beforeWrite(args.model, id);
            const out = await (target as any)[property](args);
            // A statement that matched no row leaves the snapshot as it was.
            if (typeof out !== "number" || out > 0) seen.delete(`${args.model}:${id}`);
            return out;
          };
        }
        if (property === "transaction") {
          return (fn: (inner: Adapter) => Promise<unknown>) => target.transaction((inner) => fn(view(inner as Adapter)));
        }
        return Reflect.get(target, property, receiver);
      },
    });
  };
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(view(tx as Adapter)));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

describe("DATA-41 revisions: PR review round 5", () => {
  it.each(["push", "mutation"])("raises nothing for a %s setNull child whose stale snapshot row a concurrent delete removed", async (route) => {
    const database = memoryAdapter();
    const race: Race = { id: "task:1", miss: "null", adapterId: "innodb-view" };
    const served = await serve({ database: snapshotReads(database, race) });
    await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    // The task is deleted (tombstone 2) after this write read it as a child.
    race.run = async (db) => {
      await db.delete({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any);
      await bumpRevision(db, NS, "task", "task:1", true, false);
    };
    const res = route === "push"
      ? (await served.push({ resource: "project", operation: "delete", id: "project:1" })).body.result
      : (await served.send("mutation", { resource: "project", version: 1, operation: "delete", id: "project:1", clientId: "c", mutationId: "d5" })).body.result;
    expect(race.run).toBeUndefined();
    expect(JSON.stringify(res)).toContain('"ok":true');
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    expect(await served.rev("project", "project:1")).toEqual({ rev: 2, deleted: true });
  });

  it("raises a live revision over a tombstone for a push merge that recreated the record", async () => {
    const database = memoryAdapter();
    const race: Race = { id: "task:1", miss: "throw" };
    const served = await serve({ database: snapshotReads(database, race) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    race.run = async (db) => {
      await db.delete({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any);
      await bumpRevision(db, NS, "task", "task:1", true, false);
    };
    // Its UPDATE matches nothing, so the merge creates the record.
    const res = await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    expect(race.run).toBeUndefined();
    expect(res.body.result.revisions[res.mutationId]).toMatchObject({ rev: 3 });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 3, deleted: false });
    expect(await database.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: NS } as any))
      .toMatchObject({ title: "b" });
  });

  it("aborts a non-2xx read-back that middleware keeps a clone of", async () => {
    const served = await serve({ config: { routeHooks: {
      afterResponse: ({ action, response }: { action: string; response: Response }) => action !== "query" ? response
        : new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }),
          { status: 503, headers: { "content-type": "text/plain" } }),
    } } });
    let signal: AbortSignal | undefined;
    let kept: Response | undefined;
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!new URL(request.url).pathname.endsWith("/query")) return response;
      signal = request.signal;
      kept = response.clone();
      return response;
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    expect(res.body.result.ok).toBe(true);
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    expect(kept).toBeDefined();
    expect(signal?.aborted).toBe(true);
    // The body the middleware kept is errored, not served after the push.
    await expect(kept!.text()).rejects.toThrow();
  });

  it("gives router middleware the read-back Response before its body is read", async () => {
    const served = await serve({ config: { routeHooks: {
      afterResponse: ({ action, response }: { action: string; response: Response }) => action !== "query" ? response
        : new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }),
          { status: 200, headers: { "content-type": "application/json" } }),
    } } });
    // Ordering, not wall-clock time: next() returns the read-back Response
    // before anything reads its (never-ending) body, and before push returns.
    const events: string[] = [];
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (new URL(request.url).pathname.endsWith("/query")) events.push(response.bodyUsed ? "next:read" : "next:unread");
      return response;
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    events.push("push");
    expect(events).toEqual(["next:unread", "push"]);
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
  }, 10_000);

  it("checks a versioned query's $rev on the wire form the response sends", async () => {
    let mode: "keyed" | "unshaped" | "identity" = "keyed";
    const hooks = {
      name: "serializers",
      runsOn: ["server"],
      afterQuery: (_ctx: unknown, _query: unknown, result: Json) => {
        if (!Array.isArray(result?.data) || mode === "identity") return result;
        if (mode === "unshaped") {
          // No raw rows: its rows (with a forged $rev) appear only on serialization.
          return { toJSON: () => ({ data: [{ id: "task:1", title: "forged", $rev: 99 }] }) };
        }
        return {
          ...result,
          toJSON(key: string) {
            return key === "result" ? { data: this.data.map((row: Json) => ({ id: row.id, $rev: row.$rev })) } : { data: this.data };
          },
        };
      },
    };
    const served = await serve({ config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "secret" } });
    const query = async () => (await served.send("query", { version: 1, resource: "task", withRevisions: true })).body.result.data;
    expect(await query()).toEqual([{ id: "task:1" }]);
    mode = "unshaped";
    expect(await query()).toEqual([{ id: "task:1", title: "forged" }]);
    mode = "identity";
    expect((await query())[0]).toMatchObject({ id: "task:1", title: "secret", $rev: 1 });
  });

  /** SQL of unknown isolation whose UPDATE counts report changed rows (MySQL without found rows). */
  function changedRowCounts(database: Adapter): Adapter {
    const wrap = (db: Adapter): Adapter => new Proxy(db, {
      get(target, property, receiver) {
        if (property === "id") return "changed-rows";
        if (property === "updateMany") {
          return async (args: any) => {
            const rows = (await target.findMany({ model: args.model, where: args.where, namespace: args.namespace } as any)) as Json[];
            const changed = rows.filter((row) =>
              Object.entries(args.data).some(([key, value]) => JSON.stringify(row[key] ?? null) !== JSON.stringify(value ?? null))).length;
            await target.updateMany(args);
            return changed;
          };
        }
        if (property === "transaction") {
          return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(wrap(tx as Adapter)));
        }
        return Reflect.get(target, property, receiver);
      },
    });
    return wrap(database);
  }

  it("merges a KV record whose row lock changes no value where counts are changed rows", async () => {
    const served = await serve({ database: changedRowCounts(memoryAdapter()) });
    await served.push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { a: 1 } } });
    const merged = await served.push({ resource: "kv", operation: "merge", id: "kv:prefs", record: { value: { b: 2 } } });
    expect(merged.body.result.ok, JSON.stringify(merged.body)).toBe(true);
    expect(await served.rev("kv", "kv:prefs")).toEqual({ rev: 2, deleted: false });
    const stored = await served.database.findOne({ model: "kv", where: [{ field: "id", operator: "eq", value: "kv:prefs" }], namespace: NS } as any);
    expect(stored?.value).toEqual({ a: 1, b: 2 });
  });

  it("raises every batched relation target where counts are changed rows and reads may be a snapshot", async () => {
    const batchSchema = {
      resources: [
        { name: "project", version: 1, fields: [{ name: "name", type: "string" as const, required: false }] },
        { name: "task", version: 1, fields: [{ name: "title", type: "string" as const, required: false }, { name: "projectId", type: "string" as const, required: false }] },
      ],
      relations: [{ from: "project", to: "task", type: "one-many", relation: "tasks", fkField: "projectId" }],
    } as any;
    const served = await serve({ schema: batchSchema, database: changedRowCounts(memoryAdapter()) });
    await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    await served.push({ resource: "task", operation: "insert", id: "task:2", record: { title: "b" } });
    const res = await served.push({ resource: "project", operation: "relate", id: "project:1", relations: { tasks: ["task:1", "task:2"] } });
    expect(res.body.result.ok, JSON.stringify(res.body)).toBe(true);
    // task:1 already pointed at the project (its state is unchanged); task:2
    // changed. DATA-41's merged write evidence: a partial count of changed rows
    // cannot name the rows written, and where reads may be a snapshot no read
    // can either, so both ids are unverified and both are raised (an
    // over-count skips a revision value, never reuses one).
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: false });
    expect(await served.rev("task", "task:2")).toEqual({ rev: 2, deleted: false });
  });

  it("raises nothing for a setNull child whose update an adapter without strict not-found reports as undefined", async () => {
    const raced = new Set<string>();
    const inner = deletedBeforeUpdate(memoryAdapter(), raced);
    const lenient = (db: Adapter): Adapter => new Proxy(db, {
      get(target, property, receiver) {
        if (property === "capabilities") {
          const capabilities = Reflect.get(target, property, receiver) as Json;
          return { ...capabilities, operations: { ...capabilities.operations, strictUpdateNotFound: false } };
        }
        if (property === "update") {
          return async (args: any) => (await (target as any).update(args)) ?? undefined;
        }
        if (property === "transaction") {
          return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(lenient(tx as Adapter)));
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const served = await serve({ database: lenient(inner) });
    await served.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "p" } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a", projectId: "project:1" } });
    raced.add("task:1");
    const res = await served.push({ resource: "project", operation: "delete", id: "project:1" });
    expect(res.body.result.ok, JSON.stringify(res.body)).toBe(true);
    expect(raced.size).toBe(0);
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
  });

  it("keeps a plain query's declared $rev and nested data when the afterQuery hooks shorten a mixed batch", async () => {
    const hooks = {
      name: "shorten",
      runsOn: ["server"],
      afterQuery: (_ctx: unknown, _query: unknown, result: unknown) => (!Array.isArray(result) ? result
        : result.slice(1).map((entry: Json) => ({
          ...entry,
          data: entry.data.map((row: Json) => (row.id === "legacy:2" ? { ...row, meta: { $rev: "nested" } } : row)),
        }))),
    };
    const served = await serve({ config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "legacy", operation: "insert", id: "legacy:1", record: { $rev: "99" } });
    await served.push({ resource: "legacy", operation: "insert", id: "legacy:2", record: {} });
    const res = await served.send("query", [
      { version: 1, resource: "task", withRevisions: true },
      { version: 1, resource: "legacy", sort: ["id"] },
    ]);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    // DATA-95: the legacy rows now sit where the versioned task rows were. Their
    // `$rev` is the plain query's declared field, never a server revision, so
    // it is kept.
    expect(res.body.result).toHaveLength(1);
    expect(res.body.result[0].data).toEqual([{ id: "legacy:1", $rev: "99" }, { id: "legacy:2", meta: { $rev: "nested" } }]);
  });

  it("tombstones a delete and continues on re-insert where counts are changed rows", async () => {
    const served = await serve({ database: changedRowCounts(memoryAdapter()) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 2, deleted: true });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "b" } });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 3, deleted: false });
  });

  it("runs each record write as the adapter's own single statement, with no extra UPDATE", async () => {
    const calls: string[] = [];
    const counting = (db: Adapter): Adapter => new Proxy(db, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "transaction") {
          return (fn: (tx: Adapter) => Promise<unknown>) => target.transaction((tx) => fn(counting(tx as Adapter)));
        }
        if (["update", "updateMany", "delete", "deleteMany"].includes(String(property))) {
          return (args: any) => {
            if (args?.model === "task") calls.push(String(property));
            return (value as (a: unknown) => unknown).call(target, args);
          };
        }
        return value;
      },
    });
    const served = await serve({ database: counting(changedRowCounts(memoryAdapter())) });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    calls.length = 0;
    await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    // DATA-41's merged write evidence calls the adapter's own method with its
    // own arguments, once.
    expect(calls).toEqual(["update"]);
    calls.length = 0;
    await served.push({ resource: "task", operation: "delete", id: "task:1" });
    expect(calls).toEqual(["delete"]);
    expect(await served.rev("task", "task:1")).toEqual({ rev: 3, deleted: true });
  });
});

describe("DATA-95: a versioned query's $rev after the afterQuery hooks", () => {
  type Rewrite = (result: unknown) => unknown;
  async function mixedBatch(rewrite: Rewrite) {
    const hooks = { name: "batch", runsOn: ["server"], afterQuery: (_ctx: unknown, _query: unknown, result: unknown) => rewrite(result) };
    const served = await serve({ config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "legacy", operation: "insert", id: "legacy:1", record: { $rev: "99" } });
    const res = await served.send("query", [
      { version: 1, resource: "task", withRevisions: true },
      { version: 1, resource: "legacy" },
    ]);
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    return res.body.result as Json[];
  }
  const trimTitle = (entry: Json) => ({ ...entry, data: entry.data.map(({ title: _title, ...row }: Json) => row) });

  it("sends no server $rev on a trimmed row that a same-length reorder moved to another slot", async () => {
    const result = await mixedBatch((batch) => (Array.isArray(batch) ? [batch[1], trimTitle(batch[0])] : batch));
    expect(result).toHaveLength(2);
    expect(result[0].data).toEqual([{ id: "legacy:1", $rev: "99" }]);
    expect(result[1].data).toEqual([{ id: "task:1" }]);
  });

  it("sends no server $rev on an unchanged row moved to a slot of another resource", async () => {
    const result = await mixedBatch((batch) => (Array.isArray(batch) ? [batch[1], batch[0]] : batch));
    expect(result[0].data).toEqual([{ id: "legacy:1", $rev: "99" }]);
    expect(result[1].data[0]).toMatchObject({ id: "task:1", title: "a" });
    expect(result[1].data[0]).not.toHaveProperty("$rev");
  });

  it("keeps a plain query's declared $rev that a hook changed in a shortened batch", async () => {
    const result = await mixedBatch((batch) => (Array.isArray(batch)
      ? [{ ...batch[1], data: batch[1].data.map((row: Json) => ({ ...row, note: "x" })) }]
      : batch));
    expect(result).toEqual([expect.objectContaining({ data: [{ id: "legacy:1", $rev: "99", note: "x" }] })]);
  });

  it("keeps $rev on an unchanged mixed batch and under an identity hook", async () => {
    for (const rewrite of [(batch: unknown) => batch, (batch: unknown) => (Array.isArray(batch) ? batch.map((entry) => ({ ...entry })) : batch)]) {
      const result = await mixedBatch(rewrite);
      expect(result[0].data).toEqual([expect.objectContaining({ id: "task:1", title: "a", $rev: 1 })]);
      expect(result[1].data).toEqual([{ id: "legacy:1", $rev: "99" }]);
    }
  });
});

describe("DATA-95: a $rev is tied to the query it came from (local review round 1)", () => {
  // `ledger` issues no revisions: its `$rev` is a declared number, so its
  // `[id, $rev]` pairs can equal the ones the server issues for `task`.
  const ledgerSchema = {
    ...schema,
    resources: [
      ...schema.resources,
      {
        name: "ledger",
        version: 1,
        fields: [{ name: "$rev", type: "number" as const, required: false }, { name: "note", type: "string" as const, required: false }],
      },
    ],
  };
  type Rewrite = (batch: Json[]) => Json[];
  const editRows = (entry: Json, edit: (row: Json) => Json) => ({ ...entry, data: entry.data.map(edit) });
  async function batch(queries: Json[], rewrite: Rewrite) {
    const hooks = {
      name: "batch",
      runsOn: ["server"],
      afterQuery: (_ctx: unknown, _query: unknown, result: unknown) => (Array.isArray(result) ? rewrite(result) : result),
    };
    const served = await serve({ schema: ledgerSchema, config: { plugins: [hooks] } });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    await served.push({ resource: "ledger", operation: "insert", id: "task:1", record: { $rev: 1 } });
    expect(await served.rev("task", "task:1")).toEqual({ rev: 1, deleted: false });
    const res = await served.send("query", queries.map((query) => ({ version: 1, ...query })));
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    return res.body.result as Json[];
  }
  const mixed = [{ resource: "task", withRevisions: true }, { resource: "ledger" }];

  it("keeps a declared $rev that a hook edited when its [id, $rev] equals a server revision", async () => {
    const result = await batch(mixed, ([task, ledger]) => [task, editRows(ledger, (row) => ({ ...row, note: "x" }))]);
    expect(result[0].data).toEqual([expect.objectContaining({ id: "task:1", title: "a", $rev: 1 })]);
    expect(result[1].data).toEqual([{ id: "task:1", $rev: 1, note: "x" }]);
  });

  it("removes the server $rev of an edited certified row whose [id, $rev] equals a declared one", async () => {
    const result = await batch(mixed, ([task, ledger]) => [editRows(task, (row) => ({ ...row, title: "edited" })), ledger]);
    expect(result[0].data).toEqual([expect.objectContaining({ id: "task:1", title: "edited" })]);
    expect(result[0].data[0]).not.toHaveProperty("$rev");
    expect(result[1].data).toEqual([{ id: "task:1", $rev: 1 }]);
  });

  it("removes the $rev of a certified row whose id or $rev a hook rewrote, beside a resource that issues none", async () => {
    for (const edit of [(row: Json) => ({ ...row, id: "task:2" }), (row: Json) => ({ ...row, $rev: 7 })]) {
      const result = await batch(mixed, ([task, ledger]) => [editRows(task, edit), ledger]);
      expect(result[0].data).toHaveLength(1);
      expect(result[0].data[0]).not.toHaveProperty("$rev");
      expect(result[1].data).toEqual([{ id: "task:1", $rev: 1 }]);
    }
  });

  it("removes the $rev of an unchanged certified row moved into a plain query of the same resource", async () => {
    const result = await batch([{ resource: "task", withRevisions: true }, { resource: "task" }], ([versioned, plain]) => [plain, versioned]);
    for (const entry of result) {
      expect(entry.data).toEqual([expect.objectContaining({ id: "task:1", title: "a" })]);
      expect(entry.data[0]).not.toHaveProperty("$rev");
    }
  });

  it("removes the $rev of a certified row moved into a relation query that reaches its resource", async () => {
    const queries = [{ resource: "task", withRevisions: true }, { resource: "comment", id: "comment:1", relation: "task" }];
    const result = await batch(queries, ([versioned, related]) => [versioned, { ...related, data: versioned.data }]);
    expect(result[0].data).toEqual([expect.objectContaining({ id: "task:1", $rev: 1 })]);
    expect(result[1].data).toEqual([expect.objectContaining({ id: "task:1", title: "a" })]);
    expect(result[1].data[0]).not.toHaveProperty("$rev");
  });

  it("keeps the $rev of an unchanged certified row moved to another versioned query of its resource", async () => {
    const queries = [{ resource: "task", withRevisions: true }, { resource: "task", withRevisions: true, filters: { title: "none" } }];
    const result = await batch(queries, ([first, second]) => [second, first]);
    expect(result[0].data).toEqual([]);
    expect(result[1].data).toEqual([expect.objectContaining({ id: "task:1", title: "a", $rev: 1 })]);
  });
});

describe("DATA-95: a certified versioned row is the stored row (local review round 1)", () => {
  it("returns the row clone returns, unprojected, while a plain query projects it", async () => {
    const served = await serve();
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    // A stored column the schema does not declare, and an explicit null.
    await served.database.update({
      model: "task",
      where: [{ field: "id", operator: "eq", value: "task:1" }],
      data: { undeclared: "stored", projectId: null },
      namespace: NS,
    } as any);
    const versioned = (await served.send("query", { version: 1, resource: "task", withRevisions: true })).body.result.data;
    const clone = (await served.send("clone", { clientId: "client:b", tables: ["task"] })).body.result.data.task;
    const plain = (await served.send("query", { version: 1, resource: "task" })).body.result.data;
    // DATA-41's design: a certified row is exactly the clone row (what push
    // compares its post-write row against), not the plain query's projection.
    expect(versioned).toEqual(clone);
    expect(versioned[0]).toMatchObject({ id: "task:1", title: "a", undeclared: "stored", projectId: null, $rev: 1 });
    expect(plain[0]).not.toHaveProperty("$rev");
    expect(plain[0]).not.toHaveProperty("undeclared");
  });
});

describe("DATA-95: push read-back and the capability splice", () => {
  const isQuery = (request: Request) => new URL(request.url).pathname.endsWith("/query");
  const queryRoute = (served: { server: { router: { handle(request: Request): Promise<Response> } } }, body: string) =>
    served.server.router.handle(new Request("http://localhost/datafn/query", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }));

  it("does not wait past the deadline for middleware draining a finite read-back, and errors its later reads", async () => {
    const served = await serve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let state: "idle" | "draining" | "errored" | "done" = "idle";
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (!isQuery(request)) return response;
      // Drains a clone, one chunk at a time, waiting on the test between chunks.
      const reader = response.clone().body!.getReader();
      state = "draining";
      try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) await gate;
        state = "done";
      } catch {
        state = "errored";
      }
      return response;
    });
    const big = "x".repeat(64 * 1024);
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: big } });
    // The push returned while the middleware was still draining: it did not wait.
    expect(state).toBe("draining");
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    release();
    await vi.waitFor(() => expect(state).not.toBe("draining"));
    // Its later reads were cancelled with the read-back.
    expect(state).toBe("errored");
  }, 10_000);

  it("cancels a passed-through read-back's upstream when the push settles, while middleware keeps an unread clone", async () => {
    const events: string[] = [];
    let kept: Response | undefined;
    const served = await serve({ config: { routeHooks: {
      afterResponse: async ({ action, response }: { action: string; response: Response }) => {
        if (action !== "query") return response;
        await response.body?.cancel();
        // A non-2xx, non-JSON answer whose body always has more to send.
        const upstream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("unavailable"));
          },
          cancel() {
            events.push("upstream:cancel");
          },
        });
        return new Response(upstream, { status: 503, headers: { "content-type": "text/plain" } });
      },
    } } });
    served.server.router.use(async (request, _ctx, next) => {
      const response = await next();
      if (isQuery(request)) {
        kept = response.clone();
        events.push("clone:kept");
        // Lets the body's upstream start flowing before the read-back reads it.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return response;
    });
    const res = await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    events.push("push");
    expect(res.body.result.revisions[res.mutationId]).toEqual({ resource: "task", id: "task:1", rev: 1 });
    // The upstream was cancelled when the read-back settled, before the push
    // returned, although no one read the clone.
    expect(events).toEqual(["clone:kept", "upstream:cancel", "push"]);
    expect(kept?.bodyUsed).toBe(false);
    await expect(kept!.text()).rejects.toThrow();
  });

  it("gives router middleware byte-identical envelopes for an external /query and the read-back", async () => {
    const served = await serve();
    const seen: Array<{ request: string; response: Uint8Array }> = [];
    served.server.router.use(async (request, _ctx, next) => {
      const sent = isQuery(request) ? await request.clone().text() : "";
      const response = await next();
      if (!isQuery(request)) return response;
      seen.push({ request: sent, response: new Uint8Array(await response.clone().arrayBuffer()) });
      return response;
    });
    await served.push({ resource: "task", operation: "insert", id: "task:1", record: { title: "a" } });
    const res = await served.push({ resource: "task", operation: "merge", id: "task:1", record: { title: "b" } });
    expect(res.body.result.revisions[res.mutationId].record).toMatchObject({ id: "task:1", title: "b", $rev: 2 });
    const readBack = seen.at(-1)!;
    // The same query, sent by an external caller.
    await (await queryRoute(served, readBack.request)).arrayBuffer();
    const external = seen.at(-1)!;
    expect(external).not.toBe(readBack);
    expect(external.response).toEqual(readBack.response);
    expect(JSON.parse(new TextDecoder().decode(external.response)).capabilities).toEqual({ revisions: true });
  });

  it("drops a hook response's digest headers when it splices its body, and keeps them on a body it passes through", async () => {
    let mode: "plain" | "gzip" = "plain";
    const digests = { "content-digest": "sha-256=:test-digest:", "repr-digest": "sha-256=:test-digest:", digest: "SHA-256=test-digest" };
    let gzipped: Uint8Array | undefined;
    const served = await serve({ config: { routeHooks: {
      afterResponse: async ({ action, response }: { action: string; response: Response }) => {
        if (action !== "query") return response;
        const text = await response.text();
        if (mode === "plain") return new Response(text, { status: 200, headers: { "content-type": "application/json", ...digests } });
        gzipped = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
        return new Response(gzipped, { status: 200, headers: { "content-type": "application/json", "content-encoding": "gzip", ...digests } });
      },
    } } });
    const body = JSON.stringify({ version: 1, resource: "task" });
    const spliced = await queryRoute(served, body);
    expect(JSON.parse(await spliced.text()).capabilities).toEqual({ revisions: true });
    for (const name of Object.keys(digests)) expect(spliced.headers.has(name)).toBe(false);

    mode = "gzip";
    const passed = await queryRoute(served, body);
    expect(new Uint8Array(await passed.arrayBuffer())).toEqual(gzipped);
    for (const [name, value] of Object.entries(digests)) expect(passed.headers.get(name)).toBe(value);
  });

  it("keeps exactly one revisions capability and passes a declared non-UTF-8 charset through", async () => {
    let mode: "duplicate" | "utf16" = "duplicate";
    let utf16: Uint8Array | undefined;
    const served = await serve({ config: { routeHooks: {
      afterResponse: async ({ action, response }: { action: string; response: Response }) => {
        if (action !== "query") return response;
        const text = await response.text();
        if (mode === "duplicate") {
          return new Response(text.replace(/^\{/, '{"capabilities":{"revisions":false,"custom":1},'), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        // ASCII JSON as UTF-16LE without a byte order mark.
        utf16 = new Uint8Array([...text].flatMap((c) => [c.charCodeAt(0), 0]));
        return new Response(utf16, { status: 200, headers: { "content-type": "application/json; charset=utf-16le" } });
      },
    } } });
    const body = JSON.stringify({ version: 1, resource: "task" });
    const merged = await (await queryRoute(served, body)).text();
    expect(merged.match(/"revisions"/g)).toHaveLength(1);
    expect(JSON.parse(merged).capabilities).toEqual({ custom: 1, revisions: true });

    mode = "utf16";
    expect(new Uint8Array(await (await queryRoute(served, body)).arrayBuffer())).toEqual(utf16);
  });
});

describe("DATA-95: public-link envelopes announce the revision capability", () => {
  const linkSchema = {
    resources: [{
      name: "linkTag",
      version: 1,
      idPrefix: "tag",
      capabilities: ["timestamps", "audit", { shareable: { levels: ["viewer", "editor", "owner"], default: "private", supportsScopeGrants: true } }],
      fields: [{ name: "id", type: "string", required: true }, { name: "label", type: "string", required: false }],
    }],
    relations: [],
  } as any;

  async function linkRoutes(enabled: boolean) {
    const server = await createDatafnServer({
      schema: linkSchema,
      database: memoryAdapter(),
      allowUnknownResources: true,
      publicLinks: createDatafnPublicLinksPlugin<{ actorId: string }>({
        authenticateOwner: (request) => {
          const actorId = request.headers.get("x-owner-actor");
          return actorId ? { actorId } : null;
        },
        getOwnerActorId: (session) => session.actorId,
        getOwnerNamespace: (actorId) => `user:${actorId}`,
        directory: createMemoryIndexedDirectoryStore(),
        resourceRegion: "region:public-links",
      }),
      ...(enabled ? { revisions: { enabled: true } } : {}),
    } as any);
    const post = async (path: string, body: unknown, owner?: string) => {
      const res = await server.router.handle(new Request(`http://localhost/datafn/public-links${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(owner ? { "x-owner-actor": owner } : {}) },
        body: JSON.stringify(body),
      }), {});
      return { status: res.status, body: (await res.json()) as Json };
    };
    const created = await post("", { resource: "linkTag", scope: "resource", level: "viewer" }, "owner");
    const resolved = await post("/resolve", { token: created.body.result?.token });
    const rejected = await post("/resolve", { token: "not-a-link-token" });
    await server.close();
    return { created, resolved, rejected };
  }

  it("carries capabilities.revisions on create, resolve and error envelopes only with revisions on", async () => {
    const on = await linkRoutes(true);
    expect(on.created.status, JSON.stringify(on.created.body)).toBe(200);
    expect(on.resolved.status, JSON.stringify(on.resolved.body)).toBe(200);
    expect(on.rejected.status).toBeGreaterThanOrEqual(400);
    for (const { body } of [on.created, on.resolved, on.rejected]) expect(body.capabilities).toEqual({ revisions: true });

    const off = await linkRoutes(false);
    expect(off.created.status).toBe(200);
    for (const { body } of [off.created, off.resolved, off.rejected]) expect(body).not.toHaveProperty("capabilities");
  });
});

describe("DATA-95: canonical pull tombstone revisions", () => {
  it("gives a NUL-containing id and its neighbouring id each its own tombstone revision", async () => {
    const nulSchema = {
      resources: [{ name: "note", version: 1, fields: [{ name: "title", type: "string" as const, required: false }] }],
      relations: [],
    } as any;
    configureRevisions(nulSchema, { enabled: true });
    const database = memoryAdapter();
    const tracking = new ChangeTrackingService(database, NS);
    tracking.useRevisionsOf(nulSchema);
    await tracking.ensureReady();
    await tracking.ensureRevisionsReady();
    // Each change is recorded in the transaction that writes it (as push does).
    const record = (entries: any[], write?: (db: Adapter) => Promise<unknown>) =>
      database.transaction(async (tx) => {
        const writes = withWriteEvidence(tx as Adapter, true);
        await write?.(writes);
        await tracking.withDb(writes, true, true).recordChanges(entries);
      });
    const byId = (id: string) => [{ field: "id", operator: "eq", value: id }];
    const neighbour = "note:x";
    const nul = "note:x\u0000note:y";
    let seq = 0;
    for (const id of [neighbour, nul]) {
      await record([{ serverSeq: ++seq, resource: "note", id, op: "insert", record: { id, title: "a" } }],
        (db) => db.create({ model: "note", data: { id, title: "a" }, namespace: NS } as any));
      await record([{ serverSeq: ++seq, resource: "note", id, op: "delete", record: null }],
        (db) => db.delete({ model: "note", where: byId(id), namespace: NS } as any));
    }
    // A second delete of the NUL id that changed no row records no revision.
    await record([{ serverSeq: ++seq, resource: "note", id: nul, op: "delete", record: null }]);
    const pull = (await executePull({ clientId: "client:b", cursors: { note: "0" } } as any, nulSchema, database, NS)) as Json;
    expect(pull.ok).toBe(true);
    expect(pull.deleted.note).toEqual(expect.arrayContaining([neighbour, nul]));
    // The neighbour keeps its tombstone revision; the NUL id, with a delete
    // that recorded none, gets none.
    expect(pull.deletedRevisions).toEqual({ note: { [neighbour]: 2 } });
  });
});
