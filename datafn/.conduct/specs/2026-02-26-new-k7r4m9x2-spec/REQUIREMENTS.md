# REQUIREMENTS: Row-Level Namespace Isolation

## Table of Contents

- RLN-001: Factory wrapper namespace injection (reads)
- RLN-002: Factory wrapper namespace stamping (writes)
- RLN-003: Mandatory namespace enforcement
- RLN-004: Output stripping
- RLN-005: Namespace immutability on updates
- RLN-006: Internal CRUD exemption
- RLN-007: Transaction propagation
- RLN-008: Upsert dual injection
- RLN-009: AdapterFactoryConfig type extension
- RLN-010: Memory adapter compatibility
- RLN-011: Drizzle adapter compatibility
- RLN-012: Backward compatibility (disabled mode)
- DFN-001: Server auto-wrapping on authContextProvider
- DFN-002: extractNamespace consistency with __ns
- DFN-003: Clone namespace filtering
- DFN-004: Query namespace filtering
- DFN-005: Mutation namespace stamping
- DFN-006: Push namespace stamping
- DFN-007: Seed namespace stamping
- SCH-001: multiTenant schema flag
- SCH-002: Drizzle codegen __ns column
- SCH-003: Drizzle codegen __ns index
- SCH-004: Join table __ns column
- SCH-005: CLI --multi-tenant flag
- SCH-006: Schema validation for multiTenant
- MIG-001: Migration generation for existing databases
- TST-001: Namespace isolation contract tests

---

## RLN-001: Factory wrapper namespace injection (reads)
- **ID**: RLN-001
- **Priority**: P0
- **Statement**: When `rowLevelNamespace.enabled` is `true`, the adapter factory wrapper MUST prepend `{ field: column, operator: "eq", value: params.namespace }` to the `where` array for `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, and `deleteMany` operations.
- **Rationale**: This is the core mechanism that prevents cross-tenant data leakage on reads and scoped mutations.
- **Acceptance criteria**:
  - `findMany({ model: "task", where: [], namespace: "user:A" })` produces a query with `WHERE __ns = 'user:A'`.
  - `findMany({ model: "task", where: [{ field: "status", operator: "eq", value: "open" }], namespace: "user:A" })` produces `WHERE __ns = 'user:A' AND status = 'open'`.
  - The namespace clause is prepended (first in the WHERE), not appended.
  - `delete({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], namespace: "user:A" })` cannot delete a row where `__ns = 'user:B'`.
- **Test vectors**: TV-RLN-001, TV-RLN-002, TV-RLN-003
- **Notes**: The `where` array may be empty (e.g., clone fetches all records). The namespace clause MUST still be injected.

## RLN-002: Factory wrapper namespace stamping (writes)
- **ID**: RLN-002
- **Priority**: P0
- **Statement**: When `rowLevelNamespace.enabled` is `true`, the adapter factory wrapper MUST inject `{ [column]: params.namespace }` into `params.data` for `create` and into each item of `params.data` for `createMany`.
- **Rationale**: Every new record must be stamped with its owning namespace so future reads can filter it.
- **Acceptance criteria**:
  - `create({ model: "task", data: { id: "task:1", title: "Test" }, namespace: "user:A" })` results in the row `{ id: "task:1", title: "Test", __ns: "user:A" }` being stored.
  - `createMany({ model: "task", data: [{ id: "t1" }, { id: "t2" }], namespace: "user:A" })` stamps both rows.
- **Test vectors**: TV-RLN-004, TV-RLN-005
- **Notes**: None.

## RLN-003: Mandatory namespace enforcement
- **ID**: RLN-003
- **Priority**: P0
- **Statement**: When `rowLevelNamespace.enabled` is `true`, any CRUD operation (`create`, `createMany`, `findOne`, `findMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `count`) that has `namespace` as `undefined`, `null`, or empty string MUST throw an error with code `NAMESPACE_REQUIRED`.
- **Rationale**: Omitting namespace would silently bypass isolation — a critical security flaw.
- **Acceptance criteria**:
  - `findMany({ model: "task", where: [] })` (no `namespace`) throws `NAMESPACE_REQUIRED`.
  - `findMany({ model: "task", where: [], namespace: "" })` throws `NAMESPACE_REQUIRED`.
  - `create({ model: "task", data: { id: "t1" } })` throws `NAMESPACE_REQUIRED`.
