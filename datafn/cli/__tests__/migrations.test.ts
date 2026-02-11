/**
 * Migration Tests
 * Tests TV-MIG-001, TV-MIG-002 from TEST_VECTORS.md
 */

import { describe, it, expect } from "vitest";
import { diffSchemas } from "../src/migrations/diff.js";
import { renderPostgres } from "../src/migrations/render-postgres.js";
import { renderMySQL } from "../src/migrations/render-mysql.js";
import { renderSQLite } from "../src/migrations/render-sqlite.js";
import {
  generateDrizzleMigration,
  generatePrismaMigration,
  generateKyselyMigration,
} from "../src/migrations/adapters/index.js";
import type { DatafnSchema } from "@datafn/core";
import type { MigrationContext } from "../src/migrations/types.js";

// Test schema helper
const createSchema = (resources: any[], relations: any[] = []): DatafnSchema =>
  ({
    resources,
    relations,
  }) as DatafnSchema;

// Helper to create migration context
const createCtx = (
  fromSchema: DatafnSchema | null,
  toSchema: DatafnSchema,
  dialect: MigrationContext["dialect"] = "postgres",
  adapter: MigrationContext["adapter"] = "raw",
): MigrationContext => ({
  dialect,
  adapter,
  fromSchema,
  toSchema,
});

describe("Schema Migration Tests", () => {
  it("TV-MIG-001: Migration diff produces deterministic plan for a schema change", () => {
    const from = createSchema([
      {
        name: "task",
        version: 1,
        fields: [{ name: "title", type: "string", required: true }],
      },
    ]);

    const to = createSchema([
      {
        name: "task",
        version: 2,
        fields: [
          { name: "title", type: "string", required: true },
          { name: "done", type: "boolean", required: true },
        ],
      },
    ]);

    const plan = diffSchemas(from, to);

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toEqual({
      kind: "addField",
      resource: "task",
      field: "done",
      type: "boolean",
      required: true,
    });

    // Verify render matches expected SQL pattern
    const ctx = createCtx(from, to);
    const sql = renderPostgres(plan, ctx);
    expect(sql).toContain(
      'ALTER TABLE "task" ADD COLUMN "done" BOOLEAN NOT NULL;',
    );
  });

  it("TV-MIG-002: Invalid diffs are rejected deterministically", () => {
    const from = createSchema([
      {
        name: "task",
        version: 1,
        fields: [{ name: "title", type: "string", required: true }],
      },
    ]);

    // Missing resources in 'to'
    const invalidTo = { relations: [] } as unknown as DatafnSchema;

    try {
      diffSchemas(from, invalidTo);
      expect.fail("Should have thrown error");
    } catch (err: any) {
      expect(err).toBeTruthy();
      expect(err.code).toBe("SCHEMA_INVALID");
      expect(err.message).toContain("Invalid schema");
    }
  });

  // Additional test for other changes
  it("Handles resource additions and removals with full columns", () => {
    const from = createSchema([
      {
        name: "old_table",
        version: 1,
        fields: [{ name: "name", type: "string", required: true }],
      },
    ]);

    const to = createSchema([
      {
        name: "new_table",
        version: 1,
        fields: [
          { name: "title", type: "string", required: true },
          { name: "count", type: "number", required: false },
        ],
      },
    ]);

    const plan = diffSchemas(from, to);

    expect(plan.changes).toHaveLength(2);
    expect(plan.changes[0]).toEqual({
      kind: "addResource",
      resource: "new_table",
    });
    expect(plan.changes[1]).toEqual({
      kind: "removeResource",
      resource: "old_table",
    });

    const ctx = createCtx(from, to);
    const sql = renderPostgres(plan, ctx);
    expect(sql).toContain('CREATE TABLE "new_table"');
    expect(sql).toContain('"title" TEXT NOT NULL');
    expect(sql).toContain('"count" NUMERIC NULL');
    expect(sql).toContain('DROP TABLE IF EXISTS "old_table";');
  });
});

