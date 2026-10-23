# REQUIREMENTS

## Table of Contents

### Security — CRITICAL
- [SEC-001](#sec-001) WebSocket authentication
- [SEC-002](#sec-002) Server-derived WS namespace
- [SEC-003](#sec-003) Authz coverage for all query fields
- [SEC-004](#sec-004) Transact per-step authz
- [SEC-005](#sec-005) Field value type validation
- [SEC-006](#sec-006) Batch size limits
- [SEC-007](#sec-007) Byte-based payload measurement
- [SEC-008](#sec-008) Prototype pollution protection

### Security — HIGH
- [SEC-009](#sec-009) Relation authz enforcement
- [SEC-010](#sec-010) REST path traversal protection
- [SEC-011](#sec-011) Seed handler namespace isolation
- [SEC-012](#sec-012) Cross-tab message validation
- [SEC-013](#sec-013) Having clause deep validation
- [SEC-014](#sec-014) GroupBy field schema validation
- [SEC-015](#sec-015) LIKE pattern length cap
- [SEC-016](#sec-016) Search query length cap

### Reliability — CRITICAL
- [REL-001](#rel-001) Transaction atomicity — no silent fallthrough
- [REL-002](#rel-002) Change tracking failure propagation
- [REL-003](#rel-003) Rolled-back step annotation
- [REL-004](#rel-004) DebouncerMap orphaned Promises
- [REL-005](#rel-005) Duplicate push timer guard
- [REL-006](#rel-006) Clone error handling

### Reliability — HIGH
- [REL-007](#rel-007) WS heartbeat/ping-pong
- [REL-008](#rel-008) Redis rate limiter TTL race
- [REL-009](#rel-009) Graceful shutdown
- [REL-010](#rel-010) CAS retry backoff
- [REL-011](#rel-011) Mutation change tracking ordering
- [REL-012](#rel-012) Double event emission on offline fallback
- [REL-013](#rel-013) Batch query date codec
- [REL-014](#rel-014) Pull catch-up loop max iteration
- [REL-015](#rel-015) WS pullNow await

### Scalability — CRITICAL
- [SCA-001](#sca-001) Reconcile count via db.count()
- [SCA-002](#sca-002) Clone pagination enforcement
- [SCA-003](#sca-003) Extension transport request timeout
- [SCA-004](#sca-004) Idempotency store TTL + LRU

### Scalability — HIGH
- [SCA-005](#sca-005) WS connection limits
- [SCA-006](#sca-006) Namespace-scoped WS broadcast
- [SCA-007](#sca-007) Full table load optimization
- [SCA-008](#sca-008) Join row loading optimization
- [SCA-009](#sca-009) Aggregate group memory cap
- [SCA-010](#sca-010) Backward cursor memory optimization
- [SCA-011](#sca-011) Offline changelog size bound

### Performance — HIGH
- [PER-001](#per-001) Batch serverSeq allocation in push
- [PER-002](#per-002) Static imports in hot paths
- [PER-003](#per-003) Deduplicate push validation
- [PER-004](#per-004) Batch relation DB calls
- [PER-005](#per-005) Relation filter optimization
- [PER-006](#per-006) Changelog deduplication optimization

### Data Integrity — HIGH
- [DI-001](#di-001) modifyRelation TOCTOU fix
- [DI-002](#di-002) Guard evaluation TOCTOU fix
- [DI-003](#di-003) FallbackSequenceStore dedup
- [DI-004](#di-004) Join store key for multi-resource

### Validation — MEDIUM
- [VAL-001](#val-001) Authz deny-by-default for unknown resources
- [VAL-002](#val-002) Select token count limit
- [VAL-003](#val-003) Filter key count limit
- [VAL-004](#val-004) Sort array length limit
- [VAL-005](#val-005) Aggregation count limit
- [VAL-006](#val-006) ID field length validation
- [VAL-007](#val-007) clientId/mutationId validation
- [VAL-008](#val-008) Version field validation
- [VAL-009](#val-009) Error message disclosure control
- [VAL-010](#val-010) Default payload size limit

### Server — MEDIUM
- [SRV-001](#srv-001) REST synthetic request elimination
- [SRV-002](#srv-002) Redact common sensitive field names
- [SRV-003](#srv-003) Batch query size limit
- [SRV-004](#srv-004) Mutation log PII exposure
- [SRV-005](#srv-005) Query route file split
- [SRV-006](#srv-006) Timer phase accuracy
- [SRV-007](#srv-007) getBodyFromContext re-read guard
- [SRV-008](#srv-008) Status endpoint time exposure
- [SRV-009](#srv-009) Rate limit Retry-After header
- [SRV-010](#srv-010) extractNamespace default safety
- [SRV-011](#srv-011) Rate limiter timer unref
- [SRV-012](#srv-012) Transact duplicate validation
- [SRV-013](#srv-013) Seed handler error propagation
- [SRV-014](#srv-014) MemoryStore getRecords sort optimization
- [SRV-015](#srv-015) $or filter operator fix
- [SRV-016](#srv-016) Seed handler namespace from auth

### Execution — MEDIUM
- [EXE-001](#exe-001) Deduplicate traverseFilter/traverseHaving
- [EXE-002](#exe-002) setJoinRow linear scan fix
- [EXE-003](#exe-003) Transaction step error context
- [EXE-004](#exe-004) Transaction query step caching
- [EXE-005](#exe-005) Error classification robustness
- [EXE-006](#exe-006) Idempotency concurrent race fix
- [EXE-007](#exe-007) DbIdempotencyStore error handling
- [EXE-008](#exe-008) Delete change existence check
- [EXE-009](#exe-009) Mutation ID collision prevention
- [EXE-010](#exe-010) Mutation catch error preservation
- [EXE-011](#exe-011) GuardDataStore cross-resource fix
- [EXE-012](#exe-012) findRelation ambiguity fix
- [EXE-013](#exe-013) resolveValue per-record lookup fix
- [EXE-014](#exe-014) FK omit set computed once
- [EXE-015](#exe-015) One-many expansion optimization
- [EXE-016](#exe-016) Cursor pushdown limit fix
- [EXE-017](#exe-017) Search IN clause cap
- [EXE-018](#exe-018) Change tracking batch insert
- [EXE-019](#exe-019) getCurrentServerSeq error handling
- [EXE-020](#exe-020) Push transaction wrapping
- [EXE-021](#exe-021) Pull parallel per-resource fetch
- [EXE-022](#exe-022) forQuery full table scan fallback

### Client/Core — MEDIUM
- [CLI-001](#cli-001) createClientError naming
- [CLI-002](#cli-002) Remove deprecated switchableClient
- [CLI-003](#cli-003) Offline aggregate empty set
- [CLI-004](#cli-004) Relation from/to resource validation
- [CLI-005](#cli-005) EventBus iteration safety
- [CLI-006](#cli-006) Health check key exemption
- [CLI-007](#cli-007) KV merge race condition
- [CLI-008](#cli-008) Remove unused buildEvent import
- [CLI-009](#cli-009) Filter recursion depth limit
- [CLI-010](#cli-010) pushBatchWithRetry backoff
- [CLI-011](#cli-011) Incremental search index
- [CLI-012](#cli-012) Redundant filter application
- [CLI-013](#cli-013) IndexedDB version bound
- [CLI-014](#cli-014) Missing reconcile RPC method

### LOW Issues
- [LOW-001](#low-001) through [LOW-034](#low-034) — see individual entries

### Test Coverage
- [TST-001](#tst-001) Security test suite
- [TST-002](#tst-002) Namespace isolation tests
- [TST-003](#tst-003) Fix commented-out rollback assertions
- [TST-004](#tst-004) Fix lenient conditional assertions
- [TST-005](#tst-005) Concurrent/race condition tests
- [TST-006](#tst-006) High-volume stress tests
- [TST-007](#tst-007) Clone pagination scale tests

### Logging
- [LOG-001](#log-001) Pluggable logger interface
- [LOG-002](#log-002) Replace console.* calls
- [LOG-003](#log-003) Structured context in log calls

---

## Requirement Details

### SEC-001
- **ID**: SEC-001
- **Priority**: P0
- **Statement**: WebSocket `addClient()` MUST validate authentication via `authContextProvider` during the HTTP upgrade handshake.
- **Rationale**: SEC-C2 — Any actor can connect and receive cursor notifications without auth.
- **Acceptance criteria**:
  - `addClient()` requires an `AuthContext` parameter (or upgrade request context)
  - Connections without valid auth are rejected with WS close code `4401`
  - No cursor data is sent before auth validation completes
- **Test vectors**: TV-SEC-001, TV-SEC-002
- **Notes**: Uses existing `authContextProvider.getContext()` — same path as HTTP routes.

### SEC-002
- **ID**: SEC-002
- **Priority**: P0
- **Statement**: WebSocket namespace MUST be derived from server-side auth context; client-supplied `namespace` in `hello` messages MUST be ignored.
- **Rationale**: SEC-C1 — Client-supplied namespace enables cross-tenant cursor data leakage.
- **Acceptance criteria**:
  - `handleMessage()` for `hello` ignores `msg.namespace`
  - Namespace is set at connection time from auth context
  - Client cannot change namespace after connection
- **Test vectors**: TV-SEC-003, TV-SEC-004
- **Notes**: Breaking change for clients that relied on sending namespace in hello.

### SEC-003
- **ID**: SEC-003
- **Priority**: P0
- **Statement**: `validateQueryAuthz` MUST check field references in `aggregations`, `groupBy`, `having`, `sort`, and `search.fields` against the permission policy's `read.fields`.
- **Rationale**: SEC-C3 — Restricted fields extractable via groupBy/aggregation/sort without authz check.
- **Acceptance criteria**:
  - `aggregations[*].field` checked against `read.fields`
  - `groupBy[*]` checked against `read.fields`
  - `having` field keys checked recursively
  - `sort` field names (sans `-` prefix) checked against `read.fields`
  - `search.fields` checked against `read.fields`
  - FORBIDDEN returned for any unauthorized field
- **Test vectors**: TV-SEC-005 through TV-SEC-010
- **Notes**: System fields (`id`, `createdAt`, etc.) follow same rules as select.

### SEC-004
- **ID**: SEC-004
- **Priority**: P0
- **Statement**: The `/transact` endpoint MUST call `validateMutationAuthz` for mutation steps and `validateQueryAuthz` for query steps before execution.
- **Rationale**: SEC-C4 — Transactions bypass all permission checks.
- **Acceptance criteria**:
  - Each transaction step validated against appropriate authz function
  - Any authz failure stops the transaction before any step executes
  - Error response includes which step and field failed
- **Test vectors**: TV-SEC-011, TV-SEC-012
- **Notes**: Authz failures are pre-execution (no partial mutation).

### SEC-005
- **ID**: SEC-005
- **Priority**: P0
- **Statement**: All mutation record values MUST be validated against their schema-declared field types using strict type checking.
- **Rationale**: SEC-C5 — Untyped values cause DB errors, data corruption, downstream failures.
- **Acceptance criteria**:
  - `string` field rejects non-string values
  - `number` field rejects non-number and NaN values
  - `boolean` field rejects non-boolean values
  - `date` field accepts ISO 8601 strings and epoch numbers only
  - `object` field accepts only plain objects (not null, not array)
  - `array` field accepts only arrays
  - `null` accepted only when `nullable: true`
  - Error message: `"Field '{name}' expects {type}, got {actual}"`
- **Test vectors**: TV-SEC-013 through TV-SEC-020
- **Notes**: Applied at validation layer before execution. Does not apply to query filter values (separate concern).

### SEC-006
- **ID**: SEC-006
- **Priority**: P0
- **Statement**: Push and batch mutation endpoints MUST reject requests with more than `limits.maxBatchSize` (default 500) mutations.
- **Rationale**: SEC-C6 — Unbounded arrays exhaust server memory.
- **Acceptance criteria**:
  - Request with >500 mutations returns `DFQL_INVALID` with message including actual and max count
  - `limits.maxBatchSize` is configurable
  - Client sync engine's default `pushBatchSize: 100` remains under limit
- **Test vectors**: TV-SEC-021, TV-SEC-022
- **Notes**: Consistent with existing `limits` config pattern.

### SEC-007
- **ID**: SEC-007
- **Priority**: P0
- **Statement**: `readBodyWithLimit` MUST use `Buffer.byteLength(body, 'utf8')` instead of `body.length` for payload size measurement.
- **Rationale**: SEC-C7 — Multi-byte chars (emoji, CJK) can be 2-4x larger than `.length` suggests.
- **Acceptance criteria**:
  - 5MB of multi-byte content is correctly rejected
  - ASCII content behavior unchanged
  - `checkPayloadLimit` (Content-Length header check) also validates against byte limit
- **Test vectors**: TV-SEC-023, TV-SEC-024
- **Notes**: Also set `limits.maxPayloadBytes` default to 5,242,880.

### SEC-008
- **ID**: SEC-008
- **Priority**: P0
- **Statement**: Validation MUST reject JSON keys `__proto__`, `constructor`, `prototype` recursively in mutation records, filter values, and query parameters with `DFQL_INVALID`.
- **Rationale**: SEC-C8 — These keys can pollute prototypes via spread/assign.
- **Acceptance criteria**:
  - Top-level and nested dangerous keys rejected
  - Error message: `"Disallowed key: {key}"`
  - Applies to mutation records, query filters, aggregation config, having clause
- **Test vectors**: TV-SEC-025 through TV-SEC-028
- **Notes**: Check at validation entry points, before any data processing.

### SEC-009
- **ID**: SEC-009
- **Priority**: P1
- **Statement**: `relate`, `modifyRelation`, and `unrelate` operations MUST be checked against `write.fields` in the mutation authz policy.
- **Rationale**: SEC-H1 — Relation mutations bypass all write permission checks.
- **Acceptance criteria**:
  - Relation target field checked against `write.fields` of the source resource
  - FORBIDDEN returned when user lacks write permission for the relation field
- **Test vectors**: TV-SEC-029, TV-SEC-030
- **Notes**: The "field" for relation authz is the FK field or relation name.

### SEC-010
- **ID**: SEC-010
- **Priority**: P1
- **Statement**: REST route MUST URL-decode and sanitize resource name and ID parameters, rejecting `..`, null bytes, and encoded path separators.
- **Rationale**: SEC-H2 — Path traversal risk from unsanitized URL segments.
- **Acceptance criteria**:
  - `%2F` in resource name/ID → 400 error
  - `..` in resource name/ID → 400 error
  - Null bytes → 400 error
  - URL-decoded values validated against schema resource names
- **Test vectors**: TV-SEC-031, TV-SEC-032
- **Notes**: Use `decodeURIComponent()` + validation regex.

### SEC-011
- **ID**: SEC-011
- **Priority**: P1
- **Statement**: Seed handler MUST derive namespace from authenticated context, not hardcode `"datafn"`.
- **Rationale**: SEC-H3 — Breaks multi-tenant isolation.
- **Acceptance criteria**:
  - Seed records stored with tenant-specific namespace
  - Without auth context, seed uses default namespace (consistent with other routes)
- **Test vectors**: TV-SEC-033
- **Notes**: Aligns with Decision #1 namespace derivation pattern.

### SEC-012
- **ID**: SEC-012
- **Priority**: P1
- **Statement**: Cross-tab relay MUST validate `messageEvent.data` structure before casting to `RelayEvent`.
- **Rationale**: SEC-H4 — XSS or rogue extensions can inject arbitrary event shapes.
- **Acceptance criteria**:
  - `messageEvent.data` validated to have expected `type` and `payload` shape
  - Invalid messages silently ignored (no crash, no processing)
- **Test vectors**: TV-SEC-034
- **Notes**: Runtime type guard, not schema validation.

### SEC-013
- **ID**: SEC-013
- **Priority**: P1
- **Statement**: `having` clause MUST be deeply validated against schema fields and valid filter operators, not just checked for non-null object.
- **Rationale**: SEC-H5 — Superficial validation allows arbitrary query injection.
- **Acceptance criteria**:
  - Field names in `having` validated against schema + aggregation aliases
  - Operators validated against allowed filter operators
  - Values type-checked against field types
- **Test vectors**: TV-SEC-035, TV-SEC-036
- **Notes**: Reuse filter validation logic.

### SEC-014
- **ID**: SEC-014
- **Priority**: P1
- **Statement**: `groupBy` field names MUST be validated against the resource's schema field set.
- **Rationale**: SEC-H6 — Unvalidated fields pass through to DB adapter.
- **Acceptance criteria**:
  - Each `groupBy` field name exists in resource schema
  - Unknown fields → `DFQL_UNKNOWN_FIELD` error
- **Test vectors**: TV-SEC-037, TV-SEC-038
- **Notes**: System fields allowed in groupBy.

### SEC-015
- **ID**: SEC-015
- **Priority**: P1
- **Statement**: `$like` and `$ilike` pattern values MUST be capped at `limits.maxLikePatternLength` (default 200 chars).
- **Rationale**: SEC-H7 — Expensive patterns can cause performance degradation.
- **Acceptance criteria**:
  - Patterns exceeding limit → `DFQL_INVALID`
  - Default limit: 200 characters
- **Test vectors**: TV-SEC-039
- **Notes**: Also consider rejecting excessive `%` wildcards (future enhancement).

### SEC-016
- **ID**: SEC-016
- **Priority**: P1
- **Statement**: `search.query` MUST be capped at `limits.maxSearchQueryLength` (default 1000 chars).
- **Rationale**: SEC-H8 — Multi-megabyte queries cause memory/CPU issues.
- **Acceptance criteria**:
  - Queries exceeding limit → `DFQL_INVALID`
  - Default limit: 1000 characters
- **Test vectors**: TV-SEC-040
- **Notes**: Simple length check.

### REL-001
- **ID**: REL-001
- **Priority**: P0
- **Statement**: When `db.transaction()` throws for non-application reasons, `executeTransaction` MUST return an `INTERNAL` error and MUST NOT fall through to sequential execution.
- **Rationale**: REL-C1 — Silent atomicity loss causes partial application without caller knowledge.
- **Acceptance criteria**:
  - DB-level errors (serialization, timeout, constraint) → `{ ok: false, error: { code: "INTERNAL" } }`
  - Sequential fallback ONLY when `db.transaction === undefined` (memory adapter)
  - Application-level step failures still produce per-step error results
- **Test vectors**: TV-REL-001, TV-REL-002
- **Notes**: Client can retry on INTERNAL errors.

### REL-002
- **ID**: REL-002
- **Priority**: P0
- **Statement**: In `push.ts`, change tracking failure MUST be treated as mutation failure, consistent with `execute.ts`. Before failing, `recordChange()` MUST retry up to 2 times with 50ms/100ms delays.
- **Rationale**: REL-C2/REL-H6 — Swallowed failures cause permanent sync desynchronization.
- **Acceptance criteria**:
  - `push.ts` propagates change tracking failures (mutation marked as failed)
  - Up to 2 retries with 50ms, 100ms delay before failing
  - Behavior consistent between `push.ts` and `execute.ts`
- **Test vectors**: TV-REL-003, TV-REL-004
- **Notes**: Decision #2 — Option A + C.

### REL-003
- **ID**: REL-003
- **Priority**: P0
- **Statement**: When a transaction step fails, all preceding `ok: true` results MUST be replaced with `{ ok: false, rolledBack: true, result: <original> }`.
- **Rationale**: REL-C3 — Clients update local state with phantom (rolled-back) data.
- **Acceptance criteria**:
  - Pre-failure results annotated with `rolledBack: true`
  - `ok` set to `false` on rolled-back steps
  - Original result preserved in `result` field for debugging
  - Top-level response: `{ ok: false, error: { code: "TRANSACTION_ROLLED_BACK" } }`
- **Test vectors**: TV-REL-005, TV-REL-006
- **Notes**: Decision #4 — Option A.

### REL-004
- **ID**: REL-004
- **Priority**: P0
- **Statement**: `DebouncerMap.set()` MUST resolve or reject the old Promise before replacing callbacks when called for an existing key.
- **Rationale**: REL-C4 — Orphaned Promises never settle, causing memory leaks and hung callers.
- **Acceptance criteria**:
  - Old Promise resolves (not rejects) when superseded by new mutation for same key
  - No Promise leaks after repeated set() calls for same key
  - Original mutation merged into new mutation (existing behavior preserved)
- **Test vectors**: TV-REL-007
- **Notes**: Resolve is correct behavior since the data was merged into the new mutation.

### REL-005
- **ID**: REL-005
- **Priority**: P0
- **Statement**: `SyncEngine.start()` MUST guard against duplicate timer creation by checking if a timer already exists.
- **Rationale**: REL-C5 — Double-calling creates duplicate timers that halve push interval.
- **Acceptance criteria**:
  - `if (this.pushTimer) return;` guard at start of `start()`
  - Multiple `start()` calls are idempotent
  - `stop()` still clears the timer
- **Test vectors**: TV-REL-008
- **Notes**: Common in hot-reload scenarios.

### REL-006
- **ID**: REL-006
- **Priority**: P0
- **Statement**: Background `cloneResources` MUST catch errors and emit `sync_failed` event instead of silently swallowing them.
- **Rationale**: REL-C6 — Clone failures leave resources stuck in `hydrating` state forever.
- **Acceptance criteria**:
  - Clone errors caught with try/catch
  - `sync_failed` event emitted with error details
  - Resource state set to `failed` (not stuck in `hydrating`)
- **Test vectors**: TV-REL-009
- **Notes**: Wrap `setTimeout(async () => {...})` in error handler.

### REL-007
- **ID**: REL-007
- **Priority**: P1
- **Statement**: WebSocket manager MUST implement native WS ping/pong heartbeat with 30s interval and 10s timeout, closing dead connections automatically.
- **Rationale**: REL-H1 — Dead connections accumulate indefinitely.
- **Acceptance criteria**:
  - Ping sent every `ws.heartbeatIntervalMs` (default 30s)
  - Connection closed if pong not received within `ws.heartbeatTimeoutMs` (default 10s)
  - `removeClient()` called for closed connections
  - Heartbeat interval configurable
- **Test vectors**: TV-REL-010
- **Notes**: Uses native WS ping/pong frames, not application-level messages.

### REL-008
- **ID**: REL-008
- **Priority**: P1
- **Statement**: Redis rate limiter MUST use atomic INCR+EXPIRE or SET with NX+EX to prevent orphaned keys without TTL.
- **Rationale**: REL-H2 — Crash between `incr` and `set` leaves key without TTL.
- **Acceptance criteria**:
  - Single atomic Redis command for increment + TTL
  - No window where key exists without TTL
  - Existing rate limit behavior preserved
- **Test vectors**: TV-REL-011
- **Notes**: Lua script or MULTI/EXEC.

### REL-009
- **ID**: REL-009
- **Priority**: P1
- **Statement**: Server MUST implement graceful shutdown on SIGTERM/SIGINT with configurable `shutdownTimeoutMs` (default 10,000ms).
- **Rationale**: REL-H3 — In-flight requests dropped, WS not closed, changes not flushed.
- **Acceptance criteria**:
  - Stop accepting new connections immediately
  - Send WS close frame (1001) to all clients
  - Wait for in-flight requests up to timeout
  - Force-close after timeout
  - Clean up rate limit timers
  - `close()` method returns a Promise that resolves when shutdown complete
- **Test vectors**: TV-REL-012
- **Notes**: Decision #9 — Option A.

### REL-010
- **ID**: REL-010
- **Priority**: P1
- **Statement**: CAS retry in change tracking MUST use exponential backoff (10ms, 20ms, 40ms, ...) instead of zero-delay spin.
- **Rationale**: REL-H4 — Zero-delay retries create CPU spin under contention.
- **Acceptance criteria**:
  - First retry: 10ms delay
  - Each subsequent: double previous
  - Max 10 retries (existing)
  - Total max wait: ~10s
- **Test vectors**: TV-REL-013
- **Notes**: Simple `await sleep(10 * 2**attempt)`.

### REL-011
- **ID**: REL-011
- **Priority**: P1
- **Statement**: In `execute.ts`, change tracking MUST run within the same transaction as the mutation when possible.
- **Rationale**: REL-H5 — Change tracking after commit can fail, leaving untracked mutations.
- **Acceptance criteria**:
  - When DB adapter supports transactions, change tracking runs in same transaction
  - When not, current behavior preserved (change tracking after mutation)
- **Test vectors**: TV-REL-014
- **Notes**: Reduces the window for inconsistency.

### REL-012
- **ID**: REL-012
- **Priority**: P1
- **Statement**: Client MUST NOT emit duplicate `mutation_applied` events on offline fallback path.
- **Rationale**: REL-H7 — Subscribers receive two events for one mutation.
- **Acceptance criteria**:
  - Exactly one `mutation_applied` event per mutation regardless of online/offline path
  - Event contains correct mutation data
- **Test vectors**: TV-REL-015
- **Notes**: Guard with `emitted` flag or consolidate emission points.

### REL-013
- **ID**: REL-013
- **Priority**: P1
- **Statement**: Batch queries MUST apply date codec to results, consistent with single queries.
- **Rationale**: REL-H8 — Returns raw epoch numbers instead of Date objects.
- **Acceptance criteria**:
  - Date fields in batch query results are Date objects (or ISO strings, matching single query)
  - Consistent behavior between `query()` and `batchQuery()`
- **Test vectors**: TV-REL-016
- **Notes**: Apply same codec transform.

### REL-014
- **ID**: REL-014
- **Priority**: P1
- **Statement**: Pull catch-up `while (!caughtUp)` loop MUST have a max iteration limit (default 50).
- **Rationale**: REL-H9 — High write throughput causes infinite pull loop.
- **Acceptance criteria**:
  - Max 50 iterations (existing value referenced in engine.ts)
  - After max iterations, emit warning and stop (don't loop forever)
  - Next pull cycle picks up where this one left off
- **Test vectors**: TV-REL-017
- **Notes**: Already has `maxIterations` logic in code — verify it's enforced.

### REL-015
- **ID**: REL-015
- **Priority**: P1
- **Statement**: WS `pullNow()` calls MUST be awaited and errors handled.
- **Rationale**: REL-H10 — Pull failures from WS messages silently swallowed.
- **Acceptance criteria**:
  - `pullNow()` calls are awaited
  - Errors logged and `sync_failed` emitted (not swallowed)
- **Test vectors**: TV-REL-018
- **Notes**: Use `.catch()` if fire-and-forget is intended, but log errors.

### SCA-001
- **ID**: SCA-001
- **Priority**: P0
- **Statement**: `executeReconcile` MUST use `db.count()` (or equivalent) instead of `db.findMany({ where: [] }).length`.
- **Rationale**: SCA-C1 — Full table scan loads all records into memory just to count.
- **Acceptance criteria**:
  - No `findMany` call in reconcile for counting
  - `count()` or equivalent used
  - Correct count returned for empty and large tables
- **Test vectors**: TV-SCA-001
- **Notes**: The adapter already supports count operations.

### SCA-002
- **ID**: SCA-002
- **Priority**: P0
- **Statement**: Non-paginated clone MUST enforce `limits.maxCloneRecords` (default 10,000). When exceeded, return partial response with pagination cursors.
- **Rationale**: SCA-C2 — Unbounded clone loads all tables into memory.
- **Acceptance criteria**:
  - Total records across all tables counted before full load
  - If count > `maxCloneRecords`, auto-paginate response
  - Response includes `{ paginated: true, next: { table, afterId, limit } }`
  - Client receives enough data to continue with paginated requests
- **Test vectors**: TV-SCA-002, TV-SCA-003
- **Notes**: Decision #7 — Option B.

### SCA-003
- **ID**: SCA-003
- **Priority**: P0
- **Statement**: Extension transport pending map MUST have per-request timeout (default 30s) to prevent unbounded growth.
- **Rationale**: SCA-C3 — Background page crash leaves Promises hanging forever.
- **Acceptance criteria**:
  - Each RPC request has a 30s timeout
  - On timeout: reject Promise, remove from pending map
  - Timeout configurable
- **Test vectors**: TV-SCA-004
- **Notes**: Use `setTimeout` per request, clear on response.

### SCA-004
- **ID**: SCA-004
- **Priority**: P0
- **Statement**: `MemoryIdempotencyStore` MUST implement LRU eviction at `idempotencyMaxEntries` (default 100,000) and TTL sweep every 5 minutes.
- **Rationale**: SCA-C4 — Unbounded Map causes OOM on long-running servers.
- **Acceptance criteria**:
  - Entries older than `idempotencyTtlMs` (24h) evicted on sweep
  - Entries beyond `idempotencyMaxEntries` evicted LRU
  - Sweep interval: 5 minutes
  - Sweep timer is `unref()`'d
  - `destroy()` method to clear timer
- **Test vectors**: TV-SCA-005, TV-SCA-006
- **Notes**: Decision #11.

### SCA-005
- **ID**: SCA-005
- **Priority**: P1
- **Statement**: WebSocket manager MUST enforce `ws.maxConnections` (default 10,000) and `ws.maxConnectionsPerNamespace` (default 100) limits.
- **Rationale**: SCA-H1 — Connection storms grow set unboundedly.
- **Acceptance criteria**:
  - New connections rejected with 503 when global limit reached
  - New connections rejected when per-namespace limit reached
  - Existing connections not affected
- **Test vectors**: TV-SCA-007, TV-SCA-008
- **Notes**: Decision #8.

### SCA-006
- **ID**: SCA-006
- **Priority**: P1
- **Statement**: WebSocket broadcast MUST use namespace-scoped `Map<string, Set<Client>>` for O(1) namespace lookup instead of iterating all clients.
- **Rationale**: SCA-H2 — O(n) broadcast for every cursor update.
- **Acceptance criteria**:
  - Broadcast only sends to clients in matching namespace
  - Performance: O(clients-in-namespace) not O(all-clients)
  - addClient/removeClient maintain the namespace map
- **Test vectors**: TV-SCA-009
- **Notes**: Implementation detail — clients indexed by namespace.

### SCA-007
- **ID**: SCA-007
- **Priority**: P1
- **Statement**: `DbDataStore.create()` MUST NOT load non-primary resources with `where: []` (full scan).
- **Rationale**: SCA-H3 — Full table load for resources not needed.
- **Acceptance criteria**:
  - Only primary resource records loaded eagerly
  - Non-primary resources loaded on demand or with appropriate filters
- **Test vectors**: TV-SCA-010
- **Notes**: Lazy loading pattern.

### SCA-008
- **ID**: SCA-008
- **Priority**: P1
- **Statement**: `loadJoinRows` MUST filter by relevant record IDs instead of loading all join rows.
- **Rationale**: SCA-H4 — Full table scan for join tables.
- **Acceptance criteria**:
  - Join rows filtered by `from` IDs from the primary result set
  - For 100 primary records, only relevant join rows loaded (not 1M)
- **Test vectors**: TV-SCA-011
- **Notes**: Requires knowing primary record IDs before join load.

### SCA-009
- **ID**: SCA-009
- **Priority**: P1
- **Statement**: Aggregate `groupBy` MUST cap the number of groups at a configurable limit (default 10,000) to prevent memory exhaustion.
- **Rationale**: SCA-H5 — High-cardinality groupBy duplicates dataset in Map.
- **Acceptance criteria**:
  - When group count exceeds limit, return error or truncate with warning
  - Default cap: 10,000 groups
- **Test vectors**: TV-SCA-012
- **Notes**: Error is preferred over silent truncation.

### SCA-010
- **ID**: SCA-010
- **Priority**: P1
- **Statement**: Backward cursor pagination MUST NOT copy the entire result set with `[...records].reverse()`.
- **Rationale**: SCA-H6 — Doubles memory for backward pagination.
- **Acceptance criteria**:
  - Use in-place reverse or DB-level ORDER BY DESC
  - Memory usage does not double
- **Test vectors**: TV-SCA-013
- **Notes**: `.reverse()` mutates in place — just use it directly.

### SCA-011
- **ID**: SCA-011
- **Priority**: P1
- **Statement**: Offline changelog MUST have a configurable max size (default 10,000 entries) with oldest-first eviction.
- **Rationale**: SCA-H7 — Failed pushes append forever.
- **Acceptance criteria**:
  - Changelog capped at max entries
  - Oldest entries evicted when cap reached
  - Warning emitted when eviction occurs
- **Test vectors**: TV-SCA-014
- **Notes**: Eviction is a data loss event — must be logged.

### PER-001
- **ID**: PER-001
- **Priority**: P1
- **Statement**: Push MUST use `getNextServerSeqBatch(count)` to allocate all server sequences in one call instead of per-mutation.
- **Rationale**: PER-H1 — O(n) DB round-trips for n mutations.
- **Acceptance criteria**:
  - Single batch allocation call per push request
  - Sequences correctly assigned to individual mutations
  - Existing `getNextServerSeqBatch` API used
- **Test vectors**: TV-PER-001
- **Notes**: API already exists — just wire it up in push.

### PER-002
- **ID**: PER-002
- **Priority**: P1
- **Statement**: Dynamic `await import(...)` calls in hot request paths (route handlers) MUST be replaced with static top-level imports.
- **Rationale**: PER-H2 — Async overhead on every request.
- **Acceptance criteria**:
  - No `await import(...)` in route handler functions
  - Module imported at file top level
- **Test vectors**: N/A (performance, not correctness)
- **Notes**: Affects `routes/query.ts`, `routes/sync.ts`.

### PER-003
- **ID**: PER-003
- **Priority**: P1
- **Statement**: Push handler MUST NOT double-validate schema (handler AND executor).
- **Rationale**: PER-H3 — Validation overhead doubled.
- **Acceptance criteria**:
  - Schema validated once (in handler, before executor)
  - Executor trusts pre-validated input
- **Test vectors**: N/A (performance)
- **Notes**: Remove duplicate validation call.

### PER-004
- **ID**: PER-004
- **Priority**: P1
- **Statement**: Relation mutations MUST batch DB calls instead of sequential per-item calls.
- **Rationale**: PER-H4 — 50 items = 50+ DB round-trips.
- **Acceptance criteria**:
  - Multiple relation items processed with batch DB operations where adapter supports it
  - Fallback to sequential for adapters without batch support
- **Test vectors**: TV-PER-002
- **Notes**: `db.insertMany` / `db.deleteMany` patterns.

### PER-005
- **ID**: PER-005
- **Priority**: P1
- **Statement**: Relation filter evaluation MUST NOT load all records of the target resource; use targeted lookup instead.
- **Rationale**: PER-H5 — O(N*M) from loading all target records.
- **Acceptance criteria**:
  - Relation filter uses DB-level join or targeted query
  - Memory usage proportional to result set, not target table size
- **Test vectors**: TV-PER-003
- **Notes**: Use `findMany` with filter instead of `getRecords()`.

### PER-006
- **ID**: PER-006
- **Priority**: P1
- **Statement**: Changelog deduplication in `memoryStorage` MUST use a Set or Map for O(1) lookup instead of O(n) `.find()`.
- **Rationale**: PER-H6 — O(n^2) degradation on large changelogs.
- **Acceptance criteria**:
  - Deduplication uses index structure (Map/Set)
  - O(1) per append operation
- **Test vectors**: TV-PER-004
- **Notes**: Map keyed by mutationId.

### DI-001
- **ID**: DI-001
- **Priority**: P1
- **Statement**: `modifyRelation` MUST use atomic findOne+update (within transaction or CAS) to prevent TOCTOU race.
- **Rationale**: DI-H1 — Concurrent delete between find and update causes silent failure.
- **Acceptance criteria**:
  - Find and update in same transaction (when adapter supports it)
  - Failure to find during update → appropriate error
- **Test vectors**: TV-DI-001
- **Notes**: Same pattern as Decision #3 transaction approach.

### DI-002
- **ID**: DI-002
- **Priority**: P1
- **Statement**: Guard evaluation MUST use optimistic locking or execute within the mutation's transaction to prevent TOCTOU race.
- **Rationale**: DI-H2 — Record changes between guard check and mutation execution.
- **Acceptance criteria**:
  - Guard re-evaluated within transaction scope
  - Or: version check at mutation time detects stale guard evaluation
- **Test vectors**: TV-DI-002
- **Notes**: Transaction-scoped guards are simpler.

### DI-003
- **ID**: DI-003
- **Priority**: P1
- **Statement**: `FallbackSequenceStore` MUST detect and prevent overlapping sequence values after failover.
- **Rationale**: DI-H3 — Redis→DB failover can produce duplicate sequences.
- **Acceptance criteria**:
  - On failover, DB store reads max existing seq before allocating new ones
  - No duplicate serverSeq values produced
- **Test vectors**: TV-DI-003
- **Notes**: Max(existing) + 1 on failover init.

### DI-004
- **ID**: DI-004
- **Priority**: P1
- **Statement**: Join store key derivation MUST handle `string[]` for `from`/`to` fields (multi-resource relations), not cast to single string.
- **Rationale**: DI-H4 — Incorrect keys for multi-resource relations.
- **Acceptance criteria**:
  - `from`/`to` as `string[]` produces correct composite key
  - `from`/`to` as `string` works as before
- **Test vectors**: TV-DI-004
- **Notes**: Use `Array.isArray` check and join with separator.

### VAL-001
- **ID**: VAL-001
- **Priority**: P1
- **Statement**: `validateQueryAuthz` and `validateMutationAuthz` MUST return `FORBIDDEN` for resources with no authorization policy (deny-by-default).
- **Rationale**: M-V01 — Unknown resources are wide-open.
- **Acceptance criteria**:
  - Unknown resource → FORBIDDEN
  - Error message includes escape hatch instructions
  - Escape hatch: `allowUnknownResources: true` in config
- **Test vectors**: TV-VAL-001, TV-VAL-002
- **Notes**: Decision #12 — Option A.

### VAL-002
- **ID**: VAL-002
- **Priority**: P2
- **Statement**: Query `select` array MUST be limited to `limits.maxSelectTokens` (default 50) tokens.
- **Rationale**: M-V02 — Unbounded select can cause performance issues.
- **Acceptance criteria**:
  - Select with >50 tokens → `DFQL_INVALID`
  - Limit configurable
- **Test vectors**: TV-VAL-003
- **Notes**: Simple length check.

### VAL-003
- **ID**: VAL-003
- **Priority**: P2
- **Statement**: Filter object MUST be limited to `limits.maxFilterKeysPerLevel` (default 20) keys per nesting level.
- **Rationale**: M-V03 — Unbounded filter complexity.
- **Acceptance criteria**:
  - Filter with >20 keys at any level → `DFQL_INVALID`
  - Limit configurable
- **Test vectors**: TV-VAL-004
- **Notes**: Checked recursively.

### VAL-004
- **ID**: VAL-004
- **Priority**: P2
- **Statement**: Query `sort` array MUST be limited to `limits.maxSortFields` (default 10).
- **Rationale**: M-V04 — Unbounded sort complexity.
- **Acceptance criteria**:
  - Sort with >10 fields → `DFQL_INVALID`
- **Test vectors**: TV-VAL-005
- **Notes**: Simple length check.

### VAL-005
- **ID**: VAL-005
- **Priority**: P2
- **Statement**: Query `aggregations` count MUST be limited to `limits.maxAggregations` (default 20).
- **Rationale**: M-V05 — Unbounded aggregation complexity.
- **Acceptance criteria**:
  - >20 aggregation keys → `DFQL_INVALID`
- **Test vectors**: TV-VAL-006
- **Notes**: `Object.keys(aggregations).length`.

### VAL-006
- **ID**: VAL-006
- **Priority**: P2
- **Statement**: Record `id` field MUST be validated for maximum length `limits.maxIdLength` (default 255 chars).
- **Rationale**: M-V06 — Extremely long IDs cause DB issues.
- **Acceptance criteria**:
  - ID exceeding limit → `DFQL_INVALID`
  - Applied at mutation and push validation
- **Test vectors**: TV-VAL-007
- **Notes**: 255 matches typical VARCHAR limits.

### VAL-007
- **ID**: VAL-007
- **Priority**: P2
- **Statement**: `clientId` and `mutationId` MUST be validated at the validation layer for type (string) and reasonable length.
- **Rationale**: M-V07 — Currently not validated.
- **Acceptance criteria**:
  - Must be non-empty strings
  - Max length: 255 characters
  - Invalid → `DFQL_INVALID`
- **Test vectors**: TV-VAL-008
- **Notes**: Prevents abuse via oversized IDs.

### VAL-008
- **ID**: VAL-008
- **Priority**: P2
- **Statement**: `version` field in mutations MUST be validated as a positive integer.
- **Rationale**: M-V08 — Currently unvalidated.
- **Acceptance criteria**:
  - Must be positive integer if provided
  - Negative, zero, float, string → `DFQL_INVALID`
- **Test vectors**: TV-VAL-009
- **Notes**: Version used for schema migration.

### VAL-009
- **ID**: VAL-009
- **Priority**: P2
- **Statement**: Validation error messages MUST be generic in production (`debug: false`) and detailed in development (`debug: true`).
- **Rationale**: M-V09 — Schema disclosure aids attacker enumeration.
- **Acceptance criteria**:
  - Production: error code + generic message (no field names, no valid operators)
  - Development: full details (current behavior)
  - `debug` defaults to `process.env.NODE_ENV !== 'production'`
- **Test vectors**: TV-VAL-010, TV-VAL-011
- **Notes**: Decision #16 — Option A.

### VAL-010
- **ID**: VAL-010
- **Priority**: P2
- **Statement**: `limits.maxPayloadBytes` MUST default to 5,242,880 (5MB) instead of `undefined`.
- **Rationale**: M-V10 — No body size limit if unconfigured.
- **Acceptance criteria**:
  - Default 5MB limit applied when not configured
  - Override-able via config
- **Test vectors**: TV-VAL-012
- **Notes**: Decision #13.

### SRV-001
- **ID**: SRV-001
- **Priority**: P2
- **Statement**: REST routes SHOULD avoid creating synthetic Request objects; pass parameters directly to handlers.
- **Rationale**: M-S01 — Unnecessary allocation and coupling.
- **Acceptance criteria**:
  - REST handler receives parsed parameters directly
  - No synthetic Request construction
- **Test vectors**: N/A (refactoring)
- **Notes**: Internal refactoring, no API change.

### SRV-002
- **ID**: SRV-002
- **Priority**: P2
- **Statement**: `redactSensitiveFields` MUST check common sensitive field names (`password`, `token`, `secret`, `authorization`, `cookie`) in addition to `encrypt: true`.
- **Rationale**: M-S02 — Only `encrypt: true` fields redacted.
- **Acceptance criteria**:
  - Named fields redacted regardless of `encrypt` flag
  - Case-insensitive matching
- **Test vectors**: TV-SRV-001
- **Notes**: Simple string list check.

### SRV-003
- **ID**: SRV-003
- **Priority**: P2
- **Statement**: Batch query endpoint MUST limit concurrent queries (default: 20).
- **Rationale**: M-S03 — Unlimited `Promise.all` queries.
- **Acceptance criteria**:
  - Max concurrent queries configurable
  - Excess queries queued, not rejected
- **Test vectors**: TV-SRV-002
- **Notes**: Use `Promise.all` with chunking or a semaphore.

### SRV-004
- **ID**: SRV-004
- **Priority**: P2
- **Statement**: Mutation handler MUST NOT log full record data even after redaction.
- **Rationale**: M-S04 — PII exposure in logs.
- **Acceptance criteria**:
  - Log mutation metadata (resource, operation, ID) but not record contents
  - Debug mode may log record contents
- **Test vectors**: N/A (logging)
- **Notes**: Affects `routes/mutation.ts`.

### SRV-005
- **ID**: SRV-005
- **Priority**: P3
- **Statement**: `routes/query.ts` SHOULD be split into separate files for validation, conversion, and execution.
- **Rationale**: M-S05 — 600+ lines, mixed concerns.
- **Acceptance criteria**:
  - Separate files for query validation, DFQL conversion, execution
  - No behavior change
- **Test vectors**: N/A (refactoring)
- **Notes**: Optional improvement.

### SRV-006
- **ID**: SRV-006
- **Priority**: P2
- **Statement**: Timer phases MUST be measured per-query, not across `Promise.all` batch.
- **Rationale**: M-S06 — Inaccurate timing with parallel queries.
- **Acceptance criteria**:
  - Each query in a batch gets its own timing
  - Batch-level timing also reported
- **Test vectors**: N/A (observability)
- **Notes**: Affects `routes/query.ts`.

### SRV-007
- **ID**: SRV-007
- **Priority**: P2
- **Statement**: `getBodyFromContext` MUST NOT re-read a consumed request body.
- **Rationale**: M-S07 — Fallback may fail or produce empty results.
- **Acceptance criteria**:
  - Body cached after first read
  - Subsequent calls return cached body
- **Test vectors**: TV-SRV-003
- **Notes**: Simple caching pattern.

### SRV-008
- **ID**: SRV-008
- **Priority**: P2
- **Statement**: Status endpoint SHOULD NOT expose exact server time.
- **Rationale**: M-S08 — Aids timing attacks.
- **Acceptance criteria**:
  - Server time removed or rounded to minute granularity
- **Test vectors**: N/A (security hardening)
- **Notes**: Minor change.

### SRV-009
- **ID**: SRV-009
- **Priority**: P2
- **Statement**: Rate limit 429 response MUST include `Retry-After` header.
- **Rationale**: M-S10 — Clients cannot know when to retry.
- **Acceptance criteria**:
  - `Retry-After: {seconds}` header in 429 response
  - Value based on rate limit window remaining time
- **Test vectors**: TV-SRV-004
- **Notes**: HTTP standard.

### SRV-010
- **ID**: SRV-010
- **Priority**: P2
- **Statement**: `extractNamespace` MUST NOT default to `"datafn"` on auth failure; MUST return error or use a unique anonymous namespace.
- **Rationale**: M-S11 — Potential data leak to shared namespace.
- **Acceptance criteria**:
  - Auth failure → error, not fallback to default namespace
  - Only unauthenticated routes (status, health) may use default namespace
- **Test vectors**: TV-SRV-005
- **Notes**: Security improvement.

### SRV-011
- **ID**: SRV-011
- **Priority**: P2
- **Statement**: Rate limiter sweep timer MUST be `unref()`'d to allow graceful process exit.
- **Rationale**: M-S12 — Prevents process from exiting.
- **Acceptance criteria**:
  - Timer created with `.unref()` or `Timeout.unref()`
  - Process can exit when all other work is done
- **Test vectors**: N/A (process lifecycle)
- **Notes**: Also applies to idempotency sweep timer.

### SRV-012
- **ID**: SRV-012
- **Priority**: P2
- **Statement**: Transact handler SHOULD NOT re-validate step limits already validated by executor.
- **Rationale**: M-S13 — Duplicate work.
- **Acceptance criteria**:
  - Step limit checked once (handler or executor, not both)
- **Test vectors**: N/A (optimization)

### SRV-013
- **ID**: SRV-013
- **Priority**: P2
- **Statement**: Seed handler MUST return error when persistence fails, not success.
- **Rationale**: M-S14 — Silent failure misleads clients.
- **Acceptance criteria**:
  - Persistence error → 500 response with error details
- **Test vectors**: TV-SRV-006

### SRV-014
- **ID**: SRV-014
- **Priority**: P2
- **Statement**: `MemoryStore.getRecords` SHOULD cache sorted keys or use an insertion-ordered structure.
- **Rationale**: M-S15 — O(n log n) sort on every call.
- **Acceptance criteria**:
  - No re-sort when records haven't changed
- **Test vectors**: N/A (performance)

### SRV-015
- **ID**: SRV-015
- **Priority**: P1
- **Statement**: `$or` filter operator MUST be either implemented or rejected with `DFQL_INVALID: "$or filter operator is not yet supported"`.
- **Rationale**: M-S16 — Silent drop returns unfiltered results (data leak).
- **Acceptance criteria**:
  - `$or` either works correctly or returns explicit error
  - NEVER silently ignored
- **Test vectors**: TV-SRV-007, TV-SRV-008

### SRV-016
- **ID**: SRV-016
- **Priority**: P1
- **Statement**: Seed handler MUST derive namespace from authenticated context, consistent with other routes.
- **Rationale**: SEC-H3 — Hardcoded "datafn" namespace breaks multi-tenant isolation.
- **Acceptance criteria**: Same as SEC-011.
- **Test vectors**: Same as SEC-011.

### EXE-001 through EXE-022

*(Execution layer MEDIUM fixes — each follows the same template)*

**EXE-001** — P2 — Deduplicate `traverseFilter`/`traverseHaving` into shared function. (M-E01)
**EXE-002** — P2 — Replace O(n) linear scan in `setJoinRow` with Map-based lookup. (M-E02)
**EXE-003** — P2 — Add step index, operation, resource to transaction step error logs. (M-E03)
**EXE-004** — P2 — Cache data within transaction scope to avoid re-loading per query step. (M-E04)
**EXE-005** — P2 — Replace `message.includes()` error classification with error code matching. (M-E05)
**EXE-006** — P2 — Add locking or CAS to prevent double-execution race in MemoryIdempotencyStore. (M-E06)
**EXE-007** — P2 — `DbIdempotencyStore.get()` MUST throw on DB errors, not return null. (M-E07)
**EXE-008** — P2 — Delete operations SHOULD check record existence before recording change. (M-E08)
**EXE-009** — P2 — Replace `Date.now()+Math.random()` mutation IDs with `crypto.randomUUID()`. (M-E09)
**EXE-010** — P2 — Preserve original error information in mutation catch blocks. (M-E10)
**EXE-011** — P2 — Fix GuardDataStore to return cross-resource relation data. (M-E11)
**EXE-012** — P2 — Fix `findRelation` third matching condition ambiguity. (M-E12)
**EXE-013** — P2 — Cache schema lookup result for resolveValue instead of O(n) per record. (M-E13)
**EXE-014** — P2 — Compute FK omit set once per query, not per record. (M-E14)
**EXE-015** — P2 — Replace per-record full table scan in one-many expansion with batched lookup. (M-E15)
**EXE-016** — P2 — Fix cursor pushdown to pass limit to DB query. (M-E16)
**EXE-017** — P2 — Cap search IN clause to 1000 elements, paginate remainder. (M-E17)
**EXE-018** — P2 — Use batch insert for `recordChanges` instead of sequential. (M-E18)
**EXE-019** — P2 — `getCurrentServerSeq` MUST propagate errors, not return 0. (M-E19)
**EXE-020** — P2 — Wrap push mutations in transaction for atomic semantics. (M-E20)
**EXE-021** — P2 — Pull SHOULD fetch per-resource changes in parallel. (M-E21)
**EXE-022** — P2 — Fix `forQuery` to not fall back to full table scan. (M-E22)

### CLI-001 through CLI-014

*(Client/core MEDIUM fixes)*

**CLI-001** — P2 — Rename `createClientError` to `throwClientError` or make it return instead of throw. (M-C01)
**CLI-002** — P2 — Remove deprecated `switchableClient.ts` and its export from index.ts. (M-C02)
**CLI-003** — P2 — Return `null` for `Math.min/max(...[])` on empty sets. (M-C03)
**CLI-004** — P2 — Validate relation `from`/`to` against declared resource names in schema. (M-C04)
**CLI-005** — P2 — Copy subscription array before iteration in `emit()`. (M-C05)
**CLI-006** — P2 — Exempt `__health_check__` key from table validation. (M-C06)
**CLI-007** — P2 — Fix KV `merge` read-then-write race with CAS or transaction. (M-C07)
**CLI-008** — P2 — Remove unused `buildEvent` import. (M-C08)
**CLI-009** — P1 — Add recursion depth limit (10) on `$and`/`$or` filter evaluation. (M-C09)
**CLI-010** — P2 — Add exponential backoff to `pushBatchWithRetry`. (M-C10)
**CLI-011** — P3 — Implement incremental search index update on pull. (M-C11)
**CLI-012** — P2 — Remove redundant filter application after index-satisfied lookup. (M-C12)
**CLI-013** — P2 — Add max version cap or version reset strategy for IndexedDB. (M-C13)
**CLI-014** — P2 — Add `"reconcile"` to `DatafnRpcMethod` type. (M-C14)

### LOW-001 through LOW-034

*(All LOW severity — P3 priority)*

**LOW-001** — Remove `as any` casts in route registration. (L-S01)
**LOW-002** — Remove deprecated `enforcePayloadLimit` export. (L-S02)
**LOW-003** — Remove deprecated `parseJsonBodyOrThrow` export. (L-S03)
**LOW-004** — (Covered by LOG-001/002/003)
**LOW-005** — `unref()` pruneInterval timer. (L-S05)
**LOW-006** — Allow `afterQuery` hooks to transform results. (L-S06)
**LOW-007** — Fix aggregate `count` to respect `field` parameter. (L-S07)
**LOW-008** — Validate error shape in REST error handler. (L-S08)
**LOW-009** — Replace `JSON.stringify` in `logRequest` with lazy evaluation. (L-S09)
**LOW-010** — Cache MemoryStore sort result. (L-E01 — overlaps SRV-014)
**LOW-011** — Avoid `structuredClone` on large data in MemoryStore snapshot. (L-E02)
**LOW-012** — Document internal table index specifications. (L-E03)
**LOW-013** — Clarify `buildReplaceRecord` `updatedBy` handling. (L-E04)
**LOW-014** — Distinguish "not found" from "DB error" in guard errors. (L-E05)
**LOW-015** — Remove dead `mutation/records.ts` file. (L-E06)
**LOW-016** — Use binary search in `applyCursorAfter`. (L-E07)
**LOW-017** — Document null handling in cursor comparison. (L-E08)
**LOW-018** — Extract hardcoded system fields list in pushdown. (L-E09)
**LOW-019** — Don't mutate input array in `orderGroupedResults`. (L-E10)
**LOW-020** — Replace `any` types in aggregate.ts. (L-E11)
**LOW-021** — Remove unused `generateCursor`/`generateCursors`. (L-E12)
**LOW-022** — Fix offline aggregate group key delimiter collision. (L-C01)
**LOW-023** — Document `undefined` vs `null` semantics in normalize.ts. (L-C02)
**LOW-024** — Fix date.ts mutation vs codec copy inconsistency. (L-C03)
**LOW-025** — Document `isArchived` in SYSTEM_FIELDS but not READONLY. (L-C04)
**LOW-026** — Add `"TRANSPORT_ERROR"` to core error codes. (L-C05)
**LOW-027** — Remove unused `_schemaIndex` parameter. (L-C06)
**LOW-028** — Add resource/field count limits to `validateSchema`. (L-C07)
**LOW-029** — Use configurable `getTimestamp()` in softDelete plugin. (L-C08)
**LOW-030** — Remove dead `validateDotPath` function. (L-V01)
**LOW-031** — Type-validate filter operator values. (L-V02)
**LOW-032** — Normalize operator naming (always `$` prefix). (L-V03)
**LOW-033** — Redact sensitive data in console error handlers. (L-V04)
**LOW-034** — Document `destroy()` requirement for MemoryRateLimiter. (L-V05)

### TST-001 through TST-007

**TST-001** — P1 — Create security-focused test suite: prototype pollution, authz bypass (aggregation/groupBy/transact), WS auth, oversized values, special characters in IDs. (TG-1)
**TST-002** — P1 — Create namespace isolation test suite: verify User A cannot read User B's data via any endpoint. (TG-2)
**TST-003** — P2 — Uncomment and fix rollback assertions in `transact.test.ts`. (TG-3)
**TST-004** — P2 — Fix lenient conditional assertions in `execution-errors.test.ts`. (TG-4)
**TST-005** — P2 — Add concurrent mutation, guard, and push race condition tests. (TG-5)
**TST-006** — P3 — Add high-volume stress tests for large datasets and concurrent connections. (TG-6)
**TST-007** — P3 — Add clone pagination tests at scale. (TG-7)

### LOG-001 through LOG-003

**LOG-001** — P2 — Define `DatafnLogger` interface and add to `DatafnServerConfig`. (L-S04 / Decision #14)
**LOG-002** — P2 — Replace all `console.*` calls with `logger.*` calls.
**LOG-003** — P2 — Add structured context (request ID, namespace, operation) to all log calls.