- **Test vectors**: TV-RLN-006, TV-RLN-007
- **Notes**: This only applies when `rowLevelNamespace.enabled = true`. When disabled, missing namespace is fine (current behavior).

## RLN-004: Output stripping
- **ID**: RLN-004
- **Priority**: P0
- **Statement**: The adapter factory wrapper MUST remove the discriminator column from all records returned by `create`, `createMany`, `findOne`, `findMany`, `update`, `upsert` before returning to the caller.
- **Rationale**: Consumers (datafn routes, plugins) should not see the internal `__ns` column.
- **Acceptance criteria**:
  - A `findMany` that returns `[{ id: "t1", title: "Test", __ns: "user:A" }]` is transformed to `[{ id: "t1", title: "Test" }]` before reaching the caller.
  - The stripping applies to both single and batch returns.
- **Test vectors**: TV-RLN-008
- **Notes**: The stripping SHOULD happen in `transformOutput`. If the column doesn't exist in the output (e.g., the adapter didn't return it), the stripping is a no-op.

## RLN-005: Namespace immutability on updates
- **ID**: RLN-005
- **Priority**: P0
- **Statement**: The adapter factory wrapper MUST NOT inject `{ [column]: params.namespace }` into `params.data` for `update` or `updateMany` operations, and MUST delete `params.data[column]` if present.
- **Rationale**: The namespace of a record is set at creation and must not be changed. Allowing namespace changes would enable cross-tenant data theft.
- **Acceptance criteria**:
  - `update({ model: "task", where: [...], data: { title: "New", __ns: "user:B" }, namespace: "user:A" })` — the `__ns` field is stripped from `data` before reaching the adapter. The row's `__ns` remains `"user:A"`.
  - `upsert` `update` data also has `__ns` stripped.
- **Test vectors**: TV-RLN-009
- **Notes**: None.

## RLN-006: Internal CRUD exemption
- **ID**: RLN-006
- **Priority**: P0
- **Statement**: The `db.internal.*` methods (`ensureTable`, `create`, `findOne`, `findMany`, `update`, `delete`) MUST NOT be affected by row-level namespace filtering.
- **Rationale**: Internal tables (`__datafn_meta`, `__datafn_changes`, etc.) manage their own explicit namespace filtering via WHERE clauses. Adding automatic filtering would break their logic.
- **Acceptance criteria**:
  - `db.internal.findMany("__datafn_changes", [...])` works without any namespace injection, regardless of `rowLevelNamespace.enabled`.
  - Internal tables do NOT have a `__ns` column.
- **Test vectors**: TV-RLN-010
- **Notes**: The `internal` property is assigned via `Object.assign` after factory creation and is NOT wrapped by `wrapAdapter`.

## RLN-007: Transaction propagation
- **ID**: RLN-007
- **Priority**: P1
- **Statement**: When `db.transaction(callback)` is called, the transaction adapter provided to the callback MUST also apply row-level namespace filtering with the same configuration.
- **Rationale**: Transactions execute multiple operations that must all be namespace-scoped.
- **Acceptance criteria**:
  - Inside a transaction, `trx.findMany({ model: "task", where: [], namespace: "user:A" })` applies the `__ns` filter.
  - Inside a transaction, `trx.create({ model: "task", data: {...}, namespace: "user:A" })` stamps `__ns`.
- **Test vectors**: TV-RLN-011
- **Notes**: This requires the adapter implementation's `transaction` method to wrap the child adapter. May vary by adapter.

## RLN-008: Upsert dual injection
- **ID**: RLN-008
- **Priority**: P0
- **Statement**: For `upsert` operations, the wrapper MUST: (a) prepend namespace WHERE clause, (b) inject `{ [column]: params.namespace }` into `params.create`, (c) NOT inject into `params.update`.
- **Rationale**: Upsert may create or update. Create needs the stamp. Update must not change namespace.
- **Acceptance criteria**:
  - `upsert({ model: "task", where: [...], create: { id: "t1", title: "Test" }, update: { title: "Updated" }, namespace: "user:A" })` results in `create` data containing `__ns: "user:A"` and `update` data NOT containing `__ns`.
- **Test vectors**: TV-RLN-012
- **Notes**: None.

