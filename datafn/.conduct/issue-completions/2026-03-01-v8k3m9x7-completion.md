# Issue Completion Report: KV mutation fails with INTERNAL — push upsert conflictTarget mismatch with composite primary key

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-03-01T19:36:00Z |
| **Agent Name** | unknown-agent |
| **Model** | claude-opus-4-6[1m] |
| **Launcher** | Claude Code (Warp) |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Git Branch** | next |
| **Git Commit** | 664f92c |
| **Git Dirty** | Yes |
| **Issue File** | datafn/.conduct/issues/2026-03-01-n4k8v2m7-issue.md |

## Issue Summary

KV mutations pushed via `/datafn/push` fail with `INTERNAL` because the upsert uses `conflictTarget: "id"`, producing PostgreSQL `ON CONFLICT (id)`. The `kv` table has a composite primary key `(__ns, id)`, so PostgreSQL rejects the statement. The row-level namespace wrapper needed to transform `conflictTarget: "id"` to `["__ns", "id"]` before passing to the Drizzle adapter.

## Status: PASS

## Requirements Summary

### Requirement 1: Push upsert uses correct composite conflict target for multi-tenant tables
- **Status:** PASS
- **Evidence:** The namespace wrapper (`packages/db/src/adapter/row-level-namespace.ts` lines 211-217) now augments `conflictTarget` by prepending the namespace column (`__ns`), transforming `"id"` → `["__ns", "id"]`.
- **Test status:** 3 new tests added to `packages/db/src/adapter/__tests__/row-level-namespace.test.ts` (TV-RLN-014):
  - `transforms string conflictTarget to composite [__ns, id]` — PASS
  - `transforms array conflictTarget to prepend __ns` — PASS
  - `does not modify conflictTarget when not provided` — PASS

### Requirement 2: Regular resource mutations (todos, categories) via push still succeed
- **Status:** PASS
- **Evidence:** All 41 sync tests pass (`datafn/server/__tests__/sync.test.ts`), all 14 sync-bounded tests pass, all 8 sync-ordering tests pass.

### Requirement 3: No regressions in namespace wrapper behavior
- **Status:** PASS
- **Evidence:** All 25 namespace wrapper unit tests pass (22 existing + 3 new).

## Implementation Summary

### Files Changed
| File | Change |
|---|---|
| `packages/db/src/adapter/row-level-namespace.ts` | Added conflictTarget augmentation in `upsert` method (lines 211-217) — prepends namespace column to conflictTarget when present |
| `packages/db/src/adapter/__tests__/row-level-namespace.test.ts` | Added 3 new tests (TV-RLN-014) verifying conflictTarget augmentation for string, array, and undefined cases |

### Key Changes
- The `upsert` method in the namespace wrapper now transforms the `conflictTarget` parameter:
  - String `"id"` → Array `["__ns", "id"]`
  - Array `["id", "type"]` → Array `["__ns", "id", "type"]`
  - Undefined → unchanged (no augmentation)
- This ensures `ON CONFLICT (__ns, id)` matches the composite primary key on all multi-tenant tables.

## Verification Summary

### Test Execution Results
```
packages/db/src/adapter/__tests__/row-level-namespace.test.ts — 25 tests passed (0 failed)
datafn/server/__tests__/sync.test.ts — 41 tests passed (0 failed)
datafn/server/__tests__/sync-bounded.test.ts — 14 tests passed (0 failed)
datafn/server/__tests__/sync-ordering.test.ts — 8 tests passed (0 failed)
```

### Verification Steps
1. `npx vitest run packages/db/src/adapter/__tests__/row-level-namespace.test.ts` — 25/25 PASS
2. `npx vitest run datafn/server/__tests__/sync.test.ts` — 41/41 PASS
3. `npx vitest run datafn/server/__tests__/sync-bounded.test.ts datafn/server/__tests__/sync-ordering.test.ts` — 22/22 PASS

## Notes
- The fix was already partially in place as an unstaged change in `row-level-namespace.ts`. This completion verifies it works correctly and adds test coverage.
- The fix uses Fix B from the issue (namespace wrapper transformation) which centralizes the logic in the adapter layer rather than duplicating schema knowledge in push.ts.
- The push handler continues to pass `conflictTarget: "id"` — the namespace wrapper is responsible for augmenting it to match the composite PK. This is the correct layering since the namespace wrapper has full knowledge of the namespace column.
