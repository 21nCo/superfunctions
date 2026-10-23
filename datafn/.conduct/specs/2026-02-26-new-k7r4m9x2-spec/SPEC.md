# SPEC: Row-Level Namespace Isolation for datafn

## Metadata
- **Timestamp**: 2026-02-26T07:41:12Z
- **Agent**: Oz (Warp)
- **Model**: auto
- **Launcher**: Warp
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: macOS, zsh 5.9
- **Git branch**: `next`
- **Git commit**: `ea87d7ee18502d2864fccc56e8a4c88aa7652080`
- **Git dirty**: yes
- **spec_folder**: `2026-02-26-new-k7r4m9x2-spec`
- **spec_type**: `new`
- **spec_id**: `k7r4m9x2`
- **Input paths**: conversation context (no external notes/intent docs)

---

## Overview

datafn's multi-tenant / multi-user isolation is currently incomplete. The `authContextProvider` on `createDatafnServer` extracts a namespace string (`user:{userId}` or `tenant:{tenantId}:user:{userId}`) that correctly isolates **sync metadata** (serverSeq counters in `__datafn_meta`, change log entries in `__datafn_changes`). However, **data tables** (the actual user resources like `task`, `project`, etc.) are NOT filtered by namespace — every `db.findMany`, `db.create`, `db.findOne`, `db.upsert`, `db.delete` call passes `namespace` as a parameter, but no adapter in `@superfunctions/db` uses it for row-level filtering.

This means:
- **Clone** returns ALL records regardless of user/tenant.
- **Query** returns ALL records regardless of user/tenant.
- **Mutations** write to shared tables with no namespace stamp.
- **Pull** is correctly isolated (reads from `__datafn_changes` which IS namespace-filtered).

This spec defines the **discriminator column pattern** to add row-level namespace isolation to `@superfunctions/db` (adapter factory layer) and integrate it with datafn's existing namespace plumbing.

## Glossary

- **Namespace (library-level)**: Existing concept. A prefix applied to table names to separate libraries sharing a database (e.g., `datafn_task` vs `authfn_users`). Configured at adapter creation time. Unchanged by this spec.
- **Namespace (row-level)**: New concept. A discriminator column (`__ns`) added to every data row. Filters reads and stamps writes so that different tenants/users within the same table see only their own data.
- **Discriminator column**: The `__ns` column (type: `text`, indexed, NOT NULL). Stores the row-level namespace string.
- **Namespace string**: The resolved value from `authContextProvider`, e.g. `"user:123"`, `"tenant:abc:user:123"`, or the default `"datafn"`.
- **Row-level filtering**: Automatic injection of `WHERE __ns = ?` into all read operations and `__ns = ?` into all write data when `rowLevelNamespace` is enabled.
- **Adapter factory wrapper**: The `wrapAdapter()` function in `packages/db/src/adapter/factory.ts` that intercepts all CRUD calls before delegating to the underlying adapter implementation.
- **Internal tables**: Tables prefixed with `__datafn_` (e.g., `__datafn_meta`, `__datafn_changes`). These use `db.internal` CRUD and are NOT subject to row-level namespace filtering (they already have their own explicit namespace filtering).

## Goals

1. **Data isolation**: When `authContextProvider` is configured, each user/tenant MUST only see and mutate their own records in data tables.
2. **Adapter-agnostic**: The solution MUST work with any SQL database adapter (Drizzle/Postgres, Drizzle/MySQL, Drizzle/SQLite, Prisma, Kysely, memory adapter) without adapter-specific code.
3. **Backward compatible**: When `rowLevelNamespace` is NOT enabled, behavior is identical to today. No schema changes, no performance impact.
4. **Transparent to datafn**: datafn already passes `namespace` to every DB call. The adapter factory MUST handle filtering/stamping automatically — no changes needed in datafn's query/mutation/sync route handlers.
5. **Schema integration**: The datafn CLI codegen MUST generate the `__ns` column in Drizzle schemas when multi-tenant mode is detected.