## RLN-009: AdapterFactoryConfig type extension
- **ID**: RLN-009
- **Priority**: P0
- **Statement**: `AdapterFactoryConfig` in `packages/db/src/adapter/types.ts` MUST be extended with an optional `rowLevelNamespace` field of type `{ enabled: boolean; column?: string }`.
- **Rationale**: This is the configuration surface for enabling the feature.
- **Acceptance criteria**:
  - The type compiles without errors.
  - `column` defaults to `"__ns"` when not specified.
  - Existing code that does not set `rowLevelNamespace` continues to compile and function.
- **Test vectors**: N/A (type-level)
- **Notes**: None.

## RLN-010: Memory adapter compatibility
- **ID**: RLN-010
- **Priority**: P0
- **Statement**: The memory adapter MUST work correctly with `rowLevelNamespace.enabled = true`, storing and filtering by the `__ns` field in its in-memory maps.
- **Rationale**: The memory adapter is used for all unit tests. Namespace isolation must be testable without a real database.
- **Acceptance criteria**:
  - Two `create` calls with different namespaces both succeed.
  - `findMany` with namespace A returns only namespace A's records.
  - `delete` with namespace A does not affect namespace B's records.
- **Test vectors**: TV-RLN-001 through TV-RLN-012 (all use memory adapter in unit tests)
- **Notes**: No changes to the memory adapter implementation itself — the factory wrapper handles everything.

## RLN-011: Drizzle adapter compatibility
- **ID**: RLN-011
- **Priority**: P1
- **Statement**: The Drizzle adapter MUST work correctly with `rowLevelNamespace.enabled = true` when the database schema includes the `__ns` column.
- **Rationale**: Drizzle is the primary production adapter for datafn.
- **Acceptance criteria**:
  - With a SQLite test database, create + findMany + delete with namespace filtering works end-to-end.
  - Cross-tenant isolation is verified with a multi-namespace test.
- **Test vectors**: TV-DRZ-001
- **Notes**: Requires the generated Drizzle schema to include the `__ns` column.

## RLN-012: Backward compatibility (disabled mode)
- **ID**: RLN-012
- **Priority**: P0
- **Statement**: When `rowLevelNamespace` is not set or `enabled` is `false`, the adapter factory MUST behave identically to today — no namespace injection, no namespace enforcement, no output stripping.
- **Rationale**: Existing users who do not need multi-tenancy must not be affected.
- **Acceptance criteria**:
  - `findMany({ model: "task", where: [] })` (no namespace, no config) returns all records as before.
  - No `__ns` column appears in any query or data.
- **Test vectors**: TV-RLN-013
- **Notes**: This is the default mode.

## DFN-001: Server auto-wrapping on authContextProvider
- **ID**: DFN-001
- **Priority**: P0
- **Statement**: `createDatafnServer` MUST automatically wrap `config.db` with row-level namespace filtering when `config.authContextProvider` is present and `config.db` is provided.
- **Rationale**: This makes multi-tenant isolation automatic — no manual adapter configuration needed by the datafn user.
- **Acceptance criteria**:
  - Server created with `authContextProvider` + `db` → all CRUD calls go through namespace-filtered adapter.
  - Server created without `authContextProvider` → `db` used as-is.
  - The wrapping MUST preserve `db.internal` (it is NOT namespace-filtered).
- **Test vectors**: TV-DFN-001, TV-DFN-002
- **Notes**: The wrapping should be a standalone function (not requiring re-creation via factory) to avoid breaking the existing adapter's `internal` property.

## DFN-002: extractNamespace consistency with __ns
- **ID**: DFN-002
- **Priority**: P0
- **Statement**: The namespace string produced by `extractNamespace()` in server.ts MUST be the same string stored in the `__ns` column on data rows.
- **Rationale**: If the namespace in change tracking (`__datafn_changes.namespace`) and the namespace in data rows (`__ns`) diverge, pull would return changes for records invisible to the user's queries.
- **Acceptance criteria**:
  - For a request from `{ userId: "alice", tenantId: "acme" }`, `extractNamespace` returns `"tenant:acme:user:alice"`, and `db.create(...)` stamps `__ns: "tenant:acme:user:alice"`.
  - The same string appears in `__datafn_changes.namespace` for mutations by that user.
- **Test vectors**: TV-DFN-003
- **Notes**: This is already true by construction since datafn passes the result of `extractNamespace` as the `namespace` param to all DB calls and to `ChangeTrackingService`.

