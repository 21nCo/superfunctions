# DataFn CLI Migration Generation Proposal

## Overview

Yes, it's **definitely possible** to add migration generation to the DataFn CLI based on DFQL schema versions. This document outlines how this feature could work.

## Current State

> **Status: IMPLEMENTED** (as of 2026-01-28)
>
> The migration generation feature has been fully implemented per this proposal.

### What Exists (IMPLEMENTED ✅)

1. **Complete Migration Infrastructure** (`datafn/cli/src/migrations/`):
   - `diff.ts` - Schema diffing with resource, field, relation, and index support ✅
   - `render-postgres.ts` - Full Postgres SQL renderer ✅
   - `render-mysql.ts` - Full MySQL SQL renderer ✅
   - `render-sqlite.ts` - Full SQLite SQL renderer ✅
   - `types.ts` - Complete migration types including relations and indices ✅
   - `adapters/drizzle.ts` - Drizzle ORM migration generator ✅
   - `adapters/prisma.ts` - Prisma migration generator ✅
   - `adapters/kysely.ts` - Kysely migration generator ✅

2. **CLI Command** (`cli/src/cli.ts`):
   - `generate-migration` command with full options support ✅
   - Schema loading (single schema or from/to comparison) ✅
   - Output to migrations directory ✅

3. **Schema Versioning**:
   - Each resource in DFQL schema has a `version` field
   - Example: `{ name: "task", version: 1, fields: [...] }`

4. **Relation/Join Table Support** ✅:
   - Many-to-many relations create join tables
   - One-to-many relations handled appropriately
   - Metadata columns supported

5. **Index Support** ✅:
   - Base indices
   - Search indices (with database-specific hints)
   - Vector indices (with extension hints)

### What's Still Planned (Future Enhancements)

1. **Schema version tracking** in database (introspection from live DB)
2. **Configuration file** (`datafn.config.js`) loading
3. **Migration rollback** generation (down migrations)
4. **Data migration** support for field type changes

## Proposed Implementation

### 1. CLI Command Structure

```bash
# Generate migration from current schema version
npx @datafn/cli generate-migration \
  --schema ./schema.json \
  --adapter drizzle \
  --database postgres \
  --output ./migrations

# Generate migration comparing two schema files
npx @datafn/cli generate-migration \
  --from ./schema-v1.json \
  --to ./schema-v2.json \
  --adapter drizzle \
  --database postgres \
  --output ./migrations

# With configuration file
npx @datafn/cli generate-migration \
  --config ./datafn.config.js
```

### 2. Configuration File Format

```typescript
// datafn.config.js
export default {
  schema: './schema.json',  // Path to current DFQL schema
  adapter: 'drizzle',        // 'drizzle' | 'prisma' | 'kysely'
  database: 'postgres',      // 'postgres' | 'mysql' | 'sqlite'
  migrationsDir: './migrations',
  namespace: 'datafn',       // Database namespace/prefix
  
  // Optional: Database connection for introspection
  databaseUrl: process.env.DATABASE_URL,
  
  // Optional: Custom field type mappings
  typeMappings: {
    'date': 'TIMESTAMP',  // Override default mapping
  },
  
  // Optional: Relation/join table naming convention
  joinTablePrefix: '__datafn_join_',
};
```

### 3. Migration Generation Flow

```
1. Load DFQL schema(s)
   ├─ If --from/--to: Load both and diff
   └─ If --schema: Load current, introspect database for previous version

2. Compute migration plan
   ├─ Diff schemas (resources, fields, relations)
   ├─ Detect version changes
   └─ Generate MigrationPlan

3. Generate adapter-specific migration
   ├─ Drizzle: Generate Drizzle migration file
   ├─ Prisma: Generate Prisma migration SQL
   └─ Kysely: Generate Kysely migration file

4. Write migration file(s)
   └─ Timestamped filename: `{timestamp}_v{fromVersion}_to_v{toVersion}.{ext}`
```

### 4. What Gets Migrated

#### Resources (Tables)
- **Create table**: When resource is added
- **Drop table**: When resource is removed
- **Rename table**: When resource name changes (if supported)

#### Fields (Columns)
- **Add column**: When field is added
- **Drop column**: When field is removed
- **Alter column**: When field type or constraints change
  - Type changes (e.g., `string` → `number`)
  - Required/nullable changes
  - Default value changes
  - Unique constraint changes

#### Relations (Join Tables)
- **Create join table**: For `many-many` relations
  - Table name: `__datafn_join_{from}_{relation}`
  - Columns: `from`, `to`, plus metadata fields
- **Drop join table**: When relation is removed
- **Alter join table**: When relation metadata changes

#### Indices
- **Create index**: For `base`, `search`, `vector` indices
- **Drop index**: When indices are removed

### 5. Adapter-Specific Outputs

#### Drizzle

```typescript
// migrations/1234567890_v1_to_v2.ts
import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';

export const up = async (db) => {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS "task" (
      "id" TEXT PRIMARY KEY,
      "label" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL
    );
  `);
  
  await db.execute(`
    CREATE TABLE IF NOT EXISTS "__datafn_join_task_tags" (
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      "value" TEXT,
      PRIMARY KEY ("from", "to")
    );
  `);
};

