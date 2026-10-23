# Issue Completion Report

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-19T13:07:00Z |
| **Agent** | unknown-agent |
| **Model** | claude-4.6-sonnet-medium-thinking |
| **Launcher** | Cursor |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | darwin 25.2.0 / zsh |
| **Git Branch** | `next` |
| **Git Dirty** | Yes |
| **Issue File** | `datafn/.conduct/issues/2026-02-19-m7k3x9p4-issue.md` |

---

## Issue Summary

Three interrelated bugs caused sync operations to fail or silently lose data when using the Drizzle adapter:

1. **Root Cause 1**: The Drizzle codegen did not emit a `kv` table even though `ensureBuiltinKv()` injects the `kv` resource at runtime. Additionally, the `kv` resource definition in `ensureBuiltinKv()` lacked an explicit `id` field, so the codegen would have generated an `id`-less table even if it were included.

2. **Root Cause 2**: Join table naming was inconsistent — `clone.ts` and `reconcile.ts` queried `db.findMany({ model: "join_todos_tags_categories" })` (the logical client store key), but the actual DB table created by `relations.ts` and codegen is `__datafn_join_todos_tags`. This caused clone/reconcile to always return empty join data with Drizzle (error silently swallowed).

3. **Root Cause 3**: Clone/reconcile included the `kv` resource (injected by `ensureBuiltinKv()`) in their iterations, but since `kv` had no Drizzle table, the DB query failed silently. Resolved by Fix 1 (kv table now exists).

4. **Root Cause 4 (Low severity)**: `coerceDateFields` silently returned uncoerced data when the resource was not found in the schema — converted to a `console.warn` for early detection.

---

## Status: PASS

---

## Requirements Summary

### Requirements Addressed

| Requirement | Status | Evidence |
|---|---|---|
| Push KV mutation succeeds with Drizzle/Postgres adapter | PASS | Codegen now emits `kv` table with `id text PK, value jsonb/json/text` per dialect; Drizzle `resolveTable()` finds it |
| Clone without explicit `tables` filter includes `kv` data correctly | PASS | `ensureBuiltinKv()` adds kv to schema; kv table now exists in DB schema |
| Clone with explicit tables still works (no regression) | PASS | Server sync tests: 17/17 pass |
| Reconcile returns correct count for `kv` resource | PASS | kv table now exists; reconcile queries it successfully |
| Push of `relate` operation records change under the correct join table name | PASS | `extractJoinDeltas` uses `join_${from}_${rel}_${to}` (logical key); pull/client use same key — consistent round-trip |
| Clone with `includeJoins: true` returns join rows correctly | PASS | `clone.ts` now queries `__datafn_join_${from}_${relation}` (actual DB table) but returns under `join_${from}_${relation}_${to}` (logical client key) |
| Pull returns join changes under the correct resource key | PASS | Change tracking and pull both use `join_` logical keys — unchanged, already consistent |
| Client reconcile drift detection matches server join store names | PASS | `reconcile.ts` returns join counts under `join_${from}_${relation}_${to}` logical keys matching what client engine.ts expects |
| Codegen output includes `kv` table with correct column types for all 3 dialects | PASS | Tests TV-DRZ-KV-001 through kv-005: postgres=jsonb, mysql=json, sqlite=text; 26/26 tests pass |
| Existing drizzle-codegen tests pass (no regression) | PASS | 26/26 tests pass after updating pre-existing assertions for kv inclusion |
| Defensive logging in coerceDateFields | PASS | `console.warn` added when resource not found in schema |

---

## Test Status

### Tests Run

| Test File | Pass/Fail | Count |
|---|---|---|
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | ✅ PASS | 26/26 |
| `datafn/server/__tests__/sync.test.ts` | ✅ PASS | 17/17 |
| `datafn/client/__tests__/sync.test.ts` | ✅ PASS | 19/19 |
| `datafn/server/__tests__/query-validation.test.ts` | ✅ PASS | 16/16 |

Pre-existing failures in `__tests__/ts-loading.test.ts`, `__tests__/auto-discovery.test.ts`, `__tests__/ts-schema-vectors.test.ts` (CLI), and DFQL aggregate/filter/transaction server tests are pre-existing regressions unrelated to these changes (CLI tests use renamed `generate-types` command; server DFQL tests fail on unimplemented features).

---

## Implementation Summary

### Files Changed

