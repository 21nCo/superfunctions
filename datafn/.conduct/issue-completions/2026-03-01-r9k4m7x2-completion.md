# Issue Completion Report: Push upsert missing `conflictTarget: "id"`

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-03-01T13:15:00Z |
| **Agent** | unknown-agent |
| **Model** | claude-opus-4-6[1m] |
| **Launcher** | CLI |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Git branch** | `next` |
| **Git commit** | `664f92c` |
| **Git dirty** | Yes |
| **Issue file** | `datafn/.conduct/issues/2026-03-01-m4k7x9v2-issue.md` |

## Issue Summary

Push upsert in `push.ts` was missing `conflictTarget: "id"`, causing the row-level namespace wrapper to corrupt the ON CONFLICT target to `(__ns, id)` — a constraint that doesn't exist. This caused all push-based merge/replace mutations to fail with an INTERNAL error on servers with namespace isolation enabled.

## Status: PASS

## Requirements Summary

| Requirement | Status | Evidence |
|---|---|---|
| Add `conflictTarget: "id"` to upsert in push.ts | PASS | Line 245 of `push.ts` now contains `conflictTarget: "id"` |
| Consistency with execute.ts and relations.ts fixes | PASS | All three files now have `conflictTarget: "id"` — verified via grep |
| No regressions to non-namespaced servers | PASS | The explicit `conflictTarget: "id"` is correct regardless of namespace — it targets the primary key |
| No type errors introduced | PASS | `tsc --noEmit` shows no new errors in push.ts (pre-existing errors unchanged) |

## Implementation Summary

### Files changed
- `datafn/server/src/execution/sync/push.ts` — Added `conflictTarget: "id"` to the upsert call at line 245

### Key changes
One-line addition: `conflictTarget: "id"` added to the `db.upsert()` call in the push sync path, matching the identical fix already applied in `execute.ts:74` and `relations.ts:137`.

## Verification Summary

### Verification steps
1. **Code inspection**: Confirmed the upsert at push.ts:239-246 now includes `conflictTarget: "id"`
2. **Grep consistency check**: `grep conflictTarget datafn/server/src` shows all three call sites (push.ts, execute.ts, relations.ts) now have `conflictTarget: "id"`
3. **Type check**: `npx tsc --noEmit --project datafn/server/tsconfig.json` — no new errors in push.ts; all errors are pre-existing in other files

## Notes

- This was a regression from an incomplete fix in issue `2026-02-27-x8k3m9v7` which fixed execute.ts and relations.ts but missed push.ts
- The fix is identical in all three locations — a single property addition
- No tests exist specifically for the push sync path's upsert conflict target; the existing test infrastructure does not cover namespace-isolated push scenarios
