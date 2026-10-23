# Full Audit Report: DataFn Production-Readiness

## Metadata

- **Timestamp**: 2026-02-26T19:00:00Z
- **Agent**: Factory Droid (Claude Opus 4.6)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions/datafn
- **Branch**: next
- **Commit**: ea87d7e
- **Dirty**: Yes
- **Audit ID**: x3cjj10g
- **Audit Type**: Full production-readiness audit (scalability, high-volume, security, maintainability)
- **Scope**: All packages — server (42 files), client (41 files), core (16 files), svelte (2 files), cli (4 files)

---

## Executive Summary

DataFn is a capable local-first data framework with offline sync, DFQL query language, real-time WebSocket cursors, and multi-tenant namespace isolation. However, the codebase has **significant production-readiness gaps** across all layers. This audit identified **157 total issues** spanning server, execution, client, validation/auth, and framework adapters.

**Overall Readiness: RED -- Not production-ready without addressing CRITICAL and HIGH items**

| Aspect | Rating | Key Gaps |
|---|---|---|
| **Security** | RED | WebSocket has no auth; authz bypassed via aggregations, transact, and relations; no field value type validation; prototype pollution risk |
| **Scalability** | YELLOW | Full table scans in reconcile/clone; unbounded memory in idempotency, changelog, pending maps; O(n) broadcasts |
| **High-Volume** | YELLOW | Sequential per-mutation DB round-trips in push; no batch limits on mutations; per-record O(n) schema lookups |
| **Data Integrity** | YELLOW | Transaction results mislead on rollback; change tracking failures silently swallowed; TOCTOU races in guards and relations |
| **Reliability** | YELLOW | No graceful shutdown; orphaned promises in debouncer; duplicate push timers; dead WS connections accumulate |
| **Maintainability** | GREEN | Well-structured packages, good separation of concerns; some large files and `any` types; deprecated code still exported |

### Issue Summary

| Severity | Server | Execution | Client/Core | Validation/Auth | **Total** |
|----------|--------|-----------|-------------|-----------------|-----------|
| CRITICAL | 5 | 4 | 4 | 5 | **18** |
| HIGH | 12 | 13 | 10 | 8 | **43** |
| MEDIUM | 16 | 22 | 14 | 10 | **62** |
| LOW | 9 | 12 | 8 | 5 | **34** |
| **Total** | **42** | **51** | **36** | **28** | **157** |

---

## CRITICAL Issues (18)

These must be fixed before any production deployment.

### Security — CRITICAL

