# PHASE_00: Core Utility Parity

## Phase Goal
Implement all missing core utility functions in Python to match TypeScript `@datafn/core` exports, providing the foundation for all subsequent phases.

## In Scope
- Full filter operator support (22 operators + logical ops + dot-path + depth limit)
- Filter operator remapping (`normalize_filter_ops`)
- Sort term parsing and in-memory record sorting
- Select token parsing
- Date coercion utilities
- Aggregation operations
- DFQL normalization
- Join table utilities
- Namespace helper
- Field type validation and prototype pollution checks

## Out of Scope
- Integrating utilities into handlers (that's Phase 3–6)
- Schema index changes (Phase 1)
- Logger/hooks (Phase 2)

## Deliverables

### New files
1. `datafn/python/datafn/utils/__init__.py` — package init, re-exports
2. `datafn/python/datafn/utils/sort.py` — `parse_sort_terms()`, `sort_records()`
3. `datafn/python/datafn/utils/select.py` — `parse_select_token()`, `apply_select()`, `apply_omit()`
4. `datafn/python/datafn/utils/date.py` — `to_epoch_ms()`, `from_epoch_ms()`, `coerce_date_fields_to_epoch()`
5. `datafn/python/datafn/utils/aggregate.py` — `calculate_aggregation()`
6. `datafn/python/datafn/utils/normalize.py` — `normalize_dfql()`, `dfql_key()`
7. `datafn/python/datafn/utils/joins.py` — `get_join_table_name()`, `get_join_store_key()`, `enumerate_join_store_keys()`
8. `datafn/python/datafn/utils/ns.py` — `ns()`
9. `datafn/python/datafn/utils/validate_fields.py` — `check_prototype_pollution()`, `validate_field_value()`

### Modified files
10. `datafn/python/datafn/filters.py` — Add 16 missing operators, `$and`/`$or`, `normalize_filter_ops()`, dot-path traversal, depth guard

### Test files
11. `datafn/python/tests/test_filters.py` — Comprehensive filter tests
12. `datafn/python/tests/test_utils.py` — Tests for all new utilities

## Requirements Covered
- FILT-001, FILT-002, FILT-003, FILT-004, FILT-005
- SORT-001, SORT-002
- SEL-001
- DATE-001
- AGG-001
- NORM-001
- JOIN-001
- NS-001
- VAL-007 (prototype pollution check implementation, integration in Phase 4)

## Implementation Tasks

1. [ ] Create `datafn/python/datafn/utils/` package with `__init__.py`
2. [ ] Enhance `filters.py`:
   - Add `OP_REMAP` dict matching TypeScript's operator remapping table
   - Add `normalize_filter_ops(filters)` that recursively remaps non-`$` operators
   - Add `$in` operator: `value in operand_list`
   - Add `$nin` operator: `value not in operand_list`
   - Add `$like` operator: convert SQL LIKE pattern to regex (% → .*, _ → .)
   - Add `$ilike` operator: same as `$like` with `re.IGNORECASE`
   - Add `$not_like` operator: negate `$like`
   - Add `$not_ilike` operator: negate `$ilike`
   - Add `$is_null` operator: `value is None` when operand is `True`
   - Add `$is_not_null` operator: `value is not None`
   - Add `$is_empty` operator: `value in (None, "", [])`
   - Add `$is_not_empty` operator: negation of `$is_empty`
   - Add `$contains` operator: `operand in value` (string)
   - Add `$startsWith` operator: `value.startswith(operand)`
   - Add `$endsWith` operator: `value.endswith(operand)`
   - Add `$before` operator: `value < operand` (numeric/date)
   - Add `$after` operator: `value > operand` (numeric/date)
   - Add `$between` operator: `operand[0] <= value <= operand[1]`
   - Add `$not_between` operator: negate `$between`
   - Add `$and` logical operator: `all(evaluate_filter(record, cond) for cond in conditions)`
   - Add `$or` logical operator: `any(evaluate_filter(record, cond) for cond in conditions)`
   - Add dot-path traversal: split field name on `.`, traverse nested dicts
   - Add depth guard: track nesting depth, reject beyond `max_depth` (default 10)
   - Handle null values gracefully (comparison operators return False for None)
3. [ ] Create `utils/sort.py`:
   - `parse_sort_terms(sort_list)`: parse sort format strings
   - `sort_records(records, terms)`: multi-key sort with null handling and id tie-breaking
   - Use `functools.cmp_to_key` for custom comparator
4. [ ] Create `utils/select.py`:
   - `parse_select_token(token)`: parse dot-path tokens to `{"path", "base_name", "directive"}`
   - `apply_select(records, select_tokens)`: whitelist fields, always include `id`
   - `apply_omit(records, omit_tokens)`: blacklist fields, always keep `id`
5. [ ] Create `utils/date.py`:
   - `to_epoch_ms(value)`: datetime | str | int → int (epoch ms)
   - `from_epoch_ms(value)`: int | str → datetime
   - `coerce_date_fields_to_epoch(record, date_fields)`: in-place coercion
   - Handle ISO 8601 strings with `datetime.fromisoformat()`
   - Handle timezone-aware and naive datetimes
6. [ ] Create `utils/aggregate.py`:
   - `calculate_aggregation(op, field, records)`: count/sum/min/max/avg
   - Null-safe: skip None values for sum/min/max/avg
   - Empty set returns None (except count returns 0)
7. [ ] Create `utils/normalize.py`:
   - `normalize_dfql(value)`: recursive key sort, remove None (keep explicit None)
   - `dfql_key(value)`: `json.dumps(normalize_dfql(value), separators=(',', ':'), sort_keys=True)`
8. [ ] Create `utils/joins.py`:
   - `get_join_table_name(from_resource, relation_name, join_table=None)`: canonical name or custom
   - `get_join_store_key(from_resource, relation_name, to_resource)`: `join_{from}_{rel}_{to}`
   - `enumerate_join_store_keys(relations, resource_filter=None)`: list all many-many join keys
9. [ ] Create `utils/ns.py`:
   - `ns(*segments)`: join non-empty segments with `:`
   - Raise ValueError on empty args
10. [ ] Create `utils/validate_fields.py`:
    - `check_prototype_pollution(obj)`: recursive check for `__proto__`, `constructor`, `prototype`
    - `validate_field_value(schema_type, value, nullable)`: type check against schema type
    - Support types: string, number, boolean, date, object, array, file, json
11. [ ] Write `tests/test_filters.py`:
    - Test each of the 22 operators with positive and negative cases
    - Test `$and`, `$or` with nesting
    - Test `normalize_filter_ops()`
    - Test dot-path traversal
    - Test depth limit rejection
    - Test null value handling
12. [ ] Write `tests/test_utils.py`:
    - Test `parse_sort_terms()` with all formats
    - Test `sort_records()` with nulls and tie-breaking
    - Test `parse_select_token()`
    - Test `apply_select()` and `apply_omit()`
    - Test `to_epoch_ms()`, `from_epoch_ms()`, `coerce_date_fields_to_epoch()`
    - Test `calculate_aggregation()` for all ops
    - Test `normalize_dfql()` and `dfql_key()`
    - Test `get_join_table_name()` and `get_join_store_key()`
    - Test `ns()` with various inputs
    - Test `check_prototype_pollution()` and `validate_field_value()`

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_filters.py tests/test_utils.py -v
```

**Expected outcomes:**
- All filter operator tests pass (22 operators × positive + negative cases)
- All utility function tests pass
- No import errors from new utils package

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing tests continue to pass (no regressions)

## Stop Condition
- All new utility functions implemented and tested
- All existing tests pass
- Ready for Phase 1 (validation enhancement using these utilities)
