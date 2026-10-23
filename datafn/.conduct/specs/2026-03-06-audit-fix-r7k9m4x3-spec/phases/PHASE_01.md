# PHASE_01: Validation & Schema Enhancement

## Phase Goal
Enhance `SchemaIndex` and validation layer to support FK field injection, read-only field tracking, schema validation on init, and limit enforcement — establishing the validation foundation for handlers.

## In Scope
- FK field injection from many-one relations
- Read-only field tracking (separate from writable)
- Schema validation at `create_datafn_server()` init
- Field type validation function for mutation use
- Required field tracking
- Default value tracking
- Limit enforcement utilities
- ID length validation
- Error classification utility

## Out of Scope
- Applying validation in handlers (Phase 3–4)
- Logger/hooks integration (Phase 2)

## Deliverables

### Modified files
1. `datafn/python/datafn/validation.py` — Major enhancement:
   - `SchemaIndex._build_index()` — FK field injection, readonly tracking, field schema storage
   - `validate_schema(schema)` — Full schema validation matching TS
   - `validate_record_types(record, resource, schema_index)` — Field type validation
   - `validate_required_fields(record, resource, schema_index)` — Required field check
   - `apply_defaults(record, resource, schema_index)` — Default value application
   - `validate_limits(query_or_mutation, limits_config)` — Limit enforcement
   - `validate_id_length(id_value, max_length)` — ID length check
2. `datafn/python/datafn/envelope.py` — Add error classification utility:
   - `classify_error(exception)` — Map exceptions to DatafnErrorCode
   - Add all error codes matching TypeScript
3. `datafn/python/datafn/server.py` — Call `validate_schema()` at init

### Test files
4. `datafn/python/tests/test_validation_enhanced.py` — Tests for all new validation

## Requirements Covered
- VAL-001, VAL-002, VAL-003, VAL-004, VAL-005, VAL-006, VAL-008, VAL-009
- MUT-004 (error classification utility)

## Implementation Tasks

1. [ ] Enhance `SchemaIndex._build_index()`:
   - Store full field schemas (not just names) per resource: `self.field_schemas: Dict[str, Dict[str, dict]]`
   - Build `self.writable_fields: Dict[str, Set[str]]` (excludes readonly)
   - Build `self.readonly_fields: Dict[str, Set[str]]` (id + fields with `readonly: true`)
   - Build `self.required_fields: Dict[str, Set[str]]` (fields with `required: true` and no default)
   - Build `self.field_defaults: Dict[str, Dict[str, Any]]` (fields with `default` value)
   - Inject FK fields from many-one relations:
     - For each relation where `type == "many-one"`, add FK field to the `from` resource
     - FK field name: `relation.fkField or f"{relation.relation}Id"`
     - FK field schema: `{"name": fk_name, "type": "string", "required": false, "readonly": false}`
   - Build `self.date_fields: Dict[str, Set[str]]` (fields with `type == "date"`)
2. [ ] Implement `validate_schema(schema)`:
   - Check `resources` key exists and is a non-empty list
   - Check no duplicate resource names
   - Check no duplicate field names within each resource
   - Check resource count <= 100
   - Check fields per resource <= 200
   - Validate relation `from`/`to` reference existing resources
   - Validate relation types are valid
   - Return `{"ok": true, "result": normalized_schema}` or `{"ok": false, "error": {...}}`
3. [ ] Implement `validate_record_types(record, resource_name, schema_index)`:
   - For each key in record, look up field schema
   - Call `validate_field_value(schema_type, value, nullable)` from utils
   - Return list of errors or empty list
4. [ ] Implement `validate_required_fields(record, resource_name, schema_index)`:
   - For insert operations: check all required fields present
   - Skip fields with defaults (they'll be filled)
   - Return list of missing field names or empty list
5. [ ] Implement `apply_defaults(record, resource_name, schema_index)`:
   - For each field with default that's not in record: set `record[field] = default`
   - Return modified record
6. [ ] Implement limit validation utilities:
   - `validate_query_limits(query, limits)` — check select tokens, sort fields, filter keys, aggregations
   - `validate_mutation_limits(mutation, limits)` — check batch size
   - `validate_id_length(id_value, max_length)` — check ID string length
7. [ ] Enhance `envelope.py`:
   - Add `classify_error(exception)` function:
     - Pattern match error messages for unique violations → `CONFLICT`
     - Check for not-found patterns → `NOT_FOUND`
     - Default → `INTERNAL`
   - Add all error code constants: `SCHEMA_INVALID`, `LIMIT_EXCEEDED`, `CONFLICT`, `NOT_FOUND`, `DFQL_ABORTED`
8. [ ] Update `server.py`:
   - Call `validate_schema(config["schema"])` at the start of `create_datafn_server()`
   - Raise on invalid schema before building routes
9. [ ] Update `validate_record_keys()` to use `writable_fields` (reject readonly fields)
10. [ ] Write tests:
    - Schema validation: valid schema, duplicate resources, duplicate fields, too many resources, invalid relations
    - FK field injection: verify FK field appears in writable fields
    - Read-only rejection: mutation with `id` in record rejected
    - Field type validation: correct types pass, wrong types fail
    - Required fields: insert without required field fails, merge without required field passes
    - Default values: missing field gets default
    - Limit enforcement: exceeding each limit returns correct error
    - ID length: valid and oversized IDs
    - Error classification: test each pattern

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_validation_enhanced.py -v
```

**Expected outcomes:**
- Schema validation tests pass
- FK injection tests pass
- Read-only field rejection tests pass
- Type validation tests pass
- Required field tests pass
- Default value tests pass
- Limit enforcement tests pass
- Error classification tests pass

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing tests continue to pass

## Stop Condition
- SchemaIndex correctly injects FK fields and tracks readonly/required/defaults
- Schema validation runs on init and catches invalid schemas
- Field type validation works for all schema types
- Ready for Phase 3 (query handler using validation) and Phase 4 (mutation handler using validation)
