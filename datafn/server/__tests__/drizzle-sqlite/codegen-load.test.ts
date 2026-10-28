import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { generateDrizzleSchema } from "@datafn/cli";

// Resource and join-table names that match the helper and import the SQLite
// boolean columns need.
const collidingSchema = {
  namespaced: false,
  resources: [
    {
      name: "datafnBoolean",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true },
        { name: "on", type: "boolean", required: false },
      ],
    },
    {
      name: "customType",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true },
        { name: "on", type: "boolean", required: false },
      ],
    },
  ],
  relations: [
    {
      from: "datafnBoolean",
      to: "customType",
      type: "many-many",
      relation: "links",
      joinTable: "datafnBoolean_2",
      metadata: [{ name: "pinned", type: "boolean", required: false }],
    },
  ],
};

// Inside node_modules so the module resolves drizzle-orm like this test does.
const cacheDir = fileURLToPath(new URL("../../node_modules/.cache/", import.meta.url));
mkdirSync(cacheDir, { recursive: true });
const workDir = mkdtempSync(join(cacheDir, "datafn-codegen-load-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function loadGeneratedSqliteSchema(schemaInput: unknown): Promise<Record<string, unknown>> {
  const source = generateDrizzleSchema(schemaInput, "sqlite");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const file = join(workDir, "schema.mjs");
  writeFileSync(file, outputText);
  return import(pathToFileURL(file).href);
}

describe("Drizzle SQLite codegen output", () => {
  it("loads and round-trips booleans when resources are named like the boolean helper", async () => {
    const generated = await loadGeneratedSqliteSchema(collidingSchema);
    const schema = generated.schema as Record<string, SQLiteTable>;
    const tables = {
      datafnBoolean: generated.datafnBoolean as SQLiteTable,
      customType: generated.customType as SQLiteTable,
      join: generated.datafnBoolean_2 as SQLiteTable,
    };
    expect(getTableConfig(tables.datafnBoolean).name).toBe("datafnBoolean");
    expect(getTableConfig(tables.customType).name).toBe("customType");
    expect(getTableConfig(tables.join).name).toBe("datafnBoolean_2");
    expect(schema.datafnBoolean).toBe(tables.datafnBoolean);
    expect(schema.customType).toBe(tables.customType);

    const sqlite = new Database(":memory:");
    try {
      for (const table of Object.values(tables)) {
        const { name, columns } = getTableConfig(table);
        sqlite.exec(`CREATE TABLE "${name}" (${columns.map((column) => `"${column.name}"`).join(", ")})`);
      }
      const db = drizzle(sqlite, { schema });
      const envelope = { __datafnE2ee: 1, alg: "AES-GCM", keyRef: "k1", iv: "aXY=", data: "Y2lwaGVy" };
      const cases = [
        { table: tables.datafnBoolean, column: "on", rows: (on: unknown) => ({ on }) },
        { table: tables.customType, column: "on", rows: (on: unknown) => ({ on }) },
        { table: tables.join, column: "pinned", rows: (pinned: unknown) => ({ from: "f", to: "t", pinned }) },
      ];
      for (const { table, column, rows } of cases) {
        await db.insert(table).values([
          { id: "a", ...rows(true) },
          { id: "b", ...rows(false) },
          { id: "c", ...rows(envelope) },
        ]);
        const { name, columns } = getTableConfig(table);
        const stored = sqlite.prepare(`SELECT "${column}" AS v FROM "${name}" ORDER BY id`).all();
        expect(stored).toEqual([{ v: 1 }, { v: 0 }, { v: JSON.stringify(envelope) }]);
        const id = columns.find((candidate) => candidate.name === "id")!;
        const read = (await db.select().from(table).orderBy(id)) as Record<string, unknown>[];
        expect(read.map((row) => row[column])).toEqual([true, false, envelope]);
      }
    } finally {
      sqlite.close();
    }
  });
});
