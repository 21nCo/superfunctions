# TEST VECTORS: Row-Level Namespace Isolation

## TV-RLN-001: findMany with namespace returns only matching records
- **Description**: Verify that `findMany` with namespace A returns only records where `__ns = A`.
- **Setup**: Create `{ id: "t1", title: "A task", __ns: "user:A" }` and `{ id: "t2", title: "B task", __ns: "user:B" }` in the `task` table.
- **Input**: `db.findMany({ model: "task", where: [], namespace: "user:A" })`
- **Expected output**: `[{ id: "t1", title: "A task" }]` (no `__ns` field, no `t2`)
- **Negative variant**: `db.findMany({ model: "task", where: [], namespace: "user:B" })` → `[{ id: "t2", title: "B task" }]` (no `t1`)

## TV-RLN-002: findMany with namespace + user filters
- **Description**: Namespace filter composes correctly with user-provided WHERE clauses.
- **Setup**: Records: `{ id: "t1", title: "Open", status: "open", __ns: "user:A" }`, `{ id: "t2", title: "Done", status: "done", __ns: "user:A" }`, `{ id: "t3", title: "Open B", status: "open", __ns: "user:B" }`.
- **Input**: `db.findMany({ model: "task", where: [{ field: "status", operator: "eq", value: "open" }], namespace: "user:A" })`
- **Expected output**: `[{ id: "t1", title: "Open", status: "open" }]` (t3 excluded despite matching filter)

## TV-RLN-003: delete cannot cross namespace boundary
- **Description**: Delete with namespace A does not affect namespace B's records.
- **Setup**: `{ id: "t1", __ns: "user:A" }`, `{ id: "t2", __ns: "user:B" }`.
- **Input**: `db.delete({ model: "task", where: [{ field: "id", operator: "eq", value: "t2" }], namespace: "user:A" })`
- **Expected outcome**: `t2` still exists (WHERE `__ns = 'user:A' AND id = 't2'` matches zero rows).
- **Verification**: `db.findMany({ model: "task", where: [], namespace: "user:B" })` → `[{ id: "t2" }]`

## TV-RLN-004: create stamps namespace
- **Description**: Created record includes the `__ns` column with the provided namespace.
- **Input**: `db.create({ model: "task", data: { id: "t1", title: "Test" }, namespace: "user:A" })`
- **Expected output**: Returned record is `{ id: "t1", title: "Test" }` (no `__ns` — stripped).
- **Verification**: Raw storage contains `{ id: "t1", title: "Test", __ns: "user:A" }`.

## TV-RLN-005: createMany stamps all records
- **Description**: Batch create stamps every record.
- **Input**: `db.createMany({ model: "task", data: [{ id: "t1" }, { id: "t2" }], namespace: "user:A" })`
- **Expected outcome**: Both rows have `__ns: "user:A"` in storage.

## TV-RLN-006: missing namespace throws NAMESPACE_REQUIRED
- **Description**: CRUD without namespace in enabled mode throws.
- **Input**: `db.findMany({ model: "task", where: [] })` (no `namespace` field)
- **Expected error**: `{ code: "NAMESPACE_REQUIRED", message: "Row-level namespace is enabled but no namespace was provided" }`

## TV-RLN-007: empty namespace throws NAMESPACE_REQUIRED
- **Description**: Empty string namespace in enabled mode throws.
- **Input**: `db.create({ model: "task", data: { id: "t1" }, namespace: "" })`
- **Expected error**: `{ code: "NAMESPACE_REQUIRED", message: "Row-level namespace is enabled but no namespace was provided" }`

## TV-RLN-008: output stripping removes __ns from returned records
- **Description**: The `__ns` column is never visible to callers.
- **Setup**: Record `{ id: "t1", title: "Test", __ns: "user:A" }` in storage.
- **Input**: `db.findOne({ model: "task", where: [{ field: "id", operator: "eq", value: "t1" }], namespace: "user:A" })`
- **Expected output**: `{ id: "t1", title: "Test" }` — no `__ns` key.

## TV-RLN-009: update cannot change namespace
- **Description**: Attempting to set `__ns` in update data is silently stripped.
- **Setup**: Record `{ id: "t1", title: "Old", __ns: "user:A" }`.
- **Input**: `db.update({ model: "task", where: [{ field: "id", operator: "eq", value: "t1" }], data: { title: "New", __ns: "user:B" }, namespace: "user:A" })`
- **Expected outcome**: Row becomes `{ id: "t1", title: "New", __ns: "user:A" }` (namespace unchanged).

