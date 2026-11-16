/**
 * DATA-19: a `null` stored for a non-nullable field means "not set" for the
 * upload order too, not only for the uploaded record. A defaulted,
 * non-nullable reference stored as `null` is sent without the field, so the
 * server fills its default; the referenced resource must then go up first,
 * exactly as for a record stored without the field. The server is
 * `@datafn/server` on the Drizzle SQLite adapter over better-sqlite3, with the
 * tables `@datafn/cli` generates for the schema and `PRAGMA foreign_keys = ON`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatafnSchema } from "@datafn/core";
// @datafn/server resolves to its source through the alias in vitest.config.ts.
import { createDatafnServer } from "@datafn/server";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
// The codegen source, so the test needs no cli build.
import { generateDrizzleSchema } from "../../cli/src/drizzle-codegen.js";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";

const schema: DatafnSchema = {
  // Codegen emits FOREIGN KEY constraints only in database integrity mode.
  relationIntegrity: "database",
  resources: [
    // Listed before the owners it references: only the reference in use can
    // put owners first.
    {
      name: "items",
      version: 1,
      fields: [
        { name: "label", type: "string", required: true },
        // Optional and not nullable; the server fills the default when unset.
        { name: "ownerId", type: "string", required: false, default: "owners:default" },
      ],
    },
    {
      name: "owners",
      version: 1,
      fields: [{ name: "name", type: "string", required: true }],
    },
  ],
  relations: [
    { from: "items", to: "owners", type: "many-one", relation: "owner", inverse: "items", fkField: "ownerId" },
  ],
};

// Inside node_modules so the generated module resolves drizzle-orm like this test does.
const cacheDir = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
mkdirSync(cacheDir, { recursive: true });
const workDir = mkdtempSync(join(cacheDir, "datafn-cloneup-null-fk-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function loadGeneratedTables(): Promise<{ tables: SQLiteTable[]; drizzleSchema: Record<string, unknown> }> {
  const source = generateDrizzleSchema(schema, "sqlite");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = join(workDir, `schema-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, outputText);
  const generated = (await import(pathToFileURL(file).href)) as { schema: Record<string, unknown> };
  return {
    tables: Object.values(generated.schema).filter((value): value is SQLiteTable => is(value, SQLiteTable)),
    drizzleSchema: generated.schema,
  };
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const dialect = new SQLiteSyncDialect();

/** CREATE statements with primary keys and foreign keys, as drizzle-kit migrates them. */
function createTableStatements(tables: SQLiteTable[]): string[] {
  return tables.map((table) => {
    const config = getTableConfig(table);
    const definitions = config.columns.map((column) => {
      const constraints = column.primary ? " PRIMARY KEY" : column.notNull ? " NOT NULL" : "";
      const defaultClause = is(column.default, SQL) ? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}` : "";
      return `${quote(column.name)} ${column.getSQLType()}${constraints}${defaultClause}`;
    });
    for (const key of config.primaryKeys) {
      definitions.push(`PRIMARY KEY (${key.columns.map((column) => quote(column.name)).join(", ")})`);
    }
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      definitions.push(
        `FOREIGN KEY (${reference.columns.map((column) => quote(column.name)).join(", ")}) ` +
          `REFERENCES ${quote(getTableConfig(reference.foreignTable).name)} ` +
          `(${reference.foreignColumns.map((column) => quote(column.name)).join(", ")})`,
      );
    }
    return `CREATE TABLE ${quote(config.name)} (${definitions.join(", ")})`;
  });
}

type Server = Awaited<ReturnType<typeof createDatafnServer>>;

let sqlite: Database.Database;
let server: Server;
let foreignKeyCount = 0;
const clients: Array<ReturnType<typeof createDatafnClient>> = [];

beforeEach(async () => {
  const { tables, drizzleSchema } = await loadGeneratedTables();
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const statement of createTableStatements(tables)) sqlite.exec(statement);
  foreignKeyCount = tables.reduce((sum, table) => sum + getTableConfig(table).foreignKeys.length, 0);
  server = await createDatafnServer({
    schema,
    db: drizzleAdapter({ db: drizzle(sqlite, { schema: drizzleSchema }), dialect: "sqlite" }),
    authorize: async () => true,
    allowUnknownResources: true,
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.sync.stop();
  await server.close();
  sqlite.close();
});

function connect(storage: MemoryStorageAdapter) {
  const pushes: Array<{ mutations: Array<Record<string, any>> }> = [];
  const client = createDatafnClient({
    clientId: "client:null-fk",
    schema,
    storage,
    sync: {
      offlinability: false,
      remote: "http://datafn.test/datafn",
      http: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === "/datafn/push") {
            pushes.push(await request.clone().json());
          }
          return server.router.handle(request);
        },
      },
    },
  });
  clients.push(client);
  return { client, pushes };
}

const rows = (table: string) =>
  sqlite.prepare(`SELECT * FROM ${quote(table)} ORDER BY "id"`).all() as Array<Record<string, unknown>>;

describe("DATA-19: cloneUp orders a defaulted reference stored as null like an unset one", () => {
  it.each([
    ["stored as null (Postgres pull shape)", { ownerId: null }],
    ["absent (created without the field)", {}],
  ])("uploads the default's target first when ownerId is %s", async (_label, ownerField) => {
    expect(foreignKeyCount).toBe(1);
    const storage = new MemoryStorageAdapter(["items", "owners"]);
    await storage.upsertRecord("items", { id: "items:a", label: "A", ...ownerField });
    await storage.upsertRecord("owners", { id: "owners:default", name: "Default" });

    const { client, pushes } = connect(storage);
    const result = await client.sync.cloneUp({ pullAfter: false });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);

    const mutations = pushes.flatMap((push) => push.mutations);
    expect(mutations.map((mutation) => mutation.id)).toEqual(["owners:default", "items:a"]);
    const item = mutations.find((mutation) => mutation.id === "items:a")!;
    expect(item.record).not.toHaveProperty("ownerId");

    expect(rows("owners").map((row) => row.id)).toEqual(["owners:default"]);
    expect(rows("items").map((row) => [row.id, row.owner_id])).toEqual([["items:a", "owners:default"]]);
  });
});
