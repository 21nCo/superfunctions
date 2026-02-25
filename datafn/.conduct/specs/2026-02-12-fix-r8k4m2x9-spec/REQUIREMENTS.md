# Requirements

## Table of Contents

| ID        | Priority | Summary                                                                      |
| --------- | -------- | ---------------------------------------------------------------------------- |
| ICRUD-001 | P0       | `InternalCrud` interface definition                                          |
| ICRUD-002 | P0       | `Adapter.internal` property                                                  |
| ICRUD-003 | P0       | `ensureTable` lazy DDL with caching                                          |
| DRZ-001   | P0       | Drizzle adapter `InternalCrud` implementation                                |
| PRS-001   | P0       | Prisma adapter `InternalCrud` implementation                                 |
| KYS-001   | P0       | Kysely adapter `InternalCrud` implementation                                 |
| MEM-001   | P0       | Memory adapter `InternalCrud` implementation                                 |
| SRV-001   | P0       | Server: route `__datafn_meta` through `adapter.internal`                     |
| SRV-002   | P0       | Server: route `__datafn_changes` through `adapter.internal`                  |
| SRV-003   | P0       | Server: route `__datafn_idempotency` through `adapter.internal`              |
| SRV-004   | P0       | Server: route `__datafn_seed` through `adapter.internal`                     |
| JT-001    | P1       | Add `joinTable` and `joinColumns` to `DatafnRelationSchema`                  |
| JT-002    | P1       | Server: resolve many-many join table from schema relation                    |
| JT-003    | P1       | Server: use `joinColumns` for column names in join operations                |
| JT-004    | P1       | Fallback to `__datafn_join_*` via `adapter.internal` when `joinTable` absent |
| CLI-001   | P1       | CLI migration: generate named join tables when `joinTable` set               |
| CLI-002   | P1       | CLI codegen: emit join table TS interfaces for typed relations               |

---

## ICRUD-001 — `InternalCrud` Interface Definition

- **Priority**: P0
- **Statement**: The `@superfunctions/db` package MUST export an `InternalCrud` interface with methods: `ensureTable`, `create`, `findOne`, `findMany`, `update`, `delete`.
- **Rationale**: Provides the contract for all adapters to implement raw CRUD without schema resolution.
- **Acceptance Criteria**:
  - `InternalCrud` is exported from `@superfunctions/db`
  - `InternalColumnDef` is exported from `@superfunctions/db`
  - All methods accept a plain string table name (not a model/ORM ref)
  - TypeScript compilation succeeds
- **Test Vectors**: TV-ICRUD-001
- **Notes**: The `where` array uses `{ field, op, value }` tuples — a simplified version of the existing `WhereClause`.

## ICRUD-002 — `Adapter.internal` Property

- **Priority**: P0
- **Statement**: The `Adapter` interface MUST include a readonly `internal` property of type `InternalCrud`.
- **Rationale**: Gives the DataFn server a clean pathway to access internal tables without polluting user CRUD.
- **Acceptance Criteria**:
  - `Adapter` interface includes `readonly internal: InternalCrud`
  - All adapter factory functions produce adapters with `internal` populated
  - Existing adapter methods remain unchanged
- **Test Vectors**: TV-ICRUD-001
- **Notes**: This is a breaking interface change.

## ICRUD-003 — `ensureTable` Lazy DDL with Caching

- **Priority**: P0
- **Statement**: `ensureTable(name, columns)` MUST run `CREATE TABLE IF NOT EXISTS` DDL on first call for a given table name and MUST NOT re-run on subsequent calls.
- **Rationale**: Prevents redundant DDL on every request while ensuring tables exist on first use.
- **Acceptance Criteria**:
  - First call runs DDL, subsequent calls return immediately
  - Table name MUST match `^__datafn_[a-z0-9_]+$`
  - Invalid table names MUST throw `Error` with descriptive message
  - DDL is dialect-appropriate (Postgres, SQLite, MySQL)
- **Test Vectors**: TV-ENSURE-001, TV-ENSURE-002
- **Notes**: Caching is per adapter instance lifetime.

## DRZ-001 — Drizzle Adapter `InternalCrud` Implementation

- **Priority**: P0
- **Statement**: The Drizzle adapter MUST implement `InternalCrud` using `db.run(sql`...`)` from `drizzle-orm` for DDL and by dynamically constructing raw SQL for CRUD.
- **Rationale**: Drizzle's `sql` template tag bypasses schema resolution while still using the same connection pool.
- **Acceptance Criteria**:
  - `ensureTable` runs appropriate `CREATE TABLE IF NOT EXISTS` for the configured dialect (postgres/sqlite/mysql)
  - `create` inserts a row and returns the inserted data
  - `findOne` returns a matching row or `null`
  - `findMany` returns matching rows (supports optional `orderBy` and `limit`)
  - `update` updates matching rows and returns count
  - `delete` deletes matching rows and returns count