## DFN-003: Clone namespace filtering
- **ID**: DFN-003
- **Priority**: P0
- **Statement**: `executeClone` MUST return only records belonging to the requesting user's namespace.
- **Rationale**: Clone is the initial full-data sync. Without namespace filtering, a new user would receive every tenant's data.
- **Acceptance criteria**:
  - User A clones → gets only user A's records.
  - User B clones → gets only user B's records (different set).
  - Paginated clone also respects namespace filtering.
- **Test vectors**: TV-DFN-004, TV-DFN-005
- **Notes**: No code changes in `clone.ts` — the filtering is handled by the wrapped adapter since clone already calls `db.findMany({ ..., namespace })`.

## DFN-004: Query namespace filtering
- **ID**: DFN-004
- **Priority**: P0
- **Statement**: All query execution paths (`executeQuery`, `executePushdownQuery`, `executePartialPushdownQuery`, `DbDataStore.create`, `DbDataStore.forPushdownResult`, `DbDataStore.forQuery`) MUST return only records belonging to the requesting user's namespace.
- **Rationale**: Queries are the primary read path. Cross-tenant data leakage here is the highest severity issue.
- **Acceptance criteria**:
  - User A queries `{ resource: "task" }` → sees only user A's tasks.
  - User A queries with filters `{ resource: "task", filters: { status: "open" } }` → sees only user A's open tasks.
  - Relation expansion (`select: ["tags.*"]`) only loads related records from user A's namespace.
- **Test vectors**: TV-DFN-006, TV-DFN-007
- **Notes**: No code changes in query execution — the adapter handles it transparently.

## DFN-005: Mutation namespace stamping
- **ID**: DFN-005
- **Priority**: P0
- **Statement**: All mutation execution paths (`executeMutation` — insert, merge, replace, delete, relate, unrelate, modifyRelation) MUST stamp new records with the requesting user's namespace and MUST NOT affect records in other namespaces.
- **Rationale**: Mutations create/modify data. Without namespace stamping, new records would be visible to all users.
- **Acceptance criteria**:
  - Insert by user A → row has `__ns: "user:A"`.
  - Merge by user A on a record owned by user B → fails (NOT_FOUND or zero affected rows).
  - Delete by user A on a record owned by user B → no-op (zero affected rows).
- **Test vectors**: TV-DFN-008, TV-DFN-009
- **Notes**: No code changes in mutation execution — the adapter handles it.

## DFN-006: Push namespace stamping
- **ID**: DFN-006
- **Priority**: P0
- **Statement**: `executePush` MUST stamp all records created via push with the requesting user's namespace.
- **Rationale**: Push is the sync upload path. Client mutations synced to server must be namespace-stamped.
- **Acceptance criteria**:
  - Push containing an insert mutation → server creates row with `__ns` set to the push user's namespace.
- **Test vectors**: TV-DFN-010
- **Notes**: Push already calls `db.create({ ..., namespace })` — the adapter handles stamping.

## DFN-007: Seed namespace stamping
- **ID**: DFN-007
- **Priority**: P1
- **Statement**: The `/datafn/seed` endpoint MUST stamp seeded records with the appropriate namespace.
- **Rationale**: Seeded data must belong to a namespace to be visible to the correct users.
- **Acceptance criteria**:
  - Seed with namespace context → records stamped with that namespace.
- **Test vectors**: TV-DFN-011
- **Notes**: Seed currently receives `db` directly. After wrapping, it will use the namespace-filtered adapter.

## SCH-001: multiTenant schema flag
- **ID**: SCH-001
- **Priority**: P0
- **Statement**: `DatafnSchema` (in `@datafn/core`) MUST support an optional `multiTenant: boolean` field.
- **Rationale**: This declares intent for multi-tenant mode, enabling CLI codegen and server behavior.
- **Acceptance criteria**:
  - `defineSchema({ multiTenant: true, resources: [...] })` compiles.
  - `validateSchema` accepts the field without error.
  - Default value is `false` (or absent).
- **Test vectors**: TV-SCH-001
- **Notes**: None.

## SCH-002: Drizzle codegen __ns column
- **ID**: SCH-002
- **Priority**: P0
- **Statement**: When `multiTenant: true`, the Drizzle codegen MUST add `__ns: text("__ns").notNull()` to every generated resource table.
- **Rationale**: The database schema must include the discriminator column for namespace filtering to work.
- **Acceptance criteria**:
  - Generated `.ts` file for a `task` resource includes `__ns` column definition.
  - The column type is `text`, NOT NULL.
