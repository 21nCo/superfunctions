# TEST VECTORS

## TV-SEC-006-P1
- Description: Push accepts batch exactly at configured limit.
- Input:
```json
{ "route": "/datafn/push", "limits": { "maxBatchSize": 500 }, "body": { "clientId": "c1", "mutations": ["500-valid-items"] } }
```
- Expected output:
```json
{ "status": 200, "ok": true }
```
- Negative variant(s): TV-SEC-006-N1

## TV-SEC-006-N1
- Description: Push rejects batch over configured limit.
- Input:
```json
{ "route": "/datafn/push", "limits": { "maxBatchSize": 500 }, "body": { "clientId": "c1", "mutations": ["501-valid-items"] } }
```
- Expected output:
```json
{ "status": 400, "ok": false, "error": { "code": "DFQL_INVALID", "messageContains": ["501", "500"] } }
```

## TV-SEC-006-P2
- Description: Mutation endpoint accepts array body exactly at configured limit.
- Input:
```json
{ "route": "/datafn/mutation", "limits": { "maxBatchSize": 50 }, "body": ["50-valid-mutations"] }
```
- Expected output:
```json
{ "status": 200, "ok": true }
```
- Negative variant(s): TV-SEC-006-N2

## TV-SEC-006-N2
- Description: Mutation endpoint rejects array body over configured limit.
- Input:
```json
{ "route": "/datafn/mutation", "limits": { "maxBatchSize": 50 }, "body": ["51-valid-mutations"] }
```
- Expected output:
```json
{ "status": 400, "ok": false, "error": { "code": "DFQL_INVALID", "details": { "path": "$" } } }
```

## TV-SEC-008-P1
- Description: Clean query with aggregations/having passes.
- Input:
```json
{ "resource": "task", "aggregations": { "total": { "op": "count", "field": "*" } }, "having": { "total": { "gt": 0 } } }
```
- Expected output:
```json
{ "validation": "ok" }
```
- Negative variant(s): TV-SEC-008-N1, TV-SEC-008-N2

## TV-SEC-008-N1
- Description: Query aggregations containing `__proto__` is rejected.
- Input:
```json
{ "resource": "task", "aggregations": { "__proto__": { "op": "count", "field": "*" } } }
```
- Expected output:
```json
{ "validation": "error", "error": { "code": "DFQL_INVALID", "messageContains": ["Disallowed key", "__proto__"] } }
```

## TV-SEC-008-N2
- Description: Top-level query object with nested `constructor` is rejected.
- Input:
```json
{ "resource": "task", "meta": { "constructor": { "prototype": {} } } }
```
- Expected output:
```json
{ "validation": "error", "error": { "code": "DFQL_INVALID", "messageContains": ["constructor"] } }
```

## TV-REL-002-P1
- Description: Change tracking transient failure recovers via retries in execute path.
- Input:
```json
{ "path": "executeMutation", "mock": { "recordChangeFailuresBeforeSuccess": 2 } }
```
- Expected output:
```json
{ "result": { "ok": true }, "assert": { "recordChangeAttempts": 3, "retryDelaysMs": [50, 100] } }
```
- Negative variant(s): TV-REL-002-N1

## TV-REL-002-N1
- Description: Change tracking persistent failure exhausts retries and fails mutation.
- Input:
```json
{ "path": "executeMutation", "mock": { "recordChangeAlwaysFails": true } }
```
- Expected output:
```json
{ "result": { "ok": false }, "error": { "code": "INTERNAL" } }
```

## TV-REL-011-P1
- Description: Push mutation is atomic with change tracking on transaction-capable adapter.
- Input:
```json
{ "path": "executePush", "adapter": "transaction-capable", "mock": { "changeTrackingFails": true } }
```
- Expected output:
```json
{ "pushResult": { "errors": [{ "code": "INTERNAL" }] }, "dbAssert": { "mutationRecordExists": false } }
```
- Negative variant(s): TV-REL-011-N1

## TV-REL-011-N1
- Description: Non-transaction adapter logs non-atomic fallback and returns explicit mutation failure on change-tracking error.
- Input:
```json
{ "path": "executePush", "adapter": "no-transaction", "mock": { "changeTrackingFails": true } }
```
- Expected output:
```json
{ "pushResult": { "errors": [{ "code": "INTERNAL" }] }, "logsContain": ["non-atomic", "push"] }
```

## TV-PER-002-P1
- Description: Route sources contain no dynamic import calls.
- Input:
```json
{ "command": "rg -n \"await import\\(\" datafn/server/src/routes" }
```
- Expected output:
```json
{ "stdout": "", "exitCode": 1 }
```
- Negative variant(s): TV-PER-002-N1

## TV-PER-002-N1
- Description: Injected dynamic import in route is detected by static check.
- Input:
```json
{ "fixture": "route file with await import(...)" }
```
- Expected output:
```json
{ "check": "fails", "reason": "dynamic import found" }
```

## TV-SRV-001-P1
- Description: REST wiring does not create synthetic Request objects for internal route bridging.
- Input:
```json
{ "command": "rg -n \"new Request\\(\\\"http://localhost/datafn/\" datafn/server/src/server.ts" }
```
- Expected output:
```json
{ "stdout": "", "exitCode": 1 }
```
- Negative variant(s): TV-SRV-001-N1

