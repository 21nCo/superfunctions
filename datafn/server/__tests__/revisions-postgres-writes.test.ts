/**
 * DATA-41: revision writes under truly concurrent PostgreSQL sessions. PGlite
 * has one session, so these run only against a PostgreSQL server named by
 * DATAFN_TEST_POSTGRES_URL (skipped otherwise), at its default READ COMMITTED
 * isolation. Each write raises its revision from the evidence of its own
 * statements (withWriteEvidence), as push, /mutation and /transact do.
 */
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assignWriteRevisions,
  bumpRevision,
  configureRevisions,
  ensureRevisionsTable,
  readRevisions,
  withWriteEvidence,
} from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
// A schema whose `task` resource issues revisions (change rows record rev only then).
const revisionSchema = { resources: [{ name: "task", version: 1, fields: [{ name: "title", type: "string" }] }], relations: [] } as any;
configureRevisions(revisionSchema, { enabled: true });

const url = process.env.DATAFN_TEST_POSTGRES_URL;
// CI (.github/workflows/datafn-postgres.yml) sets this, so a missing server
// fails the suite instead of skipping it.
if (!url && process.env.DATAFN_TEST_POSTGRES_REQUIRED === "1") {
  throw new Error("DATAFN_TEST_POSTGRES_REQUIRED is set but DATAFN_TEST_POSTGRES_URL is not");
}
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

/**
 * Deletes task `id` in `tx` through the adapter's own delete and raises its
 * tombstone from that write's evidence, as push and /mutation do; undefined
 * when it removed nothing.
 */