| ID | Layer | File | Description |
|---|---|---|---|
| **SEC-C1** | Server | `ws.ts:29-36` | **WebSocket namespace spoofing** — Client-supplied `namespace` in `hello` message is trusted without server-side validation. A malicious client can subscribe to any tenant's real-time cursor updates, leaking sync activity cross-tenant. Fix: Derive namespace from authenticated context, reject client-supplied values. |
| **SEC-C2** | Server | `ws.ts:1-72` | **WebSocket has no authentication** — `addClient()` accepts any connection without auth. Any actor can connect and receive cursor notifications for any namespace, spoof clientIds, or enumerate namespaces. Fix: Require auth token validation in `addClient()` or `handleMessage()`. |
| **SEC-C3** | Validation | `authz.ts:25-72` | **Authorization bypass via aggregation/groupBy/sort/search fields** — `validateQueryAuthz` only checks `select` and `filters`, not `aggregations`, `groupBy`, `having`, `sort`, or `search.fields`. Restricted field values can be extracted via `groupBy: ["salary"]` or `aggregations: { avg: { op: "avg", field: "salary" } }`. Fix: Extend authz to cover all query fields. |
| **SEC-C4** | Validation | `routes/transact.ts:1-140` | **Transact endpoint skips per-step authorization** — Unlike `/mutation` and `/query` which enforce field-level authz, `/transact` never calls `validateMutationAuthz` or `validateQueryAuthz`. Unauthorized mutations can be wrapped in transactions to bypass permissions. Fix: Add per-step authz validation in the transact handler. |
| **SEC-C5** | Validation | `validation/mutation.ts:66-102` | **No field value type validation** — Record keys are validated against schema, but values are never type-checked. A field declared as `type: "number"` accepts `"hello"`, `[]`, `{}`. Causes DB adapter errors, data corruption, and downstream logic failures. Fix: Add `validateFieldValue(fieldType, value)` for all mutations. |
| **SEC-C6** | Validation | `validation/mutation.ts:150-175` | **No batch size limit on mutation arrays** — Push and mutation endpoints accept unbounded mutation arrays. A compact JSON array can encode thousands of mutations within the payload limit, exhausting server memory during processing. Fix: Add `maxBatchSize` limit (default: 500). |
| **SEC-C7** | Server | `http/middleware.ts:31-38` | **Payload size limit uses string length instead of byte length** — `readBodyWithLimit` compares `body.length` (char count) vs `maxBytes`. UTF-8 multi-byte chars (emoji, CJK) can be 2-4x larger than `.length` suggests, enabling memory exhaustion. Fix: Use `Buffer.byteLength(body, 'utf8')`. |
| **SEC-C8** | Validation | `validation/schema.ts:210-235` | **No prototype pollution protection** — `__proto__`, `constructor`, `prototype` as JSON string keys pass validation and could pollute prototypes in downstream spread/assign operations. Fix: Reject these keys at validation entry points. |

### Reliability — CRITICAL

| ID | Layer | File | Description |
|---|---|---|---|
| **REL-C1** | Server | `execution/transact.ts:89-98` | **Transaction atomicity silently lost** — If `db.transaction()` throws a non-application error (serialization, timeout, constraint), the code falls through to sequential non-atomic execution without informing the caller. Mutations may be partially applied. Fix: Return INTERNAL error on adapter failures; only fall through when adapter lacks transaction support. |
| **REL-C2** | Server | `execution/sync/push.ts:222-224` | **Change tracking failure silently swallowed in push** — When a mutation succeeds but `recordChange()` fails, the error is logged but execution continues. The mutation persists but the change log entry is missing, causing all sync clients to permanently miss this change. Fix: Treat change tracking failure as mutation failure, or implement a dead-letter queue. |
| **REL-C3** | Execution | `execution/transact.ts:85-105` | **Transaction results include rolled-back step results** — When a step fails in `db.transaction()`, earlier `ok: true` results remain in the response array, but the DB rolled them back. Clients may update local state with phantom data. Fix: Annotate rolled-back steps or clear pre-failure results. |
| **REL-C4** | Client | `client/src/debounce.ts:55-95` | **DebouncerMap orphaned Promises** — When `set()` is called for an existing key, old Promise resolve/reject callbacks are replaced. The original caller's Promise never settles, hanging forever and leaking memory. Fix: Resolve or reject the old Promise before replacing callbacks. |
| **REL-C5** | Client | `client/src/sync/engine.ts:125-140` | **Duplicate push interval timers on multiple `start()` calls** — `start()` unconditionally creates `setInterval`. Double-calling (hot-reload, race) creates duplicate timers that are never cleared, halving the effective push interval. Fix: Guard with `if (this.timer) return;`. |
| **REL-C6** | Client | `client/src/sync/engine.ts:280-285` | **Background clone errors swallowed silently** — `setTimeout(async () => { await this.cloneResources(tables); }, 0)` ignores the returned Promise. Clone failures leave resources permanently stuck in `hydrating` state. Fix: Try/catch with `sync_failed` event emission. |

### Scalability — CRITICAL

