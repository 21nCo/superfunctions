# Full Audit Report: Fix Internal Table Resolution Across All Adapters

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-13T16:30:00Z |
| **Agent Name** | Droid |
| **Model** | Claude Opus 4.6 |
| **Launcher** | Factory Droid CLI |
| **Workspace** | `/Users/ar/dev/superfunctions` |
| **OS / Shell** | macOS (darwin 25.0.0) / zsh |
| **Git Branch** | `heads/next` |
| **Git Commit** | `2d1a0bf` |
| **Git Dirty** | Yes |

---

## Audit Scope

### Intent/Notes Paths Audited
- `datafn/.conduct/issues/2026-02-12-x9k4m7p3-issue.md` (source issue)

### Spec Bundle Paths Audited
- `datafn/.conduct/specs/2026-02-12-fix-r8k4m2x9-spec/`
  - `SPEC.md`
  - `REQUIREMENTS.md`
  - `TEST_VECTORS.md`
  - `PLAN.md`
  - `INTENT_AUDIT.md`
  - `phases/PHASE_00.md` through `phases/PHASE_04.md`
  - `phase-reports/PHASE_00-2026-02-13-g7k4m2x8-report.md` through `phase-reports/PHASE_04-2026-02-13-q8k3m7x2-report.md`

### Codebase Scope Audited
- `packages/db/src/adapter/types.ts` — InternalCrud/InternalColumnDef types, Adapter interface
- `packages/db/src/index.ts` — type exports
- `packages/db/src/adapter/factory.ts` — wrapAdapter placeholder for internal
- `packages/db/src/adapters/drizzle/internal.ts` — Drizzle InternalCrud implementation
- `packages/db/src/adapters/drizzle/index.ts` — Drizzle adapter wiring
- `packages/db/src/adapters/prisma/internal.ts` — Prisma InternalCrud implementation
- `packages/db/src/adapters/prisma/index.ts` — Prisma adapter wiring
- `packages/db/src/adapters/kysely/internal.ts` — Kysely InternalCrud implementation
- `packages/db/src/adapters/kysely/index.ts` — Kysely adapter wiring
- `packages/db/src/adapters/memory/index.ts` — Memory adapter with inline InternalCrud
- `packages/db/src/testing/mocks.ts` — MockAdapter with internal stubs
- `packages/db/src/adapters/drizzle/drizzle.test.ts` — Drizzle adapter tests (including internal CRUD tests)
- `datafn/server/src/execution/internal-tables.ts` — Internal table schemas + ensureInternalTable/ensureJoinTable helpers
- `datafn/server/src/execution/sync/sequence-store.ts` — DatabaseSequenceStore using adapter.internal
- `datafn/server/src/execution/sync/change-tracking.ts` — ChangeTrackingService using adapter.internal
- `datafn/server/src/execution/idempotency-db.ts` — DbIdempotencyStore using adapter.internal
- `datafn/server/src/routes/seed.ts` — Seed handler using adapter.internal
- `datafn/server/src/execution/mutation/relations.ts` — Relation mutations with dual-path (named joinTable vs internal)
- `datafn/server/src/execution/db-store.ts` — DbDataStore with loadJoinRows dual-path
- `datafn/core/src/types.ts` — DatafnRelationSchema with joinTable/joinColumns
- `datafn/core/src/schema.ts` — validateSchema with joinTable/joinColumns validation
- `datafn/cli/src/codegen.ts` — generateTypes with join table interface generation
- `datafn/cli/src/migrations/types.ts` — MigrationChange with joinTable/joinColumns
- `datafn/cli/src/migrations/diff.ts` — diffSchemas passing joinTable/joinColumns through
- `datafn/cli/src/migrations/render-postgres.ts` — Postgres renderer with joinTable support
- `datafn/cli/src/migrations/render-mysql.ts` — MySQL renderer with joinTable support
- `datafn/cli/src/migrations/render-sqlite.ts` — SQLite renderer with joinTable support
- `datafn/cli/__tests__/codegen.test.ts` — Codegen tests including join table interface
- `datafn/cli/__tests__/migrations.test.ts` — Migration tests including named join tables

### Commands Executed During Audit
- None (read-only static audit)

---

## High-Level Findings

| Category | Status |
|---|---|
| Intent coverage in spec | 18/18 covered (100%) |
| Spec coverage in code | 17/17 requirements implemented |
| PASS | 14 |
| PARTIAL | 3 |
| FAIL | 0 |
| UNVERIFIED | 0 |
| Critical issues found | 0 |
| Medium issues found | 5 |
| Low issues found | 4 |