## Non-Goals

- PostgreSQL Row-Level Security (RLS) policies. This spec uses application-level filtering, not database-level RLS.
- Per-tenant database or per-tenant schema separation. This spec uses a shared-table, discriminator-column approach.
- Client-side changes. The client already has physical storage isolation (separate IndexedDB databases per user/tenant).
- Changes to the `authorize` callback or `authz.ts` field-level permissions. Those remain complementary, orthogonal mechanisms.
- Cross-tenant queries (e.g., admin dashboards that see all tenants). This is explicitly deferred until a future spec adds an escape hatch.

## Public API

### `@superfunctions/db` — AdapterFactoryConfig changes

```typescript
// packages/db/src/adapter/types.ts — AdapterFactoryConfig additions
interface AdapterFactoryConfig {
  // ... existing fields ...

  /**
   * Row-level namespace isolation configuration.
   * When enabled, every CRUD operation that carries a `namespace` param
   * will have automatic WHERE filtering and data stamping on a discriminator column.
   */
  rowLevelNamespace?: {
    /** Enable row-level namespace filtering. Default: false. */
    enabled: boolean;
    /** Column name for the discriminator. Default: "__ns". */
    column?: string;
  };
}
```

### `@superfunctions/db` — Adapter behavior when `rowLevelNamespace.enabled = true`

For every CRUD method on the wrapped adapter:

| Method | Injection |
|---|---|
| `create(params)` | Add `{ [column]: params.namespace }` to `params.data`. Error if `params.namespace` is undefined/empty. |
| `createMany(params)` | Add `{ [column]: params.namespace }` to each item in `params.data`. |
| `findOne(params)` | Prepend `{ field: column, operator: "eq", value: params.namespace }` to `params.where`. |
| `findMany(params)` | Prepend `{ field: column, operator: "eq", value: params.namespace }` to `params.where`. |
| `update(params)` | Prepend namespace WHERE clause. |
| `updateMany(params)` | Prepend namespace WHERE clause. |
| `delete(params)` | Prepend namespace WHERE clause. |
| `deleteMany(params)` | Prepend namespace WHERE clause. |
| `upsert(params)` | Prepend namespace WHERE clause. Add `{ [column]: params.namespace }` to `params.create`. |
| `count(params)` | Prepend namespace WHERE clause. |

**Output stripping**: `transformOutput` MUST remove the `[column]` field from returned records so consumers never see it.

**Internal CRUD bypass**: `db.internal.*` methods are NOT affected. They already manage their own namespace filtering.

### `datafn` server — createDatafnServer changes

```typescript
// datafn/server/src/server.ts — createDatafnServer additions
interface DatafnServerConfig<TContext = any> {
  // ... existing fields ...

  // No new fields needed. When authContextProvider is present AND db is provided,
  // the server MUST wrap the adapter with rowLevelNamespace enabled.
}
```

The wrapping logic:
1. If `config.authContextProvider` is present AND `config.db` is provided:
   - Wrap `config.db` with a row-level namespace interceptor (either by re-wrapping via factory or by a standalone wrapper function).
   - The discriminator column is `__ns`.
2. If `config.authContextProvider` is NOT present:
   - Use `config.db` as-is (no wrapping). Backward compatible.

### `datafn` CLI — Schema generation changes

The `datafn generate-schema` (Drizzle codegen) command MUST:
1. Accept a `--multi-tenant` flag (or detect from schema metadata).
2. When multi-tenant is enabled, add `__ns: text("__ns").notNull()` column to every generated resource table and every join table.
3. Add an index on `__ns` for every table: `.index("idx_{tableName}___ns", table.__ns)`.
4. When multi-tenant is NOT enabled, omit the column entirely (backward compatible).

### datafn schema — Multi-tenant declaration

