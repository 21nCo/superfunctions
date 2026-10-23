import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import { DatabaseStorage, getWatchFnSchema } from "../../src/storage/database";
import { projectEvent } from "../../src/storage/projection";
import { QueryEngine } from "../../src/query/query-engine";

it("streams every SQLite projection/version page in storage order and preserves complete filtered aggregates after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watch-query-stream-"));
  const filename = join(directory, "events.sqlite");
  let sql: Kysely<any> | undefined;
  function open() {
    const native = new Database(filename);
    sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
    const adapter = kyselyAdapter({ db: sql, dialect: "sqlite", schema: { watchfn_events: "watchfn_events" } });
    return { native, adapter, storage: new DatabaseStorage(adapter) };
  }
  try {
    let connection = open();
    const schema = getWatchFnSchema().watchfn_events;
    connection.native.exec(`CREATE TABLE watchfn_events (${Object.entries(schema.fields).map(([field, definition]) => `"${field}" ${definition.type === "number" ? "REAL" : "TEXT"}${field === "id" ? " PRIMARY KEY" : ""}`).join(",")})`);
    for (const index of schema.indexes!) connection.native.exec(`CREATE INDEX "${index.name}" ON watchfn_events (${index.fields.map(field => `"${field}"`).join(",")})`);
    const expected: any[] = [];
    const insert = connection.native.prepare('INSERT INTO watchfn_events (id,payload,projectionVersion,eventType,eventApp,eventTimestamp) VALUES (?,?,?,?,?,?)');
    connection.native.transaction(() => {
      for (let index = 0; index < 4207; index++) {
        const payload = { id: index, name: index % 5 ? "request" : "error", type: "track", app: { name: index % 11 ? "web" : "other" }, timestamp: index, properties: { value: index % 101, group: index % 3, keep: index % 7 === 0, user: index % 17 } };
        const projection = projectEvent(payload);
        // Every compatibility stream exceeds 1000 rows; IDs interleave all three.
        const version = index % 3 === 0 ? projection.projectionVersion : index % 3 === 1 ? null : 99;
        insert.run(String(index).padStart(8, "0"), JSON.stringify(payload), version, projection.eventType, projection.eventApp, projection.eventTimestamp);
        expected.push(payload);
      }
    })();
    const spy = vi.spyOn(connection.adapter, "findMany");
    vi.spyOn(connection.storage, "getAll").mockRejectedValue(new Error("getAll must not be called"));
    vi.spyOn(connection.storage, "executeQuery").mockRejectedValue(new Error("executeQuery must not be called"));
    let query = new QueryEngine(connection.storage);
    const where = { type: "track", "app.name": "web", keep: true };
    const matches = expected.filter(event => event.app.name === "web" && event.properties.keep && event.timestamp >= 200 && event.timestamp <= 4100);
    const options = { where, timeRange: { from: 200, to: 4100 } };
    expect((await query.execute({ ...options, limit: 5 })).data).toEqual(matches.slice(0, 5));
    expect((await query.execute({ ...options, orderBy: { field: "value", direction: "desc" }, limit: 17 })).data).toEqual([...matches].sort((a, b) => b.properties.value - a.properties.value).slice(0, 17));
    const result = await query.execute({ ...options, metric: "request", groupBy: "group", aggregations: {
      count: { operation: "count" }, sum: { operation: "sum", field: "value" }, avg: { operation: "avg", field: "value" }, min: { operation: "min", field: "value" }, max: { operation: "max", field: "value" }, distinct: { operation: "count_distinct", field: "user" }, p95: { operation: "percentile", field: "value", percentile: 95 }, ratio: { operation: "rate", numerator: { metric: "error" }, denominator: { metric: "request" } },
    }, orderBy: { field: "group", direction: "asc" } });
    const expectedGroups = [0, 1, 2].map(group => {
      const all = matches.filter(event => event.properties.group === group);
      const requests = all.filter(event => event.name === "request");
      const values = requests.map(event => event.properties.value), sorted = [...values].sort((a, b) => a - b);
      const at = 0.95 * (sorted.length - 1), low = Math.floor(at), high = Math.ceil(at), weight = at - low;
      return { group, count: requests.length, sum: values.reduce((sum, value) => sum + value, 0), avg: values.reduce((mean, value) => mean + value / values.length, 0), min: Math.min(...values), max: Math.max(...values), distinct: new Set(requests.map(event => event.properties.user)).size, p95: sorted[low] * (1 - weight) + sorted[high] * weight, ratio: all.filter(event => event.name === "error").length / requests.length };
    });
    expect(result.data).toEqual(expectedGroups);
    expect(spy.mock.calls.length).toBeGreaterThan(30);
    expect(spy.mock.calls.every(([params]) => params.limit === 128 && params.offset === undefined)).toBe(true);
    expect(spy.mock.calls.some(([params]) => params.where?.some(clause => clause.field === "id" && clause.operator === "gt"))).toBe(true);
    // Full scan has no projected predicate and still crosses every adapter page.
    expect((await query.execute({ aggregations: { count: { operation: "count" } } })).data).toEqual([{ count: 4207 }]);
    // SQLite UTF-8 order differs from JS UTF-16 order for these custom IDs.
    // The decision must precede output, including the previously yielded ASCII rows.
    const custom = ["legacy-\ue000", "legacy-😀"].map(id => ({ id, type: "track", app: { name: "unicode" } }));
    for (const event of custom) insert.run(event.id, JSON.stringify(event), null, null, null, null);
    const unicode = await query.execute({ where: { type: "track", "app.name": "unicode" } });
    expect(unicode.data.map(event => event.id)).toEqual(custom.map(event => event.id).sort());
    await sql!.destroy(); sql = undefined; connection = open(); query = new QueryEngine(connection.storage);
    expect((await query.execute({ ...options, limit: 5 })).data).toEqual(matches.slice(0, 5));
    expect((await query.aggregate({ metric: "request.value", aggregation: "sum" })).data).toEqual([{ value: expected.filter(event => event.name === "request").reduce((sum, event) => sum + event.properties.value, 0) }]);
  } finally { await sql?.destroy(); await rm(directory, { recursive: true, force: true }); }
});