**Overall verdict**: The implementation is substantially correct and covers all intent items and requirements. The core bug (Drizzle adapter `resolveTable` throwing for internal tables) is fixed. However, several medium-severity issues exist around SQL injection safety, incomplete `findMany` ordering (ascending only), missing observability/debug logging for `ensureTable`, and inconsistencies between adapter default column naming.

---

## Intent Inventory (numbered)

Extracted from `datafn/.conduct/issues/2026-02-12-x9k4m7p3-issue.md`:

| # | Intent Item |
|---|---|
| I-1 | Drizzle adapter `resolveTable` must not throw for `__datafn_*` internal tables |
| I-2 | Fix must work across ALL adapters (Drizzle, Prisma, Kysely, Memory), not just Drizzle |
| I-3 | Adapter-level raw CRUD — a sub-interface that bypasses ORM schema resolution |
| I-4 | `ensureTable` DDL for internal tables (lazy, cached, dialect-appropriate) |
| I-5 | Raw CRUD operations (`create`, `findOne`, `findMany`, `update`, `delete`) for internal tables |
| I-6 | Server routes internal table operations through new raw CRUD, not through user adapter CRUD |
| I-7 | `__datafn_meta` operations routed through raw CRUD |
| I-8 | `__datafn_changes` operations routed through raw CRUD |
| I-9 | `__datafn_idempotency` operations routed through raw CRUD |
| I-10 | `__datafn_seed` operations routed through raw CRUD |
| I-11 | Join tables — DataFn should use user-defined relation tables instead of `__datafn_join_*` internal tables |
| I-12 | Add `joinTable` / `joinColumns` fields to `DatafnRelationSchema` |
| I-13 | Server resolves join table name from schema relation, uses normal adapter CRUD for named tables |
| I-14 | Fallback: unnamed join tables still work via `__datafn_join_*` through raw CRUD |
| I-15 | DataFn CLI generates join table DDL in migrations when `joinTable` is set |
| I-16 | DataFn CLI codegen emits TS interfaces for join tables with metadata |
| I-17 | Users must NOT need to know about or register internal `__datafn_*` tables |
| I-18 | Backward compatibility: existing schemas without `joinTable` continue to work |

---

## Intent -> Spec Coverage Matrix

| # | Intent Item | SPEC.md Section | Requirement IDs | Test Vectors | Status |
|---|---|---|---|---|---|
| I-1 | resolveTable fix | Overview, Semantics | DRZ-001 | TV-DRZ-INTERNAL-001 | COVERED |
| I-2 | All adapters | Goals, Invariants | DRZ-001, PRS-001, KYS-001, MEM-001 | TV-DRZ-*, TV-PRS-*, TV-KYS-*, TV-MEM-* | COVERED |
| I-3 | Raw CRUD sub-interface | Public API | ICRUD-001, ICRUD-002 | TV-ICRUD-001 | COVERED |
| I-4 | ensureTable DDL | Public API, Semantics | ICRUD-003 | TV-ENSURE-001, TV-ENSURE-002 | COVERED |
| I-5 | Raw CRUD ops | Public API | ICRUD-001 | TV-DRZ-INTERNAL-001 | COVERED |
| I-6 | Server routing | Semantics (Routing) | SRV-001 through SRV-004 | TV-SERVERSEQ-001 | COVERED |
| I-7 | `__datafn_meta` | Semantics, Data Formats | SRV-001 | TV-SERVERSEQ-001 | COVERED |
| I-8 | `__datafn_changes` | Semantics, Data Formats | SRV-002 | TV-CHANGELOG-001 | COVERED |
| I-9 | `__datafn_idempotency` | Semantics, Data Formats | SRV-003 | TV-IDEMP-001 | COVERED |
| I-10 | `__datafn_seed` | Semantics, Data Formats | SRV-004 | TV-SEED-001 | COVERED |
| I-11 | Named join tables | Semantics (Join Table Resolution) | JT-001, JT-002 | TV-JT-RESOLVE-001 | COVERED |
| I-12 | `joinTable`/`joinColumns` | Public API (Modified Schema) | JT-001 | TV-JT-SCHEMA-001 | COVERED |
| I-13 | Server join table resolution | Semantics | JT-002, JT-003 | TV-JT-RESOLVE-001, TV-JT-COLS-001 | COVERED |
| I-14 | Fallback `__datafn_join_*` | Semantics | JT-004 | TV-JT-FALLBACK-001 | COVERED |
| I-15 | CLI migration generation | Public API (CLI) | CLI-001 | TV-CLI-JT-001 | COVERED |
| I-16 | CLI codegen interfaces | Public API (CLI) | CLI-002 | TV-CLI-CODEGEN-001 | COVERED |
| I-17 | No user awareness needed | Goals, Invariants | ICRUD-002 | All internal CRUD vectors | COVERED |
| I-18 | Backward compatibility | Compatibility, Invariants | JT-004 | TV-JT-FALLBACK-001 | COVERED |

