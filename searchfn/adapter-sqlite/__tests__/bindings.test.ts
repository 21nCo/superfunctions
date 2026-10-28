import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteAdapter, fromLibsql, type SqliteDriver } from "../src/index";
import { betterSqlite, libsql, type TestDatabase } from "./helpers";

const bindings: Array<[string, () => TestDatabase]> = [
  ["better-sqlite3", betterSqlite],
  ["@libsql/client", libsql],
];

describe.each(bindings)("%s binding", (_name, open) => {
  let database: TestDatabase;
  let driver: SqliteDriver;

  afterEach(() => database.close());

  async function setUp(): Promise<void> {
    database = open();
    driver = database.driver;
    await driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)");
  }

  it("maps rows to plain objects and reports changes", async () => {
    await setUp();
    expect(await driver.run("INSERT INTO t (label) VALUES (?), (?)", ["a", null])).toEqual({ changes: 2 });
    expect(await driver.all("SELECT id, label FROM t ORDER BY id")).toEqual([
      { id: 1, label: "a" },
      { id: 2, label: null },
    ]);
  });

  it("commits a batch as one transaction and rolls back all of it on failure", async () => {
    await setUp();
    await driver.batch!([
      { sql: "INSERT INTO t (label) VALUES (?)", params: ["one"] },
      { sql: "INSERT INTO t (label) VALUES (?)", params: ["two"] },
    ]);
    await expect(
      driver.batch!([
        { sql: "INSERT INTO t (label) VALUES (?)", params: ["three"] },
        { sql: "INSERT INTO missing (label) VALUES (?)", params: ["four"] },
      ]),
    ).rejects.toThrow(/missing/);
    const rows = await driver.all<{ label: string }>("SELECT label FROM t ORDER BY id");
    expect(rows.map((row) => row.label)).toEqual(["one", "two"]);
  });

  it("supports FTS5 with the unicode61 tokenizer", async () => {
    await setUp();
    await driver.exec("CREATE VIRTUAL TABLE f USING fts5(c0, tokenize = 'unicode61 remove_diacritics 2')");
    await driver.run("INSERT INTO f (c0) VALUES (?)", ["Crème brûlée"]);
    expect(await driver.all("SELECT c0 FROM f WHERE f MATCH ?", ['"creme"'])).toHaveLength(1);
  });
});

describe("fromLibsql", () => {
  it("normalizes integers from clients created with intMode bigint", async () => {
    const client = createClient({ url: ":memory:", intMode: "bigint" });
    const driver = fromLibsql(client);
    expect(await driver.all("SELECT 1 AS one, 'x' AS text")).toEqual([{ one: 1, text: "x" }]);
    const adapter = new SqliteAdapter({ driver });
    await adapter.initialize({ resources: [{ name: "items", searchFields: ["title"] }] });
    await adapter.index({ resource: "items", documents: [{ id: 7, fields: { title: "alpha" } }] });
    expect(await adapter.search({ resource: "items", query: "alpha" })).toEqual([7]);
    client.close();
  });
});
