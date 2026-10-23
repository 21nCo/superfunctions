# Full Audit Report: DataFn Production-Readiness & Previous Issue Tracker

## Metadata

- **Timestamp**: 2026-02-26T12:00:00Z
- **Agent**: Claude Code (Claude Opus 4.6)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions/datafn
- **Branch**: next
- **Commit**: ea87d7e
- **Dirty**: No
- **Audit ID**: 289dbdab
- **Audit Type**: Full production-readiness + regression check against prior audits
- **Prior Audits Referenced**:
  - `2026-02-25-a034bxtu-full-audit.md` (Agent: amp / Claude Sonnet 4)
  - `2026-02-24-production-readiness-audit.md` (Agent: Gemini CLI)

---

## Executive Summary

DataFn has made **significant progress** since the prior audits. Critical infrastructure gaps (rate limiting, change log pruning, idempotency TTL, `getLatestServerSeq` inefficiency) are now fixed. The `DbDataStore.forQuery()` rewrite with targeted secondary loading (INMEM-001 through INMEM-004) eliminates the most severe scalability issue for IN_MEMORY queries. However, several previously identified issues remain open, and this audit identifies **6 new issues** including a correctness bug in transaction execution.

**Overall Readiness: 🟡 Late Beta — Significant improvements, remaining items are hardening-tier**

| Aspect | Prior | Current | Summary |
|---|---|---|---|
| Scalability | 🟡 | 🟢 Good | `forQuery()` rewrite with targeted loading; full-table fallback only for edge cases |
| High-Volume | 🟡 | 🟢 Good | Change log pruning, idempotency TTL, `getLatestServerSeq` fixed |
| Fault Tolerance | 🟢 | 🟢 Good | Unchanged — strong idempotency, CAS, backoff, fallback stores |
| Throughput | 🟡 | 🟡 Medium | Dynamic import, sentinel pattern, and synthetic requests still present |
| Production-Grade | 🟡 | 🟢 Good | Rate limiting implemented, timing/observability added, retention config |

---

## 1. Previously Reported Issues — Status

### 1.1 FIXED Issues

| ID | Issue | Status | Evidence |
|---|---|---|---|
| **H-1** | Unbounded change log growth | ✅ **FIXED** | `ChangeTrackingService.pruneChanges(retentionDays)` added (change-tracking.ts:313-323). `RetentionConfig` in server config with startup pruning (RET-004) and periodic interval pruning (RET-005) in server.ts:201-301 |
| **H-2** | Unbounded idempotency store growth | ✅ **FIXED** | `DbIdempotencyStore.pruneIdempotency(retentionDays)` added (idempotency-db.ts:53-63). Integrated with startup and periodic pruning |
| **H-4** | `getLatestServerSeq` scans all changes | ✅ **FIXED** | Now uses `{ orderBy: "-server_seq", limit: 1 }` (change-tracking.ts:336-343) |
| **P-1** | No rate limiting implementation | ✅ **FIXED** | Full implementation in `middleware/rate-limit.ts`: `RedisRateLimiter` (RATE-002), `MemoryRateLimiter` (RATE-003), `createRateLimitMiddleware` (RATE-001). Integrated in server.ts with per-endpoint config and key extraction |
| **P-5** | No observability/metrics | ✅ **PARTIALLY FIXED** | `ExecutionTimer` with phase-level timing (middleware/timing.ts). `TimingEmitter` with configurable handler (OBS-001 through OBS-004). Wired into query, mutation, pull, push handlers. No full OTel integration yet |

### 1.2 PARTIALLY FIXED Issues

| ID | Issue | Status | Detail |
|---|---|---|---|
| **S-1** | Full table load for IN_MEMORY queries | 🟡 **PARTIALLY FIXED** | `DbDataStore.forQuery()` completely rewritten (db-store.ts:429-945): primary resource uses SCALE-004 pre-filter, secondaries use targeted IN queries (INMEM-001 through INMEM-004). **Remaining gap**: `DbDataStore.create()` (lines 22-56) still loads full tables for non-primary resources; `loadJoinRows()` (line 387) loads all join rows without filtering. Both methods are public API surface |
| **H-3** | Sequential mutation processing in push | 🟡 **PARTIALLY FIXED** | Batch serverSeq allocation added for relation deltas via `getNextServerSeqBatch()` + `recordChanges()` (execute.ts:336-345). **Remaining gap**: push.ts still processes mutations one-by-one in a `for` loop (line 140), each requiring idempotency check → DB op → change tracking → idempotency store = 4+ roundtrips |
| **F-1** | Change tracking errors silently swallowed | 🟡 **PARTIALLY FIXED** | `recordChanges()` now propagates errors immediately. **Remaining gap**: callers in executeMutation (line 371-373) and executePush (line 385-387) still catch-and-log change tracking errors, allowing mutations to succeed while sync breaks silently |
| **P-4** | Verbose error logging in production | 🟡 **PARTIALLY FIXED** | Structured `logRequest()` function exists (logging.ts). Timing emitter added. **Remaining gap**: `console.error` with `=== OUTER CATCH ===`-style messages still in mutation execution; `console.log(…)` in transact.ts:149 |