**Result**: 18/18 intent items are fully covered in the spec. No SPEC MISSING items.

---

## Requirement Coverage Summary

| Req ID | Priority | Status | Notes |
|---|---|---|---|
| ICRUD-001 | P0 | PASS | Interface defined and exported correctly |
| ICRUD-002 | P0 | PASS | `readonly internal: InternalCrud` on Adapter |
| ICRUD-003 | P0 | PASS | Lazy DDL with caching implemented in all adapters |
| DRZ-001 | P0 | PASS | Full CRUD via raw SQL, tested with SQLite |
| PRS-001 | P0 | PASS | Implemented via `$executeRawUnsafe`/`$queryRawUnsafe` |
| KYS-001 | P0 | PASS | Implemented via `db.schema` + raw `sql` builder |
| MEM-001 | P0 | PASS | In-memory Map-based implementation |
| SRV-001 | P0 | PASS | `__datafn_meta` routed through `adapter.internal` |
| SRV-002 | P0 | PASS | `__datafn_changes` routed through `adapter.internal` |
| SRV-003 | P0 | PASS | `__datafn_idempotency` routed through `adapter.internal` |
| SRV-004 | P0 | PASS | `__datafn_seed` routed through `adapter.internal` |
| JT-001 | P1 | PASS | `joinTable`/`joinColumns` added to `DatafnRelationSchema`, validated |
| JT-002 | P1 | PASS | Server resolves `relation.joinTable` for normal adapter CRUD |
| JT-003 | P1 | PASS | `joinColumns.from`/`.to` used for column names |
| JT-004 | P1 | PARTIAL | Fallback works, but join tables via internal are NOT validated against `__datafn_` prefix by `ensureJoinTable` (see finding M-1) |
| CLI-001 | P1 | PARTIAL | Named join tables generated correctly; however, SQLite and MySQL renderers use different default column naming than Postgres (see finding M-2) |
| CLI-002 | P1 | PARTIAL | Join table interfaces emitted correctly, but `toPascalCase` may produce unexpected names for `__datafn_join_` prefixed tables (see finding L-3) |

**Totals**: PASS: 14, PARTIAL: 3, FAIL: 0, UNVERIFIED: 0

---

## Requirement-by-Requirement Results

### ICRUD-001 — InternalCrud Interface Definition

| Criterion | Status | Evidence |
|---|---|---|
| `InternalCrud` exported from `@superfunctions/db` | PASS | `packages/db/src/index.ts` line 42: `InternalCrud` in exports |
| `InternalColumnDef` exported from `@superfunctions/db` | PASS | `packages/db/src/index.ts` line 43: `InternalColumnDef` in exports |
| Methods accept plain string table name | PASS | `packages/db/src/adapter/types.ts` lines 290-325: all methods accept `table: string` |
| TypeScript compilation succeeds | PASS | Phase reports confirm `tsc --noEmit` passes |

### ICRUD-002 — Adapter.internal Property

| Criterion | Status | Evidence |
|---|---|---|
| `readonly internal: InternalCrud` on Adapter | PASS | `packages/db/src/adapter/types.ts` line 56 |
| All adapter factories populate `internal` | PASS | Drizzle (line ~287 of index.ts), Prisma (line ~332 of index.ts), Kysely (line ~383 of index.ts), Memory (line ~190 of index.ts) — all use `Object.assign(adapter, { internal: ... })` |
| Existing adapter methods unchanged | PASS | Verified — no modifications to existing method signatures |

### ICRUD-003 — ensureTable Lazy DDL with Caching