- **Test Vectors**: TV-DRZ-INTERNAL-001, TV-DRZ-INTERNAL-002
- **Notes**: Use `sql.identifier()` or safe string interpolation for table/column names.

## PRS-001 — Prisma Adapter `InternalCrud` Implementation

- **Priority**: P0
- **Statement**: The Prisma adapter MUST implement `InternalCrud` using `prisma.$executeRaw` for DDL and `prisma.$queryRaw` for queries.
- **Rationale**: Prisma's `$executeRaw` / `$queryRaw` bypass the Prisma client schema model entirely.
- **Acceptance Criteria**: Same as DRZ-001, adapted for Prisma's raw query API.
- **Test Vectors**: TV-PRS-INTERNAL-001
- **Notes**: Prisma requires `Prisma.sql` template tag for parameterized queries.

## KYS-001 — Kysely Adapter `InternalCrud` Implementation

- **Priority**: P0
- **Statement**: The Kysely adapter MUST implement `InternalCrud` using `db.schema` for DDL and `sql` raw builder for CRUD.
- **Rationale**: Kysely has a schema builder API (`db.schema.createTable`) and raw `sql` for queries.
- **Acceptance Criteria**: Same as DRZ-001, adapted for Kysely's API.
- **Test Vectors**: TV-KYS-INTERNAL-001
- **Notes**: Kysely's `db.schema.createTable` is idempotent-friendly with `.ifNotExists()`.

## MEM-001 — Memory Adapter `InternalCrud` Implementation

- **Priority**: P0
- **Statement**: The memory adapter MUST implement `InternalCrud` using its in-memory `Map<string, Map>` store.
- **Rationale**: Memory adapter is already schemaless; the `InternalCrud` implementation is trivial.
- **Acceptance Criteria**:
  - `ensureTable` creates a collection if not exists (no-op otherwise)
  - CRUD methods operate on the in-memory store
- **Test Vectors**: TV-MEM-INTERNAL-001
- **Notes**: This is the simplest implementation.

## SRV-001 — Server: Route `__datafn_meta` Through `adapter.internal`

- **Priority**: P0
- **Statement**: `sequence-store.ts` and `change-tracking.ts` MUST use `adapter.internal.*` for all `__datafn_meta` operations.
- **Rationale**: The server currently calls `adapter.findOne({ model: "__datafn_meta" })` which fails on SQL adapters.
- **Acceptance Criteria**:
  - `DatabaseSequenceStore` calls `adapter.internal.ensureTable("__datafn_meta", ...)` on first access
  - All `findOne`/`create`/`update` calls for `__datafn_meta` use `adapter.internal.*`
  - `serverSeq` increments correctly under concurrent access
- **Test Vectors**: TV-SERVERSEQ-001
- **Notes**: Must call `ensureTable` before first CRUD operation.

## SRV-002 — Server: Route `__datafn_changes` Through `adapter.internal`

- **Priority**: P0
- **Statement**: `change-tracking.ts` MUST use `adapter.internal.*` for all `__datafn_changes` operations.
- **Rationale**: Same as SRV-001.
- **Acceptance Criteria**:
  - `ensureTable` called on first access
  - All `create`/`findMany` calls for `__datafn_changes` use `adapter.internal.*`
  - Change log entries are stored and retrievable by `serverSeq` range
- **Test Vectors**: TV-CHANGELOG-001
- **Notes**: None.

## SRV-003 — Server: Route `__datafn_idempotency` Through `adapter.internal`

- **Priority**: P0
- **Statement**: `idempotency-db.ts` MUST use `adapter.internal.*` for all `__datafn_idempotency` operations.
- **Rationale**: Same as SRV-001.
- **Acceptance Criteria**:
  - `ensureTable` called on first access
  - Duplicate mutations are correctly deduped
- **Test Vectors**: TV-IDEMP-001
- **Notes**: None.

## SRV-004 — Server: Route `__datafn_seed` Through `adapter.internal`

- **Priority**: P0
- **Statement**: `seed.ts` MUST use `adapter.internal.*` for all `__datafn_seed` operations.
- **Rationale**: Same as SRV-001.
- **Acceptance Criteria**:
  - `ensureTable` called on first access
  - Seed execution state is correctly persisted
