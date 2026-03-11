# TEST_VECTORS

## TV-ARCH-001
Description: Layering conformance check for rewritten package boundaries.
Input:
```json
{
  "command": "rg -n \"from './(pipeline|indexing|search-engine|compat)'\" searchfn/client/src searchfn/server/src"
}
```
Expected output:
```json
{ "matches": [] }
```
Negative variant(s):
- If wrappers import legacy internals, command returns matches and verification fails with `DFQL_INVALID` message "Legacy wrapper dependency detected".

## TV-ARCH-002
Description: Legacy export removal check for `@searchfn/client`.
Input:
```json
{
  "command": "node -e \"import('@searchfn/client').then(m=>console.log(Object.keys(m).sort().join(',')))\""
}
```
Expected output:
```json
{ "contains": ["createSearchClient", "createMemorySearchClient", "createIndexedDbSearchClient"], "notContains": ["SearchEngine", "migrateFlexStoreToSearchFn"] }
```
Negative variant(s):
- Export list includes removed symbols and must fail with `DFQL_UNSUPPORTED` message "Legacy export still present".

## TV-API-001
Description: Adapter contract compile check.
Input:
```json
{
  "command": "npm --prefix searchfn/adapters run typecheck"
}
```
Expected output:
```json
{ "exitCode": 0 }
```
Negative variant(s):
- Missing `signal` or required method signature causes typecheck failure with `DFQL_INVALID` message "SearchAdapter contract mismatch".

## TV-API-002
Description: Canonical server envelope for successful `/search`.
Input:
```json
{
  "request": {
    "method": "POST",
    "path": "/searchfn/search",
    "body": { "resource": "tasks", "query": "hello", "limit": 2 }
  }
}
```
Expected output:
```json
{
  "status": 200,
  "body": {
    "ok": true,
    "result": { "ids": ["t-1", "t-2"] }
  }
}
```
Negative variant(s):
- Non-envelope response shape fails with `INTERNAL` message "Invalid response envelope".

## TV-ADP-MEM-001
Description: Memory adapter deterministic tie-breaking.
Input:
```json
{
  "operations": [
    { "op": "index", "resource": "tasks", "documents": [
      { "id": "b", "fields": { "title": "same" } },
      { "id": "a", "fields": { "title": "same" } }
    ] },
    { "op": "search", "resource": "tasks", "query": "same", "limit": 2 }
  ]
}
```
Expected output:
```json
{ "ids": ["a", "b"] }
```
Negative variant(s):
- Nondeterministic order across repeated runs fails with `INTERNAL` message "Determinism violated".

## TV-ADP-IDB-001
Description: IndexedDB persistence and reopen behavior.
Input:
```json
{
  "operations": [
    { "op": "index", "resource": "notes", "documents": [{ "id": "n1", "fields": { "body": "alpha" } }] },
    { "op": "dispose" },
    { "op": "initialize", "resources": [{ "name": "notes", "searchFields": ["body"] }] },
    { "op": "search", "resource": "notes", "query": "alpha" }
  ]
}
```
Expected output:
```json
{ "ids": ["n1"] }
```
Negative variant(s):
- Search after dispose without initialize returns `DFQL_UNSUPPORTED` message "Adapter disposed".

## TV-ADP-PG-001
Description: Postgres adapter end-to-end index/search/remove.
Input:
```json
{
  "operations": [
    { "op": "initialize", "resources": [{ "name": "tasks", "searchFields": ["title", "body"] }] },
    { "op": "index", "resource": "tasks", "documents": [{ "id": "1", "fields": { "title": "report", "body": "q1" } }] },
    { "op": "search", "resource": "tasks", "query": "report" },
    { "op": "remove", "resource": "tasks", "ids": ["1"] },
    { "op": "search", "resource": "tasks", "query": "report" }
  ]
}
```
Expected output:
```json
{ "firstSearch": ["1"], "secondSearch": [] }
```
Negative variant(s):
- Missing extension/index table setup fails with `INTERNAL` message "Postgres index storage not initialized".