| Criterion | Status | Evidence |
|---|---|---|
| First call runs DDL, subsequent no-op | PASS | All 4 adapters use `ensuredTables` Set with early return |
| Name matches `^__datafn_[a-z0-9_]+$` | PASS | Regex validation in all adapters |
| Invalid names throw Error | PASS | Test TV-ENSURE-002 passes |
| DDL is dialect-appropriate | PASS | Drizzle uses raw SQL, Prisma uses `$executeRawUnsafe`, Kysely uses `db.schema.createTable().ifNotExists()` |

### DRZ-001 — Drizzle Adapter InternalCrud

| Criterion | Status | Evidence |
|---|---|---|
| `ensureTable` runs CREATE TABLE IF NOT EXISTS | PASS | `internal.ts` line 60: builds and executes DDL |
| `create` inserts and returns data | PASS | Test TV-DRZ-INTERNAL-001 passes |
| `findOne` returns row or null | PASS | Test TV-DRZ-INTERNAL-001 passes |
| `findMany` with orderBy and limit | PASS | Test TV-DRZ-INTERNAL-002 passes |
| `update` returns count | PASS | Test TV-DRZ-INTERNAL-001 passes |
| `delete` returns count | PASS | Test TV-DRZ-INTERNAL-001 passes |

### PRS-001 — Prisma Adapter InternalCrud

| Criterion | Status | Evidence |
|---|---|---|
| Uses `$executeRawUnsafe` / `$queryRawUnsafe` | PASS | `prisma/internal.ts` throughout |
| Same interface contract as DRZ-001 | PASS | Structurally verified |
| Test coverage | PASS (compilation only) | No Prisma DB in test env; TypeScript compiles |

### KYS-001 — Kysely Adapter InternalCrud

| Criterion | Status | Evidence |
|---|---|---|
| DDL uses `db.schema.createTable().ifNotExists()` | PASS | `kysely/internal.ts` line ~65 |
| CRUD uses `sql` template tag | PASS | `kysely/internal.ts` throughout |
| Test coverage | PASS (compilation only) | No Kysely DB in test env; TypeScript compiles |

### MEM-001 — Memory Adapter InternalCrud

| Criterion | Status | Evidence |
|---|---|---|
| `ensureTable` creates map entry if absent | PASS | `memory/index.ts` `createMemoryInternalCrud()` |
| CRUD operates on in-memory store | PASS | Verified in code |

### SRV-001 through SRV-004 — Server Routing

All four server routing requirements verified:

| Table | File | ensureTable | CRUD via internal | Status |
|---|---|---|---|---|
| `__datafn_meta` | `sequence-store.ts`, `change-tracking.ts` | Yes (lazy flag) | Yes | PASS |
| `__datafn_changes` | `change-tracking.ts` | Yes (lazy flag) | Yes | PASS |
| `__datafn_idempotency` | `idempotency-db.ts` | Yes (lazy flag) | Yes | PASS |
| `__datafn_seed` | `seed.ts` | Yes | Yes | PASS |

### JT-001 — joinTable/joinColumns Schema Extension

| Criterion | Status | Evidence |
|---|---|---|
| Fields added to `DatafnRelationSchema` | PASS | `core/src/types.ts` lines 83-84 |
| `validateSchema` validates types | PASS | `core/src/schema.ts` lines ~150-176 |
| Backward-compatible (optional) | PASS | Fields are optional |

### JT-002 — Server Resolves Named Join Table

| Criterion | Status | Evidence |
|---|---|---|
| `executeRelate` uses `relation.joinTable` as model | PASS | `relations.ts` — `useNamed` flag with dual path |
| `executeModifyRelation` same | PASS | `relations.ts` — same dual-path pattern |
| `executeUnrelate` same | PASS | `relations.ts` — same dual-path pattern |
| `loadJoinRows` uses `joinTable` | PASS | `db-store.ts` `loadJoinRows` |

### JT-003 — Server Uses joinColumns

| Criterion | Status | Evidence |
|---|---|---|
| Where clauses use `joinColumns.from`/`.to` | PASS | `relations.ts` — `fromCol`/`toCol` variables |
| Falls back to `"from"`/`"to"` | PASS | Default values in `const fromCol = relation.joinColumns?.from \|\| "from"` |

### JT-004 — Fallback to __datafn_join_* via internal

