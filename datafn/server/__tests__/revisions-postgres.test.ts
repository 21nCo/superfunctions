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
import { bumpRevision, ensureRevisionsTable, readInSnapshot, readRevisions } from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";

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

beforeEach(() => {
  pg = new PGlite();
  kysely = new Kysely<any>({ dialect: new PostgresDialect({ pool: pgliteAsPool(pg) }) });
  adapter = kyselyAdapter({ db: kysely, dialect: "postgres", schema: {} }) as Adapter;
});

afterEach(async () => {
  await kysely.destroy();
});

describe("DATA-41 revisions on PostgreSQL", () => {
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
    service.issueRevisions = true;
    await service.ensureReady();
    await service.ensureRevisionsReady();
    await adapter.transaction(async (tx) => {
      await service.withDb(tx as any, false).recordChanges([
        { serverSeq: 1, resource: "task", id: "task:1", op: "insert", record: { id: "task:1" } },
      ]);
    });
    const changes = await service.getChangesSince({ resource: "task", sinceSeq: 0, limit: 10 });
    expect(changes[0].rev).toBe(1);
  });

  it("reads rows and revisions in one REPEATABLE READ transaction", async () => {
    await ensureRevisionsTable(adapter);
    await bumpRevision(adapter, "ns", "task", "task:1", false);
    const isolation = await readInSnapshot(adapter, async (snapshotDb) => {
      const [row] = await snapshotDb.rawSql!.query("SHOW transaction_isolation");
      return { level: row.transaction_isolation, revs: await readRevisions(snapshotDb, "ns", "task", ["task:1"]) };
    });
    expect(isolation.level).toBe("repeatable read");
    expect(isolation.revs.get("task:1")?.rev).toBe(1);
  });
});
