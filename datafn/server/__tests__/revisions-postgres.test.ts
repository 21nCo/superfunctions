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
import { bumpRevision, configureRevisions, ensureRevisionsTable, readRevisions, readWithRevisions } from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
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
    const first = await adapter.transaction(async (tx) => bumpRevision(tx as any, "ns", "task", "task:1", false));
    const second = await adapter.transaction(async (tx) => bumpRevision(tx as any, "ns", "task", "task:1", true));
    expect([first, second]).toEqual([1, 2]);
    expect((await readRevisions(adapter, "ns", "task", ["task:1"])).get("task:1")).toEqual({ rev: 2, deleted: true });
    // A rolled-back write leaves the revision as it was.
    await expect(adapter.transaction(async (tx) => {
      await bumpRevision(tx as any, "ns", "task", "task:1", false);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await readRevisions(adapter, "ns", "task", ["task:1"])).get("task:1")?.rev).toBe(2);
  });

  it("adds the rev column to a change table created before it and records rev on change rows", async () => {
    await adapter.rawSql!.execute(
      'CREATE TABLE "__datafn_changes" (id text primary key, namespace text, server_seq integer, resource text, record_id text, op text, record text, created_at text)',
    );
    const service = new ChangeTrackingService(adapter, "ns");
    service.useRevisionsOf(revisionSchema);
    await service.ensureReady();
    await service.ensureRevisionsReady();
    await adapter.transaction(async (tx) => {
      await service.withDb(tx as any, false).recordChanges([
        { serverSeq: 1, resource: "task", id: "task:1", op: "merge", record: { id: "task:1" } },
      ]);
    });
    const changes = await service.getChangesSince({ resource: "task", sinceSeq: 0, limit: 10 });
    expect(changes[0].rev).toBe(1);
  });

  it("reads rows and revisions in one REPEATABLE READ transaction", async () => {
    await ensureRevisionsTable(adapter);
    await bumpRevision(adapter, "ns", "task", "task:1", false);
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
    await bumpRevision(adapter, "ns", "task", "task:live", false);
    await bumpRevision(adapter, "ns", "task", "task:live", false);
    await bumpRevision(adapter, "ns", "task", "task:gone", false);
    await bumpRevision(adapter, "ns", "task", "task:gone", true);
    await bumpRevision(adapter, "other", "task", "task:live", false);

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
      expect(await bumpRevision(targetAdapter, "ns", "task", "task:gone", false)).toBe(3);
    } finally {
      await targetKysely.destroy();
    }
  });
});
