# TEST VECTORS

## Security — CRITICAL

### TV-SEC-001 — WS connection without auth rejected
- **Description**: WebSocket connection attempt without auth token
- **Input**: WS upgrade request with no `Authorization` header
- **Expected output**: WS close code `4401`, reason `"Authentication required"`
- **Negative**: Connection is NOT added to client set

### TV-SEC-002 — WS connection with valid auth accepted
- **Description**: WebSocket connection with valid auth
- **Input**: WS upgrade request with valid `Authorization: Bearer <token>`
- **Expected output**: Connection accepted, namespace derived from auth context

### TV-SEC-003 — WS hello message namespace ignored
- **Description**: Client sends hello with spoofed namespace
- **Input**: `{ type: "hello", clientId: "c1", cursor: "0", namespace: "other-tenant" }`
- **Expected output**: Client namespace remains the one derived from auth (e.g. `user:123`), not `other-tenant`

### TV-SEC-004 — WS cursor broadcast scoped to namespace
- **Description**: Cursor update only reaches clients in same namespace
- **Input**: Two clients: A (namespace `user:1`), B (namespace `user:2`). Cursor pushed for `user:1`
- **Expected output**: Client A receives cursor. Client B does NOT receive cursor

### TV-SEC-005 — Authz blocks aggregation on restricted field
- **Input**: `{ resource: "employees", aggregations: { avgSalary: { op: "avg", field: "salary" } } }`, policy: `read.fields: ["name", "email"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-006 — Authz blocks groupBy on restricted field
- **Input**: `{ resource: "employees", groupBy: ["salary"] }`, policy: `read.fields: ["name"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-007 — Authz blocks sort on restricted field
- **Input**: `{ resource: "employees", sort: ["-salary"] }`, policy: `read.fields: ["name"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-008 — Authz blocks having on restricted field
- **Input**: `{ resource: "employees", groupBy: ["department"], having: { salary: { $gt: 100000 } } }`, policy: `read.fields: ["department"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-009 — Authz blocks search.fields with restricted field
- **Input**: `{ resource: "employees", search: { query: "test", fields: ["salary"] } }`, policy: `read.fields: ["name"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-010 — Authz allows aggregation on permitted field
- **Input**: `{ resource: "employees", aggregations: { count: { op: "count", field: "name" } } }`, policy: `read.fields: ["name"]`
- **Expected output**: `{ ok: true, ... }`

### TV-SEC-011 — Transact mutation step authz enforced
- **Input**: `POST /datafn/transact { steps: [{ mutation: { resource: "employees", operation: "insert", record: { salary: 100000 } } }] }`, policy: `write.fields: ["name"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-012 — Transact query step authz enforced
- **Input**: `POST /datafn/transact { steps: [{ query: { resource: "employees", select: ["salary"] } }] }`, policy: `read.fields: ["name"]`
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-013 — Type validation: string field rejects number
- **Input**: `{ resource: "users", operation: "insert", record: { id: "u1", name: 123 } }`, schema: `name: { type: "string" }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID", message: "Field 'name' expects string, got number" } }`

### TV-SEC-014 — Type validation: number field rejects string
- **Input**: `{ record: { age: "twenty" } }`, schema: `age: { type: "number" }`
- **Expected output**: `{ ok: false, error: { message: "Field 'age' expects number, got string" } }`

### TV-SEC-015 — Type validation: number field rejects NaN
- **Input**: `{ record: { age: NaN } }`, schema: `age: { type: "number" }`
- **Expected output**: `{ ok: false, error: { message: "Field 'age' expects number, got NaN" } }`

### TV-SEC-016 — Type validation: boolean field rejects string
- **Input**: `{ record: { active: "true" } }`, schema: `active: { type: "boolean" }`
- **Expected output**: `{ ok: false, error: { message: "Field 'active' expects boolean, got string" } }`

### TV-SEC-017 — Type validation: date field accepts ISO string
- **Input**: `{ record: { createdAt: "2026-01-01T00:00:00Z" } }`, schema: `createdAt: { type: "date" }`
- **Expected output**: `{ ok: true }`

### TV-SEC-018 — Type validation: date field accepts epoch number
- **Input**: `{ record: { createdAt: 1767225600000 } }`, schema: `createdAt: { type: "date" }`
- **Expected output**: `{ ok: true }`

### TV-SEC-019 — Type validation: object field rejects array
- **Input**: `{ record: { metadata: [1, 2, 3] } }`, schema: `metadata: { type: "object" }`
- **Expected output**: `{ ok: false, error: { message: "Field 'metadata' expects object, got array" } }`

### TV-SEC-020 — Type validation: nullable field accepts null
- **Input**: `{ record: { bio: null } }`, schema: `bio: { type: "string", nullable: true }`
- **Expected output**: `{ ok: true }`

### TV-SEC-021 — Batch size limit enforced
- **Input**: Push request with 501 mutations, `limits.maxBatchSize: 500`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID", message: "Batch size 501 exceeds limit 500" } }`

### TV-SEC-022 — Batch within limit accepted
- **Input**: Push request with 500 mutations
- **Expected output**: `{ ok: true, applied: [...] }` (or appropriate success response)

### TV-SEC-023 — Byte-based payload limit: multi-byte content
- **Input**: Request body with 2MB of emoji (each char = 4 bytes, total ~8MB)
- **Expected output**: 413 Payload Too Large (body.length ~2M but byte length ~8M, exceeds 5MB)

### TV-SEC-024 — Byte-based payload limit: ASCII within limit
- **Input**: Request body with 4MB of ASCII JSON
- **Expected output**: Request processed normally

### TV-SEC-025 — Prototype pollution: top-level __proto__
- **Input**: `{ resource: "users", operation: "insert", record: { id: "u1", __proto__: { isAdmin: true } } }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID", message: "Disallowed key: __proto__" } }`

### TV-SEC-026 — Prototype pollution: nested constructor
- **Input**: `{ record: { id: "u1", metadata: { constructor: { prototype: {} } } } }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID", message: "Disallowed key: constructor" } }`

### TV-SEC-027 — Prototype pollution: in filter
- **Input**: `{ resource: "users", filters: { __proto__: { $eq: "test" } } }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID", message: "Disallowed key: __proto__" } }`

### TV-SEC-028 — Clean record accepted
- **Input**: `{ record: { id: "u1", name: "test", metadata: { key: "value" } } }`
- **Expected output**: `{ ok: true }` (no false positives)

### TV-SEC-029 — Relation authz: relate blocked
- **Input**: `{ resource: "tasks", operation: "relate", id: "t1", relation: "assignee", target: "u1" }`, policy: `write.fields: ["title"]` (no "assignee")
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN" } }`

### TV-SEC-030 — Relation authz: relate allowed
- **Input**: Same as above with policy: `write.fields: ["title", "assignee"]`
- **Expected output**: `{ ok: true }`

### TV-SEC-031 — REST path traversal: encoded slash
- **Input**: `GET /datafn/rest/users%2F..%2Fadmin/123`
- **Expected output**: 400 Bad Request

### TV-SEC-032 — REST path traversal: dot-dot
- **Input**: `GET /datafn/rest/../admin/123`
- **Expected output**: 400 Bad Request

### TV-SEC-033 — Seed uses authenticated namespace
- **Input**: Seed request with auth context `{ userId: "u1" }`
- **Expected output**: Records stored with namespace `user:u1`, not `"datafn"`

### TV-SEC-034 — Cross-tab invalid message ignored
- **Input**: `messageEvent.data = { malicious: true }`
- **Expected output**: No crash, no processing, message silently discarded

### TV-SEC-035 — Having clause field validated
- **Input**: `{ having: { nonexistent: { $gt: 5 } } }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_UNKNOWN_FIELD" } }`

### TV-SEC-036 — Having clause valid field accepted
- **Input**: `{ having: { count: { $gt: 5 } } }` where `count` is an aggregation alias
- **Expected output**: `{ ok: true }`

### TV-SEC-037 — GroupBy field validated against schema
- **Input**: `{ groupBy: ["nonexistent_field"] }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_UNKNOWN_FIELD" } }`

### TV-SEC-038 — GroupBy valid field accepted
- **Input**: `{ groupBy: ["status"] }` where `status` exists in schema
- **Expected output**: `{ ok: true }`

### TV-SEC-039 — LIKE pattern length enforced
- **Input**: `{ filters: { name: { $like: "%" + "a".repeat(300) } } }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID" } }`

### TV-SEC-040 — Search query length enforced
- **Input**: `{ search: { query: "a".repeat(1500), fields: ["name"] } }`
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID" } }`

---

## Reliability — CRITICAL

### TV-REL-001 — Transaction DB error returns INTERNAL
- **Input**: Transaction with 3 steps; DB throws serialization error on step 2
- **Expected output**: `{ ok: false, error: { code: "INTERNAL" } }`. No steps persisted

### TV-REL-002 — Transaction memory adapter uses sequential
- **Input**: Transaction with memory adapter (no `db.transaction`)
- **Expected output**: Sequential execution succeeds, results returned normally

### TV-REL-003 — Push change tracking failure fails mutation
- **Input**: Push with mutation that succeeds at DB level but `recordChange()` throws
- **Expected output**: Mutation in `errors` array, not in `applied`

### TV-REL-004 — Push change tracking retry succeeds
- **Input**: `recordChange()` fails first call, succeeds on retry
- **Expected output**: Mutation in `applied` (retry transparent to caller)

### TV-REL-005 — Rolled-back steps annotated
- **Input**: Transaction: step 0 insert (ok), step 1 insert (ok), step 2 fails
- **Expected output**: `results[0] = { ok: false, rolledBack: true, result: { ok: true, record: {...} } }`, `results[1] = { ok: false, rolledBack: true, ... }`, `results[2] = { ok: false, error: {...} }`

### TV-REL-006 — Successful transaction unchanged
- **Input**: Transaction with all steps succeeding
- **Expected output**: All results `ok: true`, no `rolledBack` field

### TV-REL-007 — DebouncerMap old Promise resolves
- **Input**: `set("key1", mutA)` → Promise P1. `set("key1", mutB)` → Promise P2
- **Expected output**: P1 resolves (not hangs). P2 executes merged mutation on flush

### TV-REL-008 — SyncEngine start idempotent
- **Input**: `engine.start()` called twice
- **Expected output**: Only one push interval timer created

### TV-REL-009 — Clone error emits sync_failed
- **Input**: Clone that throws network error
- **Expected output**: `sync_failed` event emitted with error. Resource state not `hydrating`

### TV-REL-010 — WS heartbeat closes dead connection
- **Input**: Client connected but stops responding to pings
- **Expected output**: After `heartbeatIntervalMs + heartbeatTimeoutMs`, connection closed and removed

### TV-REL-011 — Redis rate limiter atomic TTL
- **Input**: Rate limit check on new key
- **Expected output**: Key created with TTL in single atomic operation

### TV-REL-012 — Graceful shutdown drains
- **Input**: SIGTERM while request is in-flight
- **Expected output**: In-flight request completes. WS clients get close code 1001. Server resolves `close()`

### TV-REL-013 — CAS retry with backoff
- **Input**: CAS contention requiring 3 retries
- **Expected output**: Delays: ~10ms, ~20ms, ~40ms between attempts

### TV-REL-014 — Change tracking in transaction
- **Input**: Mutation within DB transaction
- **Expected output**: Change log entry committed atomically with mutation

### TV-REL-015 — No double event on offline fallback
- **Input**: Mutation while offline
- **Expected output**: Exactly one `mutation_applied` event emitted

### TV-REL-016 — Batch query date codec
- **Input**: Batch query on resource with date field
- **Expected output**: Date fields are Date objects (or ISO strings), not raw epoch numbers

### TV-REL-017 — Pull loop max iterations
- **Input**: Server writing continuously during pull
- **Expected output**: Pull stops after 50 iterations, next cycle continues

### TV-REL-018 — WS pullNow errors logged
- **Input**: WS message triggers pullNow which fails
- **Expected output**: Error logged, `sync_failed` event emitted

---

## Scalability — CRITICAL

### TV-SCA-001 — Reconcile uses count not findMany
- **Input**: Reconcile on table with 100k records
- **Expected output**: Count returned quickly without loading all records into memory

### TV-SCA-002 — Clone auto-paginates large dataset
- **Input**: Clone without `page` on 15k total records, `maxCloneRecords: 10000`
- **Expected output**: Response with `paginated: true`, partial data, `next` cursor

### TV-SCA-003 — Clone small dataset no pagination
- **Input**: Clone without `page` on 500 total records
- **Expected output**: Full data, no `paginated` flag

### TV-SCA-004 — Extension transport request timeout
- **Input**: RPC request, no response for 30s
- **Expected output**: Promise rejected with timeout error, entry removed from pending map

### TV-SCA-005 — Idempotency TTL eviction
- **Input**: Entry stored, wait >24h (or mock time), sweep runs
- **Expected output**: Entry evicted, `get()` returns null

### TV-SCA-006 — Idempotency LRU eviction
- **Input**: 100,001 entries stored (max 100,000)
- **Expected output**: Oldest entry evicted, newest retained

### TV-SCA-007 — WS global connection limit
- **Input**: 10,001st connection attempt
- **Expected output**: Rejected with 503

### TV-SCA-008 — WS per-namespace limit
- **Input**: 101st connection for same namespace (limit 100)
- **Expected output**: Rejected

### TV-SCA-009 — Namespace-scoped broadcast
- **Input**: Broadcast to namespace with 10 clients, 9990 clients in other namespaces
- **Expected output**: Only 10 `send()` calls

### TV-SCA-010 — DbDataStore lazy loading
- **Input**: Query on resource A, non-primary resource B exists
- **Expected output**: Resource B NOT loaded into memory

### TV-SCA-011 — Join row filtered loading
- **Input**: 100 primary records, 1M join rows total
- **Expected output**: Only join rows for the 100 records loaded

### TV-SCA-012 — Aggregate group cap
- **Input**: GroupBy on field with 15k unique values, cap at 10,000
- **Expected output**: Error returned, not 15k groups in memory

### TV-SCA-013 — Backward cursor no array copy
- **Input**: Backward pagination on 10k records
- **Expected output**: No `[...records]` copy (verify via code, not runtime test)

### TV-SCA-014 — Offline changelog cap
- **Input**: 10,001 changelog entries (cap 10,000)
- **Expected output**: Oldest entry evicted, warning emitted

---

## Performance — HIGH

### TV-PER-001 — Batch serverSeq in push
- **Input**: Push with 50 mutations
- **Expected output**: 1 `getNextServerSeqBatch(50)` call, not 50 `getNextServerSeq()` calls

### TV-PER-002 — Batch relation DB calls
- **Input**: Relate 50 items
- **Expected output**: <5 DB calls (batched), not 50+

### TV-PER-003 — Relation filter targeted lookup
- **Input**: Relation filter on resource with 100k target records
- **Expected output**: Only matching records loaded, not all 100k

### TV-PER-004 — Changelog dedup O(1)
- **Input**: Append to changelog with 10k existing entries
- **Expected output**: O(1) dedup check (Map lookup), not O(n) scan

---

## Data Integrity

### TV-DI-001 — modifyRelation atomic
- **Input**: Concurrent modifyRelation and delete on same record
- **Expected output**: Either modification succeeds or explicit error (no silent failure)

### TV-DI-002 — Guard in transaction scope
- **Input**: Guard check + mutation under concurrent update
- **Expected output**: Guard evaluated on same snapshot as mutation (no TOCTOU)

### TV-DI-003 — FallbackSequenceStore no duplicates
- **Input**: Redis→DB failover, DB already has seq=100
- **Expected output**: Next allocated seq ≥ 101

### TV-DI-004 — Join store key handles string[]
- **Input**: Relation with `from: ["typeA", "typeB"]`
- **Expected output**: Correct composite key generated, not `"typeA,typeB"` string cast

---

## Validation — MEDIUM

### TV-VAL-001 — Unknown resource denied by default
- **Input**: Query on `unknownResource` with no authz policy
- **Expected output**: `{ ok: false, error: { code: "FORBIDDEN", message: "...allowUnknownResources..." } }`

### TV-VAL-002 — Unknown resource allowed with escape hatch
- **Input**: Same as above with `allowUnknownResources: true`
- **Expected output**: `{ ok: true }`

### TV-VAL-003 — Select token limit
- **Input**: `select` with 51 tokens (limit 50)
- **Expected output**: `DFQL_INVALID`

### TV-VAL-004 — Filter key limit
- **Input**: Filter with 21 keys at one level
- **Expected output**: `DFQL_INVALID`

### TV-VAL-005 — Sort field limit
- **Input**: Sort with 11 fields
- **Expected output**: `DFQL_INVALID`

### TV-VAL-006 — Aggregation count limit
- **Input**: 21 aggregations
- **Expected output**: `DFQL_INVALID`

### TV-VAL-007 — ID length limit
- **Input**: Record with 300-char ID
- **Expected output**: `DFQL_INVALID`

### TV-VAL-008 — clientId/mutationId validated
- **Input**: Empty string `clientId`
- **Expected output**: `DFQL_INVALID`

### TV-VAL-009 — Version field validated
- **Input**: `version: -1`
- **Expected output**: `DFQL_INVALID`

### TV-VAL-010 — Production error messages generic
- **Input**: Invalid field in production mode (`debug: false`)
- **Expected output**: Error code present, no schema field names in message

### TV-VAL-011 — Development error messages detailed
- **Input**: Same as above with `debug: true`
- **Expected output**: Full details with field names and valid operators

### TV-VAL-012 — Default payload limit applied
- **Input**: 6MB request body with no `maxPayloadBytes` configured
- **Expected output**: 413 Payload Too Large

---

## Server — MEDIUM

### TV-SRV-001 — Sensitive field redaction
- **Input**: Log call with record containing `password: "secret123"`
- **Expected output**: Logged as `password: "[REDACTED]"`

### TV-SRV-002 — Batch query concurrency limit
- **Input**: Batch of 30 queries (limit 20)
- **Expected output**: 20 execute in parallel, 10 queued, all complete

### TV-SRV-003 — Body caching
- **Input**: `getBodyFromContext` called twice
- **Expected output**: Same body returned both times, no re-read

### TV-SRV-004 — Rate limit Retry-After header
- **Input**: Rate limited request
- **Expected output**: 429 response with `Retry-After: N` header

### TV-SRV-005 — extractNamespace auth failure
- **Input**: Request with invalid auth token
- **Expected output**: Error returned, NOT fallback to `"datafn"` namespace

### TV-SRV-006 — Seed persistence failure
- **Input**: Seed request where DB insert throws
- **Expected output**: 500 response with error (not 200 success)

### TV-SRV-007 — $or filter rejected
- **Input**: `{ filters: { $or: [{ name: "a" }, { name: "b" }] } }` (if not implemented)
- **Expected output**: `{ ok: false, error: { code: "DFQL_INVALID", message: "$or filter operator is not yet supported" } }`

### TV-SRV-008 — $or filter NOT silently dropped
- **Input**: Same as above
- **Expected output**: NOT `{ ok: true, records: [all records] }` (current broken behavior)