### 1.3 NOT FIXED Issues

| ID | Issue | Severity | Detail |
|---|---|---|---|
| **S-2** | `MemoryStore.snapshot()` uses `JSON.parse(JSON.stringify())` | 🟡 Medium | memory-store.ts:131-133, 142, 151 — all three methods still use JSON round-trip for deep clone. `structuredClone()` would be faster and handle edge cases (Date, undefined) |
| **H-5** | No bulk insert/upsert support | 🟡 Medium | Still single-record processing only. `records` (plural) in DFQL types still unused by execution layer |
| **H-6** | Client `listRecords()` returns all records | 🟡 Medium | IndexedDB `getAll()` with no limit (indexedDbStorage.ts:402). Large resources (100K+ records) will cause browser memory pressure |
| **T-1** | Dynamic import in hot path | 🟡 Medium | `server.ts:462` — `await import("./http/json.js")` on every POST request |
| **T-2** | `enforcePayloadLimit` sentinel pattern | 🟡 Medium | server.ts:429-455 — creates sentinel Response, double-invokes middleware (see NEW-1 for additional detail) |
| **T-3** | REST routes create synthetic `Request` objects | 🟡 Medium | server.ts:570-594 — constructs fake Request, serializes/deserializes JSON envelope |
| **F-2** | `getGlobalChanges` returns empty array on error | 🟡 Medium | change-tracking.ts:259-262 — client believes fully synced when DB is unavailable |
| **F-3** | No circuit breaker for remote calls | 🟡 Low | Push interval backoff (5 min cap) helps but no full circuit breaker. Client retries indefinitely |
| **F-4** | Transaction rollback with non-transactional adapters | 🟡 Low | transact.ts:133-156 — sequential fallback doesn't rollback on failure |
| **F-5** | WebSocket message handling ignores parse errors | 🟡 Low | ws.ts:50-51 — `catch (e) { // Ignore }` |
| **P-2** | Content-Length only payload limit | 🔴 High | middleware.ts:10-18 — attackers can omit header and send arbitrarily large bodies |
| **P-3** | No request timeout | 🟡 Medium | No per-request timeout for long-running queries or transactions |
| **S-3** | No result streaming/pagination for store queries | 🟡 Low | DataStore returns fully materialized arrays |
| **S-4** | N+1 nested relation loading depth | 🟡 Low | forPushdownResult second-pass (db-store.ts:248-370) recursively loads nested relations |
| **S-5** | No aggregate query pushdown | 🟡 Low | GROUP BY/HAVING always in-memory (aggregate.ts) |
| **T-4** | No connection pooling abstraction | 🟡 Low | No backpressure mechanism |
| **T-5** | Sync engine uses `setInterval` | 🟡 Low | engine.ts:114 — overlapping fires suppressed by `inFlight` flag but wasteful |
| **T-6** | No query result caching | 🟡 Low | `dbMapping.cache` unused |
| **P-6** | No CORS configuration | 🟡 Low | Relies on hosting framework |
| **P-7** | Python SDK feature gap | 🟡 Low | ~15% parity with TypeScript |
| **P-8** | No schema migration strategy | 🟡 Low | Schema version exists but no runner |
| **P-9** | `console.log/warn/error` throughout | 🟡 Low | No configurable logger |
| **P-10** | `as any` casts in auth wrapper | 🟡 Low | server.ts route handlers use `as any` extensively |

---

## 2. New Issues Found

### NEW-1 🔴 CRITICAL: `executeTransaction` missing `plugins` and `namespace` arguments

**File**: server/src/execution/transact.ts:74-80

`executeStep()` calls `executeMutation()` with only 5 arguments:

```typescript
const mutationResult = await executeMutation(
  step.mutation,
  schema,
  stepDb,
  idempotencyStore,
  changeTracking,
  // Missing: plugins (DatafnPlugin[])
  // Missing: namespace (string)
);
```

But `executeMutation` requires 7 parameters:

```typescript
export async function executeMutation(
  mutation, schema, db, idempotencyStore, changeTracking, plugins, namespace
)
```

