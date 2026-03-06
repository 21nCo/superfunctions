# PHASE_00: Pass Logger to Existing Function Signatures + Outer Catch Logging

## Phase Goal

Pass `logger` to the 3 execution functions that already accept it as a parameter but aren't receiving it from their route handler callers. Also add logging to the `executeMutationCore` outer catch block.

## In Scope

- LOG-001: Pass `logger` to `executeMutation()` in `mutation.ts`
- LOG-002: Pass `logger` to `executeTransaction()` in `transact.ts`
- LOG-003: Pass `logger` to `executeReconcile()` in `sync.ts`
- LOG-007: Add `logger?.error()` to outer catch in `execute.ts:183-185`

## Out of Scope

- Adding new `logger` parameters to functions that don't have them yet (PHASE_01)
- Adding logging to catch blocks in execution functions (PHASE_02)

## Deliverables

| File | Change |
|------|--------|
| `datafn/server/src/routes/mutation.ts` | Append `logger` arg to `executeMutation()` call (~line 143) |
| `datafn/server/src/routes/transact.ts` | Append `logger` arg to `executeTransaction()` call (~line 193) |
| `datafn/server/src/routes/sync.ts` | Append `logger` arg to `executeReconcile()` call (~line 485) |
| `datafn/server/src/execution/mutation/execute.ts` | Add `logger?.error(...)` to outer catch (~line 183-185) |

## Requirements Covered

LOG-001, LOG-002, LOG-003, LOG-007

## Implementation Tasks

1. [ ] Open `datafn/server/src/routes/mutation.ts`. Find the `executeMutation()` call around line 134-143. Append `logger` as the last argument (after `namespace`).
2. [ ] Open `datafn/server/src/routes/transact.ts`. Find the `executeTransaction()` call around line 184-193. Append `logger` as the last argument (after `plugins`).
3. [ ] Open `datafn/server/src/routes/sync.ts`. Find the `executeReconcile()` call around line 479-485. Append `logger` as the last argument (after `sequenceStore`).
4. [ ] Open `datafn/server/src/execution/mutation/execute.ts`. Find the outer catch block at ~line 183-185. Add before the `opResult =` line:
   ```typescript
   logger?.error("Unexpected mutation error", {
     error: String(error),
     operation: (mutation as any).operation,
     resource: mutation.resource,
   });
   ```
5. [ ] Run `npx vitest run datafn/server` — all tests must pass.
6. [ ] Run TypeScript check: verify no compilation errors with the added arguments.

## Verification Steps

1. `npx vitest run datafn/server` — all existing tests pass (no regressions).
2. Grep to verify all 3 calls now include logger:
   - `grep -n "executeMutation(" datafn/server/src/routes/mutation.ts` — should show `logger` in the call
   - `grep -n "executeTransaction(" datafn/server/src/routes/transact.ts` — should show `logger` in the call
   - `grep -n "executeReconcile(" datafn/server/src/routes/sync.ts` — should show `logger` in the call
3. Grep to verify outer catch has logging:
   - `grep -A2 "} catch (error: any)" datafn/server/src/execution/mutation/execute.ts` — should show `logger?.error`

## Expected Outcomes

- Mutation route errors are now logged via `executeMutationCore`'s existing `logger?.error()` calls.
- Transaction route errors are now logged.
- Reconcile route errors are now logged (once catch blocks are updated in PHASE_02).
- Outer mutation catch now logs unexpected errors.

## Stop Condition

Report: all 4 files modified, all tests pass, grep verification confirms changes.