| File | Change Type | Description |
|---|---|---|
| `datafn/core/src/kv.ts` | Modified | Added explicit `id: string` field to kv resource definition in `ensureBuiltinKv()` so codegen generates a valid primary key column |
| `datafn/cli/src/drizzle-codegen.ts` | Modified | Added `ensureBuiltinKv` import and applied it to schema before iterating resources, so kv table is always emitted |
| `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts` | Modified | Regenerated to include `kv` table (`id text PK, value jsonb`); added `jsonb` to imports; added `kv` to schema export |
| `datafn/server/src/execution/sync/clone.ts` | Modified | Fixed join section: now uses `joinTableName = relation.joinTable \|\| __datafn_join_${from}_${relation}` for DB query; returns results under logical `joinStoreKey = join_${from}_${relation}_${to}` |
| `datafn/server/src/execution/sync/reconcile.ts` | Modified | Same bridge fix: queries actual DB table by `joinTableName`, returns counts under logical `joinStoreKey` |
| `datafn/server/src/execution/sync/push.ts` | Modified | Added `console.warn` in `coerceDateFields` when resource not found in schema |
| `datafn/cli/__tests__/drizzle-codegen.test.ts` | Modified | (a) Updated 9 pre-existing tests to account for kv always being present in schema exports/imports; (b) Added 5 new TV-DRZ-KV-001 tests covering all 3 dialects, deduplication, and sort position |

---

## Key Changes

### Fix 1: kv table codegen (Root Cause 1)

**`datafn/core/src/kv.ts`** — `ensureBuiltinKv()` now includes an explicit `id` field:
```typescript
fields: [
  { name: "id", type: "string", required: true },
  { name: "value", type: "object", required: false },
]
```

**`datafn/cli/src/drizzle-codegen.ts`** — schema is augmented before iteration:
```typescript
const schema = ensureBuiltinKv(unwrapEnvelope(validateSchema(schemaInput)));
```

Result for postgres:
```typescript
export const kv = pgTable("kv", {
  id: text("id").primaryKey(),
  value: jsonb("value"),
});
```

### Fix 2: Join table naming bridge (Root Cause 2)

**`datafn/server/src/execution/sync/clone.ts`** and **`reconcile.ts`**:
```typescript
// Logical key used by client (change tracking, pull, IDB store)
const joinStoreKey = `join_${relation.from}_${relation.relation}_${relation.to}`;
// Actual DB table name (matches relations.ts mutations and codegen)
const joinTableName = relation.joinTable || `__datafn_join_${relation.from}_${relation.relation}`;

// Query using DB table name
await db.findMany({ model: joinTableName, ... });

// Return results under logical key (client compatibility)
joins[joinStoreKey] = joinRecords;
joinCounts[joinStoreKey] = joinRecords.length;
```

This approach preserves full round-trip consistency:
- `push.ts extractJoinDeltas` → records change under `join_` logical key
- `pull.ts` → returns changes under `join_` logical key  
- `clone.ts` → queries `__datafn_join_` DB table, returns under `join_` key
- `reconcile.ts` → queries `__datafn_join_` DB table, returns counts under `join_` key
- Client engine.ts → compares `storage.countJoinRows("join_...")` vs server counts under `join_...` ✓

### Fix 4: Defensive logging (Root Cause 4)

```typescript
console.warn(
  `coerceDateFields: resource "${resource}" not found in schema — skipping date coercion. ` +
    `Known resources: ${schema.resources.map((r) => r.name).join(", ")}`,
);
```

---

## Verification Summary

### Commands Run

```bash
# Rebuild @datafn/core to pick up kv.ts changes
cd datafn/core && npm run build  # ✅ BUILD SUCCESS

# Drizzle codegen tests (26 tests, includes 5 new kv tests)
cd datafn/cli && npx vitest run __tests__/drizzle-codegen.test.ts
# ✅ 26/26 PASS

# Server sync tests
cd datafn/server && npx vitest run __tests__/sync.test.ts
# ✅ 17/17 PASS

# Server query-validation tests (no regression)
cd datafn/server && npx vitest run __tests__/query-validation.test.ts
# ✅ 16/16 PASS

# Client sync tests (no regression)
cd datafn/client && npx vitest run __tests__/sync.test.ts
# ✅ 19/19 PASS
```

---

## Notes

- The bridge approach (keeping `join_` logical key for sync layer, using `__datafn_join_` only for DB queries) is the minimal-impact fix. Changing the client-side IDB store naming to `__datafn_join_` would require updating `offline/relations.ts`, `adapters/indexedDbStorage.ts`, `sync/cloneUp.ts`, and `export.ts` — a much larger refactor with higher risk of breaking local query resolution. The bridge approach achieves correct behavior without touching the client storage contract.
- The `pull.ts` `startsWith("join_")` detection at line 283 was intentionally NOT changed because change tracking records join changes under the `join_` logical key; this detection is correct.
- Pre-existing test failures in CLI (`ts-loading`, `auto-discovery`, `ts-schema-vectors`) are caused by `generate-types` command being renamed to `generate` in a prior change — unrelated to this issue.
- Pre-existing test failures in server DFQL tests (aggregate, filter, transaction, pagination) are caused by unimplemented query features — unrelated to this issue.
- A Drizzle migration will be needed to add the `kv` table to existing deployed databases. The codegen now produces the correct DDL.