## TV-ADP-ES-001
Description: Elastic-compatible adapter on Elasticsearch and OpenSearch dialects.
Input:
```json
{
  "variants": [
    { "engine": "elasticsearch", "node": "http://localhost:9200" },
    { "engine": "opensearch", "node": "http://localhost:9201" }
  ],
  "query": "incident"
}
```
Expected output:
```json
{
  "elasticsearch": { "ok": true, "ids": ["d1"] },
  "opensearch": { "ok": true, "ids": ["d1"] }
}
```
Negative variant(s):
- Unsupported engine value fails with `DFQL_UNSUPPORTED` message "Unsupported elastic dialect".

## TV-ADP-MEI-001
Description: Meilisearch adapter full CRUD-like search flow.
Input:
```json
{
  "operations": [
    { "op": "initialize", "resources": [{ "name": "docs", "searchFields": ["title"] }] },
    { "op": "index", "resource": "docs", "documents": [{ "id": "d1", "fields": { "title": "Hello World" } }] },
    { "op": "search", "resource": "docs", "query": "hello" },
    { "op": "clear", "resource": "docs" }
  ]
}
```
Expected output:
```json
{ "search": ["d1"], "clear": "ok" }
```
Negative variant(s):
- Invalid API key/auth fails with `FORBIDDEN` message "Meilisearch authorization failed".

## TV-ADP-CONF-001
Description: Conformance suite runs for all built-in adapters.
Input:
```json
{
  "command": "npm --prefix searchfn/adapters test -- __tests__/conformance/*.test.ts"
}
```
Expected output:
```json
{ "exitCode": 0, "adapters": ["memory", "indexeddb", "postgres", "meilisearch", "elastic-compatible"] }
```
Negative variant(s):
- Any adapter contract drift fails with `DFQL_INVALID` message "Adapter conformance failed".

## TV-SRV-001
Description: Thin server endpoint registration and base path wiring.
Input:
```json
{
  "config": { "basePath": "/searchfn", "adapter": "memory" },
  "request": { "method": "GET", "path": "/searchfn/status" }
}
```
Expected output:
```json
{ "status": 200, "body": { "ok": true, "result": { "adapter": "memory" } } }
```
Negative variant(s):
- Missing adapter in constructor fails with `DFQL_INVALID` message "adapter is required".

## TV-SRV-002
Description: Server validation and limit enforcement.
Input:
```json
{
  "request": { "method": "POST", "path": "/searchfn/search", "body": { "resource": "tasks", "query": "x", "limit": 1000000 } },
  "limits": { "maxLimit": 1000 }
}
```
Expected output:
```json
{ "status": 400, "body": { "ok": false, "error": { "code": "LIMIT_EXCEEDED", "message": "limit exceeds maximum" } } }
```
Negative variant(s):
- Empty query body returns `DFQL_INVALID` message "Search query must not be empty".

## TV-SRV-003
Description: Authorization callback enforcement.
Input:
```json
{
  "authorize": "returns false for action=search",
  "request": { "method": "POST", "path": "/searchfn/search", "body": { "resource": "tasks", "query": "a" } }
}
```
Expected output:
```json
{ "status": 403, "body": { "ok": false, "error": { "code": "FORBIDDEN", "message": "Authorization denied" } } }
```
Negative variant(s):
- If unauthorized request reaches adapter call, fail with `INTERNAL` message "Authorization bypass".

## TV-SRV-004
Description: Status endpoint returns capabilities and lifecycle metadata.
Input:
```json
{
  "request": { "method": "GET", "path": "/searchfn/status" }
}
```
Expected output:
```json
{
  "status": 200,
  "body": {
    "ok": true,
    "result": {
      "adapter": "postgres",
      "capabilities": { "persistent": true, "searchAll": true },
      "uptimeMs": 12345
    }
  }
}
```
Negative variant(s):
- Status endpoint leaking secrets fails with `INTERNAL` message "Sensitive status leakage".

