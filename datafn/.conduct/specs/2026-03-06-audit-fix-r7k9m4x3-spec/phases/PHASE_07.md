# PHASE_07: Server Integration & Comprehensive Tests

## Phase Goal
Wire logger, hooks, limits, config validation, payload size limits, and field-level authorization into the server and handlers. Run full end-to-end test suite confirming all parity features work together.

## In Scope
- Server: config validation at init
- Server: schema validation at init (verify Phase 1 integration)
- Server: logger wiring to all handlers
- Server: plugin/hook wiring to query + mutation handlers
- Server: limits config propagation to handlers
- Payload size limit enforcement
- Field-level authorization (read/write permissions)
- End-to-end integration tests covering all phases

## Out of Scope
- WebSocket support
- Rate limiting
- REST endpoint generation

## Deliverables

### Modified files
1. `datafn/python/datafn/server.py` — Config validation, logger, hooks, limits wiring
2. `datafn/python/datafn/handlers/query.py` — Logger calls, hook integration, authz
3. `datafn/python/datafn/handlers/mutation.py` — Logger calls, hook integration, authz
4. `datafn/python/datafn/handlers/transact.py` — Logger calls
5. `datafn/python/datafn/handlers/sync.py` — Logger calls

### New files
6. `datafn/python/datafn/authz.py` — Field-level authorization validation

### Test files
7. `datafn/python/tests/test_integration.py` — End-to-end integration tests
8. `datafn/python/tests/test_authz.py` — Authorization tests

## Requirements Covered
- SRV-003, SRV-004
- AUTH-001
- Final integration of: SRV-001, SRV-002

## Implementation Tasks

1. [ ] Enhance `server.py`:
   - Add config validation at start of `create_datafn_server()`:
     - `schema` is required (dict)
     - `db` is required (Adapter protocol)
     - `authorize` is optional (callable)
     - `plugins` is optional (list)
     - `logger` is optional (DatafnLogger)
     - `limits` is optional (dict with numeric values)
     - Raise `ValueError` on invalid config
   - Create logger: `logger = create_logger(config.get("logger"))`
   - Store plugins, limits on config object
   - Log server initialization: `logger.info("DataFn server initialized")`
   - Pass logger, plugins, limits to all handler factories
2. [ ] Create `authz.py`:
   - `validate_query_authz(query, resource_schema, schema_index)`:
     - If resource has `permissions.read.fields`: check select/filter fields are allowed
     - `id` is always readable
     - Return `FORBIDDEN` error for unauthorized field access
   - `validate_mutation_authz(mutation, resource_schema, schema_index)`:
     - If resource has `permissions.write.fields`: check record fields are allowed
     - Return `FORBIDDEN` error for unauthorized field writes
3. [ ] Wire hooks into query handler:
   - Before query execution: `result = await run_before_hook(plugins, "server", "before_query", ctx, query)`
   - If hook returns error, return error (don't execute query)
   - After query execution: `await run_after_hook(plugins, "server", "after_query", ctx, query, result)`
   - If after_query hook returns transformed result, use it
4. [ ] Wire hooks into mutation handler:
   - Before mutation: `result = await run_before_hook(plugins, "server", "before_mutation", ctx, mutation)`
   - After mutation: `await run_after_hook(plugins, "server", "after_mutation", ctx, mutation, result)`
5. [ ] Wire logger into all handlers:
   - Log request start: `logger.debug("Query request", {"resource": query["resource"]})`
   - Log errors: `logger.error("Query failed", {"code": error.code, "message": error.message})`
   - Log request end: `logger.debug("Query completed", {"resource": ...})`
   - NEVER log record data or PII
6. [ ] Wire field-level authorization:
   - In query handler: call `validate_query_authz()` after resource validation
   - In mutation handler: call `validate_mutation_authz()` after resource validation
7. [ ] Implement payload size limit:
   - In each handler, before JSON parsing:
     - If `limits.maxPayloadBytes` is set and request body size is known:
       - Return `LIMIT_EXCEEDED` if body exceeds limit
   - Note: actual size checking depends on framework integration
   - Provide `check_payload_size(body, max_bytes)` utility
8. [ ] Write integration tests:
   - Full flow: create server → query → mutation → transact → sync
   - Config validation: missing schema, missing db, invalid limits
   - Logger: verify logger.info called on init
   - Plugin: before_query hook modifies query
   - Plugin: before_mutation hook rejects mutation
   - Field auth: query for unauthorized field returns FORBIDDEN
   - Field auth: mutation writing unauthorized field returns FORBIDDEN
   - Limit enforcement: query with too many select tokens rejected
   - Cursor pagination end-to-end: insert 10 records, paginate with limit 3
   - Aggregation end-to-end: insert records, groupBy + count
   - Merge decision end-to-end: merge non-existent creates, merge existing updates
   - Replace end-to-end: replace preserves system fields
   - Batch insert end-to-end: insert 5 records via records[]
   - Transaction end-to-end: atomic rollback with annotation
   - Sync end-to-end: push with date coercion, pull with limit
9. [ ] Run full test suite and fix any regressions

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/ -v --tb=short
```

**Expected outcomes:**
- ALL tests pass (existing + new)
- No regressions in any existing functionality
- Integration tests cover end-to-end flows

```bash
python -m pytest tests/test_integration.py -v
```

**Expected outcomes:**
- Full CRUD + pagination + aggregation + transactions + sync end-to-end

```bash
python -m pytest tests/test_authz.py -v
```

**Expected outcomes:**
- Field-level auth correctly restricts field access

## Stop Condition
- All phases integrated and tested together
- Full test suite passes
- Python server is at feature parity with TypeScript server (non-capabilities)
- Ready for production use