| Criterion | Status | Evidence |
|---|---|---|
| Dynamic names continue to work | PASS | `relations.ts` — `!useNamed` branch |
| `ensureTable` creates join table | PASS | `ensureJoinTable` in `internal-tables.ts` |
| CRUD via `adapter.internal.*` | PASS | Verified in code |
| **Note**: `ensureJoinTable` does NOT validate table name prefix | PARTIAL | The `__datafn_join_*` tables are passed to `adapter.internal.ensureTable` which validates the prefix, but `ensureJoinTable` itself does not pre-validate — this is acceptable since the underlying `ensureTable` validates |

### CLI-001 — CLI Migration: Named Join Tables

| Criterion | Status | Evidence |
|---|---|---|
| `diffSchemas` passes through `joinTable`/`joinColumns` | PASS | `diff.ts` — `joinTable: toRel.joinTable, joinColumns: toRel.joinColumns` |
| Postgres renderer uses `joinTable` name | PASS | `render-postgres.ts` — `change.joinTable ? change.joinTable : ...` |
| MySQL renderer uses `joinTable` name | PASS | `render-mysql.ts` — same pattern |
| SQLite renderer uses `joinTable` name | PASS | `render-sqlite.ts` — same pattern |
| Without `joinTable`, existing naming preserved | PASS | Fallback in all renderers |

**PARTIAL finding**: Default column names differ across renderers when `joinColumns` is not set:
- Postgres: `"from"` / `"to"`
- MySQL: `${change.from}_id` / `${change.to}_id`
- SQLite: `${change.from}_id` / `${change.to}_id`

This inconsistency means the same schema without `joinColumns` will produce different DDL depending on the dialect. See finding M-2.

### CLI-002 — CLI Codegen: Join Table Interfaces

| Criterion | Status | Evidence |
|---|---|---|
| Interface includes `fromId`/`toId` or custom columns | PASS | `codegen.ts` — `fromCol`/`toCol` from `joinColumns` |
| PascalCase name | PASS | `toPascalCase(jtName)` |
| Added to Tables mapping | PASS | `joinTableInterfaces` loop |
| Only when metadata present | PASS | Guard: `!rel.metadata \|\| rel.metadata.length === 0` |

---

## Spec Conflicts / Spec Gaps

### Spec Gap SG-1: Default column names for join tables without `joinColumns`

The SPEC states:
- In `relations.ts`: column names default to `"from"`/`"to"` (SPEC.md, Semantics section)
- In CLI migration renderers: the SPEC is silent on what default column names should be when `joinColumns` is not set

The implementation has:
- Server (`relations.ts`): defaults to `"from"`/`"to"` — matches SPEC
- CLI Postgres renderer: defaults to `"from"`/`"to"` — matches server
- CLI MySQL/SQLite renderers: defaults to `${change.from}_id`/`${change.to}_id` — does NOT match server

This means the CLI-generated DDL for MySQL/SQLite join tables uses different column names than what the server expects at runtime. **This could cause runtime failures if a user generates a migration with MySQL/SQLite and the server tries to use `"from"`/`"to"` column names.**

**Severity**: MEDIUM — affects only the fallback (`__datafn_join_*`) path with MySQL/SQLite, which is the transitional path. Named `joinTable` schemas with explicit `joinColumns` are unaffected.

### Spec Gap SG-2: SPEC says `findMany` only supports ascending orderBy

The SPEC's `InternalCrud.findMany` signature has `orderBy?: string` (a single field name, implicitly ascending). The implementation in all adapters hardcodes `ASC` ordering. The `change-tracking.ts` `getLatestServerSeq` works around this by fetching all rows ascending and taking the last element. This is correct but inefficient for large change sets.

**Severity**: LOW — functional but suboptimal. The SPEC explicitly chose this simplification.

---

## Cross-Cutting Audits

### Security / Authorization / Validation Boundaries

| Check | Status | Notes |
|---|---|---|
| Internal tables inherit same DB credentials | PASS | Same `db` instance used throughout |
| No new auth boundaries introduced | PASS | Internal CRUD bypasses ORM but not DB auth |
| `ensureTable` name validation (prefix check) | PASS | All adapters validate `^__datafn_[a-z0-9_]+$` |
| SQL injection in table/column names | **MEDIUM RISK** | See finding M-3 below |
| Column value parameterization | PASS | Drizzle uses `sql` template tag; Prisma uses `?` placeholders; Kysely uses `sql` template tag |

**Finding M-3: SQL injection risk in table and column names**

