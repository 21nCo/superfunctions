import { describe, expect, it } from "vitest";
import type { TableSchema } from "@superfunctions/db";
import {
  generateDrizzleMigration,
  generateKyselyMigration,
  generatePrismaMigration,
} from "../utils/generators.js";
import { createMigrationPlan, diffTables } from "../utils/schema-diff.js";
import {
  introspectMySQL,
  introspectPostgres,
  introspectSQLite,
  mapDatabaseTypeToFieldType,
} from "../utils/introspection.js";
import { generateDrizzleSchemaFile } from "../utils/schema-generators.js";
import { hasUnsafeMySqlMetadataSyntax } from "../utils/mysql-types.js";

const syncJobs = {
  modelName: "syncJobs",
  fields: {
    id: { type: "string", required: true, fieldName: "id" },
    claimToken: {
      type: "string",
      required: false,
      fieldName: "claim_token",
      maxLength: 64,
    },
  },
  indexes: [
    { name: "plugfn_sync_jobs_claim_token_idx", fields: ["claimToken"], unique: true },
  ],
} as unknown as TableSchema;

function sqliteColumn(
  tableName: string,
  columnName: string,
  dataType: string,
  isNullable: boolean,
) {
  return {
    dialect: "sqlite" as const,
    tableName,
    columnName,
    dataType,
    isNullable,
    defaultValue: null,
    isPrimaryKey: columnName === "id",
    isUnique: false,
  };
}