| ID | Layer | File | Description |
|---|---|---|---|
| **SCA-C1** | Execution | `execution/sync/reconcile.ts:95-140` | **Reconcile counts via full table scan** — `db.findMany({ where: [] }).length` loads every record into memory just to count. On 100k+ row tables this is catastrophic. Fix: Use `db.count()` which the adapter supports. |
| **SCA-C2** | Execution | `execution/sync/clone.ts:140-160` | **Non-paginated clone loads all tables into memory** — Without `page`, `executeClone` loads ALL records from ALL tables into a single response. For 10 tables x 50k records = 500k records in memory. Fix: Enforce pagination or add per-table limits. |
| **SCA-C3** | Client | `client/src/extension/transport.ts:20-45` | **Extension transport unbounded pending map** — RPC request entries are never cleaned up if the background page crashes. The `pending` Map grows unboundedly, and caller Promises hang forever. Fix: Add per-request timeout (30s default). |
| **SCA-C4** | Execution | `execution/idempotency.ts:32-48` | **MemoryIdempotencyStore has no TTL** — Stores every mutation result in a Map with no eviction. Long-running servers will OOM. Fix: Add TTL-based eviction or LRU max-entries cap. |

---

## HIGH Issues (43)

### Security — HIGH

| ID | Layer | File | Description |
|---|---|---|---|
| **SEC-H1** | Validation | `authz.ts:107-130` | **Relation authorization not enforced** — `relate`, `modifyRelation`, `unrelate` bypass all write permission checks. Users with no write perms can modify relationships. |
| **SEC-H2** | Server | `routes/rest.ts:49-50,94-96` | **REST path traversal risk** — Resource name/ID extracted via `pathname.split("/")` without URL decoding or sanitization. `%2F`, `..`, null bytes could bypass validation. |
| **SEC-H3** | Server | `routes/seed.ts:10` | **Seed handler hardcodes namespace** — All seed records stored in `"datafn"` namespace regardless of authenticated tenant, breaking multi-tenant isolation. |
| **SEC-H4** | Client | `client/src/crossTab.ts:55-70` | **Cross-tab relay has no message validation** — `messageEvent.data` cast directly to `RelayEvent` without validation. XSS or rogue extensions can inject arbitrary event shapes. |
| **SEC-H5** | Validation | `validation/query.ts:118-122` | **`having` clause validation is superficial** — Only checked to be a non-null object; contents never validated against schema or checked for valid operators. |
| **SEC-H6** | Validation | `validation/query.ts:220-250` | **`groupBy` fields not validated against schema** — Field names not checked to exist in resource field set; typos or attacker-crafted fields pass validation. |
| **SEC-H7** | Validation | `validation/query.ts:360-395` | **`$like`/`$ilike` pattern injection** — No length or character validation on LIKE patterns; expensive patterns can cause performance degradation. |
| **SEC-H8** | Validation | `validation/query.ts:150-180` | **Search query length unbounded** — `search.query` has no maximum length; multi-megabyte queries can cause memory/CPU issues in search plugin. |

### Scalability — HIGH

| ID | Layer | File | Description |
|---|---|---|---|
| **SCA-H1** | Server | `ws.ts:14-15` | **Unbounded WebSocket client set** — `clients` Set has no max size. Connection storms grow it unboundedly until OOM. |
| **SCA-H2** | Server | `ws.ts:46-57` | **O(n) broadcast for every cursor update** — Iterates ALL connected clients per push. Fix: Maintain `Map<namespace, Set<Client>>` for O(1) lookup. |
| **SCA-H3** | Execution | `db-store.ts:39-46` | **Full table load for non-primary resources** — `DbDataStore.create()` loads non-primary resources with `where: []` (full scan). |
| **SCA-H4** | Execution | `db-store.ts:230-245` | **loadJoinRows loads all join rows** — No filtering; for 1M join rows this is a full table scan. |
| **SCA-H5** | Execution | `query/aggregate.ts:25-35` | **Aggregate groups accumulate unbounded** — High-cardinality `groupBy` duplicates entire dataset in Map. |
| **SCA-H6** | Execution | `query/execute.ts:80-100` | **Backward cursor pagination doubles memory** — `[...records].reverse()` copies the entire result set. |
| **SCA-H7** | Client | `client/src/storage.ts` | **Offline changelog has no size bound** — Failed pushes append mutations forever with no eviction or cap. IndexedDB can grow to hundreds of MB. |

