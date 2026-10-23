# Phase 21: watchfn Integration

## Phase Goal
Implement the watchfn integration for live performance data per endpoint.

## In Scope
- `fetchEndpointMetrics()` — fetch metrics from watchfn HTTP API
- PerformanceOverlay data flow in explorer and docsfn
- `apifnWatchMiddleware()` — @superfunctions/http middleware for reporting metrics

## Out of Scope
- watchfn core implementation (separate package)
- Dashboard features

## Deliverables
- `apifn/core/src/integrations/watchfn.ts`
- `apifn/core/__tests__/watchfn-integration.test.ts`

## Requirements Covered
- WATCH-001, WATCH-002, WATCH-003, WATCH-004

## Implementation Tasks
1. [ ] Implement `fetchEndpointMetrics(url, options)`: HTTP GET to watchfn query API, parse response into EndpointMetrics[]
2. [ ] Implement time range and endpoint filtering in query params
3. [ ] Implement graceful degradation: if watchfn unavailable, return empty array with warning
4. [ ] Implement `apifnWatchMiddleware()`: capture request duration, status code, path; report to watchfn via its event API
5. [ ] Wire watchfn data into ApiExplorer and docsfn renderers (pass metrics as props)
6. [ ] Implement periodic refresh in UI components (configurable interval)
7. [ ] Write integration tests (mock watchfn HTTP responses)
8. [ ] Export from core index

## Verification Steps
1. `npm run test` → watchfn integration tests pass
2. TV-WATCH-001: Mock watchfn response → parsed EndpointMetrics
3. Middleware captures and reports metrics (mock test)
4. Graceful degradation: connection error → empty metrics, no crash

## Stop Condition
Metrics fetch and middleware work. Graceful degradation verified.
