# Phase 11: Test Assertions & Scripts

## Phase Goal
Implement the assertion library and sandboxed script execution for collection tests.

## In Scope
- Assertion helpers: status, body, headers, response time, JSON path, schema validation
- Script sandbox: execute pre-request and test scripts safely
- `test("name", fn)` syntax support
- `expect` / assertion API
- Injected variables: `req`, `res`, `env`, `expect`, `test`

## Out of Scope
- CLI test command (next phase)
- Custom assertion functions from user plugins

## Deliverables
- `apifn/collections/src/runner/assertions.ts`
- `apifn/collections/src/runner/script-sandbox.ts`
- `apifn/collections/__tests__/assertions.test.ts`
- `apifn/collections/__tests__/script-sandbox.test.ts`

## Requirements Covered
- RUN-004, RUN-005, ASSERT-001, ASSERT-002, ASSERT-003, ASSERT-004, ASSERT-005, ASSERT-006, ASSERT-007

## Implementation Tasks
1. [ ] Implement assertion API: `expect(value)` chain with `.to.equal()`, `.to.have.property()`, `.to.include()`, `.to.be.below()`, `.to.have.length()`, `.to.matchSchema()`, `.to.have.jsonPath()`
2. [ ] Implement `test("name", fn)` wrapper that catches errors and records assertion results
3. [ ] Implement script sandbox: execute JavaScript string in isolated context (vm module or Function constructor with restricted globals)
4. [ ] Inject `req`, `res`, `env`, `expect`, `test` into sandbox context
5. [ ] Implement pre-request script support: `req` is mutable (headers, body, URL can be modified)
6. [ ] Implement post-response/test script support: `res` with `.status`, `.body`, `.headers`, `.responseTime`
7. [ ] Enforce script execution timeout (10 seconds per SPEC limits)
8. [ ] Block filesystem/process/network access in sandbox
9. [ ] Integrate assertions into runner: capture AssertionResult per test
10. [ ] Write tests for TV-ASSERT-001 through TV-ASSERT-007, TV-RUN-004, TV-RUN-005
11. [ ] Export assertion utilities

## Verification Steps
1. `npm run test` → all assertion and sandbox tests pass
2. TV-ASSERT-001: Status code assertion passes/fails correctly
3. TV-ASSERT-002: Body assertions work on JSON responses
4. TV-RUN-005: Test script executes and assertions recorded in report
5. Sandbox blocks `require('fs')` access

## Stop Condition
Assertions and script sandbox work correctly. Sandbox security verified.
