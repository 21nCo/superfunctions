# Unified Schema Generation & Join Table Refactor Specification

**Timestamp**: 2026-02-15T18:00:00Z
**Agent**: claude-opus-4-6
**Model**: Claude Opus 4.6
**Launcher**: Claude Code (VSCode)
**OS**: macOS (arm64)
**Git Branch**: heads/next
**Repo Path**: /Users/serro/Documents/dev/n/superfunctions/datafn

---

## 1. Overview

### 1.1 Purpose

Replace the `generate-types` and `generate-migration` CLI commands with a single `generate` command that produces adapter-specific ORM schema definitions (initially Drizzle) and client TypeScript types from the DataFn schema. Additionally, refactor join table mutations to use the ORM adapter instead of internal CRUD, since join tables will now be first-class ORM tables.

### 1.2 Background

The current architecture requires users to maintain **two separate schemas** that must stay in sync:

1. **DataFn schema** (`schema.datafn.ts`) — defines resources, fields, relations for validation and sync
2. **ORM schema** (e.g., Drizzle `pgTable` definitions) — defines actual database table structure

The `generate-migration` command attempts to bridge this gap by generating migration SQL from DataFn schema diffs, but:
- Users still need a hand-written ORM schema for the adapter to work at runtime
- ORM tools (drizzle-kit, prisma migrate) already handle migration generation better
- The dual-schema maintenance is error-prone and creates friction

Additionally, many-many join tables are currently split between two code paths:
- Named join tables (with `joinTable` in schema) use `adapter.create`/`findOne`/`update`/`delete`
- Auto-generated join tables use `adapter.internal.create`/`findOne`/`update`/`delete`

This split is an artifact of join tables not existing in the ORM schema. With generated schemas, all join tables should go through the ORM adapter uniformly.

### 1.3 Goals

1. **Single Source of Truth**: DataFn schema generates both ORM schema and client types
2. **Remove Migration System**: Delegate migration management to ORM-native tools
3. **Unified CLI**: Single `generate` command replacing `generate-types` and `generate-migration`
4. **Drizzle Schema Codegen**: Generate `pgTable`/`mysqlTable`/`sqliteTable` definitions with correct type mappings, constraints, indices, and join tables
5. **Uniform Join Table Handling**: All join table operations go through `adapter.create`/`findOne`/`update`/`delete` (not `adapter.internal`)
6. **Simplify Codebase**: Remove migration diff engine, SQL renderers, and ORM adapter generators

### 1.4 Non-Goals

- Generating Prisma or Kysely schemas (future enhancement — Drizzle only for now)
- Drizzle `relations()` helper generation (Drizzle relations are for query API, not required for DataFn)
- Automatic migration execution (users run `drizzle-kit` themselves)
- Changing how internal system tables (`__datafn_meta`, `__datafn_changes`, etc.) work
- Schema validation changes (existing `validateSchema()` is unchanged)

---

## 2. User Experience

### 2.1 New Workflow

```bash
# 1. Write your DataFn schema (single source of truth)
# schema.datafn.ts

# 2. Generate ORM schema + client types
$ datafn generate --adapter drizzle --database postgres
✓ Schema written to: ./datafn-schema.drizzle.ts
✓ Types written to: ./datafn-types.ts

# 3. Use ORM tooling for migrations
$ drizzle-kit generate
$ drizzle-kit migrate

# 4. Use generated schema in your app
import { schema } from './datafn-schema.drizzle';
const db = drizzle(pool, { schema });
```

### 2.2 Explicit Paths

```bash
$ datafn generate \
  --adapter drizzle \
  --database postgres \
  --schema ./src/schema.datafn.ts \
  --output ./src/db/
```

### 2.3 Auto-Discovery

When `--schema` is NOT provided, the CLI MUST search in the same order as current `generate-types`:
1. `./schema.datafn.ts`
2. `./src/schema.datafn.ts`
3. `./schema.json`
4. `./src/schema.json`

### 2.4 Error Cases

**Missing required `--adapter` flag:**
```bash
$ datafn generate
✗ Error: --adapter is required
  Supported: drizzle
```

**Missing required `--database` flag:**
```bash
$ datafn generate --adapter drizzle
✗ Error: --database is required
  Supported: postgres, mysql, sqlite
```

**Unsupported adapter:**
```bash
$ datafn generate --adapter prisma --database postgres
✗ Error: Unsupported adapter: prisma
  Currently supported: drizzle
```

### 2.5 Removed Commands