**Impact**:
- `plugins` defaults to `[]` — search index updates, custom hooks, etc. do **not** run for mutations inside transactions
- `namespace` defaults to `undefined` — all transaction mutations use the wrong namespace, breaking multi-tenant isolation. DB operations receive `namespace: undefined` instead of the user's namespace

**Severity**: Critical — data corruption risk in multi-tenant deployments; silent feature degradation for plugins

**Fix**: Pass `plugins` and `namespace` through to `executeStep`.

---

### NEW-2 🟡 WARNING: Double invocation of `enforcePayloadLimit` middleware

**File**: server/src/server.ts:429-455

The `withAuth` wrapper calls the payload limit middleware **twice** per request:

```typescript
const limiter = enforcePayloadLimit(limits.maxPayloadBytes);
const limitRes = await limiter(req, async () => new Response("OK")); // ← Result discarded
// ... comments ...
const nextSentinel = new Response("__NEXT__");
const res = await limiter(req, async () => nextSentinel); // ← Actual check
```

The first invocation's result (`limitRes`) is never checked. The second invocation uses the sentinel pattern. Both calls read the `Content-Length` header but only the second result is acted upon.

**Impact**: Unnecessary overhead per POST request (two middleware invocations, two Response object allocations)

**Fix**: Remove the first invocation and inline the Content-Length check directly.

---

### NEW-3 🟡 WARNING: `MemoryRateLimiter` has unbounded memory growth

**File**: server/src/middleware/rate-limit.ts:42-61

The `windows` Map never has expired entries cleaned up proactively. Cleanup only occurs when a specific key is next checked — if a client stops making requests, their window entry persists indefinitely.

**Impact**: Memory leak proportional to unique client × endpoint combinations over server lifetime

**Fix**: Add periodic sweep (e.g., every 60s) or use a TTL-aware data structure.

---

### NEW-4 🟡 WARNING: Aggregate group key collision risk

**File**: server/src/execution/query/aggregate.ts:45

```typescript
const key = keyParts.join("||");
```

The separator `||` could exist within field values, causing group key collisions. E.g., grouping by `status` where values are `"a||b"` and `"a"` + `"b"` would produce identical keys.

**Impact**: Incorrect aggregation results when field values contain the separator

**Fix**: Use `JSON.stringify(keyParts)` or a structured key (Map with composite key).

---

### NEW-5 🟡 WARNING: WebSocket broadcasts ignore namespace/tenant isolation

**File**: server/src/ws.ts:58-67

`broadcastCursor()` sends cursor updates to **all** connected clients regardless of namespace or tenant:

```typescript
broadcastCursor(cursor: string) {
  const msg = JSON.stringify({ type: "cursor", cursor });
  for (const client of this.clients) {
    client.send(msg); // ALL clients receive ALL cursors
  }
}
```

**Impact**: In multi-tenant deployments, Tenant A's cursor updates are broadcast to Tenant B's clients, triggering unnecessary pulls. Not a data leak (pulls are namespace-scoped) but a performance waste and potential information side-channel (timing of writes).

**Fix**: Track client namespace on `hello` message and filter broadcasts by namespace.

---

### NEW-6 🟡 WARNING: Authorization bypass for system fields

**File**: server/src/validation/authz.ts:50-56, 113-119

System field names are hardcoded and **always** pass authorization checks:

```typescript
baseName === "id" || baseName === "createdAt" || baseName === "updatedAt" ||
baseName === "createdBy" || baseName === "updatedBy" || baseName === "isArchived";
```

If a `permissions.read.fields` policy is defined but intentionally **excludes** system fields (e.g., to hide `createdBy` for privacy), the authz layer will still allow reading them.

**Impact**: Cannot restrict access to system fields via permissions policy

**Fix**: Only bypass authz for `id` (which is always needed for identity). Other system fields should respect the permissions policy when one is defined.

---

## 3. Architecture Improvements Since Prior Audits

### 3.1 Targeted Secondary Loading (INMEM-001 through INMEM-004)

The `DbDataStore.forQuery()` rewrite is the single most impactful change. For IN_MEMORY queries:

1. **Primary resource** uses SCALE-004 pre-filter WHERE clauses
2. **Many-many secondaries** loaded via join table → targeted IN query on secondary IDs
3. **Non-many-many secondaries** loaded via FK-based IN queries (both forward and inverse relations)
4. **INMEM-003 fast path** returns empty store immediately when pre-filter yields zero primary records
5. **INMEM-004 fallback** logs warning and does full load only for unmapped relation paths

This eliminates the worst-case scenario (full table scans for all related resources) for the vast majority of queries.

### 3.2 Rate Limiting (RATE-001 through RATE-005)

