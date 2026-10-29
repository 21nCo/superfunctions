import Database from "better-sqlite3";
import { createClient, type Client } from "@libsql/client";
import { fromBetterSqlite3, fromLibsql, type SqliteDriver } from "../src/index";

export interface TestDatabase {
  driver: SqliteDriver;
  close(): void;
}

export function betterSqlite(): TestDatabase {
  const db = new Database(":memory:");
  return { driver: fromBetterSqlite3(db), close: () => db.close() };
}

export function libsql(): TestDatabase & { client: Client } {
  const client = createClient({ url: ":memory:" });
  return { client, driver: fromLibsql(client), close: () => client.close() };
}

/** Count rows of an adapter-owned table, resolved through the resources table. */
export async function countRows(
  driver: SqliteDriver,
  resource: string,
  kind: "docs" | "fts",
  prefix = "searchfn",
): Promise<number> {
  const [row] = await driver.all<{ id: number; generation: number }>(
    `SELECT id, generation FROM "${prefix}_resources" WHERE resource = ?`,
    [resource],
  );
  const table = kind === "docs" ? `${prefix}_r${row.id}_docs` : `${prefix}_r${row.id}_fts_${row.generation}`;
  const [count] = await driver.all<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`);
  return Number(count.n);
}

export async function generationOf(driver: SqliteDriver, resource: string, prefix = "searchfn"): Promise<number> {
  const [row] = await driver.all<{ generation: number }>(
    `SELECT generation FROM "${prefix}_resources" WHERE resource = ?`,
    [resource],
  );
  return Number(row.generation);
}

/** Names of the FTS tables (not FTS5 shadow tables) that exist, in generation order. */
export async function ftsTables(driver: SqliteDriver, prefix = "searchfn"): Promise<string[]> {
  const rows = await driver.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  const pattern = new RegExp(`^${prefix}_r\\d+_fts_\\d+$`);
  return rows
    .map((row) => String(row.name))
    .filter((name) => pattern.test(name))
    .sort((left, right) => Number(left.split("_").pop()) - Number(right.split("_").pop()));
}