All three SQL adapters (Drizzle, Prisma, Kysely) use `sql.raw()` or string interpolation for table names and column names in internal CRUD operations. While the `ensureTable` name is validated against `^__datafn_[a-z0-9_]+$`, the column names in `create`, `update`, and where clauses come from the server code (`internal-tables.ts` column definitions and the server's hardcoded field names like `"namespace"`, `"serverSeq"`, etc.). These are not user-controlled, so the risk is LOW in practice, but the pattern is brittle:

- `drizzle/internal.ts`: `drizzleSql.raw(cols.join(', '))`, `drizzleSql.raw(table)`
- `prisma/internal.ts`: Template string `\`INSERT INTO ${table}\`` with direct interpolation
- `kysely/internal.ts`: `kyselySql.raw(cols.join(', '))`, `kyselySql.raw(table)`

The values are parameterized (good), but table/column names are raw-injected (acceptable given they come from trusted server code, not user input). However, if the `InternalCrud` interface is ever exposed to user-controlled input, this would be a critical SQL injection vulnerability.

**Recommendation**: Add a column name validation function (e.g., `^[a-zA-Z_][a-zA-Z0-9_]*$`) as a defense-in-depth measure.

### Determinism Invariants

| Check | Status | Notes |
|---|---|---|
| `ensureTable` DDL is deterministic | PASS | Column order matches input array order |
| `generateTypes` is deterministic | PASS | Resources sorted alphabetically, fields sorted |
| `diffSchemas` is deterministic | PASS | Resources and relations sorted |
| CAS retry loop is deterministic | PASS | Fixed max retries (10) |
| Seed endpoint determinism | PASS | Uses `timestamp: 0` as default for determinism |

### Limits / Caps

| Check | Status | Notes |
|---|---|---|
| Max columns per internal table: 20 | **NOT ENFORCED** | Finding M-4: The SPEC states max 20 columns, but no code enforces this cap |
| Internal table name regex | PASS | Enforced in all adapters |

**Finding M-4**: The SPEC section "Limits / Caps" states "Maximum columns per internal table: 20 (defensive; current max is 8)" but no `ensureTable` implementation checks `columns.length <= 20`. This is a spec-vs-code gap.

### Error Handling + Canonical Envelopes

| Check | Status | Notes |
|---|---|---|
| `ensureTable` invalid name throws descriptive Error | PASS | "ensureTable: table name must start with..." |
| Failed internal CRUD includes table name | PARTIAL | Finding M-5: Most operations don't wrap errors with table name context |
| Server-level error wrapping | PASS | Server catches and logs errors, returns appropriate responses |
| Idempotency store error handling | PASS | Silently fails (best-effort), logs errors |
| Change tracking error handling | PASS | Logs errors, returns empty arrays |

**Finding M-5**: The SPEC states "Failed internal CRUD operations MUST throw with clear error messages including the internal table name and operation." The current implementations do NOT wrap errors with table name and operation context — they throw the raw SQL/driver errors. For example, if a Drizzle `findOne` on `__datafn_meta` fails, the error message will contain the raw SQL error, not a wrapped message like "InternalCrud.findOne on __datafn_meta failed: <original error>".

### Compatibility / Versioning / Migrations

| Check | Status | Notes |
|---|---|---|
| `internal` is a breaking change to Adapter | Acknowledged | All 4 adapters + MockAdapter updated simultaneously |
| Existing schemas without `joinTable` work | PASS | Fallback path tested |
| Existing `__datafn_join_*` migrations unaffected | PASS | No migration path needed |
| `wrapAdapter` has placeholder for `internal` | PASS | Factory provides throwing placeholder, overridden by `Object.assign` |

### Observability

| Check | Status | Notes |
|---|---|---|
| `debug: true` logs `ensureTable` DDL | **NOT IMPLEMENTED** | Finding L-1: SPEC requires debug logging for `ensureTable` DDL execution, but no adapter implementation checks for debug config |

**Finding L-1**: The SPEC states "When `debug: true` is set on the adapter config, `ensureTable` DDL execution MUST be logged." None of the adapter `InternalCrud` implementations access the adapter's debug config or log DDL execution. The `createDrizzleInternalCrud(db, dialect)` function signature doesn't even receive the `debug` config.

---

## Recommendations (ranked)

### Priority 1 (should fix before merge)

**R-1: Fix default column name inconsistency across CLI renderers (SG-1, CLI-001)**

The MySQL and SQLite renderers default to `${from}_id`/`${to}_id` column names for join tables without `joinColumns`, while the Postgres renderer and the server runtime use `"from"`/`"to"`. This will cause runtime failures for MySQL/SQLite users using the fallback join table path.

- Files: `render-mysql.ts`, `render-sqlite.ts`
- Fix: Change default column names to `"from"`/`"to"` to match Postgres renderer and server expectations, OR document this as an intentional difference

### Priority 2 (should fix soon)

**R-2: Add error wrapping for internal CRUD operations (M-5, ICRUD-003)**

Wrap internal CRUD errors to include table name and operation for debuggability, as required by the SPEC's Observability section.

- Files: All 4 adapter `internal.ts` files
- Fix: Add try/catch wrappers that re-throw with context

**R-3: Enforce 20-column cap in `ensureTable` (M-4)**

Add `columns.length <= 20` check in each adapter's `ensureTable` implementation.

- Files: All 4 adapter `internal.ts` files

### Priority 3 (improvements)

**R-4: Add column name validation as defense-in-depth (M-3)**

Add a simple regex check (`^[a-zA-Z_][a-zA-Z0-9_]*$`) for column names in `create`, `update`, and `findMany` operations.

- Files: All 3 SQL adapter `internal.ts` files

**R-5: Implement debug logging for `ensureTable` (L-1)**

Pass debug config to internal CRUD factories and log DDL execution when enabled.

- Files: All 4 adapter `internal.ts` files + adapter `index.ts` files

**R-6: Add `direction` option to `findMany` opts (SG-2)**

While not required by current spec, adding `direction?: 'asc' | 'desc'` to `findMany` opts would eliminate the workaround in `getLatestServerSeq` and improve performance.

- Files: `packages/db/src/adapter/types.ts`, all 4 adapter `internal.ts` files

---

## Correctness of the Problem Being Solved

### Is the root cause correctly identified?

**YES.** The issue correctly identifies three root causes:

1. **RC-1**: `resolveTable` hard-fails on unknown models — this is the primary bug
2. **RC-2**: Asymmetric adapter behavior — memory adapter is schemaless, SQL adapters are schema-bound — explains why tests pass but production fails
3. **RC-3**: Internal tables lack DDL — even if resolution is fixed, physical tables don't exist

### Is the chosen solution appropriate?

**YES, with caveats.** The spec chose "Path B" (adapter-level raw CRUD via `Adapter.internal`) rather than "Option A" from the issue (dynamic table creation in Drizzle) or "Option B" (server-level initialization). This was a good architectural decision because:

1. It cleanly separates internal table operations from user table operations
2. It avoids leaking dialect knowledge into the server layer
3. It provides a reusable interface for all adapters
4. It keeps the `resolveTable` function untouched — internal tables never enter the ORM resolution path

**However**, the solution introduces more surface area than strictly necessary for the bug fix. The join table externalization (JT-001 through JT-004, CLI-001, CLI-002) is a P1 enhancement bundled with the P0 bug fix. While the join table work is related (join tables are also internal tables), it expands the scope significantly. This is not inherently wrong but means the changeset is larger and has more risk surface than a minimal fix.

### Are there overlooked edge cases?

1. **Transaction support**: The `InternalCrud` interface does not participate in transactions. If the server wraps a mutation in a transaction (via `adapter.transaction()`), the internal table operations happen outside that transaction. This could lead to inconsistencies — e.g., a mutation writes to a user table inside a transaction, but the change record in `__datafn_changes` is written outside. If the transaction rolls back, the change record persists. This is not covered in the SPEC.

2. **Concurrent `ensureTable` calls**: If two requests arrive simultaneously and both try to `ensureTable`, the `Set` cache check (`ensuredTables.has(name)`) is not atomic with the DDL execution. Two DDL statements could execute concurrently. This is safe because `CREATE TABLE IF NOT EXISTS` is idempotent, but it's worth noting.

3. **Memory adapter internal store isolation**: The memory adapter's `createMemoryInternalCrud()` creates a separate `internalStore` Map from the main adapter's `store` Map. This means internal and user data are properly isolated, which is correct behavior.

---

## Appendix: Commands Run + Environment Details

- **Audit method**: Static read-only code review
- **No commands executed** — all analysis done via file reading and comparison against spec
- **Environment**: macOS darwin 25.0.0, Node.js (npm workspace monorepo), TypeScript
- **Test results referenced**: From phase completion reports (not independently re-run during this audit)