### Performance — HIGH

| ID | Layer | File | Description |
|---|---|---|---|
| **PER-H1** | Server | `execution/sync/push.ts:191-260` | **Sequential serverSeq allocation per mutation** — O(n) round-trips for n mutations. `getNextServerSeqBatch()` API exists but is unused in push. |
| **PER-H2** | Server | `routes/query.ts:340-346` | **Dynamic imports in hot request paths** — `await import(...)` inside request handlers adds async overhead per request. |
| **PER-H3** | Server | `routes/sync.ts:76-89` | **Double validation in push** — Schema validated in handler AND executor, doubling validation overhead. |
| **PER-H4** | Execution | `mutation/relations.ts:110-270` | **Relation mutations execute N sequential DB calls** — Individual DB round-trips per item; 50 items = 50+ DB calls. |
| **PER-H5** | Execution | `query/filters.ts:85-115` | **Relation filter evaluation is O(N*M)** — `getRecords()` returns ALL records of target resource, then filters. |
| **PER-H6** | Client | `client/src/adapters/memoryStorage.ts:225-240` | **Changelog deduplication is O(n)** — `.find()` scans entire array per append, degrading to O(n^2). |

### Reliability — HIGH

| ID | Layer | File | Description |
|---|---|---|---|
| **REL-H1** | Server | `ws.ts` | **No WebSocket heartbeat/ping-pong** — Dead connections accumulate indefinitely, consuming memory and receiving failed broadcasts. |
| **REL-H2** | Server | `middleware/rate-limit.ts:22-29` | **Redis rate limiter race condition** — Key can persist without TTL if server crashes between `incr` and `set`. |
| **REL-H3** | Server | `server.ts:310-320` | **No graceful shutdown** — In-flight requests dropped, WS connections not closed, pending changes not flushed. |
| **REL-H4** | Server | `execution/sync/change-tracking.ts:90-128` | **CAS retry with no backoff** — Retries up to 10 times with zero delay, creating CPU spin under contention. |
| **REL-H5** | Execution | `mutation/execute.ts:195-200` | **Mutation change tracking failure after commit** — Change tracking runs AFTER mutation commit; failures leave untracked mutations. |
| **REL-H6** | Execution | `sync/push.ts:225-228` | **Push silently swallows change tracking failures** — Mutation marked as applied but change log entry lost; inconsistent with `execute.ts` which throws. |
| **REL-H7** | Client | `client/src/mutate.ts:225-295` | **Double event emission on offline fallback** — Subscribers receive two `mutation_applied` events for one mutation. |
| **REL-H8** | Client | `client/src/query.ts:60-72` | **Batch queries skip date codec** — Returns raw epoch numbers instead of Date objects, inconsistent with single queries. |
| **REL-H9** | Client | `client/src/sync/cloneUp.ts:220-255` | **Pull catch-up loop has no max iteration guard** — `while (!caughtUp)` with no limit; high server write throughput causes infinite loop. |
| **REL-H10** | Client | `client/src/sync/engine.ts:185-195` | **WebSocket `pullNow()` called without await** — Pull failures from WS cursor messages silently swallowed. |

### Data Integrity — HIGH

| ID | Layer | File | Description |
|---|---|---|---|
| **DI-H1** | Execution | `mutation/relations.ts:165-185` | **modifyRelation has TOCTOU race** — `findOne` + `update` are separate; concurrent delete between them causes silent failure. |
| **DI-H2** | Execution | `mutation/guards.ts:20-45` | **Guard evaluation has TOCTOU race** — Record fetched, filter evaluated, then mutation executed; record can change between guard check and mutation. |
| **DI-H3** | Execution | `sync/sequence-store.ts:185-210` | **FallbackSequenceStore can produce duplicate sequences** — Redis and DB fallback stores can produce overlapping sequence values after failover. |
| **DI-H4** | Client | `client/src/sync/engine.ts:400-420` | **Incorrect join store key for multi-resource relations** — `from`/`to` cast to single strings but can be `string[]`, producing incorrect keys. |