The following commands MUST be removed:
- `generate-types` — functionality absorbed into `generate`
- `generate-migration` — functionality replaced by ORM-native tooling

Running a removed command MUST print a migration notice:
```bash
$ datafn generate-types
✗ 'generate-types' has been replaced by 'generate'
  Usage: datafn generate --adapter drizzle --database postgres
```

---

## 3. Technical Design

### 3.1 Drizzle Schema Generation

New function `generateDrizzleSchema(schema, dialect)` in `datafn/cli/src/codegen.ts` (or new file `datafn/cli/src/drizzle-codegen.ts`).

**Input**: Validated `DatafnSchema` + dialect (`postgres` | `mysql` | `sqlite`)
**Output**: TypeScript string containing Drizzle table definitions

#### 3.1.1 Import Generation

Imports MUST be dialect-specific:

| Dialect | Import Path | Table Constructor |
|---------|-------------|-------------------|
| `postgres` | `drizzle-orm/pg-core` | `pgTable` |
| `mysql` | `drizzle-orm/mysql-core` | `mysqlTable` |
| `sqlite` | `drizzle-orm/sqlite-core` | `sqliteTable` |

Column type imports MUST be included only for types actually used in the schema (tree-shaken).

#### 3.1.2 Type Mapping

**Postgres (`drizzle-orm/pg-core`)**:

| DataFn Type | Drizzle Column | Import |
|-------------|---------------|--------|
| `string` | `text("field")` | `text` |
| `number` | `numeric("field")` | `numeric` |
| `boolean` | `boolean("field")` | `boolean` |
| `date` | `bigint("field", { mode: "number" })` | `bigint` |
| `object` | `jsonb("field")` | `jsonb` |
| `array` | `jsonb("field")` | `jsonb` |
| `file` | `text("field")` | `text` |

**MySQL (`drizzle-orm/mysql-core`)**:

| DataFn Type | Drizzle Column | Import |
|-------------|---------------|--------|
| `string` | `text("field")` | `text` |
| `number` | `int("field")` | `int` |
| `boolean` | `boolean("field")` | `boolean` |
| `date` | `bigint("field", { mode: "number" })` | `bigint` |
| `object` | `json("field")` | `json` |
| `array` | `json("field")` | `json` |
| `file` | `text("field")` | `text` |

**SQLite (`drizzle-orm/sqlite-core`)**:

| DataFn Type | Drizzle Column | Import |
|-------------|---------------|--------|
| `string` | `text("field")` | `text` |
| `number` | `integer("field")` | `integer` |
| `boolean` | `integer("field")` | `integer` |
| `date` | `integer("field")` | `integer` |
| `object` | `text("field")` | `text` |
| `array` | `text("field")` | `text` |
| `file` | `text("field")` | `text` |

#### 3.1.3 Field Modifiers

| DataFn Property | Drizzle Modifier | Condition |
|-----------------|-----------------|-----------|
| `required: true` | `.notNull()` | Always when true |
| `unique: true` | `.unique()` | Always when true |
| `default: value` | `.default(value)` | When default is defined |
| field name `id` with type `string` | `.primaryKey()` | Assumed primary key convention |

#### 3.1.4 Column Name Convention

DataFn field names use camelCase. The generated Drizzle column name (SQL column) MUST use snake_case for the actual column name while the TypeScript property name remains camelCase:

```typescript
createdAt: bigint("created_at", { mode: "number" }).notNull(),
```

The function `camelToSnake()` MUST be used for column name conversion.

#### 3.1.5 Index Generation

For resources with `indices.base` arrays:

```typescript
export const todos = pgTable("todos", {
  // columns...
}, (table) => [
  index("todos_completed_idx").on(table.completed),
  index("todos_created_at_idx").on(table.createdAt),
]);
```

Index name convention: `{tableName}_{fieldName}_idx`

`search` and `vector` indices are **not generated** (these require database-specific extensions and manual setup). A comment SHOULD be included if they exist in the schema.

#### 3.1.6 Join Table Generation

For every `many-many` relation, generate a join table:

```typescript
export const __datafn_join_todos_tags = pgTable("__datafn_join_todos_tags", {
  id: text("id").primaryKey(),
  from: text("from").notNull(),
  to: text("to").notNull(),
  // metadata fields if present
  priority: numeric("priority"),
});
```

Join table naming:
- If `relation.joinTable` is defined → use it
- Otherwise → `__datafn_join_{from}_{relation}`

Join column naming:
- If `relation.joinColumns` is defined → use `{ from, to }`
- Otherwise → `{ from: "from", to: "to" }`

#### 3.1.7 Schema Export

