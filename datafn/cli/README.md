# @datafn/cli

CLI tools, TypeScript code generation, and database migration management for DataFn. Generates typed interfaces from schemas and produces migration scripts for PostgreSQL, MySQL, and SQLite via Drizzle, Prisma, Kysely, or raw SQL.

## Installation

```bash
npm install @datafn/cli
```

## Features

| Feature | Description |
|---------|-------------|
| **Type Generation** | Generate TypeScript interfaces, `Tables` map, and `TypedClient` from a DataFn schema |
| **Migration Generation** | Compute migration plans from schema diffs and render as SQL or ORM code |
| **Schema Diffing** | Detect added/removed/altered resources, fields, relations, and indices |
| **Multi-Database** | PostgreSQL, MySQL, SQLite — each with dialect-specific DDL |
| **Multi-Adapter** | Drizzle ORM, Prisma, Kysely, or raw SQL output |
| **CLI Interface** | `npx @datafn/cli generate-migration` command for CI/CD pipelines |

---

## CLI Usage

### generate-migration

Generate database migrations from schema changes.

```bash
# Initial migration from a single schema file
npx @datafn/cli generate-migration \
  --schema ./schema.json \
  --adapter drizzle \
  --database postgres \
  --output ./migrations

# Migration between two schema versions
npx @datafn/cli generate-migration \
  --from ./schema-v1.json \
  --to ./schema-v2.json \
  --adapter drizzle \
  --database postgres \
  --output ./migrations

# Raw SQL (no ORM adapter)
npx @datafn/cli generate-migration \
  --schema ./schema.json \
  --database mysql \
  --output ./migrations
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--schema <path>` | Schema file for initial migration (from empty) | — |
| `--from <path>` | Source schema file | — |
| `--to <path>` | Target schema file | — |
| `--adapter <name>` | ORM adapter: `drizzle`, `prisma`, `kysely`, `raw` | `raw` |
| `--database <name>` | Database dialect: `postgres`, `mysql`, `sqlite` | `postgres` |
| `--output <dir>` | Output directory | `./migrations` |
| `-h, --help` | Show help | — |

Output files are timestamped: `<timestamp>_migration.{ts|sql}`.

---

## Programmatic API

### generateTypes(schema): string

Generate TypeScript definitions from a DataFn schema. The schema is validated first; invalid schemas throw a `DatafnError`.

```typescript
import { generateTypes } from "@datafn/cli";

const code = generateTypes({
  resources: [
    {
      name: "task",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        { name: "title", type: "string", required: true },
        { name: "done", type: "boolean", required: false },
        { name: "priority", type: "number", required: false },
        { name: "dueDate", type: "date", required: false },
        { name: "metadata", type: "object", required: false },
        { name: "tags", type: "array", required: false },
      ],
    },
    {
      name: "project",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true, unique: true },
        { name: "name", type: "string", required: true },
      ],
    },
  ],
});

console.log(code);
```

**Generated output:**

```typescript
import type { DatafnClient, DatafnTable } from "@datafn/client";

export interface Project {
  id: string;
  name: string;
}

export interface Task {
  done?: boolean;
  dueDate?: number;
  id: string;
  metadata?: Record<string, unknown>;
  priority?: number;
  tags?: unknown[];
  title: string;
}

export interface Tables {
  project: Project;
  task: Task;
}

export type TypedClient = DatafnClient & {
  project: DatafnTable<Project>;
  task: DatafnTable<Task>;
};
```

**Type mapping:**

| DataFn Type | TypeScript Type |
|-------------|----------------|
| `string` | `string` |
| `number` | `number` |
| `boolean` | `boolean` |
| `object` | `Record<string, unknown>` |
| `array` | `unknown[]` |
| `date` | `number` (timestamp) |
| `file` | `string` (URL or ID) |

Resources and fields are sorted alphabetically for deterministic output.

---

### diffSchemas(from, to): MigrationPlan

Compute the migration plan between two schema versions. Both schemas are validated first.

```typescript
import { diffSchemas } from "@datafn/cli";

const plan = diffSchemas(
  {
    resources: [
      {
        name: "task",
        version: 1,
        fields: [
          { name: "id", type: "string", required: true },
          { name: "title", type: "string", required: true },
        ],
      },
    ],
  },
  {
    resources: [
      {
        name: "task",
        version: 2,
        fields: [
          { name: "id", type: "string", required: true },
          { name: "title", type: "string", required: true },
          { name: "priority", type: "number", required: false },
        ],
      },
      {
        name: "tag",
        version: 1,
        fields: [
          { name: "id", type: "string", required: true },
          { name: "name", type: "string", required: true },
        ],
      },
    ],
    relations: [
      { from: "task", to: "tag", type: "many-many", relation: "tags" },
    ],
  },
);

console.log(plan.changes);
// [
//   { kind: "addResource", resource: "tag" },
//   { kind: "addField", resource: "task", field: "priority", type: "number", required: false },
//   { kind: "addRelation", from: "task", to: "tag", type: "many-to-many", relation: "tags" },
// ]
```

### MigrationPlan & MigrationChange

