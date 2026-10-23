# PHASE_05: Transaction Handler Fixes

## Phase Goal
Fix the transaction handler to properly wrap atomic transactions and annotate rolled-back results, and integrate guard transaction wrapping.

## In Scope
- Proper atomic transaction wrapping
- Rollback annotation on prior successful results
- Guard + mutation transaction wrapping
- Non-atomic mode correctness

## Out of Scope
- Change tracking within transactions (already handled by mutation handler)

## Deliverables

### Modified files
1. `datafn/python/datafn/handlers/transact.py` — Fixes
2. `datafn/python/datafn/handlers/mutation.py` — Guard transaction wrapping
3. `datafn/python/datafn/guards.py` — Transaction-aware guard evaluation

### Test files
4. `datafn/python/tests/test_transact_enhanced.py` — Enhanced transaction tests

## Requirements Covered
- TXN-001, TXN-002, MUT-007

## Implementation Tasks

1. [ ] Fix atomic transaction wrapping in `handle_transact()`:
   - When `atomic: true` (default):
     - Open `db.transaction()` context manager
     - Execute all steps within the transaction
     - On first mutation error: raise to trigger rollback
     - Annotate prior successful mutation results with `rolledBack: True`
     - Return results with rollback annotations
   - Pass the transaction-wrapped adapter to step handlers
2. [ ] Implement rollback annotation:
   - Track list of completed step results
   - On error in atomic mode:
     - For each prior mutation result, add `"rolledBack": True`
     - Query results are NOT marked as rolled back (queries don't mutate)
     - Add the error result as the final entry
3. [ ] Fix non-atomic mode:
   - When `atomic: false`:
     - Execute each step independently
     - On step error: record error, continue to next step
     - Return all results (successes + errors)
     - No rollback annotations
4. [ ] Implement guard transaction wrapping in mutation handler:
   - When mutation has `if` guard AND adapter supports `transaction()`:
     - Open transaction
     - Evaluate guard (read record)
     - If guard passes: execute mutation
     - If guard fails: rollback, return CONFLICT error
     - Commit on success
   - When adapter doesn't support transaction:
     - Evaluate guard (read record)
     - Execute mutation sequentially
     - Document TOCTOU risk in code comment
5. [ ] Update `guards.py` to accept optional transaction context:
   - `evaluate_guard(db, resource, id, condition, namespace, tx_db=None)`:
     - Use `tx_db` if provided, else `db` for the read
6. [ ] Write tests:
   - Atomic commit: 3 steps, all succeed
   - Atomic rollback: 3 steps, step 2 fails → step 1 marked rolledBack
   - Non-atomic partial: 3 steps, step 2 fails → step 1 committed, step 3 attempted
   - Guard with transaction: guard fails → mutation not executed
   - Guard without transaction: sequential execution

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_transact_enhanced.py -v
```

**Expected outcomes:**
- Atomic transactions roll back all changes on error
- Rolled-back results have `rolledBack: True`
- Non-atomic transactions continue on errors
- Guard + mutation are atomic when adapter supports transactions

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing transaction tests pass (no regressions)

## Stop Condition
- Atomic transactions properly wrap and roll back
- Rollback annotations appear on prior results
- Guards are transaction-safe
- Ready for Phase 7 (integration)
