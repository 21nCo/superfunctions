/**
 * Shared fixture for the Drizzle SQLite conformance suite.
 *
 * The tables below are the `@datafn/cli` drizzle-codegen output for
 * `conformanceSchema` with dialect "sqlite", which is what the Cloudflare
 * Workers deploy guide migrates into D1.
 */

import { customType, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { getTableConfig, SQLiteSyncDialect, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { is, SQL, sql } from "drizzle-orm";
import type { DatafnSchema } from "@datafn/core";

export const conformanceSchema: DatafnSchema = {
  resources: [
    {
      name: "project",
      version: 1,
      fields: [{ name: "name", type: "string", required: true }],
    },
    {
      name: "task",
      version: 1,
      fields: [
        { name: "title", type: "string", required: true },
        { name: "priority", type: "number", required: true },
        { name: "done", type: "boolean", required: true },
        { name: "projectId", type: "string", required: false, nullable: true },
        { name: "meta", type: "object", required: false, nullable: true },
        { name: "labels", type: "array", required: false, nullable: true },
        { name: "status", type: "json", required: false, nullable: true, default: "open" },
      ],
    },
    {
      name: "tag",
      version: 1,
      fields: [{ name: "label", type: "string", required: true }],
    },
  ],
  relations: [
    { from: "task", to: "project", type: "many-one", relation: "project", inverse: "tasks", fkField: "projectId" },
    { from: "task", to: "tag", type: "many-many", relation: "tags", inverse: "tasks" },
  ],
};

// BEGIN GENERATED: @datafn/cli generateDrizzleSchema(conformanceSchema, "sqlite")

const datafnBoolean = customType<{ data: boolean; driverData: number | string }>({
  dataType: () => "integer",
  toDriver: (value) => (typeof value === "boolean" ? Number(value) : JSON.stringify(value)),
  fromDriver: (value) => (typeof value === "string" ? JSON.parse(value) : Number(value) !== 0),
});

export const datafnTimezoneChange = sqliteTable("datafnTimezoneChange", {
  __ns: text("__ns").notNull(),
  effectiveFrom: integer("effective_from").notNull(),
  id: text("id").notNull(),
  recordedAt: integer("recorded_at").notNull(),
  source: text("source"),
  timezone: text("timezone").notNull(),
}, (table) => [
  primaryKey({ columns: [table.__ns, table.id] }),
  index("idx_datafnTimezoneChange___ns").on(table.__ns),
]);

export const kv = sqliteTable("kv", {
  __ns: text("__ns").notNull(),
  id: text("id").notNull(),
  value: text("value", { mode: "json" }),
}, (table) => [
  primaryKey({ columns: [table.__ns, table.id] }),
  index("idx_kv___ns").on(table.__ns),
]);

export const project = sqliteTable("project", {
  __ns: text("__ns").notNull(),
  id: text("id").notNull(),
  name: text("name").notNull(),
}, (table) => [
  primaryKey({ columns: [table.__ns, table.id] }),
  index("idx_project___ns").on(table.__ns),
]);

export const tag = sqliteTable("tag", {
  __ns: text("__ns").notNull(),
  id: text("id").notNull(),
  label: text("label").notNull(),
}, (table) => [
  primaryKey({ columns: [table.__ns, table.id] }),
  index("idx_tag___ns").on(table.__ns),
]);

export const task = sqliteTable("task", {
  __ns: text("__ns").notNull(),
  done: datafnBoolean("done").notNull(),
  id: text("id").notNull(),
  labels: text("labels", { mode: "json" }),
  meta: text("meta", { mode: "json" }),
  priority: integer("priority").notNull(),
  projectId: text("project_id"),
  status: text("status", { mode: "json" }).default(sql.raw("'\"open\"'")),
  title: text("title").notNull(),
}, (table) => [
  primaryKey({ columns: [table.__ns, table.id] }),
  index("idx_task___ns").on(table.__ns),
  index("task_project_id_rel_idx").on(table.__ns, table.projectId),
]);

export const __datafn_changes = sqliteTable("__datafn_changes", {
  id: text("id").primaryKey(),
  namespace: text("namespace"),
  server_seq: integer("server_seq"),
  resource: text("resource"),
  record_id: text("record_id"),
  op: text("op"),
  record: text("record"),
  created_at: text("created_at"),
}, (table) => [
  index("__datafn_changes_namespace_server_seq_idx").on(table.namespace, table.server_seq),
]);

export const __datafn_idempotency = sqliteTable("__datafn_idempotency", {
  id: text("id").primaryKey(),
  namespace: text("namespace"),
  client_id: text("client_id"),
  mutation_id: text("mutation_id"),
  result: text("result"),
  created_at: text("created_at"),
}, (table) => [
  index("__datafn_idempotency_namespace_client_mutation_idx").on(table.namespace, table.client_id, table.mutation_id),
]);

export const __datafn_meta = sqliteTable("__datafn_meta", {
  id: text("id").primaryKey(),
  namespace: text("namespace"),
  next_server_seq: integer("next_server_seq"),
});

export const __datafn_seed = sqliteTable("__datafn_seed", {
  id: text("id").primaryKey(),
  namespace: text("namespace"),
  seed_id: text("seed_id"),
  status: text("status"),
  created_at: text("created_at"),
}, (table) => [
  index("__datafn_seed_namespace_seed_idx").on(table.namespace, table.seed_id),
]);

export const __datafn_join_task_tags = sqliteTable("__datafn_join_task_tags", {
  __ns: text("__ns").notNull(),
  from: text("from").notNull(),
  id: text("id").notNull(),
  to: text("to").notNull(),
}, (table) => [
  primaryKey({ columns: [table.__ns, table.id] }),
  index("idx___datafn_join_task_tags___ns").on(table.__ns),
  uniqueIndex("__datafn_join_task_tags_from_to_idx").on(table.__ns, table.from, table.to),
  index("__datafn_join_task_tags_from_idx").on(table.__ns, table.from),
  index("__datafn_join_task_tags_to_idx").on(table.__ns, table.to),
]);

export const schema = { __datafn_changes, __datafn_idempotency, __datafn_join_task_tags, __datafn_meta, __datafn_seed, datafnTimezoneChange, kv, project, tag, task };

// END GENERATED

export const drizzleSchema = schema;

/**
 * The upgrade the codegen docs give for JSON columns written by `@datafn/cli`
 * 0.1.1 and earlier, which stored plain text. fixture.test.ts keeps the docs in sync.
 */
export const legacyJsonUpgradeSql = `UPDATE "kv" SET "value" = json_quote("value") WHERE "value" IS NOT NULL;`;

/** Tables owned by application resources; internal `__datafn_*` tables are excluded. */
export const resourceTables: SQLiteTable[] = [datafnTimezoneChange, kv, project, tag, task, __datafn_join_task_tags];

/** Every table drizzle-kit would migrate from the generated schema. */
export const allTables: SQLiteTable[] = Object.values(drizzleSchema);

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const dialect = new SQLiteSyncDialect();

/**
 * Derives the CREATE statements drizzle-kit would emit for these tables, one
 * statement per entry so D1 can run them through `batch()`.
 */
export function createTableStatements(tables: SQLiteTable[]): string[] {
  return tables.flatMap((table) => {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      const constraints = column.primary ? " PRIMARY KEY" : column.notNull ? " NOT NULL" : "";
      // drizzle-kit writes an SQL default verbatim; codegen emits only SQL defaults for JSON columns.
      const defaultClause = is(column.default, SQL) ? ` DEFAULT ${dialect.sqlToQuery(column.default).sql}` : "";
      return `${quote(column.name)} ${column.getSQLType()}${constraints}${defaultClause}`;
    });
    for (const key of config.primaryKeys) {
      columns.push(`PRIMARY KEY (${key.columns.map((column) => quote(column.name)).join(", ")})`);
    }
    const statements = [`CREATE TABLE ${quote(config.name)} (${columns.join(", ")})`];
    for (const idx of config.indexes) {
      const { name, unique, columns: indexColumns } = idx.config;
      const columnList = indexColumns.map((column) => quote((column as { name: string }).name)).join(", ");
      statements.push(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${quote(name)} ON ${quote(config.name)} (${columnList})`);
    }
    return statements;
  });
}
