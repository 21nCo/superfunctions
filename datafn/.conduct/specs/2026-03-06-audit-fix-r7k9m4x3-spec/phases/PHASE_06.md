# PHASE_06: Sync Handler Parity

## Phase Goal
Enhance the sync handler with date coercion in push, cursor validation in pull, pull limit enforcement, join table sync, and namespace consistency across all sync operations.

## In Scope
- Push: date field coercion to epoch ms
- Pull: cursor format validation
- Pull: limit enforcement with `hasMore` flag
- Pull: join table changes included
- Namespace: consistent parameter passing in all adapter calls

## Out of Scope
- Reconciliation (deferred — TS feature)
- Push: capability field injection (capabilities spec)

## Deliverables

### Modified files
1. `datafn/python/datafn/handlers/sync.py` — Enhancements

### Test files
2. `datafn/python/tests/test_sync_enhanced.py` — Enhanced sync tests

## Requirements Covered
- SYN-001, SYN-002, SYN-003, SYN-004, SYN-005

## Implementation Tasks

1. [ ] Add date coercion in push handler:
   - Import `coerce_date_fields_to_epoch` from `utils.date`
   - Before processing each push mutation, get date fields from SchemaIndex
   - Call `coerce_date_fields_to_epoch(record, date_fields)` on mutation records
   - Handle relation metadata records as well
2. [ ] Add cursor validation in pull handler:
   - For each cursor in pull request:
     - Validate cursor is a string representation of a non-negative integer
     - Return `DFQL_INVALID` error with specific message for invalid cursors
   - Use `int(cursor_str)` with try/except for validation
3. [ ] Add pull limit enforcement:
   - Read `maxPullLimit` from config (default 5000)
   - When fetching changes: fetch `maxPullLimit + 1` changes
   - If more than `maxPullLimit` changes exist:
     - Return only `maxPullLimit` changes
     - Set `hasMore: true` in response
     - Client uses returned cursor to paginate remaining changes
   - Add `hasMore` field to pull response
4. [ ] Add join table sync in pull:
   - Import `get_join_table_name`, `enumerate_join_store_keys` from `utils.joins`
   - In pull handler: enumerate all many-many join tables from schema
   - Include join table cursors in the cursor map
   - Fetch join table changes alongside resource table changes
   - Include join table upserts/deletes in response
5. [ ] Fix namespace consistency:
   - Audit ALL adapter calls in sync.py
   - Ensure every `db.find_many()`, `db.find_one()`, `db.create()`, `db.update()`, `db.delete()` includes `namespace` parameter
   - Extract namespace from request context or use default "datafn"
   - Pass namespace to `get_changes_since()` and `write_change()` calls
6. [ ] Write tests:
   - Push date coercion: ISO string → epoch ms in record
   - Pull cursor validation: valid cursor passes, "abc" cursor fails, negative cursor fails
   - Pull limit: returns maxPullLimit changes with hasMore=true when more exist
   - Pull limit: returns all when fewer than maxPullLimit changes
   - Join table sync: relate creates join table change, pull includes it
   - Namespace: verify namespace passed to adapter calls

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_sync_enhanced.py -v
```

**Expected outcomes:**
- Push correctly coerces date fields to epoch ms
- Pull rejects invalid cursor formats
- Pull enforces limit and sets hasMore correctly
- Pull includes join table changes
- All adapter calls include namespace parameter

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing sync tests pass (no regressions)

## Stop Condition
- Sync handler properly handles dates, validates cursors, enforces limits
- Join tables are synced
- Namespace is consistent
- Ready for Phase 7 (integration)