The generated file MUST export a `schema` object containing all tables:

```typescript
export const schema = { categories, todos, __datafn_join_todos_tags };
```

This object is passed to `drizzle(pool, { schema })`.

#### 3.1.8 Output Ordering

Resources and join tables MUST be sorted alphabetically by name for deterministic output.

#### 3.1.9 Generated File Header

```typescript
// Generated by @datafn/cli. DO NOT EDIT.
// Source: schema.datafn.ts
// Database: postgres
// Generated at: 2026-02-15T18:00:00Z
```

### 3.2 Unified `generate` Command

#### 3.2.1 CLI Options

| Option | Description | Required | Default |
|--------|-------------|----------|---------|
| `--adapter <name>` | ORM adapter: `drizzle` | Yes | — |
| `--database <name>` | Dialect: `postgres`, `mysql`, `sqlite` | Yes | — |
| `--schema <path>` | Schema file (`.json` or `.datafn.ts`) | No | Auto-discover |
| `--output <dir>` | Output directory for generated files | No | `./` |

#### 3.2.2 Output Files

| File | Content |
|------|---------|
| `datafn-schema.drizzle.ts` | Drizzle table definitions |
| `datafn-types.ts` | Client TypeScript interfaces (same as current) |

Both files are written to the `--output` directory.

#### 3.2.3 Command Flow

```
1. Parse CLI arguments
2. Validate --adapter and --database
3. Resolve schema path (explicit or auto-discover)
4. Load schema (JSON or TypeScript)
5. Validate schema via validateSchema()
6. Generate Drizzle schema via generateDrizzleSchema()
7. Generate client types via generateTypes()
8. Write both files to output directory
9. Print success messages
```

### 3.3 Join Table Refactor

#### 3.3.1 Current Behavior (in `datafn/server/src/execution/mutation/relations.ts`)

```
If relation.joinTable is defined (named):
  → adapter.create() / adapter.findOne() / adapter.update() / adapter.delete()
Else (auto-generated):
  → ensureJoinTable() + adapter.internal.create() / .findOne() / .update() / .delete()
```

#### 3.3.2 New Behavior

**All** many-many join tables MUST use the adapter's standard CRUD methods:

```
Always:
  → adapter.create() / adapter.findOne() / adapter.update() / adapter.delete()
Never:
  → adapter.internal.*() for join tables
  → ensureJoinTable() call
```

#### 3.3.3 Changes Required

In `datafn/server/src/execution/mutation/relations.ts`:

1. **Remove** the `useNamed` / `!useNamed` branching in `executeRelate()`, `executeModifyRelation()`, `executeUnrelate()`
2. **Remove** all `ensureJoinTable()` calls for join tables
3. **Remove** all `adapter.internal.create/findOne/update/delete` calls for join tables
4. **Use** `adapter.create/findOne/update/delete` uniformly for all join tables
5. **Compute** table name and column names the same way for all cases:
   - `tableName = relation.joinTable || __datafn_join_{from}_{relation}`
   - `fromCol = relation.joinColumns?.from || "from"`
   - `toCol = relation.joinColumns?.to || "to"`

#### 3.3.4 Impact on ensureJoinTable()

The `ensureJoinTable()` function in `internal-tables.ts` MUST be removed since:
- Join tables are now in the generated ORM schema
- Table creation happens via ORM migrations (not runtime `CREATE TABLE IF NOT EXISTS`)
- The function is no longer called

Note: `ensureInternalTable()` is **not affected** — system tables (`__datafn_meta`, `__datafn_changes`, etc.) continue using internal CRUD.

### 3.4 Code Removal

The following MUST be removed:

| Path | Reason |
|------|--------|
| `datafn/cli/src/migrations/diff.ts` | Schema diffing no longer needed |
| `datafn/cli/src/migrations/render-postgres.ts` | SQL rendering no longer needed |
| `datafn/cli/src/migrations/render-mysql.ts` | SQL rendering no longer needed |
| `datafn/cli/src/migrations/render-sqlite.ts` | SQL rendering no longer needed |
| `datafn/cli/src/migrations/adapters/` | ORM migration generators no longer needed |
| `datafn/cli/src/migrations/types.ts` | Migration types no longer needed |
| `datafn/cli/__tests__/migrations.test.ts` | Migration tests no longer needed |
| `ensureJoinTable()` in `internal-tables.ts` | Join tables via ORM now |

The following MUST be modified:

