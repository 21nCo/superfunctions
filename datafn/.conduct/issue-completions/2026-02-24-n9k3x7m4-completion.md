# Issue Completion Report: Relate/unrelate spurious upsert with only `{id}`

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-24T08:25:00Z |
| **Agent Name** | Oz |
| **Model** | claude 4.6 sonnet (max) |
| **Launcher** | Warp |
| **Workspace Path** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | MacOS / zsh 5.9 |
| **Git Branch** | `next` |
| **Git Commit** | `2d1a0bf847258ca5811d604fc481aa59bd0e31a0` |
| **Git Dirty** | yes |
| **Issue File** | `datafn/.conduct/issues/2026-02-24-r7k3m9x4-issue.md` |

## Issue Summary

When a client pushed a `relate`, `unrelate`, or `modifyRelation` mutation, the server's change-tracking code recorded a changelog entry for the **primary resource** with `op: "upsert"` and a record containing **only `{ id }`**. This caused other clients pulling changes to have their full records overwritten with just `{ id }`, destroying all field data (name, completed, etc.) — silent data loss on every client that pulled a relation mutation from another client.

Root causes were in two locations:
1. `push.ts` (lines 456–478) — change tracking in the sync push path
2. `execute.ts` (lines 370–394) — change tracking in the standalone mutation path

Both paths fell back to `"upsert"` op for relation mutations and used `mut.record || {}` which is always empty for relation operations, producing `{ id }` stubs.

## Status: PASS

## Requirements Summary

| Requirement | Status | Evidence |
|---|---|---|
| many-many relate: no id-only stub in pull `records[]` | PASS | `TV-REL-NOSPURIOUS-001` passes |
| many-many unrelate: no id-only stub in pull `records[]` | PASS | `TV-REL-NOSPURIOUS-002` passes |
| many-many modifyRelation: no id-only stub | PASS | `modifyRelation` skips primary resource change via same code path |
| many-one relate: FK propagates as `merge` delta in `merged[]` | PASS | `TV-REL-MANYOONE-FK-001` passes |
| many-one unrelate: FK cleared as `merge` delta (`{ id, fkField: null }`) | PASS | `TV-REL-MANYOONE-UNRELATE-001` passes |
| Join table changes still propagate correctly | PASS | `TV-REL-001`, `TV-REL-002` still pass |
| Changelog has no spurious upsert entry | PASS | `TV-REL-CHANGELOG-NOSPURIOUS-001` passes |
| End-to-end: other clients don't get corrupted records | PASS | `TV-REL-PRESERVE-FIELDS-001` passes |
| Standalone `executeMutation` path (execute.ts) also fixed | PASS | Same fix applied; covered by relation mutation tests via `/datafn/mutation` endpoint |
| Existing insert/replace/merge/delete mutations unaffected | PASS | All 27 pre-existing sync tests pass |

## Test Status

**New tests added (all passing):**
- `TV-REL-NOSPURIOUS-001`: many-many relate does NOT produce id-only stub in pull records
- `TV-REL-NOSPURIOUS-002`: many-many unrelate does NOT produce id-only stub in pull records
- `TV-REL-MANYOONE-FK-001`: many-one relate produces FK merge delta in pull merged
- `TV-REL-MANYOONE-UNRELATE-001`: many-one unrelate clears FK via merge delta
- `TV-REL-CHANGELOG-NOSPURIOUS-001`: relate does NOT record op=upsert with {id} stub in changelog
- `TV-REL-PRESERVE-FIELDS-001`: other clients pulling after relate keep their full record intact

**Test execution:** `npx vitest run __tests__/sync.test.ts` → **33/33 passed**
**Relation tests:** `npx vitest run src/execution/mutation/__tests__/relations.test.ts` → **5/5 passed**

## Implementation Summary

### Files Changed

**Modified:**
- `datafn/server/src/execution/mutation/relations.ts` — Added two exported helper functions: `extractJoinDeltas` (moved logic from push.ts) and `extractRelationFkDeltas` (new: generates targeted merge deltas for many-one/one-many FK changes)
- `datafn/server/src/execution/sync/push.ts` — Removed local `extractJoinDeltas` and unused `findRelation`/`normalizeRelationPayload`. Replaced change tracking block: relation mutations now dispatch via `extractRelationFkDeltas` + `extractJoinDeltas` instead of recording a spurious primary resource upsert
- `datafn/server/src/execution/mutation/execute.ts` — Same fix: replaced change tracking block for relation mutations
- `datafn/server/__tests__/sync.test.ts` — Added 6 new regression test cases

### Key Changes

1. **`extractJoinDeltas(mutation, schema)`** (new export in `relations.ts`): extracts many-many join row change events — moved from push.ts to be shared with execute.ts.

2. **`extractRelationFkDeltas(mutation, schema)`** (new export in `relations.ts`): for many-one/one-many relations, returns `{ op: "merge", resource, id, record: { id, [fkField]: value } }` deltas. For many-many and `modifyRelation`, returns empty (join deltas handle those). This ensures FK changes propagate as partial `merge` ops rather than full-replacement `upsert` ops.

3. **Change tracking path (push.ts + execute.ts)**: For `relate`/`modifyRelation`/`unrelate`, the code now:
   - Skips the primary resource `upsert` entry entirely
   - Records FK merge deltas via `extractRelationFkDeltas` (for many-one/one-many)
   - Records join row deltas via `extractJoinDeltas` (for many-many)
   - For regular mutations (insert/merge/replace/delete): unchanged behavior

## Verification Summary

```
npx vitest run __tests__/sync.test.ts
→ 33 tests passed (0 failed)

npx vitest run src/execution/mutation/__tests__/relations.test.ts
→ 5 tests passed (0 failed)
```

Pre-existing failures (7 test files, 16 tests) confirmed to be unrelated to this fix — present before and after changes, involving query execution, DFQL select/aggregate/filter/transaction tests.

## Notes

- The fix follows **Fix Option A** from the issue: skip primary resource change for many-many; record targeted merge deltas for many-one/one-many
- The `extractJoinDeltas` helper was originally private to `push.ts`; moving it to `relations.ts` also fixes a secondary omission where `execute.ts` was not recording join deltas at all for many-many mutations via the `/datafn/mutation` endpoint
- `modifyRelation` is skipped by `extractRelationFkDeltas` because it only applies to many-many relations (schema-enforced), so join deltas alone suffice
- Client-side `apply.ts` requires no changes — `merged[]` is already handled by `mergeRecord()` (added in a prior fix); the pull protocol already has `merged` support for propagating partial updates
- No public API changes — only internal change tracking behavior modified
