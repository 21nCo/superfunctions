/**
 * Injected-driver behavior that needs a real Postgres: transaction rollback, array parameters,
 * driver errors, and storage shared with the connectionString path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import postgres from "postgres";
import {
  PostgresAdapter,
  fromPg,
  fromPostgresJs,
  type PostgresDriver,
  type PostgresQueryable,
} from "../src/index";
import { PG_URL, clearSchema, postgresAvailable, resetSchema } from "./support/postgres-env";

/** Fails every insert into a resource table, after the batch's delete has already run. */
function failingInserts(driver: PostgresDriver): PostgresDriver {
  const wrap = (db: PostgresQueryable): PostgresQueryable => ({
    query: (sql, params) =>
      /INSERT INTO "searchfn_\w+"\."searchfn_docs_/.test(sql)
        ? Promise.reject(Object.assign(new Error("check constraint violated"), { code: "23514" }))
        : db.query(sql, params),
  });
  return { query: (sql, params) => driver.query(sql, params), transaction: (fn) => driver.transaction!((tx) => fn(wrap(tx))) };
}

const bindings = [
  {
    name: "postgres.js",
    schema: "searchfn_it_pgjs",
    open: () => {
      const sql = postgres(PG_URL, { max: 5, fetch_types: false });
      return { driver: fromPostgresJs(sql), close: () => sql.end() };
    },
  },
  {
    name: "fromPg",
    schema: "searchfn_it_pg",
    open: () => {
      const pool = new Pool({ connectionString: PG_URL });
      return { driver: fromPg(pool), close: () => pool.end() };
    },
  },
];

describe.each(bindings)("PostgresAdapter with $name", ({ schema, open }) => {
  let available = false;
  let connection: ReturnType<typeof open>;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    available = await postgresAvailable();
    if (!available) return;
    await resetSchema(schema);
    connection = open();
  });

  afterAll(async () => {
    await connection?.close();
  });

  beforeEach(async (ctx) => {
    if (!available) return ctx.skip();
    await clearSchema(schema);
    adapter = new PostgresAdapter({ driver: connection.driver, schema, retry: { maxRetries: 0 } });
    await adapter.initialize({ resources: [{ name: "notes", searchFields: ["title", "body"] }] });
  });

  it("stores searchFields as a text[] in the meta table", async () => {
    const { rows } = await connection.driver.query<{ search_fields: string[] }>(
      `SELECT array_to_json(search_fields) AS search_fields FROM "${schema}".searchfn_meta WHERE resource = $1`,
      ["notes"],
    );
    expect(rows).toEqual([{ search_fields: ["title", "body"] }]);
  });

  it("round-trips field names that need escaping and filters search by field", async () => {
    const fields = ["title", 'quote"d', "comma,field", "back\\slash"];
    await adapter.initialize({ resources: [{ name: "escaped", searchFields: fields }] });
    const { rows } = await connection.driver.query<{ search_fields: string[] }>(
      `SELECT array_to_json(search_fields) AS search_fields FROM "${schema}".searchfn_meta WHERE resource = $1`,
      ["escaped"],
    );
    expect(rows).toEqual([{ search_fields: fields }]);

    await adapter.index({
      resource: "escaped",
      documents: [
        { id: 1, fields: { title: "alpha", 'quote"d': "beta" } },
        { id: 2, fields: { title: "beta", "comma,field": "alpha" } },
      ],
    });
    expect(await adapter.search({ resource: "escaped", query: "alpha", fields: ["title"] })).toEqual([1]);
    expect(await adapter.search({ resource: "escaped", query: "beta", fields: ['quote"d'] })).toEqual([1]);
    expect(await adapter.search({ resource: "escaped", query: "alpha", fields: ["comma,field", "title"] })).toEqual([1, 2]);
  });

  it("rolls back the delete when an insert in the same index batch fails", async () => {
    await adapter.index({ resource: "notes", documents: [{ id: "n1", fields: { title: "original" } }] });

    const failing = new PostgresAdapter({ driver: failingInserts(connection.driver), schema, retry: { maxRetries: 0 } });
    await expect(
      failing.index({ resource: "notes", documents: [{ id: "n1", fields: { title: "replacement" } }] }),
    ).rejects.toThrow(/check constraint violated/);

    expect(await adapter.search({ resource: "notes", query: "original" })).toEqual(["n1"]);
    expect(await adapter.search({ resource: "notes", query: "replacement" })).toEqual([]);
  });

  it("returns numeric ids, numeric scores and empty results for an undeclared resource", async () => {
    await adapter.index({
      resource: "notes",
      documents: [
        { id: 10, fields: { title: "workers hyperdrive", body: "workers" } },
        { id: "a", fields: { title: "workers" } },
      ],
    });
    expect(await adapter.search({ resource: "notes", query: "workers" })).toEqual([10, "a"]);

    const all = await adapter.searchAll({ query: "hyper", prefix: true });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ resource: "notes", id: 10 });
    expect(all[0].score).toBeGreaterThan(0);

    expect(await adapter.search({ resource: "never_declared", query: "workers" })).toEqual([]);
    await expect(adapter.remove({ resource: "never_declared", ids: [1] })).resolves.toBeUndefined();
  });

  it("indexes resources whose table name is shortened with a hash", async () => {
    const resource = `bookmarks_${"x".repeat(80)}`;
    await adapter.initialize({ resources: [{ name: resource, searchFields: ["title"] }] });
    await adapter.index({ resource, documents: [{ id: 1, fields: { title: "long table" } }] });
    expect(await adapter.search({ resource, query: "long" })).toEqual([1]);
  });

  it("reads and writes the same tables as a connectionString adapter", async () => {
    const owned = new PostgresAdapter({ connectionString: PG_URL, schema, retry: { maxRetries: 0 } });
    try {
      await owned.initialize({ resources: [{ name: "notes", searchFields: ["title", "body"] }] });
      await owned.index({ resource: "notes", documents: [{ id: "from-pg", fields: { title: "shared storage" } }] });
      await adapter.index({ resource: "notes", documents: [{ id: "injected", fields: { title: "shared storage" } }] });

      expect(await adapter.search({ resource: "notes", query: "shared" })).toEqual(["from-pg", "injected"]);
      expect(await owned.search({ resource: "notes", query: "shared" })).toEqual(["from-pg", "injected"]);
    } finally {
      await owned.dispose();
    }
  });

  it("leaves the caller's client open after dispose", async () => {
    await adapter.dispose();
    expect(await connection.driver.query<{ ok: number }>("SELECT 1 AS ok")).toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("postgres.js connection errors", () => {
  it("surfaces a refused connection as a redacted SearchAdapterError", async () => {
    const sql = postgres("postgres://searchfn:hunter2-secret@127.0.0.1:1/searchfn_test", { max: 1, connect_timeout: 2 });
    try {
      const adapter = new PostgresAdapter({ driver: fromPostgresJs(sql), retry: { maxRetries: 0 } });
      const error = await adapter.search({ resource: "notes", query: "q" }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "SearchAdapterError", code: "INTERNAL" });
      expect((error as Error).message).toMatch(/^Postgres operation failed: .*ECONNREFUSED/);
      expect((error as Error).message).not.toContain("hunter2-secret");
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});

