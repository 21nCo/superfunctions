import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWatch } from "../src/index.js";
import { SQLITE_EVENTS_TABLE, buildSqliteQuery, createSqliteStorage } from "../src/sqlite.js";
import { deferred, sqliteFile, type SqliteFile } from "./helpers.js";

let db: SqliteFile;
afterEach(() => db?.cleanup());

describe("[durable-sqlite] SQLite storage on @superfunctions/db", () => {
  it("has committed the row when the receipt arrives: a separate connection reads it", async () => {
    db = sqliteFile();
    const watch = createWatch({ storage: createSqliteStorage({ adapter: db.connect().adapter }) });
    await watch.start();
    const receipt = await watch.ingest({ type: "sdk.failure", attributes: { operation: "tasks.get", release: "1.2.0" } });
    expect(receipt).toMatchObject({ ok: true, storage: "sqlite", durable: true });
    const reader = new Database(db.file, { readonly: true });
    const rows = reader.prepare(`SELECT id, type, attributes FROM ${SQLITE_EVENTS_TABLE}`).all();
    reader.close();
    expect(rows).toEqual([{ id: receipt.ok ? receipt.event.id : "", type: "sdk.failure", attributes: '{"operation":"tasks.get","release":"1.2.0"}' }]);
    await watch.stop();
  });

  it("returns a failed receipt, not a success, when the database rejects the write", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const listener = vi.fn();
    const watch = createWatch({ storage: createSqliteStorage({ adapter }) });
    watch.subscribe(listener);
    await watch.start();
    sqlite.exec(`DROP TABLE ${SQLITE_EVENTS_TABLE}`);
    const receipt = await watch.ingest({ type: "lost" });
    expect(receipt).toMatchObject({ ok: false, error: { code: "storage_failed", message: expect.stringContaining("no such table") } });
    expect(listener).not.toHaveBeenCalled();
    await expect(watch.query()).rejects.toMatchObject({ code: "storage_failed" });
    await watch.stop();
  });

  it("never closes the borrowed adapter or connection on stop", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const close = vi.spyOn(adapter, "close");
    const watch = createWatch({ storage: createSqliteStorage({ adapter }) });
    await watch.start();
    await watch.ingest({ type: "kept" });
    await watch.stop();
    expect(close).not.toHaveBeenCalled();
    expect(sqlite.open).toBe(true);
    expect(sqlite.prepare(`SELECT count(*) AS n FROM ${SQLITE_EVENTS_TABLE}`).get()).toEqual({ n: 1 });
  });

  it("refuses writes and queries once the storage session is closed", async () => {
    db = sqliteFile();
    const storage = createSqliteStorage({ adapter: db.connect().adapter });
    await expect(storage.query({ attributes: [], limit: 1, order: "desc" })).rejects.toThrow(/not open/);
    await storage.open();
    await storage.close();
    await expect(storage.write([])).rejects.toThrow(/not open/);
  });

  it("applies its schema idempotently and can leave schema management to the caller", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const first = createSqliteStorage({ adapter });
    await first.open();
    await first.open();
    await createSqliteStorage({ adapter }).open();
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'watchfn_%' ORDER BY name").all()).toEqual([
      { name: "watchfn_events_ts" },
      { name: "watchfn_events_type_ts" },
    ]);

    const bare = sqliteFile();
    try {
      const unmanaged = createSqliteStorage({ adapter: bare.connect().adapter, ensureSchema: false });
      await unmanaged.open();
      const write = unmanaged.write([{ id: "a", type: "t", timestamp: new Date(0).toISOString(), receivedAt: new Date(0).toISOString(), attributes: {} }]);
      await expect(write).rejects.toMatchObject({ cause: { message: expect.stringContaining("no such table") } });
    } finally {
      bare.cleanup();
    }
  });

  it("rejects adapters that are not SQL adapters on SQLite", () => {
    expect(() => createSqliteStorage({ adapter: {} })).toThrow(/rawSql/);
    const postgres = { rawSql: { dialect: "postgres" as const, query: async () => [], execute: async () => undefined } };
    expect(() => createSqliteStorage({ adapter: postgres })).toThrow(/dialect is postgres/);
  });

  it("binds every filter value as a parameter", () => {
    const { sql, params } = buildSqliteQuery({
      fromMs: 1,
      toMs: 2,
      types: ["a", "b"],
      attributes: [
        ["k", "' OR 1=1 --"],
        ["n", 5],
        ["b", false],
      ],
      limit: 11,
      order: "asc",
    });
    expect(sql).not.toContain("OR 1=1");
    expect(sql.split("?").length - 1).toBe(params.length);
    expect(params).toEqual([1, 2, "a", "b", "k", JSON.stringify("' OR 1=1 --"), "n", "5", "b", "false", 11]);
    expect(sql).toContain("ORDER BY e.ts ASC, e.seq ASC LIMIT ?");
  });
});

