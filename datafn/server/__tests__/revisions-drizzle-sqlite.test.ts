/**
 * DATA-41 on an adapter without transactions (Drizzle on SQLite, as on
 * Cloudflare D1): every write path records the record's revision on its
 * change row from the first write on a fresh database.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import { createDatafnServer } from "../src/index.js";
import { conformanceSchema, createTableStatements, drizzleSchema, resourceTables } from "./drizzle-sqlite/fixture.js";

type Server = Awaited<ReturnType<typeof createDatafnServer>>;
const open: Array<{ server: Server; sqlite: Database.Database }> = [];

afterEach(async () => {
  for (const { server, sqlite } of open.splice(0)) {
    await server.close();
    sqlite.close();
  }
});

async function start(
  existing?: Database.Database,
  wrap: (adapter: ReturnType<typeof drizzleAdapter>) => ReturnType<typeof drizzleAdapter> = (adapter) => adapter,
) {
  const sqlite = existing ?? new Database(":memory:");
  // A fresh database: only the resource tables exist, no DataFn internal table.
  if (!existing) for (const statement of createTableStatements(resourceTables)) sqlite.exec(statement);
  const adapter = wrap(drizzleAdapter({ db: drizzle(sqlite, { schema: drizzleSchema }), dialect: "sqlite" }));
  expect(adapter.capabilities?.transactions?.supported).toBe(false);
  const server = await createDatafnServer({
    schema: conformanceSchema,
    db: adapter,
    authorize: async () => true,
    allowUnknownResources: true,
    revisions: { enabled: true },
  } as any);
  open.push({ server, sqlite });
  const call = async (path: string, body: unknown) => {
    const response = await server.router.handle(new Request(`http://datafn.test/datafn/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: (await response.json()) as any };
  };
  return { sqlite, call };
}

const insert = (id: string, mutationId: string) => ({
  resource: "task", version: 1, operation: "insert", id, clientId: "c1", mutationId,
  record: { title: "Alpha", priority: 1, done: false },
});

describe("DATA-41 revisions on Drizzle SQLite (no transactions)", () => {
  it("records rev on change rows written by push, /mutation and sequential /transact on a fresh database", async () => {
    const { sqlite, call } = await start();

    const pushed = await call("push", { clientId: "c1", mutations: [insert("task:a", "m1")] });
    expect(pushed.status).toBe(200);
    expect(pushed.body.result.ok).toBe(true);
    expect(pushed.body.result.revisions.m1).toMatchObject({ resource: "task", id: "task:a", rev: 1 });

    const mutated = await call("mutation", {
      resource: "task", version: 1, operation: "merge", id: "task:a", clientId: "c1", mutationId: "m2", record: { title: "Bravo" },
    });
    expect(mutated.status).toBe(200);
    expect(mutated.body.result).toMatchObject({ ok: true, rev: 2 });

    const transacted = await call("transact", {
      atomic: false,
      steps: [
        { mutation: { resource: "task", version: 1, operation: "merge", id: "task:a", clientId: "c1", mutationId: "m3", record: { title: "Charlie" } } },
        { mutation: insert("task:b", "m4") },
      ],
    });
    expect(transacted.status).toBe(200);
    expect(transacted.body.result.ok).toBe(true);

    const rows = sqlite.prepare(`SELECT record_id, op, rev FROM "__datafn_changes" ORDER BY server_seq`).all();
    expect(rows).toEqual([
      { record_id: "task:a", op: "insert", rev: 1 },
      { record_id: "task:a", op: "merge", rev: 2 },
      { record_id: "task:a", op: "merge", rev: 3 },
      { record_id: "task:b", op: "insert", rev: 1 },
    ]);

    const pulled = await call("pull", { clientId: "c2", cursor: "0" });
    expect(pulled.status).toBe(200);
    const changes = pulled.body.result.changes as Array<Record<string, any>>;
    expect(changes.map((change) => [change.id, change.rev])).toEqual([
      ["task:a", 1], ["task:a", 2], ["task:a", 3], ["task:b", 1],
    ]);
    // Without transactions a write and its revision commit separately, so
    // no recorded row is certified with a revision: rev alone (round 12).
    expect(changes[0].record).toMatchObject({ id: "task:a", title: "Alpha" });
    for (const change of changes) expect(change.record).not.toHaveProperty("$rev");
  });

  it("returns rev without a row or tombstone on push and no $rev rows on pull (round 12)", async () => {
    const { call } = await start();
    const pushed = await call("push", {
      clientId: "c1",
      mutations: [
        insert("task:a", "m1"),
        { resource: "task", version: 1, operation: "replace", id: "task:a", clientId: "c1", mutationId: "m2", record: { id: "task:a", title: "Bravo", priority: 2, done: true } },
        insert("task:b", "m3"),
        { resource: "task", version: 1, operation: "delete", id: "task:b", clientId: "c1", mutationId: "m4" },
      ],
    });
    expect(pushed.status).toBe(200);
    expect(pushed.body.result.ok).toBe(true);
    expect(pushed.body.result.revisions).toEqual({
      m1: { resource: "task", id: "task:a", rev: 1 },
      m2: { resource: "task", id: "task:a", rev: 2 },
      m3: { resource: "task", id: "task:b", rev: 1 },
      m4: { resource: "task", id: "task:b", rev: 2 },
    });

    const global = await call("pull", { clientId: "c2", cursor: "0" });
    const changes = global.body.result.changes as Array<Record<string, any>>;
    expect(changes.map((change) => [change.id, change.rev])).toEqual([
      ["task:a", 1], ["task:a", 2], ["task:b", 1], ["task:b", 2],
    ]);
    for (const change of changes) if (change.record) expect(change.record).not.toHaveProperty("$rev");

    const canonical = await call("pull", { clientId: "c2", cursors: { task: "0" } });
    expect(canonical.status).toBe(200);
    const records = canonical.body.result.records.task as Array<Record<string, any>>;
    expect(records.find((row) => row.id === "task:a")).toMatchObject({ title: "Bravo" });
    for (const row of records) expect(row).not.toHaveProperty("$rev");
    // Tombstone revisions come from the change's rev, not a certified row.
    expect(canonical.body.result.deletedRevisions).toEqual({ task: { "task:b": 2 } });
  });

  it("creates no revision storage for an atomic /transact it refuses", async () => {
    const { sqlite, call } = await start();
    const refused = await call("transact", { steps: [{ mutation: insert("task:a", "m1") }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: "DFQL_UNSUPPORTED" });
    const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__datafn_revisions'`).all();
    expect(tables).toEqual([]);
  });

  it("adds the rev column to an upgraded change table even where an unqualified quoted name reads as a string", async () => {
    const first = await start();
    expect((await first.call("push", { clientId: "c1", mutations: [insert("task:a", "m1")] })).status).toBe(200);
    // The change table as an earlier release created it: no rev column.
    first.sqlite.exec(`ALTER TABLE "__datafn_changes" DROP COLUMN "rev"`);
    // SQLite built with double-quoted string literals answers an unqualified
    // SELECT "rev" with the string 'rev' instead of failing on the column.
    const lax = (adapter: ReturnType<typeof drizzleAdapter>) => {
      const rawSql = adapter.rawSql!;
      return Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter, {
        rawSql: {
          dialect: rawSql.dialect,
          execute: rawSql.execute.bind(rawSql),
          query: (sql: string, params?: any) =>
            /SELECT\s+"rev"\s+FROM\s+"__datafn_changes"/i.test(sql) ? Promise.resolve([]) : rawSql.query(sql, params),
        },
      });
    };
    const second = await start(first.sqlite, lax);
    const merged = await second.call("push", {
      clientId: "c1",
      mutations: [{ resource: "task", version: 1, operation: "merge", id: "task:a", clientId: "c1", mutationId: "m2", record: { title: "Bravo" } }],
    });
    expect(merged.status).toBe(200);
    expect(merged.body.result.ok).toBe(true);
    const columns = first.sqlite.prepare(`PRAGMA table_info("__datafn_changes")`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("rev");
    const rows = first.sqlite.prepare(`SELECT record_id, op, rev FROM "__datafn_changes" ORDER BY server_seq`).all();
    expect(rows).toEqual([
      { record_id: "task:a", op: "insert", rev: null },
      { record_id: "task:a", op: "merge", rev: 2 },
    ]);
  });
});