## TV-CLI-001
Description: `createSearchClient` thin wrapper delegates to injected adapter.
Input:
```json
{
  "clientFactory": "createSearchClient({adapter: fakeAdapter})",
  "operations": ["index", "search", "remove", "clear"]
}
```
Expected output:
```json
{ "adapterCalls": ["index", "search", "remove", "clear"] }
```
Negative variant(s):
- Importing legacy class names fails typecheck with `DFQL_UNSUPPORTED` message "Legacy client API removed".

## TV-CLI-002
Description: Convenience constructors produce functioning clients.
Input:
```json
{
  "operations": [
    { "factory": "createMemorySearchClient", "search": "alpha" },
    { "factory": "createIndexedDbSearchClient", "search": "alpha" }
  ]
}
```
Expected output:
```json
{ "memory": "ok", "indexeddb": "ok" }
```
Negative variant(s):
- Invalid constructor config fails with `DFQL_INVALID` message "Invalid adapterConfig".

## TV-CLI-003
Description: Thin client limit clamping and deterministic sorting.
Input:
```json
{
  "params": { "query": "x", "resources": ["a", "b"], "limit": 200000, "limitPerResource": 200000 }
}
```
Expected output:
```json
{ "effectiveLimit": 10000, "effectiveLimitPerResource": 1000 }
```
Negative variant(s):
- Non-positive limit fails with `DFQL_INVALID` message "limit must be a positive number".

## TV-DFP-001
Description: DataFn provider bridge delegates and normalizes results.
Input:
```json
{
  "provider": "createSearchProvider(adapter)",
  "operation": "searchAll",
  "params": { "query": "invoice", "resources": ["tasks", "notes"], "limit": 5 }
}
```
Expected output:
```json
{ "results": [{ "resource": "tasks", "id": "t1", "score": 1.0 }] }
```
Negative variant(s):
- Adapter without `searchAll` and empty resources fails with `DFQL_INVALID` message "resources are required when adapter.searchAll is unavailable".

## TV-MIG-001
Description: Internal consumer migration completeness.
Input:
```json
{
  "command": "rg -n \"@searchfn/client|SearchEngine|InMemorySearchFn\" recfn datafn searchfn -g '!**/dist/**'"
}
```
Expected output:
```json
{ "matches": [] }
```
Negative variant(s):
- Any old import remains and fails with `DFQL_UNSUPPORTED` message "Legacy SearchFn consumer remains".

## TV-LEG-001
Description: Legacy module removal verification.
Input:
```json
{
  "command": "rg --files searchfn/client/src | rg '(compat|search-engine|in-memory-search|pipeline|indexing|cache|storage|query)'"
}
```
Expected output:
```json
{ "matches": [] }
```
Negative variant(s):
- Presence of removed legacy modules fails with `DFQL_INVALID` message "Legacy module retained".

## TV-DOC-001
Description: SearchFn docs site build and route coverage.
Input:
```json
{
  "command": "npm --prefix searchfn/docs run build"
}
```
Expected output:
```json
{ "exitCode": 0, "routes": ["/docs", "/docs/reference/client", "/docs/reference/server", "/docs/reference/adapters"] }
```
Negative variant(s):
- Missing mandatory docs route fails with `DFQL_INVALID` message "Required docs section missing".

## TV-DOC-002
Description: Shared docs theme package usage by both docs apps.
Input:
```json
{
  "command": "rg -n \"@superfunctions/docs-theme\" datafn/docs searchfn/docs"
}
```
Expected output:
```json
{ "datafnDocs": true, "searchfnDocs": true }
```
Negative variant(s):
- Theme drift check fails with `INTERNAL` message "Docs theme parity failure".

## TV-DOC-003
Description: Adapter operation docs completeness check.
Input:
```json
{
  "command": "rg -n \"PostgresAdapter|MeilisearchAdapter|Elastic|OpenSearch|timeouts|retries|redaction\" searchfn/docs/content/docs"
}
```
Expected output:
```json
{ "allTopicsPresent": true }
```
Negative variant(s):
- Missing adapter ops section fails with `DFQL_INVALID` message "Production adapter docs incomplete".

