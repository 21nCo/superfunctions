/**
 * DATA-41: server-managed per-record revisions.
 */

import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { readRevisions } from "../src/execution/revisions.js";
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
  ],
} as any;

async function serve(options: { enabled?: boolean; database?: Adapter } = {}) {
  const database = options.database ?? memoryAdapter();
  const server = await createDatafnServer({
    schema,
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
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
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
    expect(pull.body.result.merged.task).toEqual([expect.objectContaining({ id: "task:1", $rev: 2 })]);
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