Complete implementation with:
- Redis-backed sliding window (`RedisRateLimiter`)
- In-memory fallback (`MemoryRateLimiter`)
- Per-endpoint override configuration
- Configurable key extraction (default: auth context userId)
- Applied **before** JSON parsing and authorization (optimal reject position)

### 3.3 Data Retention (RET-001 through RET-005)

- `RetentionConfig` with `changeLogDays`, `idempotencyDays`
- Startup pruning (`pruneOnStartup`)
- Periodic interval pruning (`pruneIntervalMs`, min 60s)
- Server `close()` method clears prune interval

### 3.4 Execution Timing (OBS-001 through OBS-004)

- `ExecutionTimer` with named phase tracking
- `TimingEmitter` with configurable handler (default: console.debug)
- Error-safe handler invocation
- Wired into query, mutation, pull, push routes

### 3.5 Batch Change Tracking

- `getNextServerSeqBatch(count)` allocates contiguous serverSeq values atomically
- `recordChanges(entries[])` records multiple changes in one call
- Used for relation mutations in `executeMutation` (BATCH-CHG-002)

### 3.6 Push Cursor Advancement (FIX-B)

- Push response now includes `cursorBefore` and per-resource `cursors`
- Client advances per-table cursors after push to avoid re-fetching own changes
- `setCursorMonotonically` prevents cursor regression

---

## 4. Summary of Recommendations

### Priority 1 — Must Fix Before Production

| ID | Issue | Status | Effort |
|---|---|---|---|
| **NEW-1** | `executeTransaction` missing plugins/namespace args | New — Critical | Low |
| **P-2** | Content-Length only payload limit (no streaming enforcement) | Open | Low |

### Priority 2 — Should Fix for Scale

| ID | Issue | Status | Effort |
|---|---|---|---|
| **S-2** | Replace JSON deep clone with `structuredClone` | Open | Low |
| **T-1** | Static import for JSON parser | Open | Low |
| **T-2 / NEW-2** | Remove sentinel pattern + fix double invocation | Open | Low |
| **T-3** | Extract shared execution for REST routes | Open | Medium |
| **F-1** | Surface change tracking failures (not silently swallow) | Partially Fixed | Low |
| **F-2** | Return error envelope instead of empty array on DB failure | Open | Low |
| **P-3** | Request timeout mechanism | Open | Medium |
| **NEW-5** | Namespace-scoped WebSocket broadcasts | New | Medium |

### Priority 3 — Production Hardening

| ID | Issue | Status | Effort |
|---|---|---|---|
| **H-3** | Batch mutation processing in push | Partially Fixed | High |
| **H-5** | Bulk mutation support | Open | Medium |
| **H-6** | Client `listRecords()` pagination for large tables | Open | Medium |
| **NEW-3** | `MemoryRateLimiter` periodic cleanup | New | Low |
| **NEW-4** | Aggregate group key collision fix | New | Low |
| **NEW-6** | Authorization system field bypass | New | Low |
| **S-5** | Aggregate query pushdown (GROUP BY) | Open | High |
| **F-3** | Circuit breaker for sync engine | Open | Medium |
| **P-9** | Configurable logger replacing console.* | Open | Medium |

---

## 5. Quantitative Progress

| Metric | Feb 24 Audit | Feb 25 Audit | This Audit (Feb 26) |
|---|---|---|---|
| Critical issues | 5 (S-1, H-1, H-2, H-3, P-1) | 7 (added T-1, P-2) | 2 (NEW-1, P-2) |
| Warning issues | 10 | 16 | 13 (10 open, 3 new) |
| Fixed since prior | — | — | 5 fully, 4 partially |
| New issues found | — | — | 6 |
| Overall readiness | 🔴 CAUTION | 🟡 Beta | 🟡 Late Beta |

---

## 6. Conclusion

DataFn has made substantial progress toward production-readiness in the last 48 hours. The five most impactful fixes — targeted secondary loading, rate limiting, change log pruning, idempotency TTL, and execution timing — address the core scalability and production-grade gaps identified in prior audits.

The **one blocking issue** is NEW-1 (transaction missing namespace/plugins), which is a correctness bug affecting multi-tenant deployments and plugin ecosystems. This is a low-effort fix (add two parameters to one function call) and should be addressed immediately.

The remaining items are hardening-tier improvements that enhance performance (T-1, T-2, T-3), security (P-2), and operational safety (NEW-3, NEW-5) but do not block initial production deployment for single-tenant use cases.

---

*Audited by: Claude Code (Claude Opus 4.6) | Scope: Full codebase scan of datafn/* | Read-only static audit*
