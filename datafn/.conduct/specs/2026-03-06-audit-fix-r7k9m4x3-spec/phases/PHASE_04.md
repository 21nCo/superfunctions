# PHASE_04: Mutation Handler Parity

## Phase Goal
Enhance the Python mutation handler with merge decision logic, replace record logic, batch inserts, error classification, field validation, change tracking integration, and prototype pollution protection.

## In Scope
- Merge decision (create vs update) based on record existence
- Replace record logic (preserve system fields)
- Batch insert via `records[]`
- Error classification (map DB errors to codes)
- Field type validation on records
- Required field validation for inserts
- Default value application
- Prototype pollution check on all incoming records
- Change tracking integration in mutation path
- Idempotent delete (no change tracking for non-existent records)
- Mutation result structure normalization

## Out of Scope
- Guard transaction wrapping (Phase 5)
- Sync integration (Phase 6)

## Deliverables

### Modified files
1. `datafn/python/datafn/handlers/mutation.py` — Major enhancement

### Test files
2. `datafn/python/tests/test_mutation_enhanced.py` — Comprehensive mutation tests

## Requirements Covered
- MUT-001, MUT-002, MUT-003, MUT-004, MUT-005, MUT-006, MUT-007, MUT-008
- VAL-004, VAL-005, VAL-006, VAL-007, VAL-009

## Implementation Tasks

1. [ ] Add prototype pollution check at mutation entry:
   - Import `check_prototype_pollution` from `utils.validate_fields`
   - Call on `record` and each item in `records[]` before any processing
   - Return `DFQL_INVALID` error if pollution detected
2. [ ] Add ID length validation:
   - Check `mutation.id` length against `maxIdLength`
   - Return `DFQL_INVALID` if exceeded
3. [ ] Add field type validation:
   - Import `validate_record_types` from `validation`
   - Call after prototype pollution check
   - Return `DFQL_INVALID` with field-specific error message on failure
4. [ ] Implement merge decision logic:
   - For `operation: "merge"`:
     - Check if record with `id` exists via `db.find_one()`
     - If exists → update path (partial merge, no required field check)
     - If not exists → insert path (validate required fields, apply defaults)
   - For insert path: call `validate_required_fields()` and `apply_defaults()`
5. [ ] Implement replace record logic:
   - For `operation: "replace"`:
     - Fetch existing record
     - Build new record with all schema fields
     - For each schema field NOT in incoming record, set to `null` or field default
     - Preserve system fields (id, createdAt, createdBy, updatedAt, updatedBy)
     - Strip incoming values for readonly fields
     - Use `db.update()` with full new record
6. [ ] Implement batch insert via `records[]`:
   - Check for `records` key (list) in mutation payload
   - Validate batch size against `maxBatchSize`
   - Iterate and insert each record
   - Collect all `affectedIds`
   - Each record validated independently
7. [ ] Implement error classification:
   - Wrap `db.create()`, `db.update()`, `db.delete()` calls in try/except
   - Call `classify_error(exception)` from envelope module
   - Map to appropriate error code in mutation result
8. [ ] Implement change tracking in mutations:
   - After successful insert/merge/replace/delete, call `write_change()`
   - Pass namespace, table name, operation, record ID
   - Skip change tracking for deduped (idempotent) mutations
   - Skip change tracking for delete of non-existent records
9. [ ] Implement idempotent delete:
   - For `operation: "delete"`:
     - Check if record exists before deleting
     - If not exists: return `ok: true, affectedIds: []` (no error, no change tracking)
     - If exists: delete normally, write change tracking
10. [ ] Normalize mutation result structure:
    - Ensure result always has: `ok`, `mutationId`, `affectedIds`, `deduped`, `errors`
    - `deduped` is `True` when idempotency cache hit
    - `errors` is always a list (empty on success, error entries on partial failure for batch)
11. [ ] Update `validate_record_keys()` call to use `writable_fields` from enhanced SchemaIndex
12. [ ] Write comprehensive tests:
    - Merge decision: create on non-existent, update on existing
    - Replace: preserves system fields, nulls missing fields
    - Batch insert: multiple records, respects batch size limit
    - Error classification: duplicate key → CONFLICT
    - Field type validation: string field rejects number
    - Required field: insert without required field fails
    - Default values: missing field gets default on insert
    - Prototype pollution: __proto__ key rejected
    - ID length: oversized ID rejected
    - Change tracking: insert writes change record
    - Idempotent delete: non-existent delete succeeds without change tracking
    - Result structure: always has ok, mutationId, affectedIds, deduped, errors

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_mutation_enhanced.py -v
```

**Expected outcomes:**
- Merge decision correctly chooses create vs update
- Replace preserves system fields
- Batch insert works for multiple records
- Error classification maps DB errors correctly
- Type validation rejects wrong types
- Required fields validated for inserts only
- Defaults applied for inserts
- Prototype pollution blocked
- Change tracking written for successful mutations
- Idempotent delete succeeds without change tracking
- Result structure matches spec

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing mutation tests pass (no regressions)

## Stop Condition
- Mutation handler validates types, required fields, applies defaults
- Merge decision and replace logic work correctly
- Batch inserts supported
- Change tracking integrated
- Error classification deterministic
- Ready for Phase 5 (transaction fixes) and Phase 6 (sync integration)