## TV-RLN-010: internal CRUD not affected
- **Description**: `db.internal.*` operates without namespace filtering.
- **Setup**: `rowLevelNamespace.enabled = true` on the adapter.
- **Input**: `db.internal.findMany("__datafn_changes", [{ field: "namespace", op: "eq", value: "user:A" }])`
- **Expected outcome**: Works normally — no `NAMESPACE_REQUIRED` error, no `__ns` injection.

## TV-RLN-011: transaction respects namespace filtering
- **Description**: Operations inside a transaction are namespace-filtered.
- **Setup**: Records: `{ id: "t1", __ns: "user:A" }`, `{ id: "t2", __ns: "user:B" }`.
- **Input**:
```javascript
await db.transaction(async (trx) => {
  const records = await trx.findMany({ model: "task", where: [], namespace: "user:A" });
  return records;
});
```
- **Expected output**: `[{ id: "t1" }]` — namespace B's record excluded.

## TV-RLN-012: upsert stamps create but not update
- **Description**: Upsert injects `__ns` into create data but not update data.
- **Input**: `db.upsert({ model: "task", where: [{ field: "id", operator: "eq", value: "t1" }], create: { id: "t1", title: "New" }, update: { title: "Updated" }, namespace: "user:A" })`
- **Expected outcome (new record)**: Row is `{ id: "t1", title: "New", __ns: "user:A" }`.
- **Expected outcome (existing record)**: Only `title` updated; `__ns` remains unchanged.

## TV-RLN-013: disabled mode — no filtering
- **Description**: When `rowLevelNamespace` is not enabled, behavior is unchanged.
- **Setup**: Adapter created without `rowLevelNamespace` config. Records: `{ id: "t1" }`, `{ id: "t2" }`.
- **Input**: `db.findMany({ model: "task", where: [] })` (no namespace param)
- **Expected output**: `[{ id: "t1" }, { id: "t2" }]` — all records, no error.

## TV-DFN-001: server wraps adapter when authContextProvider present
- **Description**: `createDatafnServer` with `authContextProvider` + `db` produces a namespace-filtered adapter.
- **Input**: `createDatafnServer({ schema, db: memoryAdapter(), authContextProvider: { getContext: () => ({ userId: "alice" }) } })`
- **Expected outcome**: Mutations and queries through the server are namespace-filtered.
- **Verification**: Insert via `/datafn/mutation` as user alice, then query via `/datafn/query` as user bob → bob sees empty results.

## TV-DFN-002: server does not wrap when no authContextProvider
- **Description**: Without `authContextProvider`, adapter is used as-is.
- **Input**: `createDatafnServer({ schema, db: memoryAdapter() })`
- **Expected outcome**: All records visible regardless of namespace (current behavior).

## TV-DFN-003: extractNamespace consistency
- **Description**: The namespace in `__ns` matches `__datafn_changes.namespace`.
- **Setup**: Server with `authContextProvider` returning `{ userId: "alice", tenantId: "acme" }`.
- **Input**: Insert a task via `/datafn/mutation`.
- **Expected outcome**: Data row has `__ns: "tenant:acme:user:alice"`. Change log entry has `namespace: "tenant:acme:user:alice"`.

## TV-DFN-004: clone returns only user's records
- **Description**: Clone with namespace filtering returns only the requesting user's data.
- **Setup**: Two users (alice, bob) each insert 2 tasks via push.
- **Input**: POST `/datafn/clone` as alice.
- **Expected output**: `{ ok: true, data: { task: [alice's 2 tasks only] }, ... }`

## TV-DFN-005: paginated clone respects namespace
- **Description**: Paginated clone also filters by namespace.
- **Setup**: Alice has 5 tasks, bob has 3 tasks.
- **Input**: POST `/datafn/clone` as alice with `{ page: { table: "task", afterId: null, limit: 2 } }`.
- **Expected output**: First page has 2 of alice's tasks. No bob tasks.

## TV-DFN-006: query returns only user's records
- **Description**: Query endpoint filters by requesting user's namespace.
- **Setup**: Alice has 3 tasks, bob has 2 tasks.
- **Input**: POST `/datafn/query` as alice with `{ resource: "task" }`.
- **Expected output**: `{ data: [3 tasks], nextCursor: null }` — only alice's tasks.

