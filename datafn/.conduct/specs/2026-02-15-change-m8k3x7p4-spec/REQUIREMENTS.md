# Requirements Specification

## Requirement Categories

- **MUST**: Mandatory, non-negotiable requirements
- **SHOULD**: Recommended, highly desirable requirements
- **MAY**: Optional, nice-to-have requirements

---

## FR: Functional Requirements

### FR-1: Drizzle Schema Generation — Postgres

**ID**: `FR-DRZ-PG-001`
**Category**: MUST
**Description**: The `generateDrizzleSchema()` function MUST produce valid Drizzle `pgTable` definitions for PostgreSQL from a DataFn schema.

**Acceptance Criteria**:
- Output contains `import { pgTable, ... } from "drizzle-orm/pg-core"`
- Each resource maps to a `pgTable()` call
- Column types follow the Postgres type mapping table
- Output is valid TypeScript

**Positive Tests**:
- Schema with string, number, boolean, date, object, array, file fields generates correct Drizzle Postgres columns
- Schema with multiple resources generates multiple `pgTable` definitions

**Negative Tests**:
- Invalid schema (missing resources) is rejected before codegen

---

### FR-2: Drizzle Schema Generation — MySQL

**ID**: `FR-DRZ-MY-001`
**Category**: MUST
**Description**: The `generateDrizzleSchema()` function MUST produce valid Drizzle `mysqlTable` definitions for MySQL.

**Acceptance Criteria**:
- Output contains `import { mysqlTable, ... } from "drizzle-orm/mysql-core"`
- `number` maps to `int()`, `object`/`array` map to `json()`
- MySQL backtick quoting handled correctly by Drizzle

**Positive Tests**:
- Same schema generates correct MySQL column types

**Negative Tests**:
- N/A (validation happens at schema level)

---

### FR-3: Drizzle Schema Generation — SQLite

**ID**: `FR-DRZ-SL-001`
**Category**: MUST
**Description**: The `generateDrizzleSchema()` function MUST produce valid Drizzle `sqliteTable` definitions for SQLite.

**Acceptance Criteria**:
- Output contains `import { sqliteTable, ... } from "drizzle-orm/sqlite-core"`
- `boolean` and `date` map to `integer()`
- `object` and `array` map to `text()` (JSON as text)

**Positive Tests**:
- Same schema generates correct SQLite column types

**Negative Tests**:
- N/A

---

### FR-4: Field Modifier — Required

**ID**: `FR-MOD-REQ-001`
**Category**: MUST
**Description**: Fields with `required: true` MUST generate `.notNull()` modifier.

**Acceptance Criteria**:
- `required: true` → `.notNull()` appended to column definition
- `required: false` → no `.notNull()` (column is nullable)

**Positive Tests**:
- Required field generates `text("name").notNull()`
- Optional field generates `text("name")` without `.notNull()`

**Negative Tests**:
- N/A

---

### FR-5: Field Modifier — Unique

**ID**: `FR-MOD-UNQ-001`
**Category**: MUST
**Description**: Fields with `unique: true` MUST generate `.unique()` modifier.

**Acceptance Criteria**:
- `unique: true` → `.unique()` appended
- `unique: false` or absent → no `.unique()`

**Positive Tests**:
- `{ name: "email", type: "string", unique: true }` → `text("email").unique()`

**Negative Tests**:
- N/A

---

### FR-6: Field Modifier — Default

**ID**: `FR-MOD-DEF-001`
**Category**: MUST
**Description**: Fields with a `default` value MUST generate `.default(value)` modifier.

**Acceptance Criteria**:
- `default: false` → `.default(false)`
- `default: 0` → `.default(0)`
- `default: "active"` → `.default("active")`

**Positive Tests**:
- Boolean default generates `.default(false)`
- Number default generates `.default(0)`
- String default generates `.default("active")`

**Negative Tests**:
- N/A

---

### FR-7: Primary Key Convention

**ID**: `FR-PK-001`
**Category**: MUST
**Description**: A field named `id` with type `string` MUST generate `.primaryKey()`.

**Acceptance Criteria**:
- Field `{ name: "id", type: "string", required: true }` → `text("id").primaryKey()`
- Other fields named `id` with non-string types also get `.primaryKey()`
- Resources without an `id` field MUST NOT have a primary key generated

**Positive Tests**:
- Resource with `id` field generates `.primaryKey()`

**Negative Tests**:
- Resource without `id` field does not crash or add phantom PK

---

### FR-8: Index Generation

**ID**: `FR-IDX-001`
**Category**: MUST
**Description**: Resources with `indices.base` arrays MUST generate Drizzle index definitions.

