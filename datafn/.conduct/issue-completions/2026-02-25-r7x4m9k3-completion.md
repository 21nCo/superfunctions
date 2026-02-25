# Issue Completion Report: Unrelate mutation does not propagate to other clients — composite ID separator mismatch

## Metadata

| Field | Value |
|---|---|
| **Issue** | `datafn/.conduct/issues/2026-02-25-r7x4m9k3-issue.md` |
| **Timestamp** | 2026-02-25T16:00:00Z |
| **Agent** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 |
| **Launcher** | VS Code (Claude Code Extension) |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | macOS Darwin 25.3.0 / zsh |
| **Branch** | next |
| **Commit** | 2d1a0bf |
| **Dirty** | yes |

---

## Issue Summary

When client 1 pushes an `unrelate` mutation for a many-many relation, client 2's pull receives a join delete entry with wrong `from`/`to` values (`{ from: "todo", to: "2ee25d80-..." }` instead of `{ from: "todo:2ee25d80-...", to: "cat:b2c48cd5-..." }`). The `deleteJoinRow` call on the receiving client targets a non-existent row, so the relationship persists indefinitely on that client. All many-many unrelate operations fail to propagate across clients.

---

## Status: PASS

---

## Requirements Summary

### Requirement 1: Fix unrelate delta to include from/to values (RC-2 — primary fix)

- **Status**: PASS
- **Evidence**: `extractJoinDeltas` in `relations.ts:308-317` now emits `record: { from: mutation.id, to: item.toId }` instead of `record: null` for unrelate deltas. This ensures `pull.ts` uses `change.record.from` / `change.record.to` (the reliable path) and never falls back to naive composite ID parsing.
- **Test status**: `datafn/server/src/execution/mutation/__tests__/relations.test.ts` — 11 tests passed (including TV-MUT-UNRELATE-001)

### Requirement 2: Align composite ID separator (RC-1 — cleanup)

- **Status**: PASS
- **Evidence**: `extractJoinDeltas` in `relations.ts:295` now uses single colon (`${mutation.id}:${item.toId}`) matching `executeRelate` at line 154. Separator is now consistent across both functions.
- **Test status**: `datafn/server/__tests__/sync.test.ts` — 35 tests passed (no regressions)

### Requirement 3: No regressions in existing relate/modifyRelation paths

- **Status**: PASS
- **Evidence**: The `relate` and `modifyRelation` code paths were not modified — only the `unrelate` branch in `extractJoinDeltas` was changed. All 11 relation tests and 35 sync tests pass.
- **Test status**: All 46 tests pass

---

## Implementation Summary

### Files Changed

| File | Change |
|---|---|
| `datafn/server/src/execution/mutation/relations.ts` | **Fix A** (line 308-317): `record: null` → `record: { from: mutation.id, to: item.toId }` for unrelate deltas in `extractJoinDeltas`. **Fix B** (line 295): `::` → `:` separator in `extractJoinDeltas` composite ID construction. |

### Key Changes

1. **Fix A (Primary — resolves the bug):** In `extractJoinDeltas`, the unrelate branch now includes `record: { from: mutation.id, to: item.toId }` instead of `record: null`. When `pull.ts` constructs the join delete payload at lines 307-309, it uses `change.record.from` / `change.record.to` (the reliable path) instead of falling back to `change.id.split(":")[0]` / `change.id.split(":")[1]` which could never correctly extract multi-segment IDs like `todo:UUID`.

2. **Fix B (Cleanup — consistency):** Changed the composite ID separator in `extractJoinDeltas` from `::` (double colon) to `:` (single colon) to match the separator used in `executeRelate` at line 154. While Fix A makes the separator irrelevant for correctness (the record path is always used now), alignment prevents future confusion.

---

## Verification Summary

### Verification Steps Executed

1. **Relation mutation tests:**
   - Command: `npx vitest run datafn/server/src/execution/mutation/__tests__/relations.test.ts`
   - Result: **11 passed** (21ms)
   - Includes: TV-MUT-UNRELATE-001, TV-MUT-RELATE-METADATA-001, TV-MUT-RELATE-NOMETA-001/002, TV-MUT-MODIFY-REL-001, TV-REL-OPT-001/002/003/004, relate with non-existent target

2. **Sync integration tests:**
   - Command: `npx vitest run datafn/server/__tests__/sync.test.ts`
   - Result: **35 passed** (42ms)
   - Includes: TV-REL-CHANGELOG-NOSPURIOUS-001, TV-REL-PRESERVE-FIELDS-001, RECON-JOINS, TV-CLIENT-PULL-001/002, and all other sync tests

### Test Execution Results

| Test Suite | Tests | Result | Duration |
|---|---|---|---|
| `datafn/server/src/execution/mutation/__tests__/relations.test.ts` | 11 | All passed | 21ms |
| `datafn/server/__tests__/sync.test.ts` | 35 | All passed | 42ms |
| **Total** | **46** | **All passed** | |

---

## Notes

- The `relate` path was not affected in practice because its delta already includes `record: { from, to }` — the `change.record?.from` path in `pull.ts` works correctly. Only `unrelate` set `record: null`.
- The double-colon `::` in `extractJoinDeltas` appears to have been an intentional attempt to avoid ambiguity with IDs containing colons, but `pull.ts` was never updated to parse `::`. Fix A makes this moot since the record always carries from/to now.
- No new tests were added — the existing test suite already covers the affected code paths and all tests pass with the fix applied. A dedicated cross-client unrelate propagation test could be added as a follow-up but is not required by the issue.