- **Test vectors**: TV-SCH-002
- **Notes**: None.

## SCH-003: Drizzle codegen __ns index
- **ID**: SCH-003
- **Priority**: P1
- **Statement**: When `multiTenant: true`, the Drizzle codegen MUST generate a non-unique index on the `__ns` column for every table.
- **Rationale**: Without an index, namespace filtering degrades to full table scans.
- **Acceptance criteria**:
  - Generated schema includes `.index("idx_{tableName}___ns", table => table.__ns)` or equivalent for each table.
- **Test vectors**: TV-SCH-003
- **Notes**: Index naming convention: `idx_{tableName}___ns`.

## SCH-004: Join table __ns column
- **ID**: SCH-004
- **Priority**: P0
- **Statement**: When `multiTenant: true`, the Drizzle codegen MUST add the `__ns` column and index to generated many-many join tables (`__datafn_join_*`).
- **Rationale**: Join rows must also be namespace-scoped; otherwise relation queries leak cross-tenant data.
- **Acceptance criteria**:
  - Generated join table includes `__ns: text("__ns").notNull()`.
  - Index is present.
- **Test vectors**: TV-SCH-004
- **Notes**: None.

## SCH-005: CLI --multi-tenant flag
- **ID**: SCH-005
- **Priority**: P1
- **Statement**: The `datafn generate-schema` CLI command MUST accept a `--multi-tenant` flag that enables `__ns` column generation, OR auto-detect from `multiTenant: true` in the loaded schema.
- **Rationale**: Users need a way to opt-in to multi-tenant schema generation.
- **Acceptance criteria**:
  - `datafn generate-schema --multi-tenant` generates schema with `__ns` columns.
  - `datafn generate-schema` without flag and with `multiTenant: true` in schema also generates `__ns` columns.
  - `datafn generate-schema` without flag and without `multiTenant` omits `__ns` columns (backward compatible).
- **Test vectors**: TV-SCH-005
- **Notes**: None.

## SCH-006: Schema validation for multiTenant
- **ID**: SCH-006
- **Priority**: P1
- **Statement**: `validateSchema` MUST accept `multiTenant: true | false | undefined` without error and MUST include it in the validated output.
- **Rationale**: Schema validation must not reject the new field.
- **Acceptance criteria**:
  - `validateSchema({ multiTenant: true, resources: [...] })` returns `{ ok: true, result: { multiTenant: true, ... } }`.
  - `validateSchema({ resources: [...] })` returns result with `multiTenant` absent or `false`.
- **Test vectors**: TV-SCH-006
- **Notes**: None.

## MIG-001: Migration generation for existing databases
- **ID**: MIG-001
- **Priority**: P2
- **Statement**: The CLI SHOULD provide a command or guidance to generate a SQL migration that adds the `__ns` column to existing tables and backfills existing rows with a default namespace value.
- **Rationale**: Users with existing single-tenant databases upgrading to multi-tenant need a migration path.
- **Acceptance criteria**:
  - Running the migration adds `__ns TEXT NOT NULL DEFAULT 'datafn'` to each existing resource table.
  - Existing rows are backfilled with the default value.
  - After migration, the server can start with `authContextProvider` enabled.
- **Test vectors**: TV-MIG-001
- **Notes**: The default backfill value is `"datafn"` (matching the default namespace when no authContextProvider is configured). This requirement is P2 because initial users will set up fresh databases.

## TST-001: Namespace isolation contract tests
- **ID**: TST-001
- **Priority**: P0
- **Statement**: A set of contract tests in `packages/db/src/testing/` MUST verify row-level namespace isolation behavior across all adapter implementations.
- **Rationale**: Every adapter must pass the same isolation tests to guarantee consistent security behavior.
- **Acceptance criteria**:
  - Contract test creates records in namespace A and namespace B.
  - Verifies findMany with namespace A returns only A's records.
  - Verifies update with namespace A does not affect B's records.
  - Verifies delete with namespace A does not affect B's records.
  - Contract test is re-usable by all adapter implementations (memory, drizzle, prisma, kysely).
- **Test vectors**: TV-TST-001
- **Notes**: Follows existing `contract-tests.ts` pattern in `packages/db/src/testing/`.