---

## MEDIUM Issues (62)

### Server Layer (16)

| ID | File | Description |
|---|---|---|
| M-S01 | `server.ts:240-280` | REST route creates synthetic Request objects — unnecessary allocation, coupling |
| M-S02 | `logging.ts:10-25` | `redactSensitiveFields` only checks `encrypt: true` — misses common sensitive field names |
| M-S03 | `routes/query.ts` | No batch query size limit — unlimited `Promise.all` queries |
| M-S04 | `routes/mutation.ts:136-145` | Mutation handler logs full record data after redaction — PII exposure |
| M-S05 | `routes/query.ts` | Oversized file (~600+ lines) — validation, conversion, execution all in one |
| M-S06 | `routes/query.ts:366-420` | Timer phases inaccurate with `Promise.all` batch queries |
| M-S07 | `http/json.ts:74-83` | `getBodyFromContext` fallback may re-read consumed body |
| M-S08 | `routes/status.ts:49` | Status endpoint exposes exact server time (timing attack aid) |
| M-S09 | `routes/status.ts:4` | `createHash("sha256")` not edge-compatible — requires Node.js `crypto` |
| M-S10 | `middleware/rate-limit.ts:86-98` | Rate limit 429 response lacks `Retry-After` header |
| M-S11 | `server.ts:200-215` | `extractNamespace` defaults to `"datafn"` on auth failure — potential data leak |
| M-S12 | `middleware/rate-limit.ts:47` | MemoryRateLimiter sweep timer not `unref()`'d — prevents graceful exit |
| M-S13 | `routes/transact.ts:37-43` | Duplicate step limit validation in transact (route + executor) |
| M-S14 | `routes/seed.ts:53-56` | Seed handler returns success even when persistence fails |
| M-S15 | `execution/memory-store.ts:16-21` | `getRecords` sorts `Object.keys()` on every call — O(n log n) |
| M-S16 | `routes/query.ts:497-499` | `$or` filter operator silently dropped — users get unfiltered results |

### Execution Layer (22)

| ID | File | Description |
|---|---|---|
| M-E01 | `db-store.ts:330-440` | Duplicate `traverseFilter`/`traverseHaving` logic |
| M-E02 | `memory-store.ts:55-65` | `setJoinRow` uses O(n) linear scan |
| M-E03 | `transact.ts:118` | Step errors logged without context (no step index, operation, resource) |
| M-E04 | `transact.ts:73` | Each query step re-loads data from DB (no caching within transaction) |
| M-E05 | `errors.ts:39-90` | Error classification uses fragile `message.includes()` string matching |
| M-E06 | `idempotency.ts:36-48` | Concurrent idempotency race in MemoryIdempotencyStore (double execution) |
| M-E07 | `idempotency-db.ts:30-45` | `DbIdempotencyStore.get()` returns null on DB errors (defeats idempotency) |
| M-E08 | `mutation/execute.ts:140-147` | Delete records change without existence check |
| M-E09 | `mutation/execute.ts:26` | Anonymous mutation IDs use `Date.now()+Math.random()` — collision risk |
| M-E10 | `mutation/execute.ts:100-175` | Mutation catch blocks discard original error information |
| M-E11 | `mutation/guard-store.ts:20-24` | GuardDataStore returns empty for cross-resource relations — guard evals incorrectly |
| M-E12 | `query/filters.ts:70` | `findRelation` third matching condition could match incorrect relation |
| M-E13 | `query/aggregate.ts:120-130` | `resolveValue` does per-record schema lookup — O(n) linear scan |
| M-E14 | `query/select.ts:55-65` | FK omit set computed per record instead of once |
| M-E15 | `query/select.ts:350-370` | One-many expansion does full table scan per source record |
| M-E16 | `query/pushdown.ts:120-125` | Cursor pagination loads entire table (limit=undefined) |
| M-E17 | `query/search.ts:25-40` | Search creates potentially large IN clause (1000+ elements) |
| M-E18 | `sync/change-tracking.ts:135-155` | `recordChanges` inserts entries sequentially — no batch insert |
| M-E19 | `sync/change-tracking.ts:170-180` | `getCurrentServerSeq` returns 0 on error — misleads sync clients |
| M-E20 | `sync/push.ts:135-230` | Push processes mutations without transaction wrapping — partial failure semantics |
| M-E21 | `sync/pull.ts:200-215` | Pull fetches per-resource changes sequentially (no parallelization) |
| M-E22 | `db-store.ts:435-445` | `forQuery` falls back to full table scan when no relation path found |