async function deleteWithTombstone(tx: Adapter, id: string): Promise<number | undefined> {
  const write = withWriteEvidence(tx);
  await write.delete({ model: "task", where: [{ field: "id", operator: "eq", value: id }], namespace: "datafn" } as any);
  const entry: { resource: string; id: string; op: string; record: null; rev?: number } = { resource: "task", id, op: "delete", record: null };
  await assignWriteRevisions(write, "datafn", [entry], () => false);
  return entry.rev;
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
    // The merges change a present row (a write that changed no row raises
    // no revision), stored in this run's task table.
    const db = kyselyAdapter({ db: kysely, dialect: "postgres", schema: { task: taskTable } }) as Adapter;
    const service = new ChangeTrackingService(db, namespace);
    service.useRevisionsOf(revisionSchema);
    await service.ensureReady();
    await service.ensureRevisionsReady();
    const id = "task:overlap";
    await adapter.rawSql!.execute(`INSERT INTO "${taskTable}" (id, title) VALUES ('${id}', 't0')`);
    // Each write updates the row and records its change from that UPDATE.
    const merge = async (tx: Adapter, entry: { id: string; record: { id: string; title: string } } & Record<string, unknown>) => {
      const write = withWriteEvidence(tx);
      await write.update({ model: "task", where: [{ field: "id", operator: "eq", value: entry.id }], data: { title: entry.record.title } } as any);
      await service.withDb(write, false).recordChanges([entry as any]);
    };
    for (let seq = 1; seq <= 3; seq++) {
      await db.transaction(async (tx) =>
        merge(tx as Adapter, { serverSeq: seq, resource: "task", id, op: "merge", record: { id, title: `t${seq}` } }));
    }
    const n = (await readRevisions(adapter, namespace, "task", [id])).get(id)!.rev;
    expect(n).toBe(3);

    // Writer A bumps and holds its transaction open; writer B starts on
    // another connection, reads the committed n and waits on A's row lock.
    const aBumped = deferred();
    const releaseA = deferred();
    const writerA = db.transaction(async (tx) => {
      const entry: Record<string, any> = { serverSeq: 10, resource: "task", id, op: "merge" as const, record: { id, title: "A" } };
      await merge(tx as Adapter, entry as any);
      aBumped.resolve();
      await releaseA.promise;
      return entry.rev;
    });
    await aBumped.promise;
    const writerB = db.transaction(async (tx) => {
      const entry: Record<string, any> = { serverSeq: 11, resource: "task", id, op: "merge" as const, record: { id, title: "B" } };
      await merge(tx as Adapter, entry as any);
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
});

describe.skipIf(!url)("DATA-41 overlapping deletes on a PostgreSQL server", { timeout: 120_000 }, () => {
  const database = `data41_writes_${run}`;
  let admin: pg.Pool;
  const instances: Array<Kysely<any>> = [];

  const connect = () => {
    const target = new URL(url!);
    target.pathname = `/${database}`;
    const instance = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: target.toString(), max: 4 }) }),
    });
    instances.push(instance);
    return kyselyAdapter({ db: instance, dialect: "postgres", schema: { task: "task" } }) as Adapter;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    const setup = connect();
    await setup.rawSql!.execute(`CREATE TABLE "task" (id text, "__ns" text, title text, PRIMARY KEY (id, "__ns"))`);
  });

  afterAll(async () => {
    for (const instance of instances) await instance.destroy();
    await admin?.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin?.end();
  });

  it("never marks a live record deleted when a delete overlaps a re-insert from another connection", async () => {
    const first = connect();
    const second = connect();
    await ensureRevisionsTable(first);
    const id = "task:raced";
    await first.rawSql!.execute(`INSERT INTO "task" (id, "__ns", title) VALUES ('${id}', 'datafn', 'first')`);
    await first.transaction(async (tx) => bumpRevision(tx as Adapter, "datafn", "task", id, false));
    // P1 deletes the record and commits its tombstone.
    await first.transaction(async (tx) => {
      expect(await deleteWithTombstone(tx as Adapter, id)).toBe(2);
    });
    // P3 re-inserts it and raises its revision, holding its transaction open.
    const bumped = deferred();
    const commit = deferred();
    const reinsert = second.transaction(async (tx) => {
      await (tx as Adapter).rawSql!.execute(`INSERT INTO "task" (id, "__ns", title) VALUES ('${id}', 'datafn', 'again')`);
      const rev = await bumpRevision(tx as Adapter, "datafn", "task", id, false);
      bumped.resolve();
      await commit.promise;
      return rev;
    });
    await bumped.promise;
    // P2's DELETE matches nothing (P1's delete committed, P3's insert has
    // not); its tombstone swap waits for P3 and then finds the row back.
    const overlapping = first.transaction(async (tx) => deleteWithTombstone(tx as Adapter, id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    commit.resolve();
    expect(await reinsert).toBe(3);
    expect(await overlapping).toBeUndefined();
    expect((await readRevisions(first, "datafn", "task", [id])).get(id)).toEqual({ rev: 3, deleted: false });
    const rows = await first.rawSql!.query(`SELECT id, title FROM "task" WHERE id = '${id}'`);
    expect(rows).toEqual([{ id, title: "again" }]);
  });

  it("raises exactly one tombstone when two deletes of one record overlap from two connections", async () => {
    const first = connect();
    const second = connect();
    await ensureRevisionsTable(first);
    const id = "task:twice";
    await first.rawSql!.execute(`INSERT INTO "task" (id, "__ns", title) VALUES ('${id}', 'datafn', 'first')`);
    await first.transaction(async (tx) => bumpRevision(tx as Adapter, "datafn", "task", id, false));
    // T1 deletes the record and raises its tombstone, holding its transaction open.
    const raised = deferred();
    const commit = deferred();
    const t1 = first.transaction(async (tx) => {
      const rev = await deleteWithTombstone(tx as Adapter, id);
      raised.resolve();
      await commit.promise;
      return rev;
    });
    await raised.promise;
    // T2 also saw the record; its DELETE waits on T1's row lock and then
    // matches nothing, so it removed nothing and must raise nothing.
    const t2 = second.transaction(async (tx) => deleteWithTombstone(tx as Adapter, id));
    await new Promise((resolve) => setTimeout(resolve, 300));
    commit.resolve();
    expect(await t1).toBe(2);
    expect(await t2).toBeUndefined();
    expect((await readRevisions(first, "datafn", "task", [id])).get(id)).toEqual({ rev: 2, deleted: true });
    expect(await first.rawSql!.query(`SELECT id FROM "task" WHERE id = '${id}'`)).toEqual([]);
  });
});
