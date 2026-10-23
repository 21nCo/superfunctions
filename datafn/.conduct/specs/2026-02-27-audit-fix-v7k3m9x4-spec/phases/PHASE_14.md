# PHASE 14: Test Coverage Gaps

## Phase goal
Create comprehensive test suites for security, namespace isolation, concurrent operations, and high-volume scenarios.

## In scope
- TST-001: Security test suite
- TST-002: Namespace isolation tests
- TST-003: Fix commented-out rollback assertions
- TST-004: Fix lenient conditional assertions
- TST-005: Concurrent/race condition tests
- TST-006: High-volume stress tests
- TST-007: Clone pagination scale tests

## Out of scope
- CI/CD pipeline setup
- Performance benchmarking infrastructure

## Deliverables
- `datafn/server/__tests__/security.test.ts` — NEW: comprehensive security test suite
- `datafn/server/__tests__/namespace-data-isolation.test.ts` — Enhanced (file exists, expand it)
- `datafn/server/__tests__/sync.test.ts` — Fix rollback assertions, add concurrent tests
- `datafn/server/__tests__/execution-errors.test.ts` — Fix lenient assertions
- `datafn/server/__tests__/concurrent.test.ts` — NEW: race condition tests
- `datafn/server/__tests__/stress.test.ts` — NEW: high-volume tests

## Requirements covered
TST-001 through TST-007

## Implementation tasks

### TST-001: Security test suite (`security.test.ts`)
- Prototype pollution attempts (top-level, nested, in filters, in records)
- Authz bypass via aggregation fields
- Authz bypass via groupBy fields
- Authz bypass via sort fields
- Authz bypass via having clause
- Authz bypass via search.fields
- Authz bypass via transact endpoint
- Batch size limit enforcement
- Payload size enforcement (multi-byte)
- Field value type validation (all types)
- REST path traversal attempts
- LIKE pattern length
- Search query length
- ID length limits
- Relation authz enforcement

### TST-002: Namespace isolation (`namespace-data-isolation.test.ts`)
- User A creates records → User B query returns empty
- User A push → User B pull returns empty
- User A clone → only User A's data
- WS cursor broadcast scoped to namespace
- Seed handler uses correct namespace
- extractNamespace doesn't fall back to shared namespace
- Cross-namespace mutation attempts fail

### TST-003: Fix rollback assertions
- Uncomment `// expect(taskNew).toBeNull()` in `transact.test.ts`
- Verify rolled-back data is actually not persisted
- Add assertion for `rolledBack: true` in response

### TST-004: Fix lenient assertions
- Replace conditional `if (result.ok) { expect... }` with unconditional assertions
- Each test should assert a specific expected outcome, not both success and failure

### TST-005: Concurrent tests (`concurrent.test.ts`)
- Two concurrent mutations on same record → no data loss
- Concurrent guard evaluation → guards re-evaluated in transaction
- Concurrent push from two clients → correct serverSeq ordering
- Concurrent modifyRelation → atomic, no silent failures
- Concurrent idempotent mutations → deduped correctly

### TST-006: Stress tests (`stress.test.ts`)
- 10,000 records insert + query
- 1,000 concurrent queries via batch endpoint
- 500 mutations in single push
- Long-running server with idempotency store (verify eviction)
- Rapid WebSocket connect/disconnect

### TST-007: Clone pagination tests
- Clone 15,000 records with maxCloneRecords: 10,000 → paginated
- Clone 500 records → full (not paginated)
- Paginated clone cursor continuation (page 1 → page 2 → done)
- Clone with joins across paginated responses

## Verification steps
- `cd datafn/server && bun test` — all tests pass (including new suites)
- All new test files run successfully
- No skipped or conditional assertions in updated tests
- Total test count increased by 50+ new tests

## Stop condition
All test coverage gaps closed. No conditional/lenient assertions. Report test count before/after and any test failures encountered.