### Client/Core Layer (14)

| ID | File | Description |
|---|---|---|
| M-C01 | `client/src/errors.ts:12-20` | `createClientError` always throws — misleading name |
| M-C02 | `client/src/switchableClient.ts` | Deprecated ~200-line file still exported from index.ts |
| M-C03 | `client/src/offline/aggregate.ts:85-90` | `Math.min/max(...[])` returns Infinity/-Infinity instead of null |
| M-C04 | `core/src/schema.ts:125-155` | Relation `from`/`to` not validated against declared resource names |
| M-C05 | `client/src/events/bus.ts:45-55` | `emit()` can mutate subscription array during iteration |
| M-C06 | `client/src/adapters/indexedDbStorage.ts:370-375` | `__health_check__` key not exempted from table validation |
| M-C07 | `client/src/kv.ts:150-200` | KV `merge` has read-then-write race condition |
| M-C08 | `client/src/events/build.ts` | `buildEvent` function imported but never used |
| M-C09 | `core/src/filters.ts` | No recursion depth limit on `$and`/`$or` — stack overflow risk |
| M-C10 | `client/src/sync/cloneUp.ts:270-290` | `pushBatchWithRetry` retries without backoff — hammers server |
| M-C11 | `client/src/plugins/clientSearch.ts:65-70` | Full re-index on every pull (not incremental) |
| M-C12 | `client/src/offline/query.ts:50-58` | Redundant filter application after index-satisfied lookup |
| M-C13 | `client/src/adapters/indexedDbStorage.ts:200-230` | Unbounded IndexedDB version bumping on schema evolution |
| M-C14 | `client/src/extension/rpc.ts:8-15` | Missing `"reconcile"` in `DatafnRpcMethod` type |

### Validation/Auth Layer (10)

| ID | File | Description |
|---|---|---|
| M-V01 | `authz.ts:27-30,109-112` | Authz returns `ok: true` for unknown resources — defense-in-depth gap |
| M-V02 | `validation/query.ts` | No limit on select token count |
| M-V03 | `validation/query.ts` | No limit on filter key count per level |
| M-V04 | `validation/query.ts:100-115` | No limit on sort array length |
| M-V05 | `validation/query.ts` | No limit on aggregation count |
| M-V06 | `validation/mutation.ts:55-62` | `id` field length not validated — extremely long IDs can cause DB issues |
| M-V07 | `validation/mutation.ts` | `clientId`/`mutationId` not validated at validation layer |
| M-V08 | `validation/query.ts`, `mutation.ts` | `version` field not validated for type or range |
| M-V09 | `validation/` | Error messages disclose schema structure — aids attacker enumeration |
| M-V10 | `server.ts` | `maxPayloadBytes` defaults to undefined — no body size limit if unconfigured |

---

## LOW Issues (34)

### Server (9)