```typescript
// In user's .datafn.ts schema file
export default defineSchema({
  multiTenant: true, // NEW: declares multi-tenant mode
  resources: [
    { name: "task", version: 1, fields: [...] },
  ],
});
```

When `multiTenant: true`:
- CLI codegen adds `__ns` column + index to all generated tables.
- Server wraps the adapter with row-level namespace filtering when `authContextProvider` is present.
- Attempting to start the server with `authContextProvider` but without the `__ns` column in the database SHOULD produce a clear startup error.

## Data Formats / Protocol

### Discriminator column schema

- **Column name**: `__ns` (configurable, default `"__ns"`)
- **Type**: `text` / `varchar`, NOT NULL
- **Index**: Non-unique B-tree index per table
- **Value**: The namespace string as resolved by `extractNamespace()` in server.ts:
  - With tenantId: `"tenant:{tenantId}:user:{userId}"`
  - Without tenantId: `"user:{userId}"`
  - Default (no authContextProvider): `"datafn"`

### Example: what a `task` table looks like

Without multi-tenant (unchanged):
```
| id      | title       | status |
|---------|-------------|--------|
| task:1  | Buy milk    | open   |
| task:2  | Fix bug     | done   |
```

With multi-tenant:
```
| id      | title       | status | __ns                    |
|---------|-------------|--------|-------------------------|
| task:1  | Buy milk    | open   | user:alice              |
| task:2  | Fix bug     | done   | user:bob                |
| task:3  | Deploy app  | open   | tenant:acme:user:alice  |
```

User Alice querying tasks sees only rows where `__ns` matches her resolved namespace.

## Semantics

### Write path (create / insert)

1. `datafn` server resolves namespace via `extractNamespace(ctx)` (existing).
2. Server calls `db.create({ model: "task", data: { id: "task:1", title: "Buy milk" }, namespace: "user:alice" })`.
3. Adapter factory wrapper intercepts, injects `__ns: "user:alice"` into `data`.
4. Underlying adapter creates the row with the `__ns` column populated.
5. Factory wrapper strips `__ns` from the returned record.

### Read path (findMany / findOne / count)

1. Server calls `db.findMany({ model: "task", where: [...userFilters], namespace: "user:alice" })`.
2. Factory wrapper prepends `{ field: "__ns", operator: "eq", value: "user:alice" }` to `where`.
3. Underlying adapter executes the query with the additional WHERE clause.
4. Factory wrapper strips `__ns` from each returned record.

### Update path

1. Server calls `db.update({ model: "task", where: [{ field: "id", operator: "eq", value: "task:1" }], data: { status: "done" }, namespace: "user:alice" })`.
2. Factory wrapper prepends namespace WHERE clause (prevents cross-tenant update).
3. If the record belongs to a different namespace, the WHERE matches zero rows → `NotFoundError`.

### Delete path

Same as update — namespace WHERE clause prevents cross-tenant deletion.

### Upsert path

1. Factory wrapper prepends namespace WHERE clause for the conflict check.
2. Factory wrapper injects `__ns` into `create` data.
3. `update` data does NOT get `__ns` injected (the column is immutable once set).

### Internal tables bypass

`db.internal.create`, `db.internal.findMany`, etc. are NOT wrapped. They continue to use explicit `{ field: "namespace", op: "eq", value: ... }` filtering as they do today. The `__ns` discriminator column does NOT exist on `__datafn_meta`, `__datafn_changes`, or `__datafn_idempotency` tables.

### Transaction path

When `db.transaction(callback)` is called, the transaction adapter returned to the callback MUST also have row-level namespace filtering applied. The factory wrapper MUST propagate the `rowLevelNamespace` config to the transaction adapter.

## Invariants

