# PHASE_03: Query Handler Parity

## Phase Goal
Rewrite the Python query handler to support cursor pagination (forward/backward), offset, limit enforcement, count, aggregation, select/omit, and default sort — matching TypeScript query execution.

## In Scope
- Forward cursor pagination (`cursor.after`)
- Backward cursor pagination (`cursor.before`)
- `nextCursor` computation
- Offset pagination
- Limit enforcement (`maxLimit` clamping)
- Count queries (`count: true`)
- Aggregation queries (`groupBy`, `aggregations`, `having`)
- Select/omit field filtering
- Default sort (`id:asc` when no sort)
- Sort validation for cursor pagination (id as final field)
- Query limit enforcement (maxSelectTokens, maxSortFields, etc.)

## Out of Scope
- Search plugin integration (deferred)
- Query pushdown/classification (deferred — all in-memory)
- Relation expansion in select (deferred)

## Deliverables

### Modified files
1. `datafn/python/datafn/handlers/query.py` — Major rewrite

### Test files
2. `datafn/python/tests/test_query_enhanced.py` — Comprehensive query tests

## Requirements Covered
- QRY-001, QRY-002, QRY-003, QRY-004, QRY-005, QRY-006, QRY-007, QRY-008, QRY-009
- SORT-003
- SEL-002
- VAL-008 (query limits enforcement)

## Implementation Tasks

1. [ ] Refactor `_handle_single_query()` to use new utility functions:
   - Import `parse_sort_terms`, `sort_records` from `utils.sort`
   - Import `apply_select`, `apply_omit` from `utils.select`
   - Import `calculate_aggregation` from `utils.aggregate`
   - Import `normalize_filter_ops` from `filters`
2. [ ] Add default sort enforcement:
   - If `sort` is not provided or empty, set `sort = ["id"]`
   - Parse sort terms using `parse_sort_terms()`
3. [ ] Add query limit validation:
   - Check `select` count against `maxSelectTokens`
   - Check `sort` count against `maxSortFields`
   - Check filter keys against `maxFilterKeysPerLevel`
   - Check `aggregations` count against `maxAggregations`
   - Return `LIMIT_EXCEEDED` error on violation
4. [ ] Add limit clamping:
   - If `limit` > `maxLimit`, clamp to `maxLimit`
   - If no `limit`, use `maxLimit` as default
5. [ ] Implement filter normalization:
   - Call `normalize_filter_ops()` on incoming filters before evaluation
6. [ ] Implement in-memory filtering:
   - After DB fetch, apply `evaluate_filter()` to filter records
7. [ ] Implement in-memory sorting:
   - Call `sort_records(records, parsed_sort_terms)` after filtering
8. [ ] Implement count:
   - If `count: true`, compute `total_count = len(filtered_records)` before pagination
   - Include `count` in response
9. [ ] Implement offset pagination:
   - After sorting, skip `offset` records: `records = records[offset:]`
10. [ ] Implement forward cursor pagination (`cursor.after`):
    - Validate sort includes `id` as final field (or auto-append)
    - Find position in sorted records where sort values > cursor values
    - Use composite comparison: compare each sort field in order
    - Take `limit + 1` records from cursor position
11. [ ] Implement backward cursor pagination (`cursor.before`):
    - Find position where sort values < cursor values
    - Take last `limit` records before cursor position
    - Return in original sort order
12. [ ] Implement `nextCursor` computation:
    - Fetch `limit + 1` records
    - If got > `limit`, there are more records
    - Build cursor from last returned record's sort field values
    - Return cursor dict or `None`
13. [ ] Implement aggregation queries:
    - If `groupBy` is present:
      - Group filtered records by groupBy field values
      - For each group, compute requested aggregations
      - Apply `having` filter to groups
      - Return aggregated data
    - If only `aggregations` (no `groupBy`):
      - Compute aggregations over entire result set
      - Return single result row
14. [ ] Implement select/omit:
    - After pagination, apply `apply_select()` or `apply_omit()`
    - Validate select and omit are not both present
15. [ ] Build final response:
    - `{"ok": true, "result": {"data": records, "nextCursor": cursor_or_null}}`
    - Add `count` if requested
16. [ ] Write comprehensive tests:
    - Default sort (no sort → id:asc)
    - Forward cursor: basic, boundary, empty page
    - Backward cursor: basic, boundary
    - nextCursor: present when more records, absent at end
    - Offset: skip first N records
    - Limit clamping: respects maxLimit
    - Count: returns total before pagination
    - Aggregation: groupBy with sum/avg/count/min/max
    - Having: filters groups by aggregate
    - Select: only selected fields returned
    - Omit: omitted fields excluded
    - Select + omit together: error
    - Query limits: maxSelectTokens, maxSortFields enforcement
    - Cursor without id in sort: error

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_query_enhanced.py -v
```

**Expected outcomes:**
- Forward cursor pagination works with composite keys
- Backward cursor pagination works
- nextCursor is correctly computed
- Offset pagination works
- Limit clamping works
- Count queries return total
- Aggregation with groupBy works
- Select/omit filter fields correctly
- Limit enforcement returns LIMIT_EXCEEDED

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing query tests pass (no regressions)

## Stop Condition
- Query handler supports all pagination modes (cursor forward/backward, offset)
- Aggregation and count work
- Select/omit applied
- Ready for end-to-end testing in Phase 7
