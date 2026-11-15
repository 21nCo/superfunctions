/**
 * DATA-15: cloneUp pushes parents before children, so a server whose tables
 * enforce foreign keys accepts every batch. The server is `@datafn/server`
 * on the Drizzle SQLite adapter over better-sqlite3, with the tables
 * `@datafn/cli` generates for the schema and `PRAGMA foreign_keys = ON`.
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
    // Listed before the folders they reference: cloneUp must not use schema order.
    {
      name: "files",
      version: 1,
      fields: [
        { name: "title", type: "string", required: true },
        { name: "folderId", type: "string", required: false, nullable: true },
      ],
    },
    {
      name: "folders",
      version: 1,
      fields: [
        { name: "name", type: "string", required: true },
        { name: "parentId", type: "string", required: false, nullable: true },
        { name: "parentPath", type: "string", required: false, nullable: true },
      ],
    },
    {
      name: "links",
      version: 1,
      fields: [
        { name: "label", type: "string", required: true },
        { name: "peerId", type: "string", required: false, nullable: true },
      ],
    },
    // A reference that must always be set.
    {
      name: "nodes",
      version: 1,
      fields: [
        { name: "label", type: "string", required: true },
        { name: "peerId", type: "string", required: true, nullable: false },
      ],
    },
  ],
  relations: [
    {
      from: "folders",
      to: "folders",
      type: "htree",
      relation: "children",
      inverse: "parent",
      fkField: "parentId",
      pathField: "parentPath",
    },
    {
      from: "files",
      to: "folders",
      type: "many-one",
      relation: "folder",
      inverse: "files",
      fkField: "folderId",
    },
    {
      from: "links",
      to: "links",
      type: "many-one",
      relation: "peer",
      inverse: "peers",
      fkField: "peerId",
    },
    {
      from: "nodes",
      to: "nodes",
      type: "many-one",
      relation: "peer",
      inverse: "peers",
      fkField: "peerId",
    },
  ],
};

// Inside node_modules so the generated module resolves drizzle-orm like this test does.
const cacheDir = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));
mkdirSync(cacheDir, { recursive: true });
const workDir = mkdtempSync(join(cacheDir, "datafn-cloneup-fk-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function loadGeneratedTables(): Promise<{
  tables: SQLiteTable[];
  drizzleSchema: Record<string, unknown>;
}> {
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

/** CREATE statements with primary keys, indexes and foreign keys, as drizzle-kit migrates them. */
function createTableStatements(tables: SQLiteTable[]): string[] {
  return tables.flatMap((table) => {
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
      const onDelete = foreignKey.onDelete ? ` ON DELETE ${foreignKey.onDelete}` : "";
      definitions.push(
        `FOREIGN KEY (${reference.columns.map((column) => quote(column.name)).join(", ")}) ` +
          `REFERENCES ${quote(getTableConfig(reference.foreignTable).name)} ` +
          `(${reference.foreignColumns.map((column) => quote(column.name)).join(", ")})${onDelete}`,
      );
    }
    const statements = [`CREATE TABLE ${quote(config.name)} (${definitions.join(", ")})`];
    for (const idx of config.indexes) {
      const { name, unique, columns } = idx.config;
      const columnList = columns.map((column) => quote((column as { name: string }).name)).join(", ");
      statements.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(config.name)} (${columnList})`);
    }
    return statements;
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
    clientId: "client:fk",
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

/** Rows straight from SQLite; codegen stores camelCase fields in snake_case columns. */
function rows(table: string): Array<Record<string, unknown>> {
  return sqlite.prepare(`SELECT * FROM ${quote(table)} ORDER BY "id"`).all() as Array<Record<string, unknown>>;
}

describe("DATA-15: cloneUp against SQLite with foreign keys", () => {
  it("rejects a child before its parent, so the ordering is what makes the push pass", async () => {
    expect(foreignKeyCount).toBeGreaterThanOrEqual(3);
    const response = await server.router.handle(
      new Request("http://datafn.test/datafn/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: "probe",
          mutations: [
            {
              resource: "files",
              version: 1,
              operation: "merge",
              id: "files:orphan",
              clientId: "probe",
              mutationId: "probe-1",
              record: { title: "Orphan", folderId: "folders:missing" },
            },
          ],
        }),
      }),
    );
    const body = (await response.json()) as any;
    const rejected = body.ok === false || body.result?.ok === false || (body.result?.errors ?? []).length > 0;
    expect(rejected).toBe(true);
    expect(rows("files")).toEqual([]);
  });

  it("pushes a folder tree and files whose ids sort child-first", async () => {
    const storage = new MemoryStorageAdapter(["files", "folders", "links", "nodes"]);
    // Ids sort child before parent: "folders:a" < "folders:m" < "folders:z".
    await storage.upsertRecord("folders", {
      id: "folders:a",
      name: "Leaf",
      parentId: "folders:m",
      parentPath: "folders:z-folders:m",
    });
    await storage.upsertRecord("folders", {
      id: "folders:m",
      name: "Middle",
      parentId: "folders:z",
      parentPath: "folders:z",
    });
    await storage.upsertRecord("folders", { id: "folders:z", name: "Root", parentId: null, parentPath: "" });
    await storage.upsertRecord("files", { id: "files:1", title: "In leaf", folderId: "folders:a" });
    await storage.upsertRecord("files", { id: "files:2", title: "In root", folderId: "folders:z" });

    const { client, pushes } = connect(storage);
    const result = await client.sync.cloneUp({ pullAfter: false, batchSize: 2 });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);

    const order = pushes.flatMap((push) => push.mutations).map((mutation) => mutation.id);
    expect(order).toEqual(["folders:z", "folders:m", "folders:a", "files:1", "files:2"]);
    expect(pushes.flatMap((push) => push.mutations).every((m) => m.operation === "merge")).toBe(true);

    expect(rows("folders").map((row) => [row.id, row.parent_id ?? null, row.parent_path ?? ""])).toEqual([
      ["folders:a", "folders:m", "folders:z-folders:m"],
      ["folders:m", "folders:z", "folders:z"],
      ["folders:z", null, ""],
    ]);
    expect(rows("files").map((row) => [row.id, row.folder_id])).toEqual([
      ["files:1", "folders:a"],
      ["files:2", "folders:z"],
    ]);
  });

  it("pushes a two-record reference cycle by setting one reference afterwards", async () => {
    const storage = new MemoryStorageAdapter(["files", "folders", "links", "nodes"]);
    await storage.upsertRecord("links", { id: "links:a", label: "A", peerId: "links:b" });
    await storage.upsertRecord("links", { id: "links:b", label: "B", peerId: "links:a" });

    const { client, pushes } = connect(storage);
    const result = await client.sync.cloneUp({ pullAfter: false });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const sent = pushes.flatMap((push) => push.mutations);
    expect(sent.map((mutation) => [mutation.id, mutation.record])).toEqual([
      ["links:b", { label: "B", peerId: null }],
      ["links:a", { label: "A", peerId: "links:b" }],
      ["links:b", { peerId: "links:a" }],
    ]);
    expect(sent[2].mutationId).toMatch(/^cloneup:ref:links:links:b:/);
    expect(rows("links").map((row) => [row.id, row.peer_id])).toEqual([
      ["links:a", "links:b"],
      ["links:b", "links:a"],
    ]);
  });

  it("restores a cycle reference again when the record pushed without it changes", async () => {
    const storage = new MemoryStorageAdapter(["files", "folders", "links", "nodes"]);
    await storage.upsertRecord("links", { id: "links:a", label: "A", peerId: "links:b" });
    await storage.upsertRecord("links", { id: "links:b", label: "B", peerId: "links:a" });

    const { client, pushes } = connect(storage);
    expect((await client.sync.cloneUp({ pullAfter: false })).ok).toBe(true);
    const firstRestore = pushes.flatMap((push) => push.mutations)[2];

    // links:b went up with its reference unset; edit it and clone up again.
    await storage.upsertRecord("links", { id: "links:b", label: "B2", peerId: "links:a" });
    pushes.length = 0;
    const second = await client.sync.cloneUp({ pullAfter: false });
    expect(second.errors).toEqual([]);
    expect(second.ok).toBe(true);

    const restore = pushes.flatMap((push) => push.mutations).find((m) => /:ref:/.test(m.mutationId));
    expect(restore?.record).toEqual({ peerId: "links:a" });
    expect(restore?.mutationId).not.toBe(firstRestore.mutationId);
    expect(rows("links").map((row) => [row.id, row.label, row.peer_id])).toEqual([
      ["links:a", "A", "links:b"],
      ["links:b", "B2", "links:a"],
    ]);
  });

  it("pushes a record that references itself as it is", async () => {
    const storage = new MemoryStorageAdapter(["files", "folders", "links", "nodes"]);
    await storage.upsertRecord("nodes", { id: "nodes:1", label: "One", peerId: "nodes:1" });
    await storage.upsertRecord("links", { id: "links:1", label: "Self", peerId: "links:1" });

    const { client, pushes } = connect(storage);
    const result = await client.sync.cloneUp({ pullAfter: false });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const sent = pushes.flatMap((push) => push.mutations);
    expect(sent.map((mutation) => [mutation.id, mutation.record])).toEqual([
      ["links:1", { label: "Self", peerId: "links:1" }],
      ["nodes:1", { label: "One", peerId: "nodes:1" }],
    ]);
    expect(rows("nodes").map((row) => [row.id, row.peer_id])).toEqual([["nodes:1", "nodes:1"]]);
  });

  it("never unsets a non-nullable reference in a cycle", async () => {
    const storage = new MemoryStorageAdapter(["files", "folders", "links", "nodes"]);
    // Both records already exist on the server, each pointing at itself.
    await storage.upsertRecord("nodes", { id: "nodes:a", label: "A", peerId: "nodes:a" });
    await storage.upsertRecord("nodes", { id: "nodes:b", label: "B", peerId: "nodes:b" });
    const { client, pushes } = connect(storage);
    expect((await client.sync.cloneUp({ pullAfter: false })).ok).toBe(true);

    // Locally they now point at each other.
    await storage.upsertRecord("nodes", { id: "nodes:a", label: "A", peerId: "nodes:b" });
    await storage.upsertRecord("nodes", { id: "nodes:b", label: "B", peerId: "nodes:a" });
    pushes.length = 0;
    const result = await client.sync.cloneUp({ pullAfter: false });

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const sent = pushes.flatMap((push) => push.mutations);
    expect(sent.every((mutation) => !/:ref:/.test(mutation.mutationId))).toBe(true);
    expect(sent.every((mutation) => typeof mutation.record.peerId === "string")).toBe(true);
    expect(rows("nodes").map((row) => [row.id, row.peer_id])).toEqual([
      ["nodes:a", "nodes:b"],
      ["nodes:b", "nodes:a"],
    ]);
  });

  it("reports the server's rejection for a new non-nullable cycle instead of unsetting it", async () => {
    const storage = new MemoryStorageAdapter(["files", "folders", "links", "nodes"]);
    await storage.upsertRecord("nodes", { id: "nodes:a", label: "A", peerId: "nodes:b" });
    await storage.upsertRecord("nodes", { id: "nodes:b", label: "B", peerId: "nodes:a" });

    const { client, pushes } = connect(storage);
    const result = await client.sync.cloneUp({ pullAfter: false });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "REFERENCE_CYCLE",
        path: "record.peerId",
        message: expect.stringContaining("nodes nodes:b was sent with peerId = nodes:a"),
      }),
    );
    // The server named the rejected record, so the cycle is not offered as a guess.
    expect(result.errors.some((error) => /may be why/.test(error.message))).toBe(false);
    const sent = pushes.flatMap((push) => push.mutations);
    expect(sent.every((mutation) => mutation.record?.peerId !== null)).toBe(true);
    expect(rows("nodes")).toEqual([]);
  });
});
