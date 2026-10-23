# Issue Completion Report: Drizzle upsert fails with "No values to set" on many-many relate push

## Metadata

| Field | Value |
|---|---|
| **Issue** | 2026-02-25-m7k4x9r3-issue.md |
| **Timestamp** | 2026-02-25T21:36:00Z |
| **Agent** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 |
| **Launcher** | VS Code (Claude Code Extension) |
| **Branch** | next |

---

## Requirements Summary

The issue reported that pushing a `relate` mutation for a many-many relation with no metadata (e.g. linking a todo to a tag) failed with `Error: No values to set`. This was caused by passing an empty `update: {}` object to the Drizzle adapter's `upsert()` method, which unconditionally called `.onConflictDoUpdate({ set: {} })` — invalid SQL.

### Root Causes

1. **RC-1**: `executeRelate` in `relations.ts` passes `update: {}` when join rows have no metadata (the common case)
2. **RC-2**: Drizzle adapter `upsert()` does not guard against empty update objects, always using `onConflictDoUpdate`

---

## Implementation Details

### Fix A: Drizzle adapter `upsert()` — guard empty update (Primary Fix)

**File**: `packages/db/src/adapters/drizzle/index.ts` (lines 268-303)

- Added `hasUpdate` check: `const hasUpdate = update && Object.keys(update).length > 0`
- **Postgres/SQLite path**: When `hasUpdate` is false, uses `.onConflictDoNothing({ target: keys })` instead of `.onConflictDoUpdate({ set: {} })`. Falls back to `findOne` when `onConflictDoNothing` returns empty result (conflict occurred).
- **MySQL path**: When `hasUpdate` is false, catches `ER_DUP_ENTRY` errors as no-ops since MySQL doesn't have `INSERT ... ON CONFLICT DO NOTHING` via Drizzle's API.

### Fix B: Kysely adapter `upsert()` — same guard applied

**File**: `packages/db/src/adapters/kysely/index.ts` (lines 240-300)

- Added same `hasUpdate` guard pattern
- **Postgres/SQLite path**: Uses `.onConflict((oc) => oc.column(col).doNothing())` instead of `.doUpdateSet(update)` when empty. Falls back to `findOne` on conflict.
- **MySQL path**: Uses `INSERT IGNORE INTO` raw SQL when update is empty.

### Prisma adapter — not affected

Prisma's `upsert()` natively handles empty `update: {}` gracefully (it simply doesn't update anything), so no change needed.

### Caller (`executeRelate`) — no change needed

The adapter-level fix is more robust since it protects all callers, not just `executeRelate`. The caller continues to pass `update: {}` which is now handled correctly.

---

## Tests Added

### Drizzle adapter test (`packages/db/src/adapters/drizzle/drizzle.test.ts`)

- **`should upsert with empty update (insert-if-not-exists)`**: Verifies upsert with `update: {}` succeeds on first call and is idempotent on second call (does not overwrite existing row).

### Relation mutation tests (`datafn/server/src/execution/mutation/__tests__/relations.test.ts`)

- **`TV-MUT-RELATE-NOMETA-001`**: Relate many-many with bare string (no metadata) succeeds and creates join row.
- **`TV-MUT-RELATE-NOMETA-002`**: Same relate called twice is idempotent — second call is a no-op, does not crash.

---

## Verification Results

| Test Suite | Result |
|---|---|
| `packages/db/src/adapters/drizzle/drizzle.test.ts` | 33 passed, 2 skipped |
| `datafn/server/src/execution/mutation/__tests__/relations.test.ts` | 11 passed |
| `datafn/server/__tests__/sync.test.ts` | 35 passed |

All acceptance criteria met:
- [x] Push a `relate` mutation for many-many with no metadata — succeeds
- [x] Push a `relate` mutation for many-many WITH metadata — still works (regression check)
- [x] Push the same `relate` mutation twice (idempotency) — second push is a no-op
- [x] Join row correctly created in database after push
- [x] Existing sync tests pass
- [x] Existing mutation relation tests pass

---

## Files Modified

| File | Change |
|---|---|
| `packages/db/src/adapters/drizzle/index.ts` | Guard empty update in upsert: use `onConflictDoNothing` / catch `ER_DUP_ENTRY` |
| `packages/db/src/adapters/kysely/index.ts` | Guard empty update in upsert: use `doNothing()` / `INSERT IGNORE` |
| `packages/db/src/adapters/drizzle/drizzle.test.ts` | Added empty-update upsert test |
| `datafn/server/src/execution/mutation/__tests__/relations.test.ts` | Added 2 no-metadata relate tests |