1. **No cross-tenant data leakage**: When `rowLevelNamespace` is enabled, a read operation with `namespace: "user:A"` MUST never return records where `__ns != "user:A"`. This is the primary security invariant.
2. **No cross-tenant mutation**: A write/update/delete operation with `namespace: "user:A"` MUST never affect records where `__ns != "user:A"`.
3. **Namespace immutability**: Once a record's `__ns` value is set at creation, it MUST NOT be changed by update or upsert operations.
4. **Mandatory namespace on writes**: When `rowLevelNamespace` is enabled, any `create` or `createMany` call without a `namespace` parameter MUST throw a clear error (not silently insert with null/empty `__ns`).
5. **Mandatory namespace on reads**: When `rowLevelNamespace` is enabled, any `findMany`, `findOne`, `count` call without a `namespace` parameter MUST throw a clear error (not return unfiltered results).
6. **Internal CRUD exemption**: `db.internal.*` MUST NOT be affected by row-level namespace filtering.
7. **Output cleanliness**: The `__ns` column MUST be stripped from all records returned to callers. Consumers MUST NOT see it.
8. **Idempotency**: The namespace filtering is deterministic. Same namespace + same query → same results (given same data).
9. **Change tracking consistency**: The namespace used in `__datafn_changes.namespace` (change tracking) MUST be the same string stored in `__ns` on data rows. This ensures pull results match the data visible to that user.

## Security

- The `__ns` column is an application-level security boundary. It prevents data leakage between tenants/users at the database query level.
- The namespace string is derived server-side from `authContextProvider.getContext()`, which should extract from a verified session/JWT. Client-provided namespace values MUST NOT be trusted.
- The `authorize` callback and `authz.ts` field-level permissions remain in effect as complementary layers.
- The `__ns` column SHOULD NOT be exposed in API responses, error messages, or logs (beyond debug-level).

## Limits / Caps

- **Column name length**: `__ns` is 4 characters, well within all SQL database limits.
- **Namespace string length**: No enforced maximum, but SHOULD be kept under 255 characters. Excessively long namespace strings waste index space.
- **Index overhead**: One additional B-tree index per table. For tables with millions of rows, this is standard multi-tenant overhead.
- **Query overhead**: One additional WHERE clause per query. With the index, this is O(log n) lookup, not a full table scan.

## Observability

- When `rowLevelNamespace` is enabled, the adapter factory SHOULD log (at debug level) when namespace injection occurs.
- Startup: If `authContextProvider` is configured and the adapter is wrapped, the server SHOULD log an info message: `"Row-level namespace isolation enabled (column: __ns)"`.
- Errors: Missing namespace on CRUD calls MUST produce errors with code `"NAMESPACE_REQUIRED"` and a clear message.
- The `__ns` column value MUST NOT appear in non-debug log output (it may contain user/tenant identifiers that are PII-adjacent).

## Compatibility / Versioning Strategy

- **Backward compatible**: When `multiTenant` is not declared in schema or `authContextProvider` is not configured, zero behavioral changes.
- **Migration for existing databases**: Users upgrading to multi-tenant mode MUST run a migration to add the `__ns` column to existing tables. The CLI SHOULD generate this migration. Existing rows MUST be backfilled with a default namespace (e.g., `"datafn"` or a user-specified value).
- **Schema version**: Adding `__ns` increments the schema version tracked by `db.getSchemaVersion / db.setSchemaVersion`.
- **Wire protocol**: No changes to the datafn HTTP API (`/datafn/query`, `/datafn/mutation`, etc.). The namespace is derived server-side, not sent by the client.

## Undefined / Explicitly Not Required

- Cross-tenant admin queries (reading all tenants' data). Not in scope; may be addressed by a future "superuser namespace bypass" spec.
- Row-level namespace on the client side. Client already uses separate IndexedDB databases; no `__ns` column needed in client storage.
- PostgreSQL RLS integration. The discriminator column approach is database-agnostic; RLS is a potential future optimization layer.
- Namespace migration tooling (bulk re-assigning records from one namespace to another). Out of scope.