describe("schema index migrations", () => {
  it("uses supported Drizzle builders for SQLite scalar modes", () => {
    const table = {
      modelName: "settings",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        enabled: { type: "boolean", required: true, fieldName: "enabled" },
        metadata: { type: "json", required: false, fieldName: "metadata" },
        counter: { type: "bigint", required: true, fieldName: "counter" },
      },
    } as unknown as TableSchema;
    const schema = generateDrizzleSchemaFile(
      {
        version: 1,
        schemas: [table],
      },
      "example",
      "example",
      "sqlite",
    );

    expect(schema).toContain("integer('enabled', { mode: 'boolean' })");
    expect(schema).toContain("text('metadata', { mode: 'json' })");
    expect(schema).toContain("blob('counter', { mode: 'bigint' })");
    expect(schema).not.toContain("boolean('enabled'");
    expect(schema).not.toContain("json('metadata'");
    expect(schema).not.toContain("bigint('counter'");

    const plan = createMigrationPlan("example", 0, 1, [{
      tableName: "example_settings",
      action: "create",
    }]);
    expect(generateDrizzleMigration(plan, [table], "sqlite").content)
      .toContain("counter BLOB");
    expect(mapDatabaseTypeToFieldType("BLOB")).toBe("bigint");
    expect(diffTables([table], [{
      name: "example_settings",
      columns: [
        sqliteColumn("example_settings", "id", "TEXT", false),
        sqliteColumn("example_settings", "enabled", "INTEGER", false),
        sqliteColumn("example_settings", "metadata", "TEXT", true),
        sqliteColumn("example_settings", "counter", "BLOB", false),
      ],
      indexes: [],
      constraints: [],
    }], "example")).toEqual([]);
  });

  it("uses MySQL's int builder for numeric fields", () => {
    const schema = generateDrizzleSchemaFile(
      {
        version: 1,
        schemas: [{
          modelName: "counters",
          fields: {
            id: { type: "string", required: true, fieldName: "id", maxLength: 255 },
            attempts: { type: "number", required: true, fieldName: "attempts" },
            email: { type: "string", required: true, fieldName: "email", maxLength: 255 },
            description: { type: "string", required: false, fieldName: "description" },
          },
          indexes: [{ name: "counters_email_idx", fields: ["email"], unique: true }],
        } as unknown as TableSchema],
      },
      "authfn",
      "example",
      "mysql",
    );

    expect(schema).toContain("int('attempts')");
    expect(schema).not.toContain("integer('attempts')");
    expect(schema).toContain("id: varchar('id', { length: 255 })");
    expect(schema).toContain("email: varchar('email', { length: 255 })");
    expect(schema).toContain("description: text('description')");
    expect(schema).toContain("from 'drizzle-orm/mysql-core'");
    expect(schema).toContain("generate-schema --dialect mysql");
  });

  it("rejects unbounded MySQL string keys instead of narrowing their contract", () => {
    expect(() => generateDrizzleSchemaFile(
      {
        version: 1,
        schemas: [{
          modelName: "counters",
          fields: {
            id: { type: "string", required: true, fieldName: "id" },
          },
          indexes: [],
        } as unknown as TableSchema],
      },
      "authfn",
      "example",
      "mysql",
    )).toThrow("MySQL key field counters.id must declare maxLength");
  });

  it("rejects composite MySQL string indexes beyond the InnoDB key budget", () => {
    expect(() => generateDrizzleSchemaFile(
      {
        version: 1,
        schemas: [{
          modelName: "accounts",
          fields: {
            id: { type: "string", required: true, fieldName: "id", maxLength: 64 },
            provider: { type: "string", required: true, fieldName: "provider", maxLength: 500 },
            providerAccountId: { type: "string", required: true, fieldName: "provider_account_id", maxLength: 500 },
          },
          indexes: [{
            name: "accounts_provider_account_idx",
            fields: ["provider", "providerAccountId"],
            unique: true,
          }],
        } as unknown as TableSchema],
      },
      "authfn",
      "example",
      "mysql",
    )).toThrow("encoded key size 4000 bytes exceeds the 3072-byte InnoDB limit");
  });

  it("scopes PostgreSQL index relations to the requested schema", async () => {
    let indexQuery = "";
    let indexParams: unknown[] = [];
    const db = {
      query: async (query: string, params: unknown[]) => {
        if (query.includes("information_schema.tables")) {
          return { rows: [{ table_name: "sync_jobs" }] };
        }
        if (query.includes("information_schema.columns")) {
          return { rows: [] };
        }
        if (query.includes("FROM pg_indexes")) {
          indexQuery = query;
          indexParams = params;
          return { rows: [] };
        }
        throw new Error(`Unexpected query: ${query}`);
      },
    };

    await introspectPostgres(db, "tenant_a");

    expect(indexQuery).toContain(
      "JOIN pg_namespace index_ns ON index_ns.oid = c.relnamespace",
    );
    expect(indexQuery).toContain("AND index_ns.nspname = $1");
    expect(indexParams).toEqual(["tenant_a", "sync_jobs"]);
  });

  it("reads MySQL visibility from EXTRA and preserves index prefixes", async () => {
    const db = {
      query: async (query: string, params?: unknown[]) => {
        if (query.includes("@@innodb_page_size")) {
          return [[{ page_size: 8192 }]];
        }
        if (query.includes("information_schema.TABLES")) {
          expect(query).toContain("information_schema.CHARACTER_SETS");
          return [[{ table_name: "plugfn_jobs", row_format: "Compact", character_set_max_bytes: 4 }]];
        }
        if (query.includes("information_schema.COLUMNS")) {
          expect(query).not.toContain("IS_VISIBLE");
          expect(query).toContain("cs.MAXLEN");
          return [[{
            column_name: "legacy_note",
            data_type: "text",
            column_type: "text",
            character_maximum_length: 65_535,
            extra: "INVISIBLE",
            generation_expression: "",
            character_set_name: "latin1",
            character_set_max_bytes: 1,
            collation_name: "latin1_swedish_ci",
            column_comment: "",
            is_nullable: "YES",
            column_default: null,
            column_key: "UNI",
          }]];
        }
        if (query.includes("information_schema.STATISTICS")) {
          expect(query).toContain("SUB_PART as sub_part");
          expect(query).toContain("INDEX_TYPE as index_type");
          return [[{
            name: "jobs_note_idx",
            table_name: "plugfn_jobs",
            non_unique: 0,
            column_name: "legacy_note",
            sub_part: 50,
            index_type: "FULLTEXT",
          }]];
        }
        if (query.includes("information_schema.KEY_COLUMN_USAGE")) {
          expect(query).toContain("TABLE_SCHEMA = ? AND TABLE_NAME = ?");
          expect(query).toContain(
            "REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ?",
          );
          expect(params).toEqual(["app", "plugfn_jobs", "app", "plugfn_jobs"]);
          return [[{
            name: "jobs_owner_fk",
            table_schema: "app",
            table_name: "plugfn_jobs",
            column_name: "owner_id",
            referenced_table_schema: "app",
            referenced_table: "plugfn_users",
            referenced_column: "id",
          }, {
            name: "audit_job_fk",
            table_schema: "shared",
            table_name: "audit_log",
            column_name: "job_id",
            referenced_table_schema: "app",
            referenced_table: "plugfn_jobs",
            referenced_column: "id",
          }]];
        }
        throw new Error(`Unexpected query: ${query}`);
      },
    };

    const [table] = await introspectMySQL(db, "app", "plugfn_");

    expect(table.columns[0].isVisible).toBe(false);
    expect(table.columns[0].characterSetMaxBytes).toBe(1);
    expect(table).toMatchObject({ rowFormat: "Compact", innodbPageSize: 8192, characterSetMaxBytes: 4 });
    expect(table.indexes[0].prefixLengths).toEqual([50]);
    expect(table.indexes[0].indexType).toBe("FULLTEXT");
    expect(table.schema).toBe("app");
    expect(table.constraints).toEqual([
      {
        name: "jobs_owner_fk",
        type: "FOREIGN KEY",
        tableSchema: "app",
        tableName: "plugfn_jobs",
        columns: ["owner_id"],
        referencedTableSchema: "app",
        referencedTable: "plugfn_users",
        referencedColumns: ["id"],
      },
      {
        name: "audit_job_fk",
        type: "FOREIGN KEY",
        tableSchema: "shared",
        tableName: "audit_log",
        columns: ["job_id"],
        referencedTableSchema: "app",
        referencedTable: "plugfn_jobs",
        referencedColumns: ["id"],
      },
    ]);
  });

  it("preserves SQLite index uniqueness during introspection", async () => {
    const db = {
      all: async (query: string, params: unknown[]) => {
        if (query.includes("FROM sqlite_master") && query.includes("type = 'table'")) {
          return [{ table_name: "plugfn_sync_jobs" }];
        }
        if (query.includes("PRAGMA table_info")) {
          return [
            { name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
            { name: "claim_token", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
          ];
        }
        if (query.includes("pragma_index_list")) {
          expect(params).toEqual(["plugfn_sync_jobs"]);
          return [{ name: "plugfn_sync_jobs_claim_token_idx", is_unique: 1 }];
        }
        if (query.includes("pragma_index_info")) {
          expect(params).toEqual(["plugfn_sync_jobs_claim_token_idx"]);
          return [{ name: "claim_token", seqno: 0 }];
        }
        throw new Error(`Unexpected query: ${query}`);
      },
    };

    const [table] = await introspectSQLite(db);

    expect(table.indexes).toEqual([{
      name: "plugfn_sync_jobs_claim_token_idx",
      tableName: "plugfn_sync_jobs",
      columns: ["claim_token"],
      isUnique: true,
    }]);
    expect(diffTables([syncJobs], [table], "plugfn")).toEqual([]);
  });

  it("detects a required index missing from an existing table", () => {
    const diffs = diffTables(
      [syncJobs],
      [{
        name: "plugfn_sync_jobs",
        columns: [
          {
            tableName: "plugfn_sync_jobs",
            columnName: "id",
            dataType: "text",
            isNullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isUnique: true,
          },
          {
            tableName: "plugfn_sync_jobs",
            columnName: "claim_token",
            dataType: "text",
            isNullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isUnique: false,
          },
        ],
        indexes: [],
        constraints: [],
      }],
      "plugfn",
    );

    expect(diffs).toEqual([
      expect.objectContaining({
        tableName: "plugfn_sync_jobs",
        action: "alter",
        missingIndexes: [{
          name: "plugfn_sync_jobs_claim_token_idx",
          columns: ["claim_token"],
          unique: true,
        }],
      }),
    ]);
  });

  it("replaces a same-name index whose columns or uniqueness do not match", () => {
    const diffs = diffTables(
      [syncJobs],
      [{
        name: "plugfn_sync_jobs",
        columns: [
          {
            tableName: "plugfn_sync_jobs",
            columnName: "id",
            dataType: "text",
            isNullable: false,
            defaultValue: null,
            isPrimaryKey: true,
            isUnique: true,
          },
          {
            tableName: "plugfn_sync_jobs",
            columnName: "claim_token",
            dataType: "text",
            isNullable: true,
            defaultValue: null,
            isPrimaryKey: false,
            isUnique: false,
          },
        ],
        indexes: [{
          name: "plugfn_sync_jobs_claim_token_idx",
          tableName: "plugfn_sync_jobs",
          columns: ["id"],
          isUnique: false,
        }],
        constraints: [],
      }],
      "plugfn",
    );

    expect(diffs).toEqual([
      expect.objectContaining({
        changedIndexes: [{
          name: "plugfn_sync_jobs_claim_token_idx",
          current: {
            columns: ["id"],
            unique: false,
            textColumns: ["id"],
            columnMetadata: [{ dataType: "text" }],
          },
          required: { columns: ["claim_token"], unique: true },
        }],
      }),
    ]);

    const plan = createMigrationPlan("plugfn", 5, 6, diffs);
    const mysqlIndex =
      "CREATE UNIQUE INDEX plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs (claim_token);";
    expect(generateDrizzleMigration(plan, [syncJobs], "mysql").content)
      .toContain(mysqlIndex);
    expect(generateKyselyMigration(plan, [syncJobs], "mysql").content)
      .toContain(mysqlIndex);
  });

  it("emits missing indexes for SQL and Kysely migrations", () => {
    const plan = createMigrationPlan("plugfn", 5, 6, [{
      tableName: "plugfn_sync_jobs",
      action: "alter",
      missingIndexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        columns: ["claim_token"],
        unique: true,
      }],
    }]);

    expect(generateDrizzleMigration(plan, [syncJobs], "postgres").content).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs (claim_token);",
    );
    expect(generateKyselyMigration(plan, [syncJobs], "postgres").content).toContain(
      "createIndex('plugfn_sync_jobs_claim_token_idx').on('plugfn_sync_jobs').columns([\"claim_token\"]).unique().execute()",
    );

    for (const generate of [
      generateDrizzleMigration,
      generatePrismaMigration,
      generateKyselyMigration,
    ]) {
      expect(generate(plan, [syncJobs], "mysql").content).toContain(
        "CREATE UNIQUE INDEX plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs (claim_token);",
      );
    }
  });

  it("drops a new index before its indexed column in Kysely rollbacks", () => {
    const plan = createMigrationPlan("plugfn", 5, 6, [{
      tableName: "plugfn_sync_jobs",
      action: "alter",
      missingColumns: ["claim_token"],
      missingIndexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        columns: ["claim_token"],
        unique: true,
      }],
    }]);
    const content = generateKyselyMigration(plan, [syncJobs], "postgres").content;
    const down = content.slice(content.indexOf("export async function down"));

    expect(down.indexOf("dropIndex('plugfn_sync_jobs_claim_token_idx')"))
      .toBeLessThan(down.indexOf("dropColumn('claim_token')"));
  });

  it("rejects unique MySQL indexes on unbounded TEXT columns", () => {
    const unboundedSyncJobs = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: {
          type: "string",
          required: false,
          fieldName: "claim_token",
        },
      },
    } as unknown as TableSchema;
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_sync_jobs",
      action: "create",
    }]);
    expect(() => generateDrizzleMigration(plan, [unboundedSyncJobs], "mysql"))
      .toThrow("Cannot generate unique MySQL index plugfn_sync_jobs_claim_token_idx on unbounded TEXT column(s): claim_token");
    expect(() => generatePrismaMigration(plan, [unboundedSyncJobs], "mysql"))
      .toThrow("Cannot generate unique MySQL index plugfn_sync_jobs_claim_token_idx on unbounded TEXT column(s): claim_token");
  });

  it("creates bounded MySQL claim tokens with full-value uniqueness", () => {
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_sync_jobs",
      action: "create",
    }]);
    for (const generate of [generateDrizzleMigration, generatePrismaMigration]) {
      const content = generate(plan, [syncJobs], "mysql").content;
      expect(content).toContain("claim_token VARCHAR(64)");
      expect(content).toContain(
        "CREATE UNIQUE INDEX plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs (claim_token);",
      );
      expect(content).not.toContain("claim_token(191)");
    }
    const kysely = generateKyselyMigration(plan, [syncJobs], "mysql").content;
    expect(kysely).toContain("addColumn('claim_token', 'varchar(64)'");
    expect(kysely).toContain(
      "CREATE UNIQUE INDEX plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs (claim_token);",
    );
    const mysqlSchema = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        id: { ...syncJobs.fields.id, maxLength: 255 },
      },
    };
    const drizzleSchema = generateDrizzleSchemaFile(
      { version: 6, schemas: [mysqlSchema] },
      "plugfn",
      "plugfn",
      "mysql",
    );
    expect(drizzleSchema).toContain(
      "claimToken: varchar('claim_token', { length: 64 })",
    );
    expect(drizzleSchema).toContain(
      "uniqueIndex('plugfn_sync_jobs_claim_token_idx').on(table.claimToken)",
    );
  });

  it("migrates existing MySQL TEXT before creating a bounded unique index", () => {
    const diffs = diffTables([syncJobs], [{
      name: "plugfn_sync_jobs",
      columns: [
        {
          dialect: "mysql",
          tableName: "plugfn_sync_jobs",
          columnName: "id",
          dataType: "text",
          maxLength: null,
          isNullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isUnique: true,
        },
        {
          dialect: "mysql",
          tableName: "plugfn_sync_jobs",
          columnName: "claim_token",
          dataType: "text",
          maxLength: null,
          isNullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isUnique: false,
        },
      ],
      indexes: [],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].columnChanges).toEqual([expect.objectContaining({
      column: "claim_token",
      change: "maxLength changed from unbounded to 64",
    })]);
    const plan = createMigrationPlan("plugfn", 5, 6, diffs);
    for (const generate of [generateDrizzleMigration, generatePrismaMigration]) {
      const content = generate(plan, [syncJobs], "mysql").content;
      expect(content).toContain(
        "ALTER TABLE plugfn_sync_jobs MODIFY COLUMN claim_token VARCHAR(64) NULL;",
      );
      expect(content.indexOf("MODIFY COLUMN claim_token"))
        .toBeLessThan(content.indexOf("CREATE UNIQUE INDEX"));
    }
    const kysely = generateKyselyMigration(plan, [syncJobs], "mysql").content;
    const up = kysely.slice(0, kysely.indexOf("export async function down"));
    const down = kysely.slice(kysely.indexOf("export async function down"));
    expect(up.indexOf("MODIFY COLUMN claim_token VARCHAR(64) NULL"))
      .toBeLessThan(up.indexOf("CREATE UNIQUE INDEX"));
    expect(down.indexOf("dropIndex('plugfn_sync_jobs_claim_token_idx')"))
      .toBeLessThan(down.indexOf("MODIFY COLUMN claim_token TEXT NULL"));
  });

  it("does not classify bounded VARCHAR columns as unbounded rollback text", () => {
    const replacementSchema = {
      ...syncJobs,
      indexes: [{ name: "plugfn_sync_jobs_claim_token_idx", fields: ["id"] }],
    } as unknown as TableSchema;
    const diffs = diffTables([replacementSchema], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        maxLength: 64,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "id",
        dataType: "varchar",
        maxLength: 64,
        isNullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isUnique: true,
      }],
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        isUnique: true,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].changedIndexes?.[0].current.textColumns).toBeUndefined();
    expect(() => generateKyselyMigration(
      createMigrationPlan("plugfn", 6, 7, diffs),
      [replacementSchema],
      "mysql",
    )).not.toThrow();
  });

  it("rejects MySQL VARCHAR bounds beyond the utf8mb4-safe limit", () => {
    const invalid = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: { ...syncJobs.fields.claimToken, maxLength: 16_384 },
      },
    } as unknown as TableSchema;
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_sync_jobs",
      action: "create",
    }]);

    for (const generate of [
      generateDrizzleMigration,
      generatePrismaMigration,
      generateKyselyMigration,
    ]) {
      expect(() => generate(plan, [invalid], "mysql"))
        .toThrow("expected an integer between 1 and 16383");
    }
    expect(() => generateDrizzleSchemaFile(
      {
        version: 1,
        schemas: [{
          ...invalid,
          fields: {
            ...invalid.fields,
            id: { ...invalid.fields.id, maxLength: 255 },
          },
        }],
      },
      "plugfn",
      "plugfn",
      "mysql",
    )).toThrow("expected an integer between 1 and 16383");

    expect(() => diffTables([invalid], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        maxLength: 16_384,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [],
      constraints: [],
    }], "plugfn")).toThrow("expected an integer between 1 and 16383");
  });

  it("rejects bounded MySQL string indexes above the utf8mb4 key budget", () => {
    const invalidIndex = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: { ...syncJobs.fields.claimToken, maxLength: 769 },
      },
    } as unknown as TableSchema;
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_sync_jobs",
      action: "create",
    }]);

    for (const generate of [
      generateDrizzleMigration,
      generatePrismaMigration,
      generateKyselyMigration,
    ]) {
      expect(() => generate(plan, [invalidIndex], "mysql"))
        .toThrow("exceeds the utf8mb4 full-column index limit 768");
    }
  });

  it("accounts for non-string columns in composite MySQL index key budgets", () => {
    const composite = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: { ...syncJobs.fields.claimToken, maxLength: 768 },
        sequence: { type: "number", required: true, fieldName: "sequence" },
      },
      indexes: [{
        name: "plugfn_sync_jobs_composite_idx",
        fields: ["claimToken", "sequence"],
        unique: false,
      }],
    } as unknown as TableSchema;
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_sync_jobs",
      action: "create",
    }]);

    for (const generate of [
      generateDrizzleMigration,
      generatePrismaMigration,
      generateKyselyMigration,
    ]) {
      expect(() => generate(plan, [composite], "mysql"))
        .toThrow("encoded key size 3076 bytes exceeds the 3072-byte InnoDB limit");
    }
  });

  it("uses physical temporal widths in composite MySQL index budgets", () => {
    const composite = {
      modelName: "events",
      fields: {
        token: { type: "string", required: true, fieldName: "token", maxLength: 766 },
        recordedAt: {
          type: "datetime",
          required: true,
          fieldName: "recorded_at",
        },
        active: { type: "boolean", required: true, fieldName: "active" },
      },
      indexes: [{
        name: "events_token_recorded_idx",
        fields: ["token", "recordedAt", "active"],
      }],
    } as unknown as TableSchema;
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_events",
      action: "create",
    }]);

    expect(() => generateDrizzleMigration(plan, [composite], "mysql"))
      .not.toThrow();
    expect(generateDrizzleMigration(plan, [composite], "mysql").content)
      .toContain("events_token_recorded_idx ON plugfn_events (token, recorded_at, active)");
  });

  it("prefixes MySQL indexes for date fields stored as ISO text", () => {
    const dateText = {
      modelName: "events",
      fields: {
        id: { type: "string", required: true, fieldName: "id", maxLength: 64 },
        occurredAt: {
          type: "datetime",
          dateStorageType: "iso-text",
          required: true,
          fieldName: "occurred_at",
        },
      },
      indexes: [{
        name: "plugfn_events_occurred_at_idx",
        fields: ["occurredAt"],
        unique: false,
      }],
    } as unknown as TableSchema;
    const plan = createMigrationPlan("plugfn", 0, 1, [{
      tableName: "plugfn_events",
      action: "create",
    }]);

    expect(generateDrizzleMigration(plan, [dateText], "mysql").content)
      .toContain("plugfn_events_occurred_at_idx ON plugfn_events (occurred_at(191))");
    expect(generateKyselyMigration(plan, [dateText], "mysql").content)
      .toContain("plugfn_events_occurred_at_idx ON plugfn_events (occurred_at(191))");
  });

  it("detects an existing MySQL VARCHAR when the schema requires unbounded TEXT", () => {
    const unbounded = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: {
          type: "string",
          required: false,
          fieldName: "claim_token",
        },
      },
      indexes: [],
    } as unknown as TableSchema;
    const diffs = diffTables([unbounded], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(64)",
        maxLength: 64,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].columnChanges?.[0].change)
      .toContain("maxLength changed from 64 to unbounded");
  });

  it("rebuilds dependent MySQL indexes around indexed column widening", () => {
    const widened = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: {
          type: "string",
          required: false,
          fieldName: "claim_token",
        },
      },
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        fields: ["claimToken"],
        unique: false,
      }],
    } as unknown as TableSchema;
    const diffs = diffTables([widened], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(100)",
        maxLength: 100,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        isUnique: false,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].rebuiltIndexes).toEqual([
      expect.objectContaining({
        name: "plugfn_sync_jobs_claim_token_idx",
        required: { columns: ["claim_token"], unique: false },
      }),
    ]);
    const plan = createMigrationPlan("plugfn", 5, 6, diffs);
    const drop = "DROP INDEX plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs";
    const alter = "MODIFY COLUMN claim_token TEXT NULL";
    const create =
      "CREATE INDEX plugfn_sync_jobs_claim_token_idx ON plugfn_sync_jobs (claim_token(191))";

    for (const content of [
      generateDrizzleMigration(plan, [widened], "mysql").content,
      generatePrismaMigration(plan, [widened], "mysql").content,
    ]) {
      expect(content.indexOf(drop)).toBeGreaterThanOrEqual(0);
      expect(content.indexOf(alter)).toBeGreaterThan(content.indexOf(drop));
      expect(content.indexOf(create)).toBeGreaterThan(content.indexOf(alter));
    }
    const kysely = generateKyselyMigration(plan, [widened], "mysql").content;
    const kyselyDrop = "dropIndex('plugfn_sync_jobs_claim_token_idx')";
    expect(kysely.indexOf(kyselyDrop)).toBeGreaterThanOrEqual(0);
    expect(kysely.indexOf(alter)).toBeGreaterThan(kysely.indexOf(kyselyDrop));
    expect(kysely.indexOf(create)).toBeGreaterThan(kysely.indexOf(alter));
  });

  it("widens a MySQL VARCHAR in place without dropping its full-column unique index", () => {
    const widened = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: { ...syncJobs.fields.claimToken, maxLength: 128 },
      },
    } as unknown as TableSchema;
    const diffs = diffTables([widened], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(64)",
        maxLength: 64,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        prefixLengths: [null],
        indexType: "BTREE",
        isUnique: true,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].columnChanges?.map((change) => change.change))
      .toEqual(["maxLength changed from 64 to 128"]);
    expect(diffs[0].rebuiltIndexes).toEqual([]);
    const plan = createMigrationPlan("plugfn", 5, 6, diffs);
    for (const content of [
      generateDrizzleMigration(plan, [widened], "mysql").content,
      generatePrismaMigration(plan, [widened], "mysql").content,
      generateKyselyMigration(plan, [widened], "mysql").content.split("export async function down")[0],
    ]) {
      expect(content).toContain("MODIFY COLUMN claim_token VARCHAR(128) NULL");
      expect(content).not.toMatch(/DROP INDEX|dropIndex|CREATE (?:UNIQUE )?INDEX|createIndex/);
    }
  });

  it("sizes every key on a changed MySQL column against the row format and page-size budget before any DDL", () => {
    const widenTo = (maxLength: number, indexFields = ["claimToken"], required = false, ownerLength = 32) => ({
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: { ...syncJobs.fields.claimToken, maxLength, required },
        owner: { type: "string", required: false, fieldName: "owner", maxLength: ownerLength },
      },
      indexes: [{ name: "plugfn_sync_jobs_claim_token_idx", fields: indexFields, unique: true }],
    } as unknown as TableSchema);
    const varcharColumn = (columnName: string, length: number, characterSetMaxBytes: number | null = 4) => ({
      dialect: "mysql" as const,
      tableName: "plugfn_sync_jobs",
      columnName,
      dataType: "varchar",
      columnType: `varchar(${length})`,
      maxLength: length as number | null,
      characterSetMaxBytes,
      isNullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isUnique: false,
    });
    const current = (
      rowFormat: string,
      { prefixLength = null as number | null, columnBytes = 4 as number | null, innodbPageSize = 16384, tableBytes = 4 } = {},
    ) => [{
      name: "plugfn_sync_jobs",
      rowFormat,
      innodbPageSize,
      characterSetMaxBytes: tableBytes,
      columns: [varcharColumn("claim_token", 64, columnBytes), varcharColumn("owner", 32)],
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        prefixLengths: [prefixLength],
        indexType: "BTREE",
        isUnique: true,
      }],
      constraints: [],
    }];
    const inPlace = (diffs: ReturnType<typeof diffTables>, maxLength: number) => {
      expect(diffs[0].columnChanges?.map((change) => change.change))
        .toEqual([`maxLength changed from 64 to ${maxLength}`]);
      expect(diffs[0].rebuiltIndexes).toEqual([]);
    };
    const pageSizeRefusal = (limit: number) =>
      new RegExp(`over the ${limit}-byte InnoDB key limit for innodb_page_size(?!.*ROW_FORMAT)`);

    // COMPACT/REDUNDANT: 192 utf8mb4 characters take 768 bytes, over the
    // 767-byte key part limit that ROW_FORMAT=DYNAMIC lifts; 191 fit in 764.
    for (const rowFormat of ["Compact", "REDUNDANT"]) {
      expect(() => diffTables([widenTo(192)], current(rowFormat), "plugfn")).toThrow(
        new RegExp(`${rowFormat} row format limits index key parts to 767 bytes.*plugfn_sync_jobs_claim_token_idx \\(claim_token 768 bytes\\).*ROW_FORMAT=DYNAMIC`),
      );
      inPlace(diffTables([widenTo(191)], current(rowFormat), "plugfn"), 191);
    }
    // MODIFY COLUMN keeps a string column's own character set (700 latin1
    // bytes fit); an unknown one counts as utf8mb4.
    inPlace(diffTables([widenTo(700)], current("Compact", { columnBytes: 1 }), "plugfn"), 700);
    expect(() => diffTables([widenTo(192)], current("Compact", { columnBytes: null }), "plugfn")).toThrow(/767 bytes/);
    // A widening combined with another change rebuilds the key; still refused.
    expect(() => diffTables([widenTo(192, ["claimToken"], true)], current("Compact"), "plugfn")).toThrow(
      /plugfn_sync_jobs_claim_token_idx \(claim_token 768 bytes\)/,
    );
    // A prefixed key part would be rebuilt at full width, so it is refused too.
    expect(() => diffTables([widenTo(768)], current("Compact", { prefixLength: 32 }), "plugfn")).toThrow(
      /plugfn_sync_jobs_claim_token_idx \(claim_token 3072 bytes\)/,
    );
    // Rebuilding a composite key drops the prefix of an unchanged key part:
    // owner(100) would become a full 250-character utf8mb4 key part.
    const composite = current("Compact");
    composite[0].columns[1] = varcharColumn("owner", 250);
    composite[0].indexes[0] = { ...composite[0].indexes[0], columns: ["claim_token", "owner"], prefixLengths: [null, 100] };
    expect(() => diffTables([widenTo(191, ["claimToken", "owner"], false, 250)], composite, "plugfn")).toThrow(
      /\(claim_token 764 bytes, owner 1000 bytes\).*ROW_FORMAT=DYNAMIC/,
    );
    // Every part fits 767 bytes but the whole key does not fit the page-size
    // total: 16 KiB pages allow 3,072 bytes, 8 KiB 1,536, 4 KiB 768. A row
    // format change cannot help, so none is offered.
    const partNames = ["claim_token", "p1", "p2", "p3", "p4"];
    const fiveParts = current("Compact");
    fiveParts[0].columns = partNames.map((name) => varcharColumn(name, name === "claim_token" ? 64 : 160));
    fiveParts[0].indexes[0] = { ...fiveParts[0].indexes[0], columns: partNames, prefixLengths: partNames.map(() => null) };
    const fivePartSchema = {
      ...widenTo(190),
      fields: {
        ...widenTo(190).fields,
        ...Object.fromEntries(partNames.slice(1).map((name) => [name, { type: "string", fieldName: name, maxLength: 160 }])),
      },
      indexes: [{ name: "plugfn_sync_jobs_claim_token_idx", fields: ["claimToken", "p1", "p2", "p3", "p4"], unique: true }],
    } as unknown as TableSchema;
    expect(() => diffTables([fivePartSchema], fiveParts, "plugfn")).toThrow(pageSizeRefusal(3072));
    expect(() => diffTables([widenTo(768)], current("Dynamic", { innodbPageSize: 8192 }), "plugfn")).toThrow(pageSizeRefusal(1536));
    expect(() => diffTables([widenTo(192)], current("Dynamic", { innodbPageSize: 4096 }), "plugfn")).not.toThrow();
    expect(() => diffTables([widenTo(193)], current("Dynamic", { innodbPageSize: 4096 }), "plugfn")).toThrow(pageSizeRefusal(768));
    inPlace(diffTables([widenTo(384)], current("Dynamic", { innodbPageSize: 8192 }), "plugfn"), 384);
    // A non-string column becomes a string in the table's default character
    // set: INT -> VARCHAR(192) in a latin1 COMPACT table is a 192-byte key.
    const intToString = current("Compact", { tableBytes: 1 });
    intToString[0].columns[0] = { ...varcharColumn("claim_token", 0, null), dataType: "int", columnType: "int", maxLength: null };
    expect(diffTables([widenTo(192)], intToString, "plugfn")[0].rebuiltIndexes?.map((index) => index.name))
      .toEqual(["plugfn_sync_jobs_claim_token_idx"]);
    // MODIFY COLUMN keeps an ENUM's own utf8mb4 character set, so ENUM ->
    // VARCHAR(200) in a latin1 COMPACT table is an 800-byte key part.
    const enumToString = current("Compact", { tableBytes: 1 });
    enumToString[0].columns[0] = { ...varcharColumn("claim_token", 0), dataType: "enum", columnType: "enum('a','b')", maxLength: 1, characterSet: "utf8mb4" } as never;
    expect(() => diffTables([widenTo(200)], enumToString, "plugfn")).toThrow(/claim_token 800 bytes.*ROW_FORMAT=DYNAMIC/);
    // Unchanged parts keep their physical width: a numeric TINYINT(1) takes 1
    // byte and a TIMESTAMP 4, so the rebuilt 767 + 1 and 764 + 4 byte keys fit
    // 4 KiB pages.
    for (const [type, columnType, maxLength] of [["number", "tinyint(1)", 767], ["date", "timestamp", 764]] as const) {
      const withFixedPart = current("Dynamic", { innodbPageSize: 4096, columnBytes: 1 });
      withFixedPart[0].columns[1] = { ...varcharColumn("owner", 0, null), dataType: columnType.replace(/\(.*/, ""), columnType, maxLength: null };
      withFixedPart[0].indexes[0] = { ...withFixedPart[0].indexes[0], columns: ["claim_token", "owner"], prefixLengths: [null, null] };
      const schema = widenTo(maxLength, ["claimToken", "owner"]);
      schema.fields.owner = { type, required: false, fieldName: "owner" } as TableSchema["fields"][string];
      const [diff] = diffTables([schema], withFixedPart, "plugfn");
      expect(diff.columnChanges?.map((change) => change.change)).toEqual([`maxLength changed from 64 to ${maxLength}`]);
      expect(diff.rebuiltIndexes?.map((index) => index.name)).toEqual(["plugfn_sync_jobs_claim_token_idx"]);
    }
    // An index replaced to cover another column no longer holds the widened one.
    const replaced = diffTables([widenTo(768, ["owner"])], current("Compact"), "plugfn");
    expect(replaced[0].changedIndexes?.map((index) => index.name)).toEqual(["plugfn_sync_jobs_claim_token_idx"]);
    // DYNAMIC on 16 KiB pages keeps the 3,072-byte budget.
    inPlace(diffTables([widenTo(768)], current("Dynamic"), "plugfn"), 768);
  });

  it("rebuilds widened MySQL indexes with prefixed keys and refuses over-budget keys", () => {
    const varcharColumn = (columnName: string, length: number) => ({
      dialect: "mysql" as const,
      tableName: "plugfn_sync_jobs",
      columnName,
      dataType: "varchar",
      columnType: `varchar(${length})`,
      maxLength: length,
      isNullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isUnique: false,
    });
    const widened = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: { ...syncJobs.fields.claimToken, maxLength: 400 },
        owner: { type: "string", required: false, fieldName: "owner", maxLength: 400 },
      },
      indexes: [{ name: "claim_owner_idx", fields: ["claimToken", "owner"], unique: false }],
    } as unknown as TableSchema;
    const currentIndex = {
      name: "claim_owner_idx",
      tableName: "plugfn_sync_jobs",
      columns: ["claim_token", "owner"],
      indexType: "BTREE",
      isUnique: false,
    };

    // 400 + 400 utf8mb4 characters take 3,200 bytes, over the 3,072-byte key
    // limit, so the change is refused before the index is dropped.
    expect(() => diffTables([widened], [{
      name: "plugfn_sync_jobs",
      columns: [varcharColumn("claim_token", 64), varcharColumn("owner", 400)],
      indexes: [{ ...currentIndex, prefixLengths: [null, null] }],
      constraints: [],
    }], "plugfn")).toThrow(/claim_owner_idx \(claim_token 1600 bytes, owner 1600 bytes\) would take 3200 bytes, over the 3072-byte/);

    // claim_token(32) is rebuilt as a full 400-character part: 2,000 bytes fit.
    const prefixedSchema = {
      ...widened,
      fields: { ...widened.fields, owner: { ...widened.fields.owner, maxLength: 100 } },
    } as TableSchema;
    const prefixed = diffTables([prefixedSchema], [{
      name: "plugfn_sync_jobs",
      columns: [varcharColumn("claim_token", 64), varcharColumn("owner", 100)],
      indexes: [{ ...currentIndex, prefixLengths: [32, null] }],
      constraints: [],
    }], "plugfn");
    expect(prefixed[0].rebuiltIndexes?.map((index) => index.name)).toEqual(["claim_owner_idx"]);
  });

  it("matches introspected MySQL TEXT and TINYINT(1) to unbounded strings and booleans", () => {
    const table = {
      modelName: "syncJobs",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        note: { type: "string", required: false, fieldName: "note" },
        cached: { type: "boolean", required: false, fieldName: "cached" },
      },
    } as unknown as TableSchema;
    const column = (columnName: string, dataType: string, columnType: string, maxLength: number | null) => ({
      dialect: "mysql" as const,
      tableName: "plugfn_sync_jobs",
      columnName,
      dataType,
      columnType,
      maxLength,
      isNullable: columnName !== "id",
      defaultValue: null,
      isPrimaryKey: columnName === "id",
      isUnique: false,
    });
    const current = (note: ReturnType<typeof column>) => [{
      name: "plugfn_sync_jobs",
      columns: [
        column("id", "text", "text", 65535),
        note,
        column("cached", "tinyint", "tinyint(1)", null),
      ],
      indexes: [],
      constraints: [],
    }];

    expect(diffTables([table], current(column("note", "text", "text", 65535)), "plugfn")).toEqual([]);
    expect(diffTables([table], current(column("note", "longtext", "longtext", 4294967295)), "plugfn"))
      .toEqual([]);
    expect(diffTables([table], current(column("note", "tinytext", "tinytext", 255)), "plugfn")[0]
      .columnChanges?.map((change) => [change.column, change.change]))
      .toEqual([["note", "maxLength changed from 255 to unbounded"]]);
  });

  it("reads MySQL TINYINT(1) as boolean only for boolean fields", () => {
    const column = (columnName: string, columnType: string) => ({
      dialect: "mysql" as const,
      tableName: "plugfn_counters",
      columnName,
      dataType: columnType.replace(/\(.*$/, ""),
      columnType,
      maxLength: null,
      isNullable: columnName !== "id",
      defaultValue: null,
      isPrimaryKey: columnName === "id",
      isUnique: false,
    });
    const diff = (fields: Record<string, unknown>, columns: ReturnType<typeof column>[]) =>
      diffTables(
        [{ modelName: "plugfn_counters", fields } as unknown as TableSchema],
        [{
          name: "plugfn_counters",
          columns,
          indexes: [{ name: "PRIMARY", tableName: "plugfn_counters", columns: ["id"], indexType: "BTREE", isUnique: true }],
          constraints: [],
        }],
        "plugfn",
      );

    // TINYINT(1) is a numeric column with display width 1, also as a primary key.
    expect(diff(
      {
        id: { type: "number", required: true, fieldName: "id" },
        level: { type: "number", required: false, fieldName: "level" },
      },
      [column("id", "tinyint(1)"), column("level", "tinyint(1)")],
    )).toEqual([]);
    // MySQL reports BOOLEAN as TINYINT(1).
    expect(diff(
      {
        id: { type: "number", required: true, fieldName: "id" },
        enabled: { type: "boolean", required: false, fieldName: "enabled" },
      },
      [column("id", "int"), column("enabled", "tinyint(1)")],
    )).toEqual([]);
    // Other integer types are not booleans.
    expect(diff(
      {
        id: { type: "number", required: true, fieldName: "id" },
        enabled: { type: "boolean", required: false, fieldName: "enabled" },
      },
      [column("id", "int"), column("enabled", "tinyint(4)")],
    )[0].columnChanges?.map((change) => [change.column, change.change]))
      .toEqual([["enabled", "type changed from integer to boolean"]]);
  });

  it("refuses MySQL type changes with undeclared or primary index dependencies", () => {
    const unbounded = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: {
          type: "string",
          required: false,
          fieldName: "claim_token",
        },
      },
      indexes: [],
    } as unknown as TableSchema;
    const currentTable = {
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql" as const,
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(100)",
        maxLength: 100,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      constraints: [],
    };

    expect(() => diffTables([unbounded], [{
      ...currentTable,
      indexes: [{
        name: "legacy_claim_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        isUnique: false,
      }],
    }], "plugfn")).toThrow(/dependent indexes.*legacy_claim_idx/);
    expect(() => diffTables([unbounded], [{
      ...currentTable,
      indexes: [{
        name: "PRIMARY",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        isUnique: true,
      }],
    }], "plugfn")).toThrow(/dependent indexes.*PRIMARY/);
  });

  it("refuses MySQL type changes with local or inbound foreign keys", () => {
    const unbounded = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: {
          type: "string",
          required: false,
          fieldName: "claim_token",
        },
      },
    } as unknown as TableSchema;
    const baseTable = {
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql" as const,
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(100)",
        maxLength: 100,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        isUnique: true,
      }],
    };

    expect(() => diffTables([unbounded], [{
      ...baseTable,
      constraints: [{
        name: "sync_jobs_claim_fk",
        type: "FOREIGN KEY" as const,
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        referencedTable: "plugfn_claims",
        referencedColumns: ["token"],
      }],
    }], "plugfn")).toThrow(/foreign-key dependencies.*sync_jobs_claim_fk/);
    expect(() => diffTables([unbounded], [{
      ...baseTable,
      constraints: [{
        name: "audit_claim_fk",
        type: "FOREIGN KEY" as const,
        tableName: "plugfn_audit",
        columns: ["claim_token"],
        referencedTable: "plugfn_sync_jobs",
        referencedColumns: ["claim_token"],
      }],
    }], "plugfn")).toThrow(/foreign-key dependencies.*audit_claim_fk/);
  });

  it("refuses changes to MySQL indexes that support foreign keys", () => {
    expect(() => diffTables([syncJobs], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql" as const,
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(64)",
        maxLength: 64,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        isUnique: false,
      }],
      constraints: [{
        name: "sync_jobs_claim_fk",
        type: "FOREIGN KEY" as const,
        tableName: "plugfn_sync_jobs",
        columns: ["claim_token"],
        referencedTable: "plugfn_claims",
        referencedColumns: ["token"],
      }],
    }], "plugfn")).toThrow(
      /foreign-key supporting indexes.*plugfn_sync_jobs_claim_token_idx/,
    );
  });

  it("refuses rebuilt MySQL composite indexes that support foreign keys", () => {
    const widenedComposite = {
      modelName: "syncJobs",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        ownerId: {
          type: "string",
          required: true,
          fieldName: "owner_id",
          maxLength: 64,
        },
        claimToken: {
          type: "string",
          required: false,
          fieldName: "claim_token",
          maxLength: 128,
        },
      },
      indexes: [{
        name: "plugfn_sync_jobs_owner_claim_idx",
        fields: ["ownerId", "claimToken"],
        unique: true,
      }],
    } as unknown as TableSchema;
    const currentTable = {
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql" as const,
        tableName: "plugfn_sync_jobs",
        columnName: "owner_id",
        dataType: "varchar",
        columnType: "varchar(64)",
        maxLength: 64,
        isNullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql" as const,
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "varchar",
        columnType: "varchar(64)",
        maxLength: 64,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "plugfn_sync_jobs_owner_claim_idx",
        tableName: "plugfn_sync_jobs",
        columns: ["owner_id", "claim_token"],
        isUnique: true,
      }],
    };

    // Converting claim_token to TEXT changes the key, so the index is rebuilt.
    const textComposite = {
      ...widenedComposite,
      fields: {
        ...widenedComposite.fields,
        claimToken: { type: "string", required: false, fieldName: "claim_token" },
      },
    } as unknown as TableSchema;

    for (const constraint of [{
      name: "sync_jobs_owner_fk",
      type: "FOREIGN KEY" as const,
      tableName: "plugfn_sync_jobs",
      columns: ["owner_id"],
      referencedTable: "plugfn_owners",
      referencedColumns: ["id"],
    }, {
      name: "audit_owner_fk",
      type: "FOREIGN KEY" as const,
      tableName: "plugfn_audit",
      columns: ["owner_id"],
      referencedTable: "plugfn_sync_jobs",
      referencedColumns: ["owner_id"],
    }]) {
      expect(() => diffTables([textComposite], [{
        ...currentTable,
        constraints: [constraint],
      }], "plugfn")).toThrow(
        /foreign-key supporting indexes.*plugfn_sync_jobs_owner_claim_idx/,
      );
      // A VARCHAR widening keeps the index in place, so the foreign key never
      // loses its supporting index.
      expect(diffTables([widenedComposite], [{
        ...currentTable,
        constraints: [constraint],
      }], "plugfn")[0].rebuiltIndexes).toEqual([]);
    }
  });

  it("uses dialect-correct Kysely drops for explicit rebuilt-index plans", () => {
    const plan = createMigrationPlan("plugfn", 5, 6, [{
      tableName: "plugfn_sync_jobs",
      action: "alter",
      rebuiltIndexes: [{
        name: "plugfn_sync_jobs_claim_token_idx",
        current: { columns: ["claim_token"], unique: true },
        required: { columns: ["claim_token"], unique: true },
      }],
    }]);

    const content = generateKyselyMigration(plan, [syncJobs], "postgres").content;
    expect(content).toContain(
      "dropIndex('plugfn_sync_jobs_claim_token_idx').execute()",
    );
    expect(content).not.toContain(
      "dropIndex('plugfn_sync_jobs_claim_token_idx').on(",
    );
  });

  it("preserves desired and prior defaults plus the complete MySQL rollback type", () => {
    const withDefault = {
      ...syncJobs,
      fields: {
        ...syncJobs.fields,
        claimToken: {
          ...syncJobs.fields.claimToken,
          defaultValue: "pending",
        },
      },
      indexes: [],
    } as unknown as TableSchema;
    const diffs = diffTables([withDefault], [{
      name: "plugfn_sync_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_sync_jobs",
        columnName: "claim_token",
        dataType: "enum",
        columnType: "enum('legacy','pending')",
        maxLength: 7,
        isNullable: false,
        defaultValue: "legacy",
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [],
      constraints: [],
    }], "plugfn");
    const plan = createMigrationPlan("plugfn", 5, 6, diffs);

    for (const generate of [generateDrizzleMigration, generatePrismaMigration]) {
      expect(generate(plan, [withDefault], "mysql").content).toContain(
        "MODIFY COLUMN claim_token VARCHAR(64) NULL DEFAULT 'pending';",
      );
    }
    const kysely = generateKyselyMigration(plan, [withDefault], "mysql").content;
    expect(kysely).toContain(
      "MODIFY COLUMN claim_token VARCHAR(64) NULL DEFAULT 'pending'",
    );
    expect(kysely).toContain(
      "MODIFY COLUMN claim_token enum('legacy','pending') NOT NULL DEFAULT 'legacy'",
    );
  });

  it("preserves MySQL AUTO_INCREMENT and ON UPDATE column attributes", () => {
    const attributesSchema = {
      modelName: "attributes",
      fields: {
        id: { type: "number", required: true, fieldName: "id" },
        updatedAt: {
          type: "datetime",
          required: false,
          fieldName: "updated_at",
        },
      },
      indexes: [],
    } as unknown as TableSchema;
    const diffs = diffTables([attributesSchema], [{
      name: "plugfn_attributes",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_attributes",
        columnName: "id",
        dataType: "int",
        columnType: "int unsigned",
        maxLength: null,
        extra: "auto_increment",
        generationExpression: "",
        isVisible: true,
        characterSet: null,
        collation: null,
        comment: "primary counter",
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: true,
        isUnique: true,
      }, {
        dialect: "mysql",
        tableName: "plugfn_attributes",
        columnName: "updated_at",
        dataType: "timestamp",
        columnType: "timestamp",
        maxLength: null,
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
        generationExpression: "",
        isVisible: false,
        characterSet: null,
        collation: null,
        comment: "update clock",
        isNullable: false,
        defaultValue: "CURRENT_TIMESTAMP",
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [],
      constraints: [],
    }], "plugfn");
    const plan = createMigrationPlan("plugfn", 1, 2, diffs);

    const drizzle = generateDrizzleMigration(
      plan,
      [attributesSchema],
      "mysql",
    ).content;
    expect(drizzle).toContain(
      "MODIFY COLUMN id int unsigned NOT NULL auto_increment COMMENT 'primary counter';",
    );
    expect(drizzle).toContain(
      "MODIFY COLUMN updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP on update CURRENT_TIMESTAMP INVISIBLE COMMENT 'update clock';",
    );

    const kysely = generateKyselyMigration(
      plan,
      [attributesSchema],
      "mysql",
    ).content;
    expect(kysely).toContain(
      "MODIFY COLUMN id int unsigned NULL auto_increment COMMENT 'primary counter'",
    );
    expect(kysely).toContain(
      "MODIFY COLUMN updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP on update CURRENT_TIMESTAMP INVISIBLE COMMENT 'update clock'",
    );
  });

  it("removes temporal ON UPDATE metadata when changing to a non-temporal MySQL type", () => {
    const replacementSchema = {
      modelName: "attributes",
      fields: {
        legacyClock: {
          type: "string",
          required: false,
          fieldName: "legacy_clock",
          maxLength: 64,
        },
      },
      indexes: [],
    } as unknown as TableSchema;
    const diffs = diffTables([replacementSchema], [{
      name: "plugfn_attributes",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_attributes",
        columnName: "legacy_clock",
        dataType: "timestamp",
        columnType: "timestamp",
        maxLength: null,
        extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
        generationExpression: "",
        isVisible: true,
        characterSet: null,
        collation: null,
        comment: null,
        isNullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [],
      constraints: [],
    }], "plugfn");
    const kysely = generateKyselyMigration(
      createMigrationPlan("plugfn", 1, 2, diffs),
      [replacementSchema],
      "mysql",
    ).content;
    const up = kysely.slice(0, kysely.indexOf("export async function down"));
    const down = kysely.slice(kysely.indexOf("export async function down"));

    expect(up).toContain(
      "MODIFY COLUMN legacy_clock VARCHAR(64) NULL",
    );
    expect(up).not.toContain("ON UPDATE");
    expect(down).toContain(
      "MODIFY COLUMN legacy_clock timestamp NOT NULL on update CURRENT_TIMESTAMP",
    );
  });

  it("quotes character defaults and escapes introspected types in Kysely templates", () => {
    const metadataSchema = {
      modelName: "metadata",
      fields: {
        state: { type: "string", required: true, fieldName: "state", maxLength: 32 },
        marker: { type: "string", required: true, fieldName: "marker", maxLength: 32 },
        requestId: {
          type: "string",
          required: true,
          fieldName: "request_id",
          maxLength: 36,
        },
        quotedDefault: {
          type: "string",
          required: true,
          fieldName: "quoted_default",
          maxLength: 128,
        },
      },
      indexes: [],
    } as unknown as TableSchema;
    const diffs = diffTables([metadataSchema], [{
      name: "plugfn_metadata",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_metadata",
        columnName: "state",
        dataType: "varchar",
        columnType: "varchar(32)",
        maxLength: 32,
        isNullable: true,
        defaultValue: "CURRENT_TIMESTAMP",
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql",
        tableName: "plugfn_metadata",
        columnName: "marker",
        dataType: "enum",
        columnType: "enum('safe','${process.env.SECRET}','--','/*')",
        maxLength: 21,
        isNullable: false,
        defaultValue: "safe",
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql",
        tableName: "plugfn_metadata",
        columnName: "request_id",
        dataType: "varchar",
        columnType: "varchar(36)",
        maxLength: 36,
        extra: "DEFAULT_GENERATED",
        isNullable: true,
        defaultValue: "(uuid())",
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql",
        tableName: "plugfn_metadata",
        columnName: "quoted_default",
        dataType: "varchar",
        columnType: "varchar(128)",
        maxLength: 128,
        extra: "DEFAULT_GENERATED",
        isNullable: true,
        defaultValue: "(concat('a--b', '/*c*/', 'semi;colon'))",
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [],
      constraints: [],
    }], "plugfn");
    const content = generateKyselyMigration(
      createMigrationPlan("plugfn", 1, 2, diffs),
      [metadataSchema],
      "mysql",
    ).content;

    expect(content).toContain("varchar(32) NOT NULL DEFAULT 'CURRENT_TIMESTAMP'");
    expect(content).toContain("enum('safe','\\${process.env.SECRET}','--','/*')");
    expect(content).toContain("varchar(36) NOT NULL DEFAULT (uuid())");
    expect(content).toContain(
      "varchar(128) NOT NULL DEFAULT (concat('a--b', '/*c*/', 'semi;colon'))",
    );
    expect(
      hasUnsafeMySqlMetadataSyntax("(concat('safe') /* outside quote */)"),
    ).toBe(true);
    expect(
      hasUnsafeMySqlMetadataSyntax("(concat('safe\\'; DROP TABLE users; --'))"),
    ).toBe(true);
    expect(
      hasUnsafeMySqlMetadataSyntax("enum('a\\''; 'b\\'')"),
    ).toBe(true);
  });

  it("preserves removed TEXT-column metadata in a Kysely index rollback", () => {
    const replacementSchema = {
      modelName: "jobs",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        sequence: { type: "number", required: false, fieldName: "sequence" },
      },
      indexes: [{ name: "jobs_lookup_idx", fields: ["sequence"] }],
    } as unknown as TableSchema;
    const diffs = diffTables([replacementSchema], [{
      name: "plugfn_jobs",
      columns: [
        {
          tableName: "plugfn_jobs",
          columnName: "id",
          dataType: "text",
          isNullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isUnique: true,
        },
        {
          tableName: "plugfn_jobs",
          columnName: "legacy_note",
          dataType: "text",
          isNullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isUnique: false,
        },
      ],
      indexes: [{
        name: "jobs_lookup_idx",
        tableName: "plugfn_jobs",
        columns: ["legacy_note"],
        prefixLengths: [50],
        isUnique: true,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].changedIndexes?.[0].current.textColumns)
      .toEqual(["legacy_note"]);
    expect(diffs[0].changedIndexes?.[0].current.prefixLengths)
      .toEqual([50]);
    const content = generateKyselyMigration(
      createMigrationPlan("plugfn", 1, 2, diffs),
      [replacementSchema],
      "mysql",
    ).content;
    const down = content.slice(content.indexOf("export async function down"));
    expect(down).toContain(
      "CREATE UNIQUE INDEX jobs_lookup_idx ON plugfn_jobs (legacy_note(50));",
    );
  });

  it("preserves removed MySQL FULLTEXT index type without adding prefixes", () => {
    const replacementSchema = {
      modelName: "jobs",
      fields: {
        id: { type: "string", required: true, fieldName: "id", maxLength: 64 },
        sequence: { type: "number", required: false, fieldName: "sequence" },
      },
      indexes: [{ name: "jobs_lookup_idx", fields: ["sequence"] }],
    } as unknown as TableSchema;
    const diffs = diffTables([replacementSchema], [{
      name: "plugfn_jobs",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_jobs",
        columnName: "legacy_body",
        dataType: "text",
        columnType: "text",
        maxLength: 65_535,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql",
        tableName: "plugfn_jobs",
        columnName: "sequence",
        dataType: "int",
        columnType: "int",
        maxLength: null,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "jobs_lookup_idx",
        tableName: "plugfn_jobs",
        columns: ["legacy_body"],
        indexType: "FULLTEXT",
        isUnique: false,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].changedIndexes?.[0].current.indexType).toBe("FULLTEXT");
    const content = generateKyselyMigration(
      createMigrationPlan("plugfn", 1, 2, diffs),
      [replacementSchema],
      "mysql",
    ).content;
    const down = content.slice(content.indexOf("export async function down"));
    expect(down).toContain(
      "CREATE FULLTEXT INDEX jobs_lookup_idx ON plugfn_jobs (legacy_body);",
    );
    expect(down).not.toContain("legacy_body(191)");
  });

  it("restores introspected MySQL RTREE indexes as SPATIAL indexes", () => {
    const replacementSchema = {
      modelName: "places",
      fields: {
        sequence: { type: "number", required: false, fieldName: "sequence" },
      },
      indexes: [{ name: "places_lookup_idx", fields: ["sequence"] }],
    } as unknown as TableSchema;
    const diffs = diffTables([replacementSchema], [{
      name: "plugfn_places",
      columns: [{
        dialect: "mysql",
        tableName: "plugfn_places",
        columnName: "legacy_location",
        dataType: "geometry",
        columnType: "geometry",
        maxLength: null,
        isNullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }, {
        dialect: "mysql",
        tableName: "plugfn_places",
        columnName: "sequence",
        dataType: "int",
        columnType: "int",
        maxLength: null,
        isNullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
      }],
      indexes: [{
        name: "places_lookup_idx",
        tableName: "plugfn_places",
        columns: ["legacy_location"],
        indexType: "RTREE",
        isUnique: false,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].changedIndexes?.[0].current.indexType).toBe("RTREE");
    const content = generateKyselyMigration(
      createMigrationPlan("plugfn", 1, 2, diffs),
      [replacementSchema],
      "mysql",
    ).content;
    const down = content.slice(content.indexOf("export async function down"));
    expect(down).toContain(
      "CREATE SPATIAL INDEX places_lookup_idx ON plugfn_places (legacy_location);",
    );
    expect(down).not.toContain("legacy_location(191)");
  });

  it("preserves removed numeric-column metadata in a Kysely index rollback", () => {
    const replacementSchema = {
      modelName: "jobs",
      fields: {
        id: { type: "string", required: true, fieldName: "id" },
        count: { type: "number", required: false, fieldName: "count" },
      },
      indexes: [{ name: "jobs_lookup_idx", fields: ["count"] }],
    } as unknown as TableSchema;
    const diffs = diffTables([replacementSchema], [{
      name: "plugfn_jobs",
      columns: [
        {
          tableName: "plugfn_jobs",
          columnName: "id",
          dataType: "text",
          isNullable: false,
          defaultValue: null,
          isPrimaryKey: true,
          isUnique: true,
        },
        {
          dialect: "mysql",
          tableName: "plugfn_jobs",
          columnName: "legacy_count",
          dataType: "int",
          columnType: "int unsigned",
          isNullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isUnique: false,
        },
      ],
      indexes: [{
        name: "jobs_lookup_idx",
        tableName: "plugfn_jobs",
        columns: ["legacy_count"],
        isUnique: false,
      }],
      constraints: [],
    }], "plugfn");

    expect(diffs[0].changedIndexes?.[0].current.columnMetadata)
      .toEqual([{ dataType: "int", columnType: "int unsigned" }]);
    const content = generateKyselyMigration(
      createMigrationPlan("plugfn", 1, 2, diffs),
      [replacementSchema],
      "mysql",
    ).content;
    const down = content.slice(content.indexOf("export async function down"));
    expect(down).toContain(
      "CREATE INDEX jobs_lookup_idx ON plugfn_jobs (legacy_count);",
    );
  });
});