## TV-PRD-001
Description: Retry + timeout behavior under transient backend failure.
Input:
```json
{
  "adapter": "meilisearch",
  "failurePattern": ["timeout", "timeout", "success"],
  "retryConfig": { "maxRetries": 2, "baseDelayMs": 50 }
}
```
Expected output:
```json
{ "attempts": 3, "final": "success", "retryable": true }
```
Negative variant(s):
- Exceeding retry budget fails with `INTERNAL` message "Retry budget exhausted".

## TV-PRD-002
Description: Structured log emission and secret redaction.
Input:
```json
{
  "operation": "search",
  "config": { "apiKey": "secret-key" },
  "logCapture": true
}
```
Expected output:
```json
{ "contains": ["operation", "durationMs"], "notContains": ["secret-key"] }
```
Negative variant(s):
- Secret appears in logs and fails with `INTERNAL` message "Sensitive data logged".

## TV-PRD-003
Description: Benchmark gate check.
Input:
```json
{
  "command": "npm --prefix searchfn/adapters run benchmark",
  "thresholds": {
    "memory.index.docsPerSec.min": 50000,
    "memory.search.p95.ms.max": 20
  }
}
```
Expected output:
```json
{ "pass": true }
```
Negative variant(s):
- Threshold miss fails with `LIMIT_EXCEEDED` message "Performance gate failed".

## TV-QA-001
Description: Full integration matrix command.
Input:
```json
{
  "command": "npm run test --workspace searchfn/adapters -- --config vitest.integration.config.ts"
}
```
Expected output:
```json
{ "exitCode": 0, "matrix": ["postgres", "meilisearch", "elasticsearch", "opensearch", "datafn-provider"] }
```
Negative variant(s):
- Any matrix target missing fails with `DFQL_INVALID` message "Integration matrix incomplete".

## TV-NEG-001
Description: Removed legacy client API import attempt.
Input:
```json
{
  "code": "import { SearchEngine } from '@searchfn/client'"
}
```
Expected output:
```json
{ "compileError": "SearchEngine is not exported" }
```
Negative variant(s):
- If import compiles, fail with `DFQL_UNSUPPORTED` message "Legacy compatibility leaked".

## TV-NEG-002
Description: Invalid request payload shape to thin server/client.
Input:
```json
{
  "query": "   ",
  "limit": 0
}
```
Expected output:
```json
{ "error": { "code": "DFQL_INVALID", "message": "Search query must not be empty" } }
```
Negative variant(s):
- Empty query accepted => fail with `INTERNAL` message "Validation bypass".

## TV-NEG-003
Description: Adapter capability mismatch handling.
Input:
```json
{
  "adapter": "no-searchAll",
  "operation": "searchAll",
  "resources": []
}
```
Expected output:
```json
{ "error": { "code": "DFQL_INVALID", "message": "resources are required when adapter.searchAll is unavailable" } }
```
Negative variant(s):
- Silent fallback with empty result is invalid and fails.

## TV-NEG-004
Description: Operation while adapter disposed.
Input:
```json
{
  "operations": ["dispose", "search"]
}
```
Expected output:
```json
{ "error": { "code": "DFQL_UNSUPPORTED", "message": "Adapter disposed" } }
```
Negative variant(s):
- Operation succeeds after dispose without reinitialize => determinism violation.

## TV-NEG-005
Description: Postgres backend unavailable.
Input:
```json
{
  "connectionString": "postgres://invalid-host/db",
  "operation": "search"
}
```
Expected output:
```json
{ "error": { "code": "INTERNAL", "message": "Postgres connection failed" } }
```
Negative variant(s):
- Error leaks full connection string => security failure.

## TV-NEG-006
Description: External backend auth/dialect failure.
Input:
```json
{
  "backend": "elastic-or-meili",
  "credentials": "invalid"
}
```
Expected output:
```json
{ "error": { "code": "FORBIDDEN", "message": "Backend authorization failed" } }
```
Negative variant(s):
- Incorrectly mapped to generic `INTERNAL` with no context fails.