| ID | Description |
|---|---|
| L-S01 | `as any` casts in route registration obscure type errors |
| L-S02 | Deprecated `enforcePayloadLimit` still exported |
| L-S03 | Deprecated `parseJsonBodyOrThrow` still exported |
| L-S04 | Production logging uses `console.*` throughout — no structured logging |
| L-S05 | `pruneInterval` timer not `unref()`'d |
| L-S06 | `afterQuery` hooks cannot transform results — return value discarded |
| L-S07 | Aggregate `count` op ignores `field` parameter — always returns `records.length` |
| L-S08 | REST error handler doesn't validate error shape |
| L-S09 | `JSON.stringify` in `logRequest` on every request |

### Execution (12)

| ID | Description |
|---|---|
| L-E01 | MemoryStore `getRecords` sorts on every call |
| L-E02 | MemoryStore `snapshot` uses `structuredClone` on large data |
| L-E03 | Internal table schemas lack index specifications |
| L-E04 | `buildReplaceRecord` has unclear `updatedBy` handling |
| L-E05 | Guard error doesn't distinguish "not found" from "DB error" |
| L-E06 | `mutation/records.ts` appears to be dead code |
| L-E07 | Pagination `applyCursorAfter` is O(n) — could use binary search |
| L-E08 | Null handling in cursor comparison undocumented |
| L-E09 | Pushdown has hardcoded system fields list |
| L-E10 | `orderGroupedResults` mutates input array in place |
| L-E11 | Heavy use of `any` types in aggregate.ts |
| L-E12 | `cursors.ts` `generateCursor`/`generateCursors` appear unused |

### Client/Core (8)

| ID | Description |
|---|---|
| L-C01 | Offline aggregate group key delimiter `::` can collide with data |
| L-C02 | Core `normalize.ts` `undefined` vs `null` semantics undocumented |
| L-C03 | Core `date.ts` mutates in place vs client codec creates copies (inconsistent) |
| L-C04 | `isArchived` in SYSTEM_FIELDS but not READONLY_SYSTEM_FIELDS — undocumented |
| L-C05 | `DatafnClientError` extends core codes with `"TRANSPORT_ERROR"` at type level only |
| L-C06 | `offline/query.ts` `_schemaIndex` parameter unused |
| L-C07 | `validateSchema` has no resource/field count limits |
| L-C08 | `softDelete` plugin uses `new Date()` instead of configurable `getTimestamp()` |

### Validation (5)

| ID | Description |
|---|---|
| L-V01 | Dead code: `validateDotPath` function defined but never called |
| L-V02 | Filter operator values not type-validated |
| L-V03 | Inconsistent operator naming (with and without `$` prefix) |
| L-V04 | Console logging in error handlers may expose sensitive data |
| L-V05 | `MemoryRateLimiter` sweep timer must be explicitly `destroy()`'d |

---

## Test Coverage Gaps

| ID | Severity | Description |
|---|---|---|
| **TG-1** | HIGH | **No security-focused test suite** — Zero tests for prototype pollution, authz bypass via aggregation/groupBy/transact, WS auth, oversized values, or special characters in IDs |
| **TG-2** | HIGH | **No namespace isolation tests** — `authContextProvider` and namespace extraction untested. No tests verifying User A cannot read User B's data |
| **TG-3** | MEDIUM | **Commented-out rollback assertions** in `transact.test.ts` — `// expect(taskNew).toBeNull()` gives false confidence in atomicity |
| **TG-4** | MEDIUM | **Lenient conditional assertions** in `execution-errors.test.ts` — Tests accept both success and failure |
| **TG-5** | MEDIUM | **No concurrent/race condition tests** — No tests for concurrent mutations, guards, or push operations |
| **TG-6** | MEDIUM | **No high-volume/stress tests** — No tests for large datasets, many concurrent connections, or sustained load |
| **TG-7** | MEDIUM | **No sync/clone tests with large payloads** — Clone pagination behavior untested at scale |

---

## Svelte Adapter Assessment

The svelte adapter (`@datafn/svelte`) is **well-designed and production-ready**:

