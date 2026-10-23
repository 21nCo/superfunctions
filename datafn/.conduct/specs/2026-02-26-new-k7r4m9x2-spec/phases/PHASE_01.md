# Phase 1: Contract Tests + Memory Adapter Verification

## Goal
Create a reusable contract test suite that any adapter can run to prove row-level namespace isolation. Verify the memory adapter passes when wrapped.

## Scope
- `packages/db/src/testing/namespace-contract-tests.ts` (NEW)
- `packages/db/src/adapters/memory/__tests__/namespace.test.ts` (NEW)

## Requirements Covered
TST-001, RLN-001 through RLN-012

## Depends On
Phase 0

## Tasks

### 1.1 — Contract test suite
Create `packages/db/src/testing/namespace-contract-tests.ts`:
- Export `runRowLevelNamespaceContractTests(getAdapter: () => DatabaseAdapter)`.
- Test matrix (for each CRUD method):
  - Insert records for namespace A and namespace B.
  - Querying as A returns only A's records.
  - Querying as B returns only B's records.
  - Update as A does not affect B's records.
  - Delete as A does not affect B's records.
  - Count as A only counts A's records.
  - `__ns` column is never exposed in returned data.
- Cross-cutting tests:
  - Missing namespace with `mandatory: true` throws `NamespaceRequiredError`.
  - Transaction isolation — wrapped adapter inside transaction behaves identically.
  - `db.internal` bypasses namespace filtering.

### 1.2 — Memory adapter verification
Create test file that:
1. Instantiates memory adapter.
2. Wraps with `wrapWithRowLevelNamespace({ enabled: true, columnName: '__ns', mandatory: true })`.
3. Calls `runRowLevelNamespaceContractTests()`.

## Verification
- `npm test --filter=@superfunctions/db` passes.
- Contract test suite reports all green.

## Estimate
~1 day

## Exit Criteria
- Contract test suite exported and documented.
- Memory adapter passes all contract tests when wrapped.