## TV-NEG-007
Description: Adapter conformance regression.
Input:
```json
{
  "mutation": "break remove() idempotency",
  "command": "run conformance"
}
```
Expected output:
```json
{ "exitCode": 1, "failure": "remove idempotency contract" }
```
Negative variant(s):
- Suite passes despite broken contract => test harness failure.

## TV-NEG-008
Description: Sensitive value redaction failure.
Input:
```json
{
  "error": "Auth failed using apiKey=abc123",
  "logger": "structured"
}
```
Expected output:
```json
{ "logged": "Auth failed using apiKey=[REDACTED]" }
```
Negative variant(s):
- Raw key in logs => `INTERNAL` "Sensitive data logged".

## TV-NEG-009
Description: Internal repository still references removed APIs.
Input:
```json
{
  "command": "rg -n \"SearchEngine|InMemorySearchFn|migrateFlexStoreToSearchFn\" /Users/serro/Documents/dev/n/superfunctions -g '!**/dist/**'"
}
```
Expected output:
```json
{ "matches": [] }
```
Negative variant(s):
- Any match fails migration completeness gate.

## TV-NEG-010
Description: Health endpoint degraded adapter state.
Input:
```json
{
  "adapterState": "degraded",
  "request": "GET /searchfn/status"
}
```
Expected output:
```json
{ "ok": true, "result": { "state": "degraded" } }
```
Negative variant(s):
- Server crashes or returns unstructured error.

## TV-NEG-011
Description: Invalid client constructor options.
Input:
```json
{
  "factory": "createIndexedDbSearchClient",
  "adapterConfig": { "cache": { "terms": -1 } }
}
```
Expected output:
```json
{ "error": { "code": "DFQL_INVALID", "message": "Invalid adapterConfig" } }
```
Negative variant(s):
- Constructor silently accepts invalid config.

## TV-NEG-012
Description: Missing docs coverage sections.
Input:
```json
{
  "command": "node scripts/docs-coverage-check.mjs searchfn/docs",
  "requiredSections": ["architecture", "adapters", "server", "client", "datafn", "operations", "troubleshooting"]
}
```
Expected output:
```json
{ "pass": true }
```
Negative variant(s):
- Missing any required section fails with explicit section list.

## TV-NEG-013
Description: Shared docs theme drift.
Input:
```json
{
  "command": "node scripts/check-docs-theme-parity.mjs datafn/docs searchfn/docs"
}
```
Expected output:
```json
{ "pass": true }
```
Negative variant(s):
- Different token sources/layout primitives fail parity check.

## TV-NEG-014
Description: Retry policy determinism under repeated transient failures.
Input:
```json
{
  "failurePattern": ["timeout", "timeout", "timeout"],
  "retryConfig": { "maxRetries": 2 }
}
```
Expected output:
```json
{ "attempts": 3, "error": { "code": "INTERNAL", "message": "Retry budget exhausted" } }
```
Negative variant(s):
- Infinite retry loop or unbounded wait.

## TV-NEG-015
Description: Performance gate failure handling.
Input:
```json
{
  "benchmarkResult": { "memory.search.p95.ms": 55 },
  "threshold": 20
}
```
Expected output:
```json
{ "pass": false, "error": { "code": "LIMIT_EXCEEDED", "message": "Performance gate failed" } }
```
Negative variant(s):
- Gate reports pass despite threshold breach.

## TV-NEG-016
Description: Incomplete integration matrix run.
Input:
```json
{
  "matrix": ["postgres", "meilisearch"],
  "required": ["postgres", "meilisearch", "elasticsearch", "opensearch", "datafn-provider"]
}
```
Expected output:
```json
{ "error": { "code": "DFQL_INVALID", "message": "Integration matrix incomplete" } }
```
Negative variant(s):
- Matrix omission ignored and reported successful.