## TV-SRV-001-N1
- Description: Synthetic request creation is detected if regression reintroduces it.
- Input:
```json
{ "fixture": "server.ts includes new Request(...) bridge" }
```
- Expected output:
```json
{ "check": "fails", "reason": "synthetic request found" }
```

## TV-SRV-003-P1
- Description: Batch query larger than concurrency executes fully via queue.
- Input:
```json
{ "route": "/datafn/query", "limits": { "maxBatchQueryConcurrency": 20 }, "body": ["50-valid-queries"] }
```
- Expected output:
```json
{ "status": 200, "ok": true, "resultLength": 50 }
```
- Negative variant(s): TV-SRV-003-N1

## TV-SRV-003-N1
- Description: Instrumentation confirms in-flight query count never exceeds configured concurrency.
- Input:
```json
{ "route": "/datafn/query", "limits": { "maxBatchQueryConcurrency": 3 }, "body": ["10-slow-queries-with-counters"] }
```
- Expected output:
```json
{ "assert": { "maxInFlight": 3 } }
```

## TV-SRV-005-P1
- Description: Query route is split into modules and monolith no longer contains full implementation.
- Input:
```json
{ "command": "wc -l datafn/server/src/routes/query.ts && rg --files datafn/server/src/routes/query" }
```
- Expected output:
```json
{ "assert": { "queryTsLines": "<= 300", "moduleCount": ">= 3" } }
```
- Negative variant(s): TV-SRV-005-N1

## TV-SRV-005-N1
- Description: Refactor check fails if route remains monolithic.
- Input:
```json
{ "fixture": "single 900+ line query.ts with no submodules" }
```
- Expected output:
```json
{ "check": "fails", "reason": "module split missing" }
```

## TV-EXE-014-P1
- Description: Omit-set computation is cached per query context.
- Input:
```json
{ "query": "one-many expansion on 1000 records", "instrument": "count omit-set builds" }
```
- Expected output:
```json
{ "assert": { "omitSetBuildCount": "O(1) per relation context" } }
```
- Negative variant(s): TV-EXE-014-N1

## TV-EXE-014-N1
- Description: Regression path recomputes omit set per record.
- Input:
```json
{ "fixture": "omit-set build inside per-record loop" }
```
- Expected output:
```json
{ "check": "fails", "reason": "omit-set scales with row count" }
```

## TV-EXE-017-P1
- Description: Search candidates over 1000 are fully processed in chunks.
- Input:
```json
{ "searchCandidates": 1500, "chunkSize": 1000 }
```
- Expected output:
```json
{ "assert": { "processedCandidateCount": 1500, "chunkCount": 2 } }
```
- Negative variant(s): TV-EXE-017-N1

## TV-EXE-017-N1
- Description: Silent truncation to first 1000 is prohibited.
- Input:
```json
{ "searchCandidates": 1500, "legacyBehavior": "slice(0,1000)" }
```
- Expected output:
```json
{ "check": "fails", "reason": "missing 500 candidate IDs" }
```

## TV-EXE-018-P1
- Description: Batched change insert path is used when capability exists.
- Input:
```json
{ "path": "recordChanges", "capability": "batch-insert-available", "entries": 500 }
```
- Expected output:
```json
{ "assert": { "batchInsertCalls": 1, "singleInsertCalls": 0 } }
```
- Negative variant(s): TV-EXE-018-N1

## TV-EXE-018-N1
- Description: Batch capability missing uses deterministic fallback and preserves correctness.
- Input:
```json
{ "path": "recordChanges", "capability": "batch-insert-unavailable", "entries": 5 }
```
- Expected output:
```json
{ "assert": { "singleInsertCalls": 5, "orderPreserved": true, "errorEnvelopeUnchanged": true } }
```

## TV-EXE-022-P1
- Description: Unknown relation path does not trigger full-table scan fallback.
- Input:
```json
{ "query": "nested relation with no direct path", "instrument": "findMany where clauses" }
```
- Expected output:
```json
{ "assert": { "fullScanFallbackUsed": false, "result": "empty secondary + warning" } }
```
- Negative variant(s): TV-EXE-022-N1

## TV-EXE-022-N1
- Description: Unhandled relation type also avoids `where: []` broad fetch.
- Input:
```json
{ "query": "secondary load with unhandled relation type", "instrument": "findMany params" }
```
- Expected output:
```json
{ "assert": { "containsWhereEmptyArray": false } }
```

## TV-LOG-002-P1
- Description: Request logging helper contains no direct console fallback.
- Input:
```json
{ "command": "rg -n \"console\\.\" datafn/server/src/logging.ts" }
```
- Expected output:
```json
{ "stdout": "", "exitCode": 1 }
```
- Negative variant(s): TV-LOG-002-N1

## TV-LOG-002-N1
- Description: Regression check fails if `console.log` returns to request logger helper.
- Input:
```json
{ "fixture": "logRequest() has console.log fallback" }
```
- Expected output:
```json
{ "check": "fails", "reason": "direct console usage in logging helper" }
```
