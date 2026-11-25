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
import {
  bumpRevision,
  bumpTombstone,
  configureRevisions,
  ensureRevisionsTable,
  readRevisions,
  readWithRevisions,
} from "../src/execution/revisions.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { createDatafnServer } from "../src/server.js";

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
    for (let seq = 1; seq <= 3; seq++) {
      await db.transaction(async (tx) => {
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
    const writerA = db.transaction(async (tx) => {
      const entry = { serverSeq: 10, resource: "task", id, op: "merge" as const, record: { id, title: "A" } };
      await service.withDb(tx as Adapter, false).recordChanges([entry]);
      aBumped.resolve();
      await releaseA.promise;
      return entry.rev;
    });
    await aBumped.promise;
    const writerB = db.transaction(async (tx) => {
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

/**
 * DATA-41: a versioned query runs inside a REPEATABLE READ snapshot, so a
 * write another connection commits while the query runs never pairs a
 * returned row with the revision of another state. Runs in a fresh database
 * on the server named by DATAFN_TEST_POSTGRES_URL.
 */
describe.skipIf(!url)("DATA-41 versioned query on a PostgreSQL server", { timeout: 120_000 }, () => {
  const database = `data41_query_${run}`;
  const schema = {
    resources: [
      { name: "project", version: 1, fields: [{ name: "name", type: "string", required: false }] },
      {
        name: "task",
        version: 1,
        capabilities: ["trash"],
        fields: [
          { name: "title", type: "string", required: false },
          { name: "projectId", type: "string", required: false },
        ],
      },
    ],
    relations: [{ from: "task", to: "project", type: "many-one", relation: "project", fkField: "projectId" }],
  } as any;
  let admin: pg.Pool;
  const instances: Array<Kysely<any>> = [];

  const connect = () => {
    const target = new URL(url!);
    target.pathname = `/${database}`;
    const instance = new Kysely<any>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: target.toString(), max: 4 }) }),
    });
    instances.push(instance);
    return kyselyAdapter({ db: instance, dialect: "postgres", schema: { project: "project", task: "task" } }) as Adapter;
  };

  const serve = async (adapterForServer: Adapter) => {
    const server = await createDatafnServer({
      schema,
      database: adapterForServer,
      allowUnknownResources: true,
      revisions: { enabled: true },
    } as any);
    let seq = 0;
    const send = async (route: string, body: unknown) => {
      const res = await server.router.handle(
        new Request(`http://localhost/datafn/${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const push = async (mutation: Record<string, unknown>) => {
      seq += 1;
      return send("push", {
        clientId: "client:w",
        mutations: [{ version: 1, clientId: "client:w", mutationId: `w${Date.now()}-${seq}`, ...mutation }],
      });
    };
    return { send, push };
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE "${database}"`);
    const setup = connect();
    await setup.rawSql!.execute(`CREATE TABLE "project" (id text, "__ns" text, name text, PRIMARY KEY (id, "__ns"))`);
    await setup.rawSql!.execute(
      `CREATE TABLE "task" (id text, "__ns" text, title text, "projectId" text, "trashedAt" bigint, "trashedBy" text, PRIMARY KEY (id, "__ns"))`,
    );
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
      await (tx as Adapter).rawSql!.execute(`DELETE FROM "task" WHERE id = '${id}'`);
      expect(await bumpTombstone(tx as Adapter, "datafn", "task", id)).toBe(2);
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
    const overlapping = first.transaction(async (tx) => {
      await (tx as Adapter).rawSql!.execute(`DELETE FROM "task" WHERE id = '${id}'`);
      return bumpTombstone(tx as Adapter, "datafn", "task", id);
    });
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
      await (tx as Adapter).rawSql!.execute(`DELETE FROM "task" WHERE id = '${id}'`);
      const rev = await bumpTombstone(tx as Adapter, "datafn", "task", id);
      raised.resolve();
      await commit.promise;
      return rev;
    });
    await raised.promise;
    // T2 also saw the record; its DELETE waits on T1's row lock and then
    // matches nothing, so it removed nothing and must raise nothing.
    const t2 = second.transaction(async (tx) => {
      await (tx as Adapter).rawSql!.execute(`DELETE FROM "task" WHERE id = '${id}'`);
      return bumpTombstone(tx as Adapter, "datafn", "task", id);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    commit.resolve();
    expect(await t1).toBe(2);
    expect(await t2).toBeUndefined();
    expect((await readRevisions(first, "datafn", "task", [id])).get(id)).toEqual({ rev: 2, deleted: true });
    expect(await first.rawSql!.query(`SELECT id FROM "task" WHERE id = '${id}'`)).toEqual([]);
  });

  it("returns each row with the revision of exactly that row while another connection writes", async () => {
    // The writer has its own pool, so its writes commit on another session.
    const writer = await serve(connect());
    const readerAdapter = connect();
    let inject: (() => Promise<void>) | undefined;
    // Commits the injected write right after the query's first read of task
    // rows inside its snapshot transaction.
    const reader = await serve(
      new Proxy(readerAdapter, {
        get(target, property, receiver) {
          if (property !== "transaction") return Reflect.get(target, property, receiver);
          return (fn: (tx: Adapter) => Promise<unknown>) =>
            target.transaction((tx) =>
              fn(
                new Proxy(tx as Adapter, {
                  get(txTarget, txProperty, txReceiver) {
                    if (txProperty !== "findMany") return Reflect.get(txTarget, txProperty, txReceiver);
                    return async (args: any) => {
                      const rows = await (txTarget as Adapter).findMany(args);
                      if (inject && args.model === "task") {
                        const write = inject;
                        inject = undefined;
                        await write();
                      }
                      return rows;
                    };
                  },
                }),
              ),
            );
        },
      }),
    );
    await writer.push({ resource: "project", operation: "insert", id: "project:1", record: { name: "P" } });
    await writer.push({ resource: "project", operation: "insert", id: "project:2", record: { name: "Q" } });

    const states = new Map<number, Record<string, unknown>>();
    const record = async () => {
      const [row] = await readerAdapter.findMany({
        model: "task",
        where: [{ field: "id", operator: "eq", value: "task:1" }],
        namespace: "datafn",
      });
      const rev = (await readRevisions(readerAdapter, "datafn", "task", ["task:1"])).get("task:1")!.rev;
      const { __ns: _namespace, ...state } = row as Record<string, unknown>;
      states.set(rev, JSON.parse(JSON.stringify(state)));
    };
    const writes = [
      { operation: "merge", record: { title: "changed" } },
      { operation: "trash" },
      { operation: "unrelate", relations: { project: "project:1" } },
      { operation: "relate", relations: { project: "project:2" } },
      { operation: "merge", record: { title: "0-first" } },
    ];
    const queries = [
      { filters: { title: { eq: "a" } } },
      { filters: { projectId: { eq: "project:1" }, title: { not_ilike: "z" } } },
      { filters: { "project.name": { eq: "P" } } },
      { sort: ["title"], limit: 1 },
    ];
    let paired = 0;
    for (const write of writes) {
      for (const shape of queries) {
        const reset = await writer.push({
          resource: "task",
          operation: "replace",
          id: "task:1",
          record: { title: "a", projectId: "project:1" },
        });
        expect(reset.status).toBe(200);
        await writer.push({ resource: "task", operation: "insert", id: "task:0", record: { title: "b" } });
        await record();
        inject = async () => {
          const written = await writer.push({ resource: "task", id: "task:1", ...write });
          expect(written.body.result.ok).toBe(true);
          await record();
        };
        const query = await reader.send("query", { resource: "task", version: 1, withRevisions: true, ...shape });
        expect(query.status).toBe(200);
        expect(inject).toBeUndefined();
        for (const row of query.body.result.data.filter((r: Record<string, unknown>) => r.id === "task:1")) {
          if (row.$rev === undefined) continue;
          const { $rev, ...state } = row;
          expect(state).toEqual(states.get($rev));
          paired += 1;
        }
      }
    }
    // The snapshot pairs rows here (the pre-write state with its revision).
    expect(paired).toBeGreaterThan(0);
  });
});
