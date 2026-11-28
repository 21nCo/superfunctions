/**
 * DATA-41: revision storage on PostgreSQL (Kysely over PGlite, the real
 * Postgres engine in-process). PGlite has one session, so this covers the
 * PostgreSQL statements (ON CONFLICT creation, the `rev` column migration,
 * REPEATABLE READ snapshots) but not truly overlapping transactions, which
 * need a Postgres server.
 */
import { PGlite } from "@electric-sql/pglite";
import { Kysely, PostgresDialect, type PostgresPool, type PostgresPoolClient, type PostgresQueryResult } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bumpRevision, configureRevisions, ensureRevisionsTable, readRevisions, readWithRevisions, withWriteEvidence } from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { executeTransaction } from "../src/execution/transact.js";
import {
  inspectPostgresNamespaceStorage,
  quotePostgresIdentifier,
  resolveNamespaceStoragePlan,
  selectNamespaceStorageEntries,
} from "../src/namespace-storage.js";

// A schema whose `task` resource issues revisions (change rows record rev only then).
const revisionSchema = { resources: [{ name: "task", version: 1, fields: [{ name: "title", type: "string" }] }], relations: [] } as any;
configureRevisions(revisionSchema, { enabled: true });

function pgliteAsPool(pg: PGlite): PostgresPool {
  const client = {
    async query<R>(sqlText: string, parameters: readonly unknown[]) {
      const result = await pg.query<R>(sqlText, [...parameters]);
      const command = (/^\s*(\w+)/.exec(sqlText)?.[1] ?? "").toUpperCase();
      return {
        command: command as PostgresQueryResult<R>["command"],
        rowCount: result.affectedRows ?? result.rows.length,
        rows: result.rows,
      };
    },
    release() {},
  } as unknown as PostgresPoolClient;
  return {
    async connect() {
      return client;
    },
    async end() {
      await pg.close();
    },
  };
}

let pg: PGlite;
let kysely: Kysely<any>;
let adapter: Adapter;

// PGlite starts a Postgres engine per test; give it time under parallel load.
const PG_TIMEOUT_MS = 60_000;

beforeEach(() => {
  pg = new PGlite();
  kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool: pgliteAsPool(pg) }) });
  adapter = kyselyAdapter({ db: kysely, dialect: "postgres", schema: {} }) as Adapter;
});

afterEach(async () => {
  await kysely.destroy();
}, PG_TIMEOUT_MS);

