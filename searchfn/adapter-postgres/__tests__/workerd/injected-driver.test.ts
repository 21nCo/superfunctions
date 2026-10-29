/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * Smoke test inside workerd: the package loads and every adapter operation runs through an
 * injected fake query function, as it would with postgres.js over Hyperdrive.
 */
import { describe, expect, it } from "vitest";
import { PostgresAdapter, fromPostgresJs, type PostgresDriver } from "../../src/index";

interface Statement {
  sql: string;
  params?: readonly unknown[];
}

function recordingDriver(searchRows: Array<{ doc_id: string; score: number }>) {
  const statements: Statement[] = [];
  const driver: PostgresDriver = {
    async query<Row>(sql: string, params?: readonly unknown[]) {
      statements.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      return { rows: (sql.includes("SELECT doc_id, score") ? searchRows : []) as Row[] };
    },
  };
  return { driver, statements };
}

describe("PostgresAdapter in workerd", () => {
  it("runs on an injected query function", async () => {
    expect(typeof navigator !== "undefined" && navigator.userAgent).toBe("Cloudflare-Workers");

    const { driver, statements } = recordingDriver([{ doc_id: "7", score: 0.9 }]);
    const adapter = new PostgresAdapter({ driver, schema: "app" });

    await adapter.initialize({ resources: [{ name: "bookmarks", searchFields: ["title", "url"] }] });
    await adapter.index({ resource: "bookmarks", documents: [{ id: 7, fields: { title: "Hyperdrive", url: "cf" } }] });
    expect(await adapter.search({ resource: "bookmarks", query: "hyper", prefix: true })).toEqual([7]);
    expect(await adapter.searchAll({ query: "hyper" })).toEqual([{ resource: "bookmarks", id: 7, score: 0.9 }]);
    await adapter.remove({ resource: "bookmarks", ids: [7] });
    await adapter.clear("bookmarks");
    await adapter.dispose();

    expect(statements.map(({ sql }) => sql.split(" ").slice(0, 2).join(" "))).toEqual([
      "CREATE TABLE",
      "CREATE TABLE",
      "CREATE INDEX",
      "INSERT INTO",
      "DELETE FROM",
      "INSERT INTO",
      "WITH query",
      "WITH query",
      "DELETE FROM",
      "DELETE FROM",
    ]);
    expect(statements[3].params).toEqual(["bookmarks", '{"title","url"}']);
    expect(statements[5].params).toEqual(["7", "title", "Hyperdrive", "7", "url", "cf"]);
    for (const { params } of statements) {
      expect((params ?? []).every((value) => typeof value === "string" || typeof value === "number")).toBe(true);
    }
  });

  it("indexes in one transaction through the postgres.js binding", async () => {
    const log: string[] = [];
    const tx = {
      unsafe: async (text: string) => {
        log.push(`tx:${text.trim().split(/\s+/).slice(0, 2).join(" ")}`);
        return [];
      },
    };
    const sql = {
      unsafe: async (text: string) => {
        log.push(`sql:${text.trim().split(/\s+/).slice(0, 2).join(" ")}`);
        return [];
      },
      begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => {
        log.push("begin");
        const result = await fn(tx);
        log.push("commit");
        return result;
      },
    };
    const adapter = new PostgresAdapter({ driver: fromPostgresJs(sql) });
    await adapter.index({ resource: "bookmarks", documents: [{ id: "a", fields: { title: "x" } }] });
    expect(log).toEqual(["begin", "tx:DELETE FROM", "tx:INSERT INTO", "commit"]);
  });
});
