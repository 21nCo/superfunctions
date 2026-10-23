# Specification: Fix Internal Table Resolution Across All Adapters

## Metadata

| Field             | Value                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **Timestamp**     | 2026-02-12T18:50:00Z                                                                        |
| **Agent**         | antigravity                                                                                 |
| **Model**         | Claude Sonnet 4                                                                             |
| **Launcher**      | Gemini Code Assist                                                                          |
| **Workspace**     | `/Users/ar/dev/superfunctions`                                                              |
| **OS / Shell**    | macOS / zsh                                                                                 |
| **Git Branch**    | `next`                                                                                      |
| **Git Commit**    | `2d1a0bf847258ca5811d604fc481aa59bd0e31a0`                                                  |
| **Git Dirty**     | Yes                                                                                         |
| **spec_folder**   | `2026-02-12-fix-r8k4m2x9-spec`                                                              |
| **spec_type**     | `fix`                                                                                       |
| **spec_id**       | `r8k4m2x9`                                                                                  |
| **Input Paths**   | Issue: `.conduct/issues/2026-02-12-x9k4m7p3-issue.md`                                       |
| **Related Issue** | `2026-02-12-x9k4m7p3-issue` — Drizzle adapter `resolveTable` throws for `__datafn_*` tables |

---

## Overview

The DataFn server relies on internal tables (`__datafn_meta`, `__datafn_changes`, `__datafn_idempotency`, `__datafn_seed`) for sync, change tracking, and idempotency. All three SQL adapter implementations (Drizzle, Prisma, Kysely) fail when the server accesses these tables because they are not in the user-supplied schema. Additionally, many-many relations use dynamically generated `__datafn_join_*` internal tables instead of explicit user-defined join tables, compounding the issue.

This spec covers two workstreams:

1. **Adapter-level raw CRUD** — a new sub-interface on `Adapter` that bypasses ORM schema resolution for internal tables
2. **Join table externalization** — schema changes so `many-many` relations use user-defined tables instead of `__datafn_join_*` internal tables

---

## Glossary

| Term                  | Definition                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Internal table**    | A table prefixed with `__datafn_` used by the DataFn server for infrastructure (not user data)                                |
| **Raw CRUD**          | A set of CRUD operations that bypass ORM schema resolution and operate on tables by name using the underlying database driver |
| **Join table**        | A database table that stores many-to-many relationship rows (from ID, to ID, optional metadata)                               |
| **Model name**        | The string identifier passed as `model` in adapter CRUD params (e.g., `"todos"`, `"__datafn_meta"`)                           |
| **Schema resolution** | The process of mapping a model name to an ORM-specific table object (Drizzle table, Prisma delegate, Kysely table ref)        |

---

## Goals

1. Internal DataFn tables MUST be accessible through any adapter without user configuration
2. Users MUST NOT need to know about, define, or register internal tables
3. Many-many join tables SHOULD use user-defined tables declared in the schema, eliminating `__datafn_join_*` runtime generation
4. The CLI MUST generate join table definitions (Drizzle, Prisma, Kysely, raw SQL) from the schema's relation declarations
5. All existing adapter tests and DataFn server tests MUST continue to pass

## Non-Goals

- MongoDB adapter support (schemaless, already works)
- Memory adapter changes (schemaless, already works)
- Changing the internal table DDL schema (column types/names remain the same)
- Removing the `__datafn_join_` prefix entirely from migrations that already generated these tables

---

## Public API

### New: `Adapter.internal` sub-interface

```typescript
interface InternalCrud {
  /** Ensure an internal table exists (CREATE TABLE IF NOT EXISTS) */
  ensureTable(name: string, columns: InternalColumnDef[]): Promise<void>;

  /** Create a record in an internal table */
  create(
    table: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Find one record in an internal table */
  findOne(
    table: string,
    where: Array<{ field: string; op: string; value: unknown }>,
  ): Promise<Record<string, unknown> | null>;

  /** Find many records in an internal table */
  findMany(
    table: string,
    where: Array<{ field: string; op: string; value: unknown }>,
    opts?: { orderBy?: string; limit?: number },
  ): Promise<Record<string, unknown>[]>;

  /** Update records matching where clause */
  update(
    table: string,
    where: Array<{ field: string; op: string; value: unknown }>,
    data: Record<string, unknown>,
  ): Promise<number>;

  /** Delete records matching where clause */
  delete(
    table: string,
    where: Array<{ field: string; op: string; value: unknown }>,
  ): Promise<number>;
}

interface InternalColumnDef {
  name: string;
  type: "text" | "integer";
  primaryKey?: boolean;
}
```

Added to `Adapter`:

```typescript
interface Adapter {
  // ... existing methods ...

  /** Raw CRUD for internal tables, bypasses ORM schema resolution */
  readonly internal: InternalCrud;
}
```

### Modified: `DatafnRelationSchema`