describe("DATA-41 revisions on PostgreSQL", { timeout: PG_TIMEOUT_MS }, () => {
  it("creates, bumps and tombstones a revision inside transactions", async () => {
    await ensureRevisionsTable(adapter);
    const first = await adapter.transaction(async (tx) => bumpRevision(tx as any, "ns", "task", "task:1", false, true));
    const second = await adapter.transaction(async (tx) => bumpRevision(tx as any, "ns", "task", "task:1", true, true));
    expect([first, second]).toEqual([1, 2]);
    expect((await readRevisions(adapter, "ns", "task", ["task:1"])).get("task:1")).toEqual({ rev: 2, deleted: true });
    // A rolled-back write leaves the revision as it was.
    await expect(adapter.transaction(async (tx) => {
      await bumpRevision(tx as any, "ns", "task", "task:1", false, true);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await readRevisions(adapter, "ns", "task", ["task:1"])).get("task:1")?.rev).toBe(2);
  });

  it("adds the rev column to a change table created before it and records rev on change rows", async () => {
    await adapter.rawSql!.execute(
      'CREATE TABLE "__datafn_changes" (id text primary key, namespace text, server_seq integer, resource text, record_id text, op text, record text, created_at text)',
    );
    // The recorded merge changed a present row (a write that changed no row
    // raises no revision).
    await adapter.rawSql!.execute(`CREATE TABLE "task" (id text primary key, title text)`);
    await adapter.rawSql!.execute(`INSERT INTO "task" (id, title) VALUES ('task:1', 'a')`);
    const db = kyselyAdapter({ db: kysely, dialect: "postgres", schema: { task: "task" } }) as Adapter;
    const service = new ChangeTrackingService(db, "ns");
    service.useRevisionsOf(revisionSchema);
    await service.ensureReady();
    await service.ensureRevisionsReady();
    await db.transaction(async (tx) => {
      const write = withWriteEvidence(tx as any, true);
      await write.update({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], data: { title: "b" } } as any);
      await service.withDb(write, false).recordChanges([
        { serverSeq: 1, resource: "task", id: "task:1", op: "merge", record: { id: "task:1" } },
      ]);
    });
    const changes = await service.getChangesSince({ resource: "task", sinceSeq: 0, limit: 10 });
    expect(changes[0].rev).toBe(1);
  });

  it("reads rows and revisions in one REPEATABLE READ transaction", async () => {
    await ensureRevisionsTable(adapter);
    await bumpRevision(adapter, "ns", "task", "task:1", false, false);
    let level: unknown;
    const rows = await readWithRevisions(
      adapter,
      "ns",
      "task",
      async (snapshotDb) => {
        level = (await snapshotDb.rawSql!.query("SHOW transaction_isolation"))[0].transaction_isolation;
        return [{ id: "task:1" }, { id: "task:legacy" }] as Array<Record<string, unknown>>;
      },
      (result) => result,
    );
    const isolation = { level, rows };
    expect(isolation.level).toBe("repeatable read");
    // A record no revision-aware write touched has revision 0.
    expect(isolation.rows).toEqual([{ id: "task:1", $rev: 1 }, { id: "task:legacy", $rev: 0 }]);
  });

  it("keeps every revision row and tombstone through a plan-driven namespace backup and copy", async () => {
    await ensureRevisionsTable(adapter);
    await bumpRevision(adapter, "ns", "task", "task:live", false, false);
    await bumpRevision(adapter, "ns", "task", "task:live", false, false);
    await bumpRevision(adapter, "ns", "task", "task:gone", false, false);
    await bumpRevision(adapter, "ns", "task", "task:gone", true, false);
    await bumpRevision(adapter, "other", "task", "task:live", false, false);

    const query = async (sql: string) => adapter.rawSql!.query(sql) as Promise<any[]>;
    const plan = resolveNamespaceStoragePlan({
      schema: { resources: [] } as any,
      catalog: await inspectPostgresNamespaceStorage(query),
    });
    const backup = selectNamespaceStorageEntries(plan, "backup").find((entry) => entry.relation === "__datafn_revisions");
    const copy = selectNamespaceStorageEntries(plan, "copy").find((entry) => entry.relation === "__datafn_revisions");
    expect(copy).toEqual(backup);
    // Back the namespace up as the plan describes and restore it elsewhere.
    const rows = await adapter.rawSql!.query(
      `SELECT * FROM ${quotePostgresIdentifier(backup!.relation)} WHERE ${quotePostgresIdentifier(backup!.namespaceColumn!)} = ?`,
      ["ns"],
    );
    const target = new PGlite();
    const targetKysely = new Kysely<any>({ dialect: new PostgresDialect({ pool: pgliteAsPool(target) }) });
    const targetAdapter = kyselyAdapter({ db: targetKysely, dialect: "postgres", schema: {} }) as Adapter;
    try {
      await ensureRevisionsTable(targetAdapter);
      for (const row of rows) await targetAdapter.internal.create("__datafn_revisions", row as Record<string, unknown>);
      const restored = await readRevisions(targetAdapter, "ns", "task", ["task:live", "task:gone"]);
      expect(Object.fromEntries(restored)).toEqual({
        "task:live": { rev: 2, deleted: false },
        "task:gone": { rev: 2, deleted: true },
      });
      // The copy continues from the tombstone.
      expect(await bumpRevision(targetAdapter, "ns", "task", "task:gone", false, false)).toBe(3);
    } finally {
      await targetKysely.destroy();
    }
  });
});

describe("DATA-41 revisions: direct executeTransaction on PostgreSQL (round 12)", () => {
  it(
    "creates revision storage itself before its write transaction on a fresh database",
    async () => {
      await adapter.rawSql!.execute(`CREATE TABLE "task" (id text primary key, title text)`);
      const db = kyselyAdapter({ db: kysely, dialect: "postgres", schema: { task: "task" } }) as Adapter;
      const results = new Map<string, unknown>();
      const idempotencyStore = {
        get: async (clientId: string, mutationId: string) => results.get(`${clientId}:${mutationId}`),
        set: async (clientId: string, mutationId: string, result: unknown) => {
          results.set(`${clientId}:${mutationId}`, result);
        },
      } as any;
      const insert = (id: string, mutationId: string) => ({
        mutation: { resource: "task", version: 1, operation: "insert", id, clientId: "c1", mutationId, record: { title: id } } as any,
      });
      const result = await executeTransaction(
        { atomic: true, steps: [insert("task:1", "m1"), insert("task:2", "m2")] },
        revisionSchema,
        db,
        idempotencyStore,
        undefined,
        "ns",
        undefined,
        undefined,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect((result as any).result.ok, JSON.stringify(result)).toBe(true);
      expect((result as any).result.results.map((step: any) => step.rev)).toEqual([1, 1]);
      const revisions = await readRevisions(adapter, "ns", "task", ["task:1", "task:2"]);
      expect(revisions.get("task:1")).toMatchObject({ rev: 1, deleted: false });
      expect(revisions.get("task:2")).toMatchObject({ rev: 1, deleted: false });
    },
    PG_TIMEOUT_MS,
  );
});
