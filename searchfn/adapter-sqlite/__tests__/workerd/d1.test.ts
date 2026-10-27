/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SqliteAdapter, fromD1, type SqliteDriver } from "../../src/index";

let run = 0;

function adapterOn(driver: SqliteDriver, prefix: string): SqliteAdapter {
  return new SqliteAdapter({ driver, tablePrefix: prefix });
}

async function generation(driver: SqliteDriver, prefix: string, resource: string): Promise<number> {
  const [row] = await driver.all<{ generation: number }>(
    `SELECT generation FROM "${prefix}_resources" WHERE resource = ?`,
    [resource],
  );
  return row.generation;
}

describe("SqliteAdapter on D1 (workerd)", () => {
  it("indexes 1,000 documents in one call and answers prefix queries with a namespace filter", async () => {
    const driver = fromD1(env.DB);
    const prefix = `d1t${++run}`;
    const adapter = adapterOn(driver, prefix);
    await adapter.initialize({ resources: [{ name: "bookmarks", searchFields: ["title", "body"] }] });
    await adapter.index({
      resource: "bookmarks",
      documents: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        fields: { title: i === 7 ? "Subset bookmarks" : `entry ${i}`, body: i % 5 === 0 ? "subscription" : "misc" },
        metadata: { __ns: i % 2 === 0 ? "ns-a" : "ns-b" },
      })),
    });

    const [count] = await driver.all<{ n: number }>(`SELECT count(*) AS n FROM "${prefix}_r1_docs"`);
    expect(count.n).toBe(1000);
    const ids = await adapter.search({ resource: "bookmarks", query: "sub", prefix: true, namespaceFilter: ["ns-b"], limit: 500 });
    expect(ids).toHaveLength(101);
    expect(ids).toContain(7);
    expect(ids.every((id) => typeof id === "number" && id % 2 === 1)).toBe(true);
    expect(await adapter.search({ resource: "bookmarks", query: "subset bookmarks", fieldBoosts: { title: 5 } })).toEqual([7]);
  });

  it("rolls back a failed D1 batch", async () => {
    const driver = fromD1(env.DB);
    await driver.exec("CREATE TABLE IF NOT EXISTS atomic_probe (label TEXT)");
    await expect(
      driver.batch!([
        { sql: "INSERT INTO atomic_probe (label) VALUES (?)", params: ["kept?"] },
        { sql: "INSERT INTO missing_table (label) VALUES (?)", params: ["boom"] },
      ]),
    ).rejects.toThrow(/missing_table/);
    expect(await driver.all("SELECT label FROM atomic_probe")).toEqual([]);
  });

  it("breaks score ties by id in code point order, the same before and after the merge", async () => {
    const prefix = `d1t${++run}`;
    const adapter = adapterOn(fromD1(env.DB), prefix);
    await adapter.initialize({ resources: [{ name: "a", searchFields: ["title"] }] });
    const ids = ["\u{10000}", "\uE000"];
    await adapter.index({ resource: "a", documents: ids.map((id) => ({ id, fields: { title: "same text" } })) });
    expect(await adapter.search({ resource: "a", query: "same", limit: 1 })).toEqual(["\uE000"]);
    expect((await adapter.searchAll({ query: "same" })).map((result) => result.id)).toEqual(["\uE000", "\u{10000}"]);
  });

  it("rebuilds idempotently and lets a stale instance reload the new generation", async () => {
    const driver = fromD1(env.DB);
    const prefix = `d1t${++run}`;
    const writer = adapterOn(driver, prefix);
    const reader = adapterOn(driver, prefix);
    await writer.initialize({ resources: [{ name: "notes", searchFields: ["title"] }] });
    await writer.index({ resource: "notes", documents: [{ id: "n1", fields: { title: "alpha", body: "beta" } }] });
    expect(await reader.search({ resource: "notes", query: "alpha" })).toEqual(["n1"]);

    await writer.initialize({ resources: [{ name: "notes", searchFields: ["title", "body"] }] });
    await writer.initialize({ resources: [{ name: "notes", searchFields: ["body", "title"] }] });
    expect(await generation(driver, prefix, "notes")).toBe(1);

    expect(await reader.search({ resource: "notes", query: "beta" })).toEqual(["n1"]);
    await reader.rebuild("notes");
    await reader.rebuild("notes");
    expect(await generation(driver, prefix, "notes")).toBe(3);
    expect(await writer.search({ resource: "notes", query: "beta" })).toEqual(["n1"]);

    await writer.remove({ resource: "notes", ids: ["n1"] });
    await writer.remove({ resource: "notes", ids: ["n1"] });
    expect(await reader.search({ resource: "notes", query: "alpha" })).toEqual([]);
  });

  it("keeps stale instances off a retired generation that still exists and drops it on rebuild", async () => {
    const driver = fromD1(env.DB);
    const prefix = `d1t${++run}`;
    const writer = adapterOn(driver, prefix);
    const reader = adapterOn(driver, prefix);
    await writer.initialize({ resources: [{ name: "notes", searchFields: ["title"] }] });
    await writer.index({ resource: "notes", documents: [{ id: "n1", fields: { title: "alpha" } }] });
    expect(await reader.search({ resource: "notes", query: "alpha" })).toEqual(["n1"]);
    await writer.rebuild("notes");
    await driver.exec(`CREATE VIRTUAL TABLE "${prefix}_r1_fts_0" USING fts5(c0)`);

    expect(await reader.search({ resource: "notes", query: "alpha" })).toEqual(["n1"]);
    await reader.index({ resource: "notes", documents: [{ id: "n2", fields: { title: "gamma" } }] });
    expect(await writer.search({ resource: "notes", query: "gamma" })).toEqual(["n2"]);

    await writer.rebuild("notes");
    const tables = await driver.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`,
      [`${prefix}_r1_fts_0`, `${prefix}_r1_fts_1`, `${prefix}_r1_fts_2`],
    );
    expect(tables.map((table) => table.name)).toEqual([`${prefix}_r1_fts_2`]);
  });
});