**Acceptance Criteria**:
- Each field in `indices.base` generates an `index()` call
- Index name follows convention: `{tableName}_{fieldName}_idx`
- Index is passed as third argument to `pgTable`/`mysqlTable`/`sqliteTable`

**Positive Tests**:
- `indices: { base: ["completed"] }` → `index("todos_completed_idx").on(table.completed)`
- Multiple base indices generate multiple `index()` calls

**Negative Tests**:
- `search` and `vector` indices are NOT generated (comment only)

---

### FR-9: Join Table Generation

**ID**: `FR-JOIN-001`
**Category**: MUST
**Description**: Every `many-many` relation MUST generate a join table definition in the Drizzle schema.

**Acceptance Criteria**:
- Join table has `id` (text, PK), `from` (text, notNull), `to` (text, notNull) columns
- Custom `joinTable` name is used when defined in relation
- Custom `joinColumns` names are used when defined
- Default join table name: `__datafn_join_{from}_{relation}`
- Default column names: `from`, `to`
- Metadata fields are included as additional columns

**Positive Tests**:
- Many-many relation generates join table with standard columns
- Many-many with metadata generates extra columns
- Custom `joinTable` name is respected

**Negative Tests**:
- `one-many` and `many-one` relations do NOT generate join tables

---

### FR-10: Schema Export Object

**ID**: `FR-EXPORT-001`
**Category**: MUST
**Description**: The generated file MUST export a `schema` object containing all table definitions.

**Acceptance Criteria**:
- `export const schema = { ... }` includes all resource tables and join tables
- Tables are sorted alphabetically by export name

**Positive Tests**:
- Schema with 3 resources + 1 join table exports all 4 in `schema` object

**Negative Tests**:
- N/A

---

### FR-11: Column Name Convention

**ID**: `FR-COLNAME-001`
**Category**: MUST
**Description**: camelCase DataFn field names MUST be converted to snake_case for the SQL column name parameter while keeping the TypeScript property name in camelCase.

**Acceptance Criteria**:
- `createdAt` → `bigint("created_at", { mode: "number" })`
- `firstName` → `text("first_name")`
- `id` → `text("id")` (no change for single word)
- The property name (left side of `:`) stays camelCase

**Positive Tests**:
- Multi-word camelCase fields convert correctly
- Single-word fields are unchanged

**Negative Tests**:
- N/A

---

### FR-12: Unified `generate` Command

**ID**: `FR-CLI-001`
**Category**: MUST
**Description**: The CLI MUST expose a `generate` command that produces both Drizzle schema and client types.

**Acceptance Criteria**:
- `datafn generate --adapter drizzle --database postgres` succeeds
- Both `datafn-schema.drizzle.ts` and `datafn-types.ts` are generated
- `--adapter` and `--database` flags are required
- `--schema` and `--output` flags are optional

**Positive Tests**:
- Full command with all flags generates both files
- Auto-discovery with only required flags works

**Negative Tests**:
- Missing `--adapter` produces clear error
- Missing `--database` produces clear error
- Unsupported adapter produces clear error

---

### FR-13: Remove `generate-types` Command

**ID**: `FR-REM-GT-001`
**Category**: MUST
**Description**: The `generate-types` command MUST be removed. Running it MUST print a migration notice.

**Acceptance Criteria**:
- `datafn generate-types` no longer generates types
- Error message directs user to `datafn generate`
- Exit code is non-zero

**Positive Tests**:
- `datafn generate-types` prints migration notice and exits

**Negative Tests**:
- N/A

---

### FR-14: Remove `generate-migration` Command

**ID**: `FR-REM-GM-001`
**Category**: MUST
**Description**: The `generate-migration` command MUST be removed. Running it MUST print a migration notice.

**Acceptance Criteria**:
- `datafn generate-migration` no longer generates migrations
- Error message directs user to ORM-native tools
- Exit code is non-zero

**Positive Tests**:
- `datafn generate-migration` prints migration notice and exits

**Negative Tests**:
- N/A

---

### FR-15: Remove Migration Code

**ID**: `FR-REM-MIG-001`
**Category**: MUST
**Description**: All migration-related source code MUST be removed from the CLI package.

**Acceptance Criteria**:
- `migrations/diff.ts` removed
- `migrations/render-postgres.ts` removed
- `migrations/render-mysql.ts` removed
- `migrations/render-sqlite.ts` removed
- `migrations/adapters/` directory removed
- `migrations/types.ts` removed
- Migration-related imports in `cli.ts` removed
- Migration-related exports in `package.json` removed

**Positive Tests**:
- CLI compiles without migration code
- No migration exports in package

**Negative Tests**:
- N/A

---

### FR-16: Join Table Unified CRUD