describe("[durable-sqlite] the storage owns every write transaction", () => {
  const count = (sqlite: Database.Database) => (sqlite.prepare(`SELECT count(*) AS n FROM ${SQLITE_EVENTS_TABLE}`).get() as { n: number }).n;

  it("refuses to write inside a caller's transaction and leaves that transaction alone", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const listener = vi.fn();
    const watch = createWatch({ storage: createSqliteStorage({ adapter }) });
    watch.subscribe(listener);
    await watch.start();

    sqlite.exec("CREATE TABLE caller_work (v TEXT)");
    sqlite.exec("BEGIN");
    sqlite.exec("INSERT INTO caller_work VALUES ('pending')");
    const single = await watch.ingest({ type: "inside" });
    const batch = await watch.ingestBatch([{ type: "inside" }, { type: "inside" }]);
    expect(single).toMatchObject({ ok: false, error: { code: "storage_failed", message: expect.stringContaining("could not begin its own transaction") } });
    expect(batch).toMatchObject({ ok: false, error: { code: "storage_failed" } });
    expect(listener).not.toHaveBeenCalled();
    // The caller's transaction is still open with its own work intact: nothing was committed or rolled back for it.
    expect(sqlite.inTransaction).toBe(true);
    expect(sqlite.prepare("SELECT v FROM caller_work").all()).toEqual([{ v: "pending" }]);
    sqlite.exec("ROLLBACK");
    expect(count(sqlite)).toBe(0);
    expect(sqlite.prepare("SELECT count(*) AS n FROM caller_work").get()).toEqual({ n: 0 });

    expect(await watch.ingest({ type: "after" })).toMatchObject({ ok: true });
    expect(count(sqlite)).toBe(1);
    await watch.stop();
  });

  it("rolls back its own transaction when the insert fails and leaves the connection outside any transaction", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const storage = createSqliteStorage({ adapter });
    await storage.open();
    const at = new Date(0).toISOString();
    const event = { id: "dup", type: "t", timestamp: at, receivedAt: at, attributes: {} };
    await expect(storage.write([event, { ...event, type: "x" }, event])).rejects.toThrow();
    expect(sqlite.inTransaction).toBe(false);
    expect(count(sqlite)).toBe(0);
    await storage.write([event]);
    expect(count(sqlite)).toBe(1);
  });

  it("serializes concurrent ingests, including from two storages on one connection", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const first = createWatch({ storage: createSqliteStorage({ adapter }) });
    const second = createWatch({ storage: createSqliteStorage({ adapter }) });
    await Promise.all([first.start(), second.start()]);
    const receipts = await Promise.all([
      ...Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).ingest({ type: "concurrent", attributes: { index } })),
      first.ingestBatch([{ type: "concurrent" }, { type: "concurrent" }]),
      second.ingestBatch([{ type: "concurrent" }, { type: "concurrent" }]),
    ]);
    expect(receipts.every((receipt) => receipt.ok)).toBe(true);
    expect(sqlite.inTransaction).toBe(false);
    const reader = new Database(db.file, { readonly: true });
    expect(reader.prepare(`SELECT count(*) AS n FROM ${SQLITE_EVENTS_TABLE}`).get()).toEqual({ n: 24 });
    reader.close();
    await Promise.all([first.stop(), second.stop()]);
  });

  it("runs open()'s probe in the connection's queue, never inside another storage's pending transaction", async () => {
    db = sqliteFile();
    const { sqlite, adapter } = db.connect();
    const real = adapter.rawSql!;
    const log: string[] = [];
    const insertGate = deferred();
    let gateInserts = false;
    const shared = {
      rawSql: {
        dialect: "sqlite" as const,
        async query(text: string, params?: readonly unknown[]) {
          log.push(`${text.split(" ")[0]}:${sqlite.inTransaction}`);
          return real.query(text, params as never);
        },
        async execute(text: string, params?: readonly unknown[]) {
          log.push(`${text.split(" ")[0]}:${sqlite.inTransaction}`);
          if (gateInserts && text.startsWith("INSERT")) await insertGate.promise;
          return real.execute(text, params as never);
        },
      },
    };
    const writer = createSqliteStorage({ adapter: shared });
    await writer.open();
    log.length = 0;
    gateInserts = true;
    const at = new Date(0).toISOString();
    const writing = writer.write([{ id: "held", type: "t", timestamp: at, receivedAt: at, attributes: {} }]);
    await vi.waitFor(() => expect(log).toContain("INSERT:true"));
    const opening = createSqliteStorage({ adapter: shared }).open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The writer's transaction is still open, so the second storage has not run anything yet.
    expect(log).toEqual(["BEGIN:false", "INSERT:true"]);
    insertGate.resolve();
    await Promise.all([writing, opening]);
    expect(log.slice(0, 5)).toEqual(["BEGIN:false", "INSERT:true", "COMMIT:true", "SELECT:false", "BEGIN:false"]);
    expect(sqlite.inTransaction).toBe(false);
  });
});
