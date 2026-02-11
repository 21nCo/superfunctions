# PHASE 00 — Fix Existing Test Failures

## Phase Goal
Establish a clean test baseline by fixing all 14 client and 19 server test failures.

## In Scope
- Fix `cloneUp.test.ts` failures (8): KV resource stats mismatch
- Fix `sync.test.ts` failures (4): Update legacy global cursor tests to per-table cursors
- Fix `storage-idb.test.ts` failures (2): Store initialization issues
- Fix server REST endpoint tests: clientId passing
- Fix server pull cursor validation tests: Legacy format expectations
- Fix server transact validation tests: Error code standardization

## Out of Scope
- New features
- Refactoring beyond test fixes
- Performance improvements

## Deliverables
- `client/__tests__/cloneUp.test.ts` — updated assertions for KV resource stats
- `client/__tests__/sync.test.ts` — updated to use per-table cursor format
- `client/__tests__/storage-idb.test.ts` — fix initialization expectations
- `server/__tests__/*.test.ts` — fix clientId, cursor format, and error code assertions
- Minimal code changes if the tests exposed actual bugs (document in phase report)

## Requirements Covered
- TEST-001, TEST-002

## Implementation Tasks
1. Run `npm test -w @datafn/client` and capture exact failure messages
2. For each `cloneUp.test.ts` failure:
   - Determine if the test expectation or the implementation is wrong
   - Fix the test assertion or fix the KV resource stat calculation
3. For each `sync.test.ts` failure:
   - Update tests to use `{ cursors: { table: "0" } }` format instead of `{ cursor: "0" }`
4. For each `storage-idb.test.ts` failure:
   - Fix store initialization order or mock setup
5. Run `npm test -w @datafn/server` and capture exact failure messages
6. For REST endpoint tests:
   - Ensure clientId is passed correctly in test fixtures
7. For pull cursor tests:
   - Update expectations to match per-table cursor response format
8. For transact validation tests:
   - Standardize on specific error codes (prefer `DFQL_UNKNOWN_FIELD` over `DFQL_INVALID` when applicable)
9. Run full test suite and verify 0 failures

## Verification Steps
- `npm test -w @datafn/client` → 0 failures
- `npm test -w @datafn/server` → 0 failures
- `npx tsc --noEmit -p client/tsconfig.json` → 0 errors
- `npx tsc --noEmit -p server/tsconfig.json` → 0 errors

## Stop Condition
All tests pass. Report any code changes made (vs test-only changes) in the phase report.