| Path | Change |
|------|--------|
| `datafn/cli/src/cli.ts` | New `generate` command, remove old commands |
| `datafn/cli/src/codegen.ts` or new `drizzle-codegen.ts` | Add `generateDrizzleSchema()` |
| `datafn/server/src/execution/mutation/relations.ts` | Unify join table CRUD |
| `datafn/server/src/execution/internal-tables.ts` | Remove `ensureJoinTable()` |
| `datafn/cli/README.md` | Updated documentation |
| `datafn/cli/package.json` | Remove migration-related exports |

---

## 4. Specification Type

**Type**: `change`

**Rationale**: This modifies existing CLI commands and server-side relation handling. It removes functionality (migration system) and adds new functionality (Drizzle schema generation) while changing the developer workflow.

---

## 5. Success Criteria

This specification is considered successfully implemented when:

1. `datafn generate --adapter drizzle --database postgres` produces valid Drizzle pgTable definitions
2. `datafn generate --adapter drizzle --database mysql` produces valid Drizzle mysqlTable definitions
3. `datafn generate --adapter drizzle --database sqlite` produces valid Drizzle sqliteTable definitions
4. Generated Drizzle schema includes all resources, fields, indices, and join tables
5. Generated client types are identical to current `generate-types` output
6. `generate-types` and `generate-migration` commands are removed with migration notices
7. All migration code (diff engine, SQL renderers, adapters) is removed
8. Join table mutations use `adapter.create/findOne/update/delete` uniformly
9. `ensureJoinTable()` is removed
10. All existing relation tests pass with refactored code
11. All 18 test vectors pass
12. README updated with new `generate` command documentation

---

## 6. Dependencies & Constraints

### 6.1 Internal Dependencies

- `@datafn/core` — `validateSchema()`, `DatafnSchema` type (unchanged)
- `datafn/cli/src/codegen.ts` — `generateTypes()` function (unchanged)
- `datafn/server/src/execution/mutation/relations.ts` — join table mutation handlers (modified)
- `datafn/server/src/execution/internal-tables.ts` — `ensureJoinTable()` removal
- `@superfunctions/db` — `Adapter` interface (unchanged)

### 6.2 External Dependencies

- `drizzle-orm` — Referenced in generated code (import path). NOT a dependency of `@datafn/cli` itself. The generated file imports from the user's installed `drizzle-orm`.

### 6.3 Constraints

- MUST NOT add `drizzle-orm` as a dependency of `@datafn/cli`
- Generated schema MUST be valid TypeScript that compiles without errors
- Generated schema MUST work with `drizzle-kit generate` and `drizzle-kit push`
- Internal system tables (`__datafn_meta`, etc.) MUST continue using `adapter.internal`
- Auto-discovery behavior MUST be preserved from current `generate-types`
- TypeScript schema loading (`.datafn.ts`) MUST continue working

---

## 7. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Generated Drizzle schema has incorrect types | Users get DB errors | Medium | Comprehensive test vectors with exact expected output |
| Removing `ensureJoinTable` breaks existing deployments with auto-created join tables | Data loss | High | Users MUST run `datafn generate` + `drizzle-kit` before upgrading server |
| `drizzle-kit` cannot parse generated schema | Migration workflow broken | Low | Test generated schemas with actual `drizzle-kit` in CI |
| camelCase → snake_case conversion has edge cases | Column name mismatches | Low | Explicit test vectors for naming edge cases |
| Users on Prisma/Kysely lose migration support | Broken workflow | Medium | Document that only Drizzle is supported initially; Prisma/Kysely support planned |

---

## 8. Open Questions

1. **Migration notice duration**: How long should we keep the `generate-types`/`generate-migration` deprecation notices before removing them entirely?
   - **Assumption**: Keep indefinitely until next major version.

2. **Breaking change communication**: This is a breaking change for users who rely on `generate-migration`.
   - **Assumption**: Communicated via changelog and README.

---

## 9. References

- Current CLI: `datafn/cli/src/cli.ts`
- Current codegen: `datafn/cli/src/codegen.ts`
- Relation mutations: `datafn/server/src/execution/mutation/relations.ts`
- Internal tables: `datafn/server/src/execution/internal-tables.ts`
- Adapter types: `packages/db/src/adapter/types.ts`
- DataFn schema types: `datafn/core/src/types.ts`
- Drizzle adapter: `packages/db/src/adapters/drizzle/index.ts`
- Relation tests: `datafn/server/src/execution/mutation/__tests__/relations.test.ts`
- Todo app example: `datafn/examples/todo-app/`
- Drizzle docs: https://orm.drizzle.team/docs/sql-schema-declaration