it("keeps exact scalar metric presence independent of projected residual filters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "watch-exact-metric-"));
  let sql: Kysely<any> | undefined;
  try {
    const native = new Database(join(directory, "events.sqlite"));
    sql = new Kysely({ dialect: new SqliteDialect({ database: native }) });
    const schema = getWatchFnSchema().watchfn_events;
    native.exec(`CREATE TABLE watchfn_events (${Object.entries(schema.fields).map(([field, definition]) => `"${field}" ${definition.type === "number" ? "REAL" : "TEXT"}${field === "id" ? " PRIMARY KEY" : ""}`).join(",")})`);
    const adapter = kyselyAdapter({ db: sql, dialect: "sqlite", schema: { watchfn_events: "watchfn_events" } });
    const storage = new DatabaseStorage(adapter);
    const base = { name: "request", type: "track", app: { name: "web" }, timestamp: 100, properties: { duration: 10 } };
    const exact = { name: "request.duration", type: "track", app: { name: "other" }, timestamp: 0, properties: { value: 999 } };
    await storage.add(base);
    const query = new QueryEngine(storage);
    const options = { metric: "request.duration", aggregation: "avg" as const, where: { "app.name": "web" }, timeRange: { from: 50, to: 150 } };
    expect((await query.aggregate(options)).data).toEqual([{ value: 10 }]);
    await storage.add(exact);
    const memory = new QueryEngine({ getAll: () => [base, exact] } as any);
    expect((await memory.aggregate(options)).data).toEqual([{ value: null }]);
    const spy = vi.spyOn(adapter, "findMany");
    expect((await query.aggregate(options)).data).toEqual([{ value: null }]);
    expect(spy.mock.calls.every(([params]) => params.limit === 128)).toBe(true);
    expect(spy.mock.calls.some(([params]) => params.where?.some(clause => clause.field === "eventTimestamp"))).toBe(true);
    expect(spy.mock.calls.some(([params]) => params.where?.some(clause => clause.field === "eventApp"))).toBe(true);
  } finally {
    await sql?.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
