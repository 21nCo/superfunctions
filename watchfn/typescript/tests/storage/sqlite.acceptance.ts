import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import { DatabaseStorage, getWatchFnSchema } from "../../src/storage/database";
import { WatchFn } from "../../src/core/watch-fn";

it("persists ingested JSON through native SQLite close and reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watchfn-sqlite-"));
  let sql: Kysely<any> | undefined;
  let watch: WatchFn | undefined;
  const connect = () => {
    sql = new Kysely({ dialect: new SqliteDialect({ database: new Database(join(directory, "events.sqlite")) }) });
    return kyselyAdapter({ db: sql, dialect: "sqlite", schema: { watchfn_events: "watchfn_events" } });
  };
  try {
    let db = connect();
    let migration = sql!.schema.createTable("watchfn_events");
    for (const [name, field] of Object.entries(getWatchFnSchema().watchfn_events.fields)) {
      migration = migration.addColumn(name, "text", column => name === "id" ? column.primaryKey() : field.required ? column.notNull() : column);
    }
    await migration.execute();
    watch = new WatchFn({ name: "test", storage: "database", database: db, infra: { enabled: false } } as any);
    watch.start();
    const event = { name: "log", timestamp: "2026-10-20T00:00:00Z", traceId: "trace", ctx: { nested: [1, true, null, "文"] } };
    const response = await watch.httpRouter.handle(new Request("http://local/ingest", { method: "POST", body: JSON.stringify(event) }));
    expect(response.status).toBe(202);
    watch.stop();
    await sql!.destroy(); sql = undefined;
    db = connect();
    const storage = new DatabaseStorage(db);
    expect(await storage.getAll()).toEqual([event]);
    expect(await storage.query(value => value.traceId === "trace")).toEqual([event]);
    const rows = await sql!.selectFrom("watchfn_events").selectAll().execute();
    expect(typeof rows[0].payload).toBe("string");
    expect(JSON.parse(rows[0].payload)).toEqual(event);
    await sql!.schema.dropTable("watchfn_events").execute();
    await expect(storage.add(event)).rejects.toThrow();
  } finally {
    watch?.stop();
    if (sql) await sql.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