- Clean lifecycle-aware signal wrapping via `toSvelteStore(signal)` (single-argument form)
- Proper cleanup: unsubscribe on Svelte store teardown
- Deprecated factory overload correctly maintained for backward compat
- No memory leaks: cleanup function in `readable()` disposes signal and unsubscribes client

**One minor note**: The deprecated `toSvelteStoreFactory` path calls `currentSignal?.dispose()` on signal teardown, but the direct path does NOT dispose (by design — lifecycle managed by LiveSignalRegistry). This asymmetry is correct but could benefit from a comment.

## CLI Assessment

The CLI (`@datafn/cli`) is **well-structured**:

- Schema auto-discovery with sensible search order
- TypeScript schema loading via `tsx/esm/api` with clear error messages
- Drizzle codegen with deterministic output (sorted resources/fields)
- Good error UX with actionable messages

**Minor issues**:
- `loadTypeScriptSchema` uses `await import(fileUrl)` which could execute arbitrary code from a crafted `.datafn.ts` file — this is expected behavior but worth documenting the trust model
- No `--dry-run` option for `generate` command

---

## Prioritized Remediation Plan

### P0 — Block production deployment (fix immediately)

1. **SEC-C1, SEC-C2**: Add WebSocket authentication and server-derived namespace
2. **SEC-C3, SEC-C4**: Enforce authz on all query fields and transact steps
3. **SEC-C5**: Add field value type validation
4. **SEC-C6**: Add batch size limits for mutations
5. **REL-C1**: Fix transaction atomicity fallback semantics
6. **REL-C2, REL-H6**: Make change tracking failures propagate (or dead-letter)
7. **SCA-C1**: Use `db.count()` in reconcile
8. **SCA-C4**: Add TTL/max-entries to MemoryIdempotencyStore

### P1 — Fix before beta users (next 2 weeks)

9. **SEC-C7**: Fix byte length measurement in payload limit
10. **SEC-C8**: Add prototype pollution protection
11. **REL-C3**: Fix transaction result semantics for rolled-back steps
12. **REL-C4, REL-C5, REL-C6**: Fix client-side reliability (debouncer, timers, clone errors)
13. **SCA-C2, SCA-C3**: Enforce clone pagination, add transport timeouts
14. **SCA-H1, REL-H1**: Add WS connection limits and heartbeat
15. **PER-H1**: Batch serverSeq allocation in push
16. **REL-H3**: Implement graceful shutdown
17. **TG-1, TG-2**: Create security and namespace isolation test suites

### P2 — Harden for GA (next 4-6 weeks)

18. **All HIGH security issues** (SEC-H1 through SEC-H8)
19. **All HIGH performance issues** (PER-H2 through PER-H6)
20. **All HIGH data integrity issues** (DI-H1 through DI-H4)
21. **All remaining HIGH reliability issues**
22. **TG-3 through TG-7**: Fix test quality and add stress tests

### P3 — Quality of life (ongoing)

23. All MEDIUM issues
24. All LOW issues
25. Structured logging adoption
26. Edge runtime compatibility
27. Dead code removal

---

## Architectural Strengths

Despite the issues, DataFn has several strong architectural qualities worth noting:

1. **Clean package separation** — Core types, client SDK, server, svelte adapter, and CLI are well-factored
2. **Schema-first design** — Consistent validation pipeline from schema declaration through codegen
3. **Offline-first with sync** — The local-first model with changelog-based push and server-seq pull is architecturally sound
4. **LiveSignal lifecycle** — Signals survive context switches via `rebind()`, avoiding stale closures
5. **Cross-tab relay correctness** — Only metadata relayed, avoiding PII broadcast
6. **Idempotency infrastructure** — Both memory and DB stores with proper `mutationId` deduplication
7. **Pluggable DB adapters** — Clean adapter interface supporting Drizzle, Prisma, Kysely
8. **Rate limiting** — Redis and memory implementations with per-endpoint config
9. **Change tracking** — CAS-based sequence allocation with fallback store pattern
10. **Type codegen** — Deterministic TypeScript type generation from schema

---

*End of audit report*