**ID**: `FR-JT-CRUD-001`
**Category**: MUST
**Description**: All many-many join table operations in `relations.ts` MUST use `adapter.create/findOne/update/delete` (not `adapter.internal.*`).

**Acceptance Criteria**:
- `executeRelate()` uses `adapter.create()` and `adapter.findOne()` for all join tables
- `executeModifyRelation()` uses `adapter.findOne()` and `adapter.update()` for all join tables
- `executeUnrelate()` uses `adapter.delete()` for all join tables
- No `adapter.internal.*` calls for join tables remain
- No `ensureJoinTable()` calls remain

**Positive Tests**:
- Creating a many-many relation calls `adapter.create()`
- Querying a join table calls `adapter.findOne()`
- Deleting a relation calls `adapter.delete()`

**Negative Tests**:
- N/A

---

### FR-17: Remove `ensureJoinTable()`

**ID**: `FR-REM-EJT-001`
**Category**: MUST
**Description**: The `ensureJoinTable()` function MUST be removed from `internal-tables.ts`.

**Acceptance Criteria**:
- Function is deleted
- No remaining imports of `ensureJoinTable`
- `ensureInternalTable()` is NOT affected (system tables unchanged)
- `INTERNAL_TABLE_SCHEMAS` is NOT affected

**Positive Tests**:
- Compilation succeeds without `ensureJoinTable`
- System tables still work via `ensureInternalTable`

**Negative Tests**:
- N/A

---

### FR-18: Generated File Header

**ID**: `FR-HEADER-001`
**Category**: MUST
**Description**: The generated Drizzle schema file MUST include a header comment indicating it is auto-generated.

**Acceptance Criteria**:
- Header includes: `// Generated by @datafn/cli. DO NOT EDIT.`
- Header includes source schema file path
- Header includes database dialect

**Positive Tests**:
- Generated file starts with header comment

**Negative Tests**:
- N/A

---

### FR-19: Import Tree-Shaking

**ID**: `FR-IMPORT-001`
**Category**: SHOULD
**Description**: Generated imports SHOULD only include column types that are actually used in the schema.

**Acceptance Criteria**:
- Schema with only `string` fields does not import `boolean`, `numeric`, etc.
- `index` is imported only if indices exist

**Positive Tests**:
- Minimal schema imports only needed types

**Negative Tests**:
- N/A

---

### FR-20: Deterministic Output

**ID**: `FR-DET-001`
**Category**: MUST
**Description**: Generated output MUST be deterministic — the same schema input always produces identical output.

**Acceptance Criteria**:
- Resources sorted alphabetically
- Fields within tables sorted alphabetically
- Join tables sorted alphabetically
- Imports sorted alphabetically
- Multiple runs produce identical files

**Positive Tests**:
- Two runs with same schema produce byte-identical output

**Negative Tests**:
- N/A

---

## NFR: Non-Functional Requirements

### NFR-1: No Runtime Dependency on drizzle-orm

**ID**: `NFR-NODEP-001`
**Category**: MUST
**Description**: `@datafn/cli` MUST NOT add `drizzle-orm` as a package dependency. The generated file references `drizzle-orm` imports that exist in the user's project.

**Acceptance Criteria**:
- `drizzle-orm` not in `dependencies` or `devDependencies` of CLI package.json
- Generated code has `import ... from "drizzle-orm/..."` but CLI itself never imports drizzle

**Testing**: Verify package.json

---

### NFR-2: Backward Compatible Schema Loading

**ID**: `NFR-COMPAT-001`
**Category**: MUST
**Description**: All existing schema loading functionality (auto-discovery, `.datafn.ts`, `.json`, `tsx` loader) MUST continue working.

**Acceptance Criteria**:
- Auto-discovery finds `.datafn.ts` and `.json` files
- TypeScript loading via Bun native or tsx
- JSON loading via `JSON.parse()`

**Testing**: Existing schema loading tests pass

---

### NFR-3: Generated Code Compiles

**ID**: `NFR-COMPILE-001`
**Category**: MUST
**Description**: Generated Drizzle schema MUST compile without TypeScript errors when `drizzle-orm` is installed.

**Acceptance Criteria**:
- Running `tsc --noEmit` on generated schema succeeds
- No type errors in generated code

**Testing**: Compile check in test vectors

---

### NFR-4: Performance

**ID**: `NFR-PERF-001`
**Category**: SHOULD
**Description**: Schema generation SHOULD complete in under 100ms for schemas with up to 50 resources.

**Acceptance Criteria**:
- Code generation is pure string building (no I/O)
- No external processes spawned during generation

**Testing**: Benchmark test

---

### NFR-5: Cross-Runtime Compatibility

