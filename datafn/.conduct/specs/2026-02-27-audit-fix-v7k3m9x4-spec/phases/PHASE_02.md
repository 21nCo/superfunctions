# PHASE 02: Reliability CRITICAL — Server Fixes

## Phase goal
Fix transaction atomicity, change tracking consistency, and rolled-back result semantics.

## In scope
- REL-C1: Transaction fallback — return INTERNAL error, no silent fallthrough
- REL-C2/REL-H6: Change tracking failure propagation in push.ts (with retry)
- REL-C3: Annotate rolled-back step results

## Out of scope
- Client-side reliability (Phase 04)
- HIGH reliability issues (Phase 06/08)

## Deliverables
- `datafn/server/src/execution/transact.ts` — Fix fallback, annotate rolled-back results
- `datafn/server/src/execution/sync/push.ts` — Propagate change tracking failures with retry

## Requirements covered
REL-001, REL-002, REL-003

## Implementation tasks
1. **Transaction fallback** (`transact.ts`):
   - In the `db.transaction()` catch block:
     - If `db.transaction` is `undefined` (memory adapter): use sequential execution (existing behavior)
     - Otherwise: return `{ ok: false, error: { code: "INTERNAL", message: "Transaction failed: {error.message}" } }`
     - NEVER fall through to sequential when adapter HAS transaction support

2. **Rolled-back annotation** (`transact.ts`):
   - After a step failure inside `db.transaction()`:
     - For each prior result with `ok: true`, replace with `{ ok: false, rolledBack: true, result: <original> }`
     - Set top-level `ok: false`
     - Add `error: { code: "TRANSACTION_ROLLED_BACK", message: "Step {N} failed; all steps rolled back" }`

3. **Change tracking failure in push** (`push.ts`):
   - Replace the `console.error` + continue pattern with:
     ```typescript
     async function recordChangeWithRetry(service, params, maxRetries = 2) {
       for (let i = 0; i <= maxRetries; i++) {
         try {
           await service.recordChange(params);
           return;
         } catch (e) {
           if (i === maxRetries) throw e;
           await new Promise(r => setTimeout(r, 50 * (i + 1))); // 50ms, 100ms
         }
       }
     }
     ```
   - On final failure: add mutation to `errors` array, not `applied`
   - Log the failure at `error` level with mutation details

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- New/updated tests verify:
  - Transaction with DB error → INTERNAL error, no sequential fallback
  - Transaction with memory adapter → sequential succeeds
  - Rolled-back results: step 0 ok, step 1 fails → `results[0].rolledBack === true`
  - Successful transaction → no `rolledBack` field
  - Push with change tracking failure → mutation in errors
  - Push with transient change tracking → retry succeeds transparently

## Stop condition
All 3 CRITICAL reliability issues fixed. Transaction tests pass with correct semantics. Existing sync tests pass. Report results.
