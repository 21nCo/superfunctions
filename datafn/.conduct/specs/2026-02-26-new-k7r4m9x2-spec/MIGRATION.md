# MIGRATION: Row-Level Namespace Isolation (`__ns` column)

This document provides step-by-step migration guidance for adding `__ns` discriminator column support
to an existing datafn database. Covers TV-MIG-001, MIG-001.

---

## Scenario A: New Projects

No migration needed.

1. Add `multiTenant: true` to your schema:

   ```ts
   export default defineSchema({
     multiTenant: true,
     resources: [
       { name: 'task', version: 1, fields: [...] },
     ],
   });
   ```

2. Run codegen to generate the Drizzle schema with `__ns` columns and indexes:

   ```bash
   npx datafn generate-schema --multi-tenant
   # or, if multiTenant: true is already in your schema file:
   npx datafn generate-schema
   ```

3. Run the initial migration (creates tables from scratch):

   ```bash
   npx drizzle-kit generate
   npx drizzle-kit migrate
   ```

Done. The `__ns` column is present from the first migration.

---

## Scenario B: Existing Projects — Empty Database (No Data)

Use this path if your database tables exist but contain no rows (or you are okay
recreating them).

1. Add `multiTenant: true` to your schema file.

2. Regenerate the Drizzle schema:

   ```bash
   npx datafn generate-schema
   ```

3. Generate and run the Drizzle migration:

   ```bash
   npx drizzle-kit generate
   npx drizzle-kit migrate
   ```

   Drizzle Kit diffs the new schema against the current one and emits an
   `ALTER TABLE … ADD COLUMN __ns TEXT NOT NULL DEFAULT 'datafn'` statement for
   each resource table and join table.

4. Remove the `DEFAULT 'datafn'` constraint if you want strict NOT NULL going
   forward (optional — the default is only needed for the migration step).

---

## Scenario C: Existing Projects — With Live Data (Most Common)

Use this path when tables already have rows that must be preserved and correctly
assigned to a namespace.

### Step 1 — Add `__ns` column as nullable with a default

For each resource table and join table, run:

```sql
-- SQLite
ALTER TABLE task ADD COLUMN __ns TEXT DEFAULT 'datafn';

-- PostgreSQL
ALTER TABLE task ADD COLUMN __ns TEXT DEFAULT 'datafn';

-- MySQL
ALTER TABLE task ADD COLUMN __ns VARCHAR(255) DEFAULT 'datafn';
```

The column is temporarily nullable / defaulted so existing rows can be written
during the migration without violating NOT NULL.

### Step 2 — Backfill existing rows

Assign all pre-existing rows to the default namespace (`'datafn'`). This is the
value that the server uses when `authContextProvider` is not configured, so
existing single-tenant data will still be visible after enabling multi-tenancy:

```sql
UPDATE task SET __ns = 'datafn' WHERE __ns IS NULL;
```

Repeat for every resource table and join table.

If your existing data belongs to a specific user or tenant, replace `'datafn'`
with the correct namespace string (e.g. `'user:alice'` or `'tenant:acme:user:alice'`).

### Step 3 — Make the column NOT NULL

Once all rows are backfilled:

```sql
-- PostgreSQL / MySQL
ALTER TABLE task ALTER COLUMN __ns SET NOT NULL;
-- (SQLite does not support ALTER COLUMN; recreate the table instead — see note below)
```

> **SQLite note**: SQLite does not support `ALTER COLUMN ... SET NOT NULL`.
> Use a table recreation strategy via `drizzle-kit generate` + `drizzle-kit migrate`,
> which will handle this automatically once `DEFAULT 'datafn'` is set and all rows
> are backfilled.

### Step 4 — Create the index

```sql
-- All dialects
CREATE INDEX IF NOT EXISTS idx_task___ns ON task (__ns);
```

Repeat for every resource table and join table.

### Step 5 — Enable `multiTenant: true` and restart

1. Add `multiTenant: true` to your schema definition.
2. Ensure `authContextProvider` is configured on your server.
3. Restart the server.

The server logs an info message at startup confirming isolation is active:

```
Row-level namespace isolation enabled (column: __ns)
```

---

## Rollback

To revert to single-tenant mode:

1. Set `multiTenant: false` (or remove it) in your schema.
2. Remove `authContextProvider` from `createDatafnServer` config (or leave it —
   without `multiTenant: true`, the server will not wrap the adapter).
3. Optionally drop the `__ns` column and index to reclaim space:

   ```sql
   -- PostgreSQL / MySQL
   ALTER TABLE task DROP COLUMN __ns;
   DROP INDEX IF EXISTS idx_task___ns;

   -- SQLite (table recreation required)
   -- Use drizzle-kit generate + drizzle-kit migrate after removing __ns from schema
   ```

> **Warning**: Dropping the `__ns` column is irreversible. If you drop it and
> later re-enable multi-tenancy, existing rows will need to be backfilled again.

---

## Quick Reference — SQL Templates

Replace `{table}` with each resource table name (e.g. `task`, `project`) and
each join table (e.g. `__datafn_join_task_tags`).

```sql
-- 1. Add column
ALTER TABLE {table} ADD COLUMN __ns TEXT DEFAULT 'datafn';

-- 2. Backfill
UPDATE {table} SET __ns = 'datafn' WHERE __ns IS NULL;

-- 3. Add index
CREATE INDEX IF NOT EXISTS idx_{table}___ns ON {table} (__ns);
```

---

## Notes

- **Default namespace value**: `'datafn'` is used as the backfill default. This
  matches the namespace string the server uses when no `authContextProvider` is
  configured, ensuring backward-compatible behaviour for single-tenant data.
- **Index naming convention**: `idx_{tableName}___ns` (two underscores before `ns`).
- **Multiple tables**: Run Steps 1–4 for every table that has a corresponding
  datafn resource. This includes join tables generated for many-many relations
  (`__datafn_join_*`).
- **Zero-downtime**: Steps 1 and 2 can run online (column add + backfill). Step 3
  (NOT NULL) typically requires a brief lock on PostgreSQL/MySQL. Plan accordingly
  for production databases with large tables.