describe("Relation Migration Tests", () => {
  it("Detects added many-to-many relations", () => {
    const from = createSchema(
      [
        { name: "task", version: 1, fields: [] },
        { name: "tag", version: 1, fields: [] },
      ],
      [],
    );

    const to = createSchema(
      [
        { name: "task", version: 1, fields: [] },
        { name: "tag", version: 1, fields: [] },
      ],
      [
        {
          from: "task",
          to: "tag",
          type: "many-many",
          relation: "tags",
        },
      ],
    );

    const plan = diffSchemas(from, to);

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      kind: "addRelation",
      from: "task",
      to: "tag",
      type: "many-to-many",
      relation: "tags",
    });

    const ctx = createCtx(from, to);
    const sql = renderPostgres(plan, ctx);
    expect(sql).toContain("__datafn_join_task_tags");
    expect(sql).toContain('"from" TEXT NOT NULL');
    expect(sql).toContain('"to" TEXT NOT NULL');
  });

  it("Detects removed relations", () => {
    const from = createSchema(
      [{ name: "task", version: 1, fields: [] }],
      [{ from: "task", to: "user", type: "many-one", relation: "assignee" }],
    );

    const to = createSchema([{ name: "task", version: 1, fields: [] }], []);

    const plan = diffSchemas(from, to);

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      kind: "removeRelation",
      from: "task",
      to: "user",
    });
  });
});

describe("Index Migration Tests", () => {
  it("Detects added indices", () => {
    const from = createSchema([
      {
        name: "task",
        version: 1,
        fields: [{ name: "title", type: "string", required: true }],
        indices: { base: [], search: [] },
      },
    ]);

    const to = createSchema([
      {
        name: "task",
        version: 2,
        fields: [{ name: "title", type: "string", required: true }],
        indices: { base: ["title"], search: ["title"] },
      },
    ]);

    const plan = diffSchemas(from, to);

    expect(plan.changes.filter((c) => c.kind === "addIndex")).toHaveLength(2);
    expect(plan.changes).toContainEqual({
      kind: "addIndex",
      resource: "task",
      indexType: "base",
      fields: ["title"],
    });
    expect(plan.changes).toContainEqual({
      kind: "addIndex",
      resource: "task",
      indexType: "search",
      fields: ["title"],
    });

    const ctx = createCtx(from, to);
    const sql = renderPostgres(plan, ctx);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_task_title"');
    expect(sql).toContain("Full-text search index");
  });
});

describe("MySQL Renderer", () => {
  it("Generates MySQL-specific syntax", () => {
    const to = createSchema([
      {
        name: "user",
        version: 1,
        fields: [
          { name: "email", type: "string", required: true },
          { name: "data", type: "object", required: false },
        ],
      },
    ]);

    const plan = diffSchemas({ resources: [], relations: [] }, to);
    const ctx = createCtx(null, to, "mysql");
    const sql = renderMySQL(plan, ctx);

    expect(sql).toContain("CREATE TABLE `user`");
    expect(sql).toContain("`email` TEXT NOT NULL");
    expect(sql).toContain("`data` JSON NULL");
  });
});

describe("SQLite Renderer", () => {
  it("Generates SQLite-specific syntax", () => {
    const to = createSchema([
      {
        name: "item",
        version: 1,
        fields: [
          { name: "active", type: "boolean", required: true },
          { name: "count", type: "number", required: true },
        ],
      },
    ]);

    const plan = diffSchemas({ resources: [], relations: [] }, to);
    const ctx = createCtx(null, to, "sqlite");
    const sql = renderSQLite(plan, ctx);

    expect(sql).toContain('CREATE TABLE "item"');
    expect(sql).toContain('"active" INTEGER NOT NULL'); // SQLite uses INTEGER for boolean
    expect(sql).toContain('"count" INTEGER NOT NULL');
  });
});

describe("Adapter Generators", () => {
  const to = createSchema([
    {
      name: "post",
      version: 1,
      fields: [{ name: "title", type: "string", required: true }],
    },
  ]);
  const plan = diffSchemas({ resources: [], relations: [] }, to);
  const ctx = createCtx(null, to);

  it("Generates Drizzle migration", () => {
    const output = generateDrizzleMigration(plan, ctx);
    expect(output).toContain("import { sql } from 'drizzle-orm'");
    expect(output).toContain("export async function up(db)");
    expect(output).toContain("db.execute");
    expect(output).toContain('CREATE TABLE "post"');
  });

  it("Generates Prisma migration", () => {
    const output = generatePrismaMigration(plan, ctx);
    expect(output).toContain("-- Prisma Migration");
    expect(output).toContain("Provider: postgres");
    expect(output).toContain('CREATE TABLE "post"');
  });

  it("Generates Kysely migration", () => {
    const output = generateKyselyMigration(plan, ctx);
    expect(output).toContain("import { Kysely, sql } from 'kysely'");
    expect(output).toContain("export async function up(db: Kysely<any>)");
    expect(output).toContain(".execute(db)");
  });
});
