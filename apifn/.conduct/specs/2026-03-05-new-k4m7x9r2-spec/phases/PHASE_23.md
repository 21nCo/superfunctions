# Phase 23: testfn Adapter

## Phase Goal
Implement the testfn `BaseAdapter` so OpenCollection collections can run as test suites through testfn.

## In Scope
- `ApifnTestAdapter` extending `BaseAdapter` from `@testfn/core`
- Collection discovery (find `opencollection.yml` directories)
- Collection execution via `runCollection()`
- Result mapping from `RequestResult` to testfn's `TestResult`

## Out of Scope
- testfn core changes
- testfn UI integration

## Deliverables
- `apifn/core/src/integrations/testfn.ts`
- `apifn/core/__tests__/testfn-adapter.test.ts`

## Requirements Covered
- TESTFN-001, TESTFN-002, TESTFN-003

## Implementation Tasks
1. [ ] Implement `ApifnTestAdapter` class extending `BaseAdapter`
2. [ ] Implement `name = "apifn"` and `supports("apifn")` → true
3. [ ] Implement `discover(patterns)`: find `opencollection.yml` files matching patterns, read collections, return TestCase per request
4. [ ] Implement `run(tests, options)`: execute collections, map RequestResult to TestResult
5. [ ] Implement status mapping: passed→passed, failed→failed, error→failed, skipped→skipped
6. [ ] Implement duration preservation
7. [ ] Write tests with fixture collections
8. [ ] Export adapter from core index

## Verification Steps
1. `npm run test` → adapter tests pass
2. TV-TESTFN-001: Adapter has correct name and supports method
3. TV-TESTFN-002: Discovers collections and returns TestCases
4. TV-TESTFN-003: Results correctly mapped to testfn format

## Stop Condition
Adapter discovers and runs collections through testfn. Report discovery and execution results.