```diff
 export type DatafnRelationSchema = {
   from: string | string[];
   to: string | string[];
   type: "one-many" | "many-one" | "many-many" | "htree";
   relation?: string;
   inverse?: string;
   cache?: boolean;
   metadata?: Array<{ name: string; type: "string" | "number" | "boolean" | "date" | "object" }>;
   fkField?: string;
   pathField?: string;
+  joinTable?: string;
+  joinColumns?: { from: string; to: string };
 };
```

### Modified: CLI `generate-migration`

The migration generator MUST now generate join table DDL as **named user tables** when `joinTable` is specified in the relation, OR auto-name them with the `__datafn_join_` prefix when no `joinTable` is specified (backward-compatible).

### Modified: CLI `codegen.ts` (`generateTypes`)

The TS type generator MUST now emit interfaces for join table types when `many-many` relations with `metadata` are present.

---

## Data Formats / Protocol

### Internal Table Schemas

All internal tables use portable column types.

**`__datafn_meta`**:
| Column | Type | Constraint |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `namespace` | TEXT | |
| `nextServerSeq` | INTEGER | |

**`__datafn_changes`**:
| Column | Type | Constraint |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `namespace` | TEXT | |
| `serverSeq` | INTEGER | |
| `resource` | TEXT | |
| `recordId` | TEXT | |
| `op` | TEXT | |
| `record` | TEXT | |
| `createdAt` | TEXT | |

**`__datafn_idempotency`**:
| Column | Type | Constraint |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `namespace` | TEXT | |
| `clientId` | TEXT | |
| `mutationId` | TEXT | |
| `result` | TEXT | |
| `createdAt` | TEXT | |

**`__datafn_seed`**:
| Column | Type | Constraint |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `namespace` | TEXT | |
| `seedId` | TEXT | |
| `status` | TEXT | |
| `createdAt` | TEXT | |

---

## Semantics

### `Adapter.internal` Routing

The DataFn server MUST route all internal table operations through `adapter.internal.*` instead of `adapter.create()`, `adapter.findOne()`, etc. This means:

- `sequence-store.ts`: Use `adapter.internal.*` for `__datafn_meta`
- `change-tracking.ts`: Use `adapter.internal.*` for `__datafn_meta` and `__datafn_changes`
- `idempotency-db.ts`: Use `adapter.internal.*` for `__datafn_idempotency`
- `seed.ts`: Use `adapter.internal.*` for `__datafn_seed`

### Join Table Resolution

When a `many-many` relation has `joinTable` set:

- `relations.ts` MUST use `adapter.create/findOne/findMany/update/delete` with `model: relation.joinTable` (a normal user table)
- `db-store.ts` MUST use `model: relation.joinTable` for loading join rows
- Column names MUST use `relation.joinColumns.from` and `relation.joinColumns.to` instead of hardcoded `"from"` and `"to"`

When `joinTable` is NOT set (backward compatibility):

- Behavior MUST remain unchanged: use `__datafn_join_${from}_${relation}` with `"from"`/`"to"` columns
- These join tables MUST be routed through `adapter.internal.*` (not the user CRUD path)

### `ensureTable` Call Timing

Each adapter's `internal.ensureTable` MUST be called lazily on first access to that table. Results MUST be cached per table name — `ensureTable` MUST NOT run DDL more than once per table per adapter lifetime.

---

## Invariants

1. **No user schema pollution**: Users MUST NOT need to define or know about `__datafn_meta`, `__datafn_changes`, `__datafn_idempotency`, `__datafn_seed`
2. **Adapter-agnostic**: The `InternalCrud` interface MUST be implemented by all adapters (Drizzle, Prisma, Kysely, Memory)
3. **Lazy DDL**: `CREATE TABLE IF NOT EXISTS` MUST only run on first access, not on adapter initialization
4. **Idempotent DDL**: `ensureTable` MUST be safe to call multiple times with the same arguments
5. **Join table backward compatibility**: Schemas without `joinTable` MUST continue to use `__datafn_join_*` naming
6. **Deterministic column ordering**: `ensureTable` column definitions MUST produce deterministic DDL regardless of call order

---

## Security

- Internal tables MUST inherit the same connection credentials as the user's database connection
- No new authorization boundaries are introduced
- Internal table names MUST be validated to only accept `__datafn_` prefixed names in `ensureTable`

---

## Limits / Caps

- Maximum columns per internal table: 20 (defensive; current max is 8)
- Internal table names MUST match regex `^__datafn_[a-z0-9_]+$`

---

## Observability

- When `debug: true` is set on the adapter config, `ensureTable` DDL execution MUST be logged
- Failed internal CRUD operations MUST throw with clear error messages including the internal table name and operation

---

## Compatibility / Versioning

- The `internal` property on `Adapter` is a **breaking change** to the interface — all adapter implementations MUST be updated simultaneously
- Existing schemas without `joinTable` continue to work unchanged
- CLI-generated migrations already use `__datafn_join_` prefix — no migration path is needed for existing databases

---

## Undefined / Explicitly User-Deferred

- None. All items derived from the issue and user request are covered.
