# Phase 10: HTTP Client & Collection Runner

## Phase Goal
Implement the collection runner that executes requests against live APIs.

## In Scope
- Built-in fetch-based HTTP client
- `runCollection()` — sequential and parallel execution
- Variable resolution during execution
- Timeout enforcement
- Retry logic
- Request/response capture
- Run report generation

## Out of Scope
- Test scripts/assertions (next phase)
- CLI `test` command (later phase)
- Reporters beyond basic console

## Deliverables
- `apifn/collections/src/runner/runner.ts`
- `apifn/collections/src/runner/http-client.ts`
- `apifn/collections/src/report.ts`
- `apifn/collections/__tests__/runner.test.ts`

## Requirements Covered
- RUN-001, RUN-002, RUN-003, RUN-006, RUN-007, RUN-008, RUN-010, RUN-011

## Implementation Tasks
1. [ ] Implement `HttpClient` using native fetch: send request, capture response, measure duration
2. [ ] Implement sequential runner: iterate items in seq order, execute each, collect results
3. [ ] Implement parallel runner: use concurrency limiter (Promise pool), execute up to N concurrent
4. [ ] Implement variable resolution: before each request, interpolate URL, headers, body using environment + overrides
5. [ ] Implement timeout: `AbortController` with signal, abort after timeout ms
6. [ ] Implement retry: on failure, retry up to N times with optional delay
7. [ ] Implement bail: stop on first failure, mark remaining as skipped
8. [ ] Implement request/response capture: store sent request details and received response (with body size limit)
9. [ ] Implement `RunReport` generation: aggregate results into summary
10. [ ] Write tests using a local test server (or mocked fetch)
11. [ ] Export from collections index

## Verification Steps
1. `npm run test` → runner tests pass
2. TV-RUN-001: Sequential execution in order
3. TV-RUN-007: Timeout enforced, result status is "error"
4. Report structure matches SPEC Section 6.6

## Stop Condition
Collection runner executes requests and produces valid run reports. Report test results.