- **Test Vectors**: TV-SEED-001
- **Notes**: None.

## JT-001 — Add `joinTable` and `joinColumns` to `DatafnRelationSchema`

- **Priority**: P1
- **Statement**: `DatafnRelationSchema` in `@datafn/core` MUST accept optional `joinTable: string` and `joinColumns: { from: string; to: string }` fields.
- **Rationale**: Allows users to map many-many relations to explicit user-defined tables.
- **Acceptance Criteria**:
  - Fields are optional (backward-compatible)
  - `validateSchema` passes with or without these fields
  - TypeScript types are exported
- **Test Vectors**: TV-JT-SCHEMA-001
- **Notes**: Only applicable to `type: "many-many"`.

## JT-002 — Server: Resolve Many-Many Join Table from Schema

- **Priority**: P1
- **Statement**: `relations.ts` and `db-store.ts` MUST use `relation.joinTable` (if set) as the model name for join table CRUD, routing through normal `adapter.create/findOne/findMany/update/delete`.
- **Rationale**: When `joinTable` is set, it names a user-defined table that IS in the ORM schema, so normal resolution works.
- **Acceptance Criteria**:
  - If `joinTable` is set, use it as `model` in adapter CRUD calls (normal path)
  - If `joinTable` is NOT set, fall back to `__datafn_join_*` via `adapter.internal` (see JT-004)
  - `db-store.ts` `loadJoinRows` uses `joinTable` name
  - `executeRelate`, `executeModifyRelation`, `executeUnrelate` use `joinTable` name
- **Test Vectors**: TV-JT-RESOLVE-001
- **Notes**: Column names come from `joinColumns`.

## JT-003 — Server: Use `joinColumns` for Column Names

- **Priority**: P1
- **Statement**: When `joinColumns` is set, `relations.ts` and `db-store.ts` MUST use `joinColumns.from` and `joinColumns.to` instead of hardcoded `"from"` and `"to"`.
- **Rationale**: User-defined join tables typically use descriptive FK column names (e.g., `todoId`, `categoryId`).
- **Acceptance Criteria**:
  - All `where` clauses and `data` objects use `joinColumns.from`/`joinColumns.to`
  - Falls back to `"from"`/`"to"` if `joinColumns` is not set
- **Test Vectors**: TV-JT-COLS-001
- **Notes**: None.

## JT-004 — Fallback: `__datafn_join_*` via `adapter.internal`

- **Priority**: P1
- **Statement**: When a `many-many` relation does NOT have `joinTable` set, the server MUST route `__datafn_join_*` operations through `adapter.internal.*` and call `ensureTable` on first access.
- **Rationale**: Backward compatibility — existing schemas without `joinTable` must continue to work.
- **Acceptance Criteria**:
  - Dynamic `__datafn_join_*` table names continue to work
  - `ensureTable` creates the join table with `id TEXT PK, from TEXT, to TEXT` + any metadata columns
  - CRUD operations use `adapter.internal.*`
- **Test Vectors**: TV-JT-FALLBACK-001
- **Notes**: This is the transitional path.

## CLI-001 — CLI Migration: Generate Named Join Tables

- **Priority**: P1
- **Statement**: When `joinTable` is set on a `many-many` relation, the CLI `generate-migration` MUST generate DDL for that table as a normal user table (not prefixed with `__datafn_join_`).
- **Rationale**: Named join tables should be generated like any other table in migrations.
- **Acceptance Criteria**:
  - Drizzle adapter output includes `export const {joinTable} = {dialectTable}(...)` with FK references
  - Prisma adapter output includes raw SQL `CREATE TABLE {joinTable}`
  - Kysely adapter output includes Kysely migration code
  - Raw SQL output includes standard DDL
  - If `joinTable` is NOT set, existing `__datafn_join_*` generation remains unchanged
- **Test Vectors**: TV-CLI-JT-001
- **Notes**: Column names come from `joinColumns` or default to `from_id`/`to_id`.

## CLI-002 — CLI Codegen: Emit Join Table Interfaces

- **Priority**: P1
- **Statement**: `generateTypes` in `codegen.ts` SHOULD emit TypeScript interfaces for join tables when `many-many` relations have `metadata`.
- **Rationale**: Typed join tables improve developer experience for relations with metadata.
- **Acceptance Criteria**:
  - Join table interface includes `fromId`, `toId`, and metadata fields
  - Interface name is derived from `joinTable` name (PascalCase)
  - Added to `Tables` mapping type
- **Test Vectors**: TV-CLI-CODEGEN-001
- **Notes**: Only generates if `metadata` is present on the relation.
