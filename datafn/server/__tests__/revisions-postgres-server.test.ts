/**
 * DATA-41: revisions under truly concurrent PostgreSQL sessions. PGlite has
 * one session, so these run only against a PostgreSQL server named by
 * DATAFN_TEST_POSTGRES_URL (skipped otherwise), at its default READ COMMITTED
 * isolation.
 */
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bumpRevision, ensureRevisionsTable, readRevisions, readWithRevisions } from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";

const url = process.env.DATAFN_TEST_POSTGRES_URL;
const run = `${process.pid}_${Date.now()}`;
const namespace = `data41-${run}`;
const taskTable = `data41_task_${run}`;

let kysely: Kysely<any>;
let adapter: Adapter;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!url)("DATA-41 revisions on a PostgreSQL server", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    kysely = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 4 }) }),
    });
    adapter = kyselyAdapter({ db: kysely, dialect: "postgres", schema: {} }) as Adapter;
    await ensureRevisionsTable(adapter);
    await adapter.rawSql!.execute(`CREATE TABLE "${taskTable}" (id text primary key, title text)`);
  });

  afterAll(async () => {
    await adapter?.rawSql?.execute(`DROP TABLE IF EXISTS "${taskTable}"`);
    await kysely?.destroy();
  });

  it("serializes two overlapping transactions writing one record: n + 1 and n + 2, never the same", async () => {
    const service = new ChangeTrackingService(adapter, namespace);
    service.issueRevisions = true;
    await service.ensureReady();
    await service.ensureRevisionsReady();
    const id = "task:overlap";
    for (let seq = 1; seq <= 3; seq++) {
      await adapter.transaction(async (tx) => {
        await service.withDb(tx as Adapter, false).recordChanges([
          { serverSeq: seq, resource: "task", id, op: "merge", record: { id, title: `t${seq}` } },
        ]);
      });
    }
    const n = (await readRevisions(adapter, namespace, "task", [id])).get(id)!.rev;
    expect(n).toBe(3);

    // Writer A bumps and holds its transaction open; writer B starts on
    // another connection, reads the committed n and waits on A's row lock.
    const aBumped = deferred();
    const releaseA = deferred();
    const writerA = adapter.transaction(async (tx) => {
      const entry = { serverSeq: 10, resource: "task", id, op: "merge" as const, record: { id, title: "A" } };
      await service.withDb(tx as Adapter, false).recordChanges([entry]);
      aBumped.resolve();
      await releaseA.promise;
      return entry.rev;
    });
    await aBumped.promise;
    const writerB = adapter.transaction(async (tx) => {
      const entry = { serverSeq: 11, resource: "task", id, op: "merge" as const, record: { id, title: "B" } };
      await service.withDb(tx as Adapter, false).recordChanges([entry]);
      return entry.rev;
    });
    // B is now blocked on A's uncommitted update; let A commit.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseA.resolve();
    const [revA, revB] = await Promise.all([writerA, writerB]);

    expect([revA, revB]).toEqual([n + 1, n + 2]);
    expect((await readRevisions(adapter, namespace, "task", [id])).get(id)?.rev).toBe(n + 2);
    const changes = await service.getChangesSince({ resource: "task", sinceSeq: 9, limit: 10 });
    expect(changes.map((change) => [change.serverSeq, change.rev])).toEqual([[10, n + 1], [11, n + 2]]);
  });

  it("never pairs a clone row with a revision a concurrent write committed after the row was read", async () => {
    const id = "task:race";
    await adapter.rawSql!.execute(`INSERT INTO "${taskTable}" (id, title) VALUES ('${id}', 'before')`);
    await adapter.transaction(async (tx) => bumpRevision(tx as Adapter, namespace, taskTable, id, false));

    const rows = await readWithRevisions(
      adapter,
      namespace,
      taskTable,
      async (readDb) => {
        const read = await readDb.rawSql!.query(`SELECT id, title FROM "${taskTable}" WHERE id = ?`, [id]);
        // A write commits on another connection after the rows were read
        // and before their revisions are.
        await adapter.transaction(async (tx) => {
          await (tx as Adapter).rawSql!.execute(`UPDATE "${taskTable}" SET title = 'after' WHERE id = '${id}'`);
          await bumpRevision(tx as Adapter, namespace, taskTable, id, false);
        });
        return read as Array<Record<string, unknown>>;
      },
      (result) => result,
    );

    expect(rows).toEqual([{ id, title: "before", $rev: 1 }]);
    expect((await readRevisions(adapter, namespace, taskTable, [id])).get(id)?.rev).toBe(2);
  });
});