```typescript
interface MigrationPlan {
  changes: MigrationChange[];
}

type MigrationChange =
  | { kind: "addResource"; resource: string }
  | { kind: "removeResource"; resource: string }
  | { kind: "addField"; resource: string; field: string; type: string; required: boolean }
  | { kind: "removeField"; resource: string; field: string }
  | { kind: "alterField"; resource: string; field: string; changes: { type?: string; required?: boolean } }
  | { kind: "addRelation"; from: string; to: string; type: RelationType; relation?: string; inverse?: string; metadata?: Record<string, unknown> }
  | { kind: "removeRelation"; from: string; to: string; relation: string }
  | { kind: "addIndex"; resource: string; indexType: IndexType; fields: string[] }
  | { kind: "removeIndex"; resource: string; indexType: IndexType; fields: string[] };

type RelationType = "one-to-one" | "one-to-many" | "many-to-many";
type IndexType = "base" | "search" | "vector";
```

**Detected changes:**

| Kind | Description |
|------|-------------|
| `addResource` | New table/resource |
| `removeResource` | Dropped table/resource |
| `addField` | New column on existing table |
| `removeField` | Dropped column |
| `alterField` | Changed column type or required constraint |
| `addRelation` | New relation (join table or FK column) |
| `removeRelation` | Dropped relation |
| `addIndex` | New index (base, search, or vector) |
| `removeIndex` | Dropped index |

---

### SQL Renderers

Render a migration plan to dialect-specific SQL.

```typescript
import { diffSchemas, renderPostgres, renderMySQL, renderSQLite } from "@datafn/cli";
import type { MigrationContext } from "@datafn/cli";

const plan = diffSchemas(fromSchema, toSchema);

const ctx: MigrationContext = {
  dialect: "postgres",
  adapter: "raw",
  fromSchema,
  toSchema,
  joinTablePrefix: "__datafn_join_", // default
};

const sql = renderPostgres(plan, ctx);
// const sql = renderMySQL(plan, ctx);
// const sql = renderSQLite(plan, ctx);
```

### MigrationContext

```typescript
interface MigrationContext {
  /** Target database dialect */
  dialect: "postgres" | "mysql" | "sqlite";
  /** Target ORM adapter */
  adapter: "drizzle" | "prisma" | "kysely" | "raw";
  /** Source schema (null for initial migration) */
  fromSchema: DatafnSchema | null;
  /** Target schema */
  toSchema: DatafnSchema;
  /** Table namespace prefix */
  namespace?: string;
  /** Join table name prefix (default: "__datafn_join_") */
  joinTablePrefix?: string;
}
```

---

### ORM Adapter Generators

Generate ORM-specific migration files that wrap the dialect SQL.

```typescript
import {
  diffSchemas,
  generateDrizzleMigration,
  generatePrismaMigration,
  generateKyselyMigration,
} from "@datafn/cli";
import type { MigrationContext } from "@datafn/cli";

const plan = diffSchemas(fromSchema, toSchema);
const ctx: MigrationContext = {
  dialect: "postgres",
  adapter: "drizzle",
  fromSchema,
  toSchema,
};

// Drizzle ORM — TypeScript with up/down functions
const drizzle = generateDrizzleMigration(plan, ctx);

// Prisma — plain SQL file with header
const prisma = generatePrismaMigration(plan, ctx);

// Kysely — TypeScript with up/down functions
const kysely = generateKyselyMigration(plan, ctx);
```

**Drizzle output example:**

```typescript
import { sql } from 'drizzle-orm';

export async function up(db) {
  await db.execute(sql`
    ALTER TABLE "task" ADD COLUMN "priority" NUMERIC NULL;
  `);
}

export async function down(db) {
  // TODO: Add rollback logic
}
```

**Prisma output example:**

```sql
-- Prisma Migration
-- Provider: postgres

ALTER TABLE "task" ADD COLUMN "priority" NUMERIC NULL;
```

**Kysely output example:**

```typescript
import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "task" ADD COLUMN "priority" NUMERIC NULL;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // TODO: Add rollback logic
}
```

---

## Database Dialect Differences

| Feature | PostgreSQL | MySQL | SQLite |
|---------|------------|-------|--------|
| String | `TEXT` | `TEXT` | `TEXT` |
| Number | `NUMERIC` | `INT` | `INTEGER` |
| Boolean | `BOOLEAN` | `BOOLEAN` | `INTEGER` |
| Date | `BIGINT` | `BIGINT` | `INTEGER` |
| Object | `JSONB` | `JSON` | `TEXT` |
| Array | `JSONB` | `JSON` | `TEXT` |
| Identifiers | `"quoted"` | `` `backtick` `` | `"quoted"` |
| ALTER COLUMN | Full support | `MODIFY COLUMN` | Table recreation required |
| Full-text index | GIN / tsvector | `FULLTEXT INDEX` | FTS5 extension |
| Vector index | pgvector (ivfflat) | Not native | sqlite-vss extension |

---

## Exports

```typescript
// Code generation
export { generateTypes }

// Schema diffing
export { diffSchemas }

// SQL renderers
export { renderPostgres, renderMySQL, renderSQLite }

// ORM adapter generators
export { generateDrizzleMigration, generatePrismaMigration, generateKyselyMigration }

// Types
export type { MigrationPlan, MigrationChange, MigrationContext, RelationType, IndexType }
```

## License

MIT
