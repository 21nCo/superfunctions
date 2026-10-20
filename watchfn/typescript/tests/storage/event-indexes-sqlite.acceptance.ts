import { expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import { DatabaseStorage, getWatchFnSchema } from "../../src/storage/database";
import { WatchFn } from "../../src/core/watch-fn";

const bug = (id: string, app = "shop", severity = "high", timestamp = "2026-10-20T10:00:00+05:30") => ({ id, type: "bug_report", timestamp, app: { name: app }, sessionId: "s", replayId: "r", report: { title: "Checkout", severity, tags: ["checkout"] }, context: { custom: { unicode: "文" } }, integration: { issueId: "77", issueUrl: "https://github.com/acme/bugs/issues/77" } });

it("migrates an old SQLite table, keeps old HTTP matches, backfills bounded pages and reopens indexed data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watch-index-"));
  const filename = join(directory, "events.sqlite");
  let sql: Kysely<any> | undefined; let watch: WatchFn | undefined; let server: ReturnType<typeof createServer> | undefined;
  function connect() {
    const native = new Database(filename);
    sql = new Kysely<any>({ dialect: new SqliteDialect({ database: native }) });
    return { native, adapter: kyselyAdapter({ db: sql, dialect: "sqlite", schema: { watchfn_events: "watchfn_events" } }) };
  }
  try {
    let connection = connect();
    await sql!.schema.createTable("watchfn_events").addColumn("id", "text", col => col.primaryKey()).addColumn("payload", "text", col => col.notNull()).execute();
    for (const [id, event] of [["old-a", bug("old-a")], ["old-b", bug("old-b", "other")], ["old-c", bug("old-c", "shop", "low")]] as const) await sql!.insertInto("watchfn_events").values({ id, payload: JSON.stringify(event) }).execute();
    await sql!.insertInto("watchfn_events").values(Array.from({ length: 1002 }, (_, index) => {
      const id = `old-z-${String(index).padStart(4, "0")}`;
      return { id, payload: JSON.stringify(bug(id, "other")) };
    })).execute();
    let storage = new DatabaseStorage(connection.adapter);
    // Old schemas fail instead of acknowledging payloads without their projections.
    await expect(storage.add(bug("must-not-commit"))).rejects.toThrow();
    await expect(storage.backfillEventProjections()).rejects.toThrow();
    expect((await sql!.selectFrom("watchfn_events").selectAll().execute())).toHaveLength(1005);
    const schema = getWatchFnSchema().watchfn_events;
    for (const [field, definition] of Object.entries(schema.fields)) {
      if (field === "id" || field === "payload") continue;
      await sql!.schema.alterTable("watchfn_events").addColumn(field, definition.type === "number" ? "real" : "text").execute();
    }
    for (const index of schema.indexes!) await sql!.schema.createIndex(index.name).on("watchfn_events").columns(index.fields).execute();
    // A partial/unknown projection must use the compatibility scan, not disappear.
    await sql!.updateTable("watchfn_events").set({ projectionVersion: 99, eventApp: "wrong" }).where("id", "=", "old-a").execute();
    watch = new WatchFn({ name: "indexed", storage: "database", database: connection.adapter, infra: { enabled: false }, auth: { apiKey: "key" } } as any); watch.start();
    server = createServer((req, res) => { void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const response = await watch!.httpRouter.handle(new Request("http://local" + req.url, { method: req.method, headers: req.headers as HeadersInit, body: Buffer.concat(chunks) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = (path: string, value: any, key = "key") => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    const query = { where: { type: "bug_report", "app.name": "shop", "report.severity": "high", "integration.issueId": "77", sessionId: "s", replayId: "r", "report.tags": { contains: "checkout" } }, timeRange: { from: "2026-10-20T04:30:00Z", to: "2026-10-20T04:30:00Z" } };
    expect((await post("/query", query, "wrong")).status).toBe(401);
    let response = await post("/query", query); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ results: [bug("old-a")] });
    const before = await sql!.selectFrom("watchfn_events").select(["id", "payload"]).orderBy("id").execute();
    let after: string | undefined; let processed = 0;
    do { const page = await storage.backfillEventProjections({ after, limit: 127 }); processed += page.processed; after = page.nextCursor ?? undefined; } while (after);
    expect(processed).toBe(1005);
    expect(await sql!.selectFrom("watchfn_events").select(["id", "payload"]).orderBy("id").execute()).toEqual(before);
    const repeat = await storage.backfillEventProjections({ limit: 1000 });
    expect(repeat.processed).toBe(1000);
    expect(await storage.backfillEventProjections({ after: repeat.nextCursor!, limit: 1000 })).toEqual({ processed: 5, nextCursor: null });
    expect((await post("/ingest", { events: [bug("new-a"), bug("new-b", "other"), bug("new-c", "shop", "high", "2020-01-01T00:00:00Z")] })).status).toBe(202);
    response = await post("/query", query); expect(response.status).toBe(200);
    const data = await response.json() as { results: Array<{ id: string }> }; expect(data.results.map(row => row.id).sort()).toEqual(["new-a", "old-a"]);
    const plans = connection.native.prepare('EXPLAIN QUERY PLAN SELECT payload FROM watchfn_events WHERE eventType=? AND eventApp=? AND eventTimestamp>=? AND eventTimestamp<=?').all("bug_report", "shop", 0, Date.now()) as Array<{ detail: string }>;
    expect(plans.some(plan => plan.detail.includes("watchfn_events_type_app_time"))).toBe(true);
    await watch.stop(); watch = undefined;
    await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); }); server = undefined;
    await sql!.destroy(); sql = undefined;
    connection = connect(); storage = new DatabaseStorage(connection.adapter);
    expect(await storage.executeQuery({ where: { type: "bug_report", "app.name": "shop", "report.severity": "high" }, resolvedTimeRange: { from: Date.parse("2026-10-20T04:30Z"), to: Date.parse("2026-10-20T04:30Z") } })).toHaveLength(2);
    expect((await sql!.selectFrom("watchfn_events").selectAll().where("id", "=", "old-a").executeTakeFirst())?.eventIssueId).toBe("77");
  } finally {
    if (watch) await watch.stop();
    if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
    if (sql) await sql.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
