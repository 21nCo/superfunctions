# HTTP query checkpoint — 2026-10-20

`POST /query` now invokes the actual WatchFn query service and returns `200 { "results": [...] }`, preserving the former response envelope while replacing its constant empty array. Filters, time ranges, ordering, limits, and aggregation behavior belong to QueryEngine rather than a divergent HTTP implementation.

The endpoint applies the existing configured API-key policy before reading the body: Bearer and x-api-key work, enabled authentication without a key fails closed, and unspecified/explicitly disabled authentication retains the existing public-access policy. Request bodies are limited to 64 KiB, including streams without Content-Length. Invalid JSON/non-object bodies return 400; excess bytes return 413. QueryEngine's QueryValidationError returns a generic 400; storage/execution failures return a generic 503 without leaking connection details. Successful empty results remain 200.

The handler awaits the query promise and serializes its real results. The shared engine validates semantics before accessing storage. This does not implement independent HTTP filtering or accept silently ignored invalid operators.

## Scope and limits

This checkpoint authenticates the query route, not health or other interfaces. It supplies no tenant/project authorization, query execution deadline, rate limit, response-size cap, or database snapshot consistency. Database scans can still be expensive; the body limit bounds request parsing rather than total execution work. It does not establish deployed endpoint, production-scale query performance, or full original SPEC readiness.

## Validation

15 focused HTTP query tests pass, including real stored filter/sort/limit results, empty results, grouped count/average results, both API-key headers, fail-closed missing keys, authentication before body reads, invalid shapes and semantic errors before database access, awaited/sanitized database rejection, streamed body limits and malformed JSON. The existing 17 HTTP ingestion tests also pass. Standalone WatchFn `tsc --noEmit` and `git diff --check` pass. This handler depends on the shared QueryValidationError/semantic validation supplied by the query engine change; retain those changes together. No install, push, PR, release or deployment occurred.