**ID**: `NFR-RUNTIME-001`
**Category**: MUST
**Description**: The `generate` command MUST work in both Bun and Node.js runtimes.

**Acceptance Criteria**:
- `.datafn.ts` loading works natively in Bun
- `.datafn.ts` loading works in Node.js via tsx
- JSON schema loading works in both

**Testing**: CI testing on both runtimes

---

## Test Coverage Requirements

### TC-1: Unit Tests — Drizzle Codegen

**ID**: `TC-UNIT-DRZ-001`
**Category**: MUST

**Required Test Cases**:
1. `generateDrizzleSchema()` with all field types for Postgres
2. `generateDrizzleSchema()` with all field types for MySQL
3. `generateDrizzleSchema()` with all field types for SQLite
4. Field modifiers: required, unique, default
5. Primary key convention (id field)
6. Index generation from `indices.base`
7. Join table generation from many-many relations
8. Join table with metadata fields
9. Custom joinTable name and joinColumns
10. camelCase → snake_case column naming
11. Schema export object
12. Deterministic output (sorted)
13. Import tree-shaking
14. Generated file header

### TC-2: Unit Tests — CLI Command

**ID**: `TC-UNIT-CLI-001`
**Category**: MUST

**Required Test Cases**:
1. `generate` command produces both files
2. Missing `--adapter` error
3. Missing `--database` error
4. Unsupported adapter error
5. Deprecated command migration notices
6. Auto-discovery + generate
7. Explicit schema + generate

### TC-3: Unit Tests — Join Table Refactor

**ID**: `TC-UNIT-JT-001`
**Category**: MUST

**Required Test Cases**:
1. `executeRelate()` for many-many uses `adapter.create`
2. `executeModifyRelation()` uses `adapter.update`
3. `executeUnrelate()` uses `adapter.delete`
4. No `adapter.internal` calls for join tables
5. Existing relation tests pass unchanged

---

## Requirements Coverage Summary

| Requirement ID | Category | Test Coverage |
|----------------|----------|---------------|
| FR-DRZ-PG-001  | MUST     | TC-UNIT-DRZ-001, TV-DRZ-PG-001 |
| FR-DRZ-MY-001  | MUST     | TC-UNIT-DRZ-001, TV-DRZ-MY-001 |
| FR-DRZ-SL-001  | MUST     | TC-UNIT-DRZ-001, TV-DRZ-SL-001 |
| FR-MOD-REQ-001 | MUST     | TC-UNIT-DRZ-001, TV-DRZ-MOD-001 |
| FR-MOD-UNQ-001 | MUST     | TC-UNIT-DRZ-001, TV-DRZ-MOD-001 |
| FR-MOD-DEF-001 | MUST     | TC-UNIT-DRZ-001, TV-DRZ-MOD-001 |
| FR-PK-001      | MUST     | TC-UNIT-DRZ-001, TV-DRZ-PG-001 |
| FR-IDX-001     | MUST     | TC-UNIT-DRZ-001, TV-DRZ-IDX-001 |
| FR-JOIN-001    | MUST     | TC-UNIT-DRZ-001, TV-DRZ-JOIN-001 |
| FR-EXPORT-001  | MUST     | TC-UNIT-DRZ-001, TV-DRZ-PG-001 |
| FR-COLNAME-001 | MUST     | TC-UNIT-DRZ-001, TV-DRZ-COL-001 |
| FR-CLI-001     | MUST     | TC-UNIT-CLI-001, TV-CLI-GEN-001 |
| FR-REM-GT-001  | MUST     | TC-UNIT-CLI-001, TV-CLI-DEP-001 |
| FR-REM-GM-001  | MUST     | TC-UNIT-CLI-001, TV-CLI-DEP-002 |
| FR-REM-MIG-001 | MUST     | TC-UNIT-CLI-001 |
| FR-JT-CRUD-001 | MUST     | TC-UNIT-JT-001, TV-JT-REL-001 |
| FR-REM-EJT-001 | MUST     | TC-UNIT-JT-001 |
| FR-HEADER-001  | MUST     | TC-UNIT-DRZ-001, TV-DRZ-PG-001 |
| FR-IMPORT-001  | SHOULD   | TC-UNIT-DRZ-001, TV-DRZ-IMP-001 |
| FR-DET-001     | MUST     | TC-UNIT-DRZ-001, TV-DRZ-DET-001 |
| NFR-NODEP-001  | MUST     | Package analysis |
| NFR-COMPAT-001 | MUST     | Existing tests |
| NFR-COMPILE-001| MUST     | TV-DRZ-PG-001 (compile check) |
| NFR-RUNTIME-001| MUST     | CI testing |
| NFR-PERF-001   | SHOULD   | Benchmark |
