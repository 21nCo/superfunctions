# Completion Report: PostgreSQL column name case-folding causes serverSeq to always return 1

## Metadata

| Field | Value |
|---|---|
| **Issue ID** | 2026-02-18-k9x3m7p2-issue |
| **Timestamp** | 2026-02-19T05:55:00Z |
| **Agent** | Claude Opus 4.6 |
| **Launcher** | VS Code (Claude Code Extension) |
| **Status** | **Completed** |

---

## Summary

Fixed a critical PostgreSQL bug where `getNextServerSeq()` always returned `1` due to column name case-folding, causing duplicate key violations on `__datafn_changes` after the first mutation per resource+id. Also fixed a secondary CAS (Compare-And-Swap) bug where the update return value was never checked.

---

## Root Causes Addressed

### Root Cause 1: PostgreSQL column name case-folding (FIXED)

**Problem:** Internal table column definitions used camelCase names (e.g., `nextServerSeq`, `serverSeq`, `recordId`, `createdAt`). PostgreSQL folds unquoted identifiers to lowercase, so `SELECT *` returns `nextserverseq` but code accessed `meta.nextServerSeq` — always `undefined`, falling back to `1`.

**Fix:** Converted all internal table column names from camelCase to snake_case (`next_server_seq`, `server_seq`, `record_id`, `created_at`, etc.). Snake_case names are already lowercase, so PostgreSQL case-folding has no effect.

### Root Cause 2: CAS update return value not checked (FIXED)

**Problem:** The `internal.update()` call in the CAS retry loop returned `Promise<number>` (affected row count) but the value was discarded. A 0-row update (CAS miss) silently returned a stale sequence.

**Fix:** Added `const affected = await this.db.internal.update(...)` and `if (affected === 0) { continue; }` to properly retry on CAS miss.

### Root Cause 3: All camelCase columns affected (FIXED)

**Problem:** All internal tables (`__datafn_meta`, `__datafn_changes`, `__datafn_idempotency`, `__datafn_seed`) used camelCase column names.

**Fix:** Updated all column definitions and all property accesses across the codebase.

---

## Files Modified

| File | Changes |
|---|---|
| `datafn/server/src/execution/internal-tables.ts` | Converted all column names to snake_case |
| `datafn/server/src/execution/sync/change-tracking.ts` | Updated all column property accesses to snake_case; added CAS affected-row check |
| `datafn/server/src/execution/sync/sequence-store.ts` | Updated `DatabaseSequenceStore` column accesses to snake_case; added CAS affected-row check |
| `datafn/server/src/execution/idempotency-db.ts` | Updated `client_id`, `mutation_id`, `created_at` column accesses |
| `datafn/server/src/routes/seed.ts` | Updated `seed_id`, `created_at` column accesses |
| `datafn/server/__tests__/sync.test.ts` | Updated `orderBy: "server_seq"` in direct internal store query |

---

## Column Name Mapping

| Old (camelCase) | New (snake_case) | Table(s) |
|---|---|---|
| `nextServerSeq` | `next_server_seq` | `__datafn_meta` |
| `serverSeq` | `server_seq` | `__datafn_changes` |
| `recordId` | `record_id` | `__datafn_changes` |
| `createdAt` | `created_at` | `__datafn_changes`, `__datafn_idempotency`, `__datafn_seed` |
| `clientId` | `client_id` | `__datafn_idempotency` |
| `mutationId` | `mutation_id` | `__datafn_idempotency` |
| `seedId` | `seed_id` | `__datafn_seed` |

---

## Verification

### Tests Passed

- `datafn/server/__tests__/sync.test.ts` — **17/17 passed** (push, pull, clone, reconcile, relations, idempotency)
- `datafn/server/src/execution/mutation/__tests__/relations.test.ts` — **5/5 passed**
- `packages/db/src/adapters/drizzle/drizzle.test.ts` — **32/32 passed** (2 skipped)

### Migration Note

Existing PostgreSQL databases with `__datafn_meta`, `__datafn_changes`, `__datafn_idempotency`, and `__datafn_seed` tables will need their columns renamed or tables dropped and recreated. Since these are internal tracking tables (not user data), dropping and recreating is acceptable during development:

```sql
DROP TABLE IF EXISTS __datafn_meta;
DROP TABLE IF EXISTS __datafn_changes;
DROP TABLE IF EXISTS __datafn_idempotency;
DROP TABLE IF EXISTS __datafn_seed;
```

The tables will be auto-recreated with correct snake_case columns on next server start via `ensureTable()`.

---

## Blockers

None — all fixes implemented and verified.