## TV-DFN-007: query with filters + namespace
- **Description**: User filters compose with namespace filtering.
- **Setup**: Alice has `{ status: "open" }` task and `{ status: "done" }` task. Bob has `{ status: "open" }` task.
- **Input**: POST `/datafn/query` as alice with `{ resource: "task", filters: { status: { $eq: "open" } } }`.
- **Expected output**: 1 result (alice's open task). Bob's open task excluded.

## TV-DFN-008: mutation insert stamps namespace
- **Description**: Insert via `/datafn/mutation` stamps the record with the user's namespace.
- **Input**: POST `/datafn/mutation` as alice with insert mutation for task.
- **Verification**: DB row has `__ns: "user:alice"`.

## TV-DFN-009: mutation cross-tenant blocked
- **Description**: User A cannot delete or merge a record owned by user B.
- **Setup**: Bob's task `{ id: "t1", __ns: "user:bob" }`.
- **Input**: POST `/datafn/mutation` as alice with `{ operation: "delete", resource: "task", id: "t1" }`.
- **Expected outcome**: Record `t1` still exists (delete affected zero rows in alice's namespace).

## TV-DFN-010: push stamps namespace
- **Description**: Push mutations create records with the user's namespace.
- **Input**: POST `/datafn/push` as alice with insert mutation.
- **Verification**: DB row has `__ns: "user:alice"`.

## TV-DFN-011: seed stamps namespace
- **Description**: Seed endpoint stamps records with namespace from auth context.
- **Input**: POST `/datafn/seed` as alice with records.
- **Verification**: All seeded rows have `__ns: "user:alice"`.

## TV-SCH-001: multiTenant schema flag accepted
- **Description**: `defineSchema` accepts `multiTenant: true`.
- **Input**: `defineSchema({ multiTenant: true, resources: [{ name: "task", version: 1, fields: [] }] })`
- **Expected output**: Schema object with `multiTenant: true`.

## TV-SCH-002: codegen generates __ns column
- **Description**: Drizzle codegen with `multiTenant: true` includes `__ns` column.
- **Input**: Schema with `multiTenant: true` and resource `task`.
- **Expected output**: Generated Drizzle schema contains `__ns: text("__ns").notNull()` in task table definition.

## TV-SCH-003: codegen generates __ns index
- **Description**: Generated schema includes index on `__ns`.
- **Input**: Same as TV-SCH-002.
- **Expected output**: Generated schema contains index definition referencing `__ns` column.

## TV-SCH-004: codegen generates __ns on join tables
- **Description**: Join tables also get `__ns` column when `multiTenant: true`.
- **Input**: Schema with `multiTenant: true` and a many-many relation.
- **Expected output**: Generated join table schema includes `__ns: text("__ns").notNull()`.

## TV-SCH-005: CLI --multi-tenant flag
- **Description**: CLI flag enables multi-tenant schema generation.
- **Input**: `npx datafn generate-schema --multi-tenant`
- **Expected output**: Generated schema includes `__ns` columns and indexes.
- **Negative variant**: `npx datafn generate-schema` (no flag, no `multiTenant` in schema) → no `__ns` columns.

## TV-SCH-006: validateSchema accepts multiTenant
- **Description**: Schema validation passes with `multiTenant` field.
- **Input**: `validateSchema({ multiTenant: true, resources: [{ name: "task", version: 1, fields: [{ name: "title", type: "string", required: true }] }] })`
- **Expected output**: `{ ok: true, result: { multiTenant: true, resources: [...] } }`

## TV-MIG-001: migration adds __ns column
- **Description**: Migration adds `__ns` column with default value to existing tables.
- **Input**: Existing `task` table without `__ns`. Run migration.
- **Expected outcome**: `task` table now has `__ns TEXT NOT NULL DEFAULT 'datafn'` column. All existing rows have `__ns = 'datafn'`.

## TV-DRZ-001: Drizzle adapter end-to-end with namespace
- **Description**: Full CRUD cycle with Drizzle adapter (SQLite) and namespace filtering.
- **Setup**: SQLite database with Drizzle schema including `__ns` column.
- **Input sequence**:
  1. `create({ model: "task", data: { id: "t1", title: "A" }, namespace: "user:A" })`
  2. `create({ model: "task", data: { id: "t2", title: "B" }, namespace: "user:B" })`
  3. `findMany({ model: "task", where: [], namespace: "user:A" })`
- **Expected output step 3**: `[{ id: "t1", title: "A" }]`

## TV-TST-001: Contract test suite structure
- **Description**: Reusable contract test verifies isolation across adapters.
- **Input**: Run contract tests with memory adapter.
- **Expected outcome**: All assertions pass — create in ns A, findMany in ns B returns empty, delete in ns A does not affect ns B.