export const down = async (db) => {
  await db.execute(`DROP TABLE IF EXISTS "__datafn_join_task_tags";`);
  await db.execute(`DROP TABLE IF EXISTS "task";`);
};
```

#### Prisma

```sql
-- migrations/1234567890_v1_to_v2/migration.sql
-- CreateTable
CREATE TABLE "task" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    CONSTRAINT "task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "__datafn_join_task_tags" (
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "value" TEXT,
    CONSTRAINT "__datafn_join_task_tags_pkey" PRIMARY KEY ("from", "to")
);
```

#### Kysely

```typescript
// migrations/1234567890_v1_to_v2.ts
import { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('task')
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('label', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('createdAt', 'bigint', (col) => col.notNull())
    .execute();
    
  await db.schema
    .createTable('__datafn_join_task_tags')
    .addColumn('from', 'text', (col) => col.notNull())
    .addColumn('to', 'text', (col) => col.notNull())
    .addColumn('value', 'text')
    .addPrimaryKeyConstraint('__datafn_join_task_tags_pkey', ['from', 'to'])
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('__datafn_join_task_tags').execute();
  await db.schema.dropTable('task').execute();
}
```

### 6. Database Dialect Support

Each adapter needs dialect-specific SQL generation:

| Feature | Postgres | MySQL | SQLite |
|---------|----------|-------|--------|
| String | `TEXT` | `TEXT` | `TEXT` |
| Number | `INTEGER` or `NUMERIC` | `INT` | `INTEGER` |
| Boolean | `BOOLEAN` | `BOOLEAN` | `INTEGER` (0/1) |
| Date | `BIGINT` (timestamp) | `BIGINT` | `INTEGER` |
| JSON | `JSONB` | `JSON` | `TEXT` |
| Array | `JSONB` | `JSON` | `TEXT` |

### 7. Schema Version Tracking

To support incremental migrations, we need to track schema versions:

```sql
-- Create version tracking table (if not exists)
CREATE TABLE IF NOT EXISTS "_datafn_schema_versions" (
  "resource" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL,
  "updatedAt" BIGINT NOT NULL
);
```

The CLI would:
1. Read current versions from database (if connected)
2. Compare with schema file versions
3. Generate migrations for version differences

### 8. Implementation Steps

#### Phase 1: Core Infrastructure ✅ COMPLETE
- [x] Enhance `diffSchemas` to handle relations and indices
- [x] Complete `renderPostgres` with full table creation
- [x] Add `renderMySQL` and `renderSQLite` renderers
- [x] Add relation/join table migration support

#### Phase 2: Adapter Generators ✅ COMPLETE
- [x] `generateDrizzleMigration()` - Drizzle migration file generator
- [x] `generatePrismaMigration()` - Prisma SQL generator
- [x] `generateKyselyMigration()` - Kysely migration file generator

#### Phase 3: CLI Command ✅ COMPLETE
- [x] Add `generate-migration` command
- [ ] Config file loading (future enhancement)
- [ ] Schema version introspection (future enhancement)
- [x] Migration file writing

#### Phase 4: Advanced Features (PLANNED)
- [ ] Database introspection (compare with existing schema)
- [ ] Migration rollback generation
- [ ] Data migration support (for field type changes)
- [ ] Dry-run mode

### 9. Example Usage

```bash
# 1. Initial setup - generate first migration
npx @datafn/cli generate-migration \
  --schema ./schema.json \
  --adapter drizzle \
  --database postgres \
  --output ./migrations
# Creates: migrations/1234567890_v0_to_v1.ts

# 2. Schema update - increment version in schema.json
# Change: task.version: 1 → 2, add new field "priority"
npx @datafn/cli generate-migration \
  --schema ./schema.json \
  --adapter drizzle \
  --database postgres \
  --output ./migrations
# Creates: migrations/1234567891_v1_to_v2.ts

# 3. With config file
npx @datafn/cli generate-migration --config ./datafn.config.js
```

### 10. Benefits

1. **Version-based migrations**: Automatic migration generation from schema version changes
2. **Multi-adapter support**: Works with Drizzle, Prisma, Kysely
3. **Multi-database support**: Postgres, MySQL, SQLite
4. **Relation support**: Handles join tables for many-many relations
5. **Type safety**: Migrations generated from validated DFQL schemas
6. **Deterministic**: Same schema always produces same migration

### 11. Limitations & Considerations

1. **Data migrations**: Type changes (e.g., string → number) may require manual data transformation
2. **Breaking changes**: Some changes (like removing required fields) need careful handling
3. **Index management**: Complex index changes may need manual review
4. **Relation changes**: Changing relation types (many-one → many-many) requires careful migration
5. **Database-specific features**: Some features may not translate perfectly across databases

### 12. Integration with Existing Tools

This would complement existing migration tools:
- **Drizzle Kit**: Could use generated migrations or generate Drizzle-specific migrations
- **Prisma Migrate**: Could use generated SQL or generate Prisma migrations
- **Kysely Migrations**: Direct integration with Kysely migration system

## Conclusion

Yes, this is **absolutely feasible** and would be a valuable addition to the DataFn CLI. The infrastructure already exists in the codebase (both in `datafn/cli` and `packages/cli`), so this would primarily be:

1. **Completing** the existing migration infrastructure
2. **Adapting** the superfunctions CLI patterns for DataFn
3. **Adding** adapter-specific generators
4. **Creating** the CLI command interface

The feature would enable developers to:
- Generate migrations automatically from schema changes
- Support multiple ORMs and databases
- Maintain schema version consistency
- Reduce manual migration writing
