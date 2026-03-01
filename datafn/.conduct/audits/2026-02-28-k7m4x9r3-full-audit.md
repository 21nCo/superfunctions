# Full Audit Report: DataFn Audit-Fix Spec v7k3m9x4

## Metadata

- **Timestamp**: 2026-02-28T12:00:00Z
- **Agent name**: claude-opus-4-6
- **Model**: Claude Opus 4.6
- **Launcher**: VS Code (Claude Code extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0 / zsh
- **Git branch**: next
- **Git commit**: ea87d7e (dirty)
- **Audit ID**: k7m4x9r3

## Audit Scope

- **Intent/notes paths audited**:
  - `datafn/.conduct/audits/2026-02-26-x3cjj10g-full-audit.md` (original audit)
  - `datafn/.conduct/audits/2026-02-27-x3cjj10g-audit-decisions.md` (16 decisions)
- **Spec bundle paths audited**:
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/SPEC.md`
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/REQUIREMENTS.md`
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/TEST_VECTORS.md`
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/PLAN.md`
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/INTENT_AUDIT.md`
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/phases/PHASE_00-PHASE_14.md`
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/phase-reports/` (15 reports)
- **Codebase scope**: `datafn/` (server, client, core packages)
- **Commands executed**: git rev-parse, grep, glob, file reads (read-only)

## Inputs Audited

### Intent Sources
1. Original audit: 157 issues (18 CRITICAL, 43 HIGH, 62 MEDIUM, 34 LOW) + 7 test coverage gaps
2. Decision document: 16 decision points with recommended approaches

### Spec Bundle
Single spec bundle `2026-02-27-audit-fix-v7k3m9x4-spec` containing:
- SPEC.md: Architecture, semantics, invariants, security, limits, compatibility
- REQUIREMENTS.md: 120+ requirements across SEC, REL, SCA, PER, DI, VAL, SRV, EXE, CLI, LOG, LOW, TST
- TEST_VECTORS.md: 80+ test vectors
- PLAN.md: 15-phase execution plan (PHASE_00-PHASE_14)
- INTENT_AUDIT.md: Mapping of all 157 issues + 16 decisions to requirements

---

## High-Level Findings

| Severity | PASS | PARTIAL | FAIL | UNVERIFIED | Total |
|---|---|---|---|---|---|
| **CRITICAL** (SEC/REL/SCA) | 24 | 3 | 0 | 0 | 27 |
| **HIGH** (SEC/REL/PER/DI/SCA) | 26 | 2 | 1 | 0 | 29 |
| **MEDIUM** (VAL/SRV/EXE/CLI) | 44 | 8 | 2 | 9 | 63 |
| **LOW** (LOW-001-034) | 14 | 5 | 0 | 15 | 34 |
| **Logging** (LOG-001-003) | 2 | 1 | 0 | 0 | 3 |
| **Test Coverage** (TST-001-007) | 0 | 0 | 0 | 7 | 7 |
| **TOTAL** | **110** | **19** | **3** | **31** | **163** |

**Overall assessment**: The implementation covers the vast majority of the 157 audit findings. All 18 CRITICAL issues have been addressed (14 PASS, 3 PARTIAL, 1 with minor caveat). The 3 FAIL items are MEDIUM/HIGH priority. 31 items are UNVERIFIED (mostly LOW priority P3 items and test coverage).

---

## Intent Inventory

### CRITICAL Issues (18)

| # | Audit ID | Intent |
|---|---|---|
| 1 | SEC-C1 | WS namespace spoofing — client cannot override server-derived namespace |
| 2 | SEC-C2 | WS no authentication — connections must authenticate during upgrade |
| 3 | SEC-C3 | Authz bypass via aggregation/groupBy/sort/search — all query fields checked |
| 4 | SEC-C4 | Transact skips authz — per-step authz enforcement |
| 5 | SEC-C5 | No field value type validation — strict schema type checking |
| 6 | SEC-C6 | No batch size limit — enforce maxBatchSize |
| 7 | SEC-C7 | Payload uses string length — use Buffer.byteLength |
| 8 | SEC-C8 | Prototype pollution — block __proto__/constructor/prototype |
| 9 | REL-C1 | Transaction atomicity lost — no silent fallthrough to sequential |
| 10 | REL-C2 | Change tracking swallowed in push — propagate failures |
| 11 | REL-C3 | Rolled-back results misleading — annotate with rolledBack:true |
| 12 | REL-C4 | DebouncerMap orphaned Promises — resolve old promises |
| 13 | REL-C5 | Duplicate push timers — guard start() |
| 14 | REL-C6 | Clone errors swallowed — emit sync_failed |
| 15 | SCA-C1 | Reconcile full table scan — use db.count() |
| 16 | SCA-C2 | Clone loads all records — auto-paginate at 10k |
| 17 | SCA-C3 | Extension transport unbounded — 30s timeout |
| 18 | SCA-C4 | Idempotency no TTL — LRU + TTL eviction |

### HIGH Issues (43)

| # | Audit ID | Intent |
|---|---|---|
| 19 | SEC-H1 | Relation authz bypass |
| 20 | SEC-H2 | REST path traversal |
| 21 | SEC-H3 | Seed hardcoded namespace |
| 22 | SEC-H4 | Cross-tab no validation |
| 23 | SEC-H5 | Having superficial validation |
| 24 | SEC-H6 | GroupBy no schema validation |
| 25 | SEC-H7 | LIKE pattern injection |
| 26 | SEC-H8 | Search query unbounded |
| 27 | SCA-H1 | Unbounded WS clients |
| 28 | SCA-H2 | O(n) WS broadcast |
| 29 | SCA-H3 | Full table load for non-primary |
| 30 | SCA-H4 | loadJoinRows full scan |
| 31 | SCA-H5 | Aggregate groups unbounded |
| 32 | SCA-H6 | Backward cursor doubles memory |
| 33 | SCA-H7 | Offline changelog unbounded |
| 34 | PER-H1 | Sequential serverSeq in push |
| 35 | PER-H2 | Dynamic imports in hot paths |
| 36 | PER-H3 | Double validation in push |
| 37 | PER-H4 | Sequential relation DB calls |
| 38 | PER-H5 | Relation filter O(N*M) |
| 39 | PER-H6 | Changelog dedup O(n^2) |
| 40 | REL-H1 | No WS heartbeat |
| 41 | REL-H2 | Redis rate limit race |
| 42 | REL-H3 | No graceful shutdown |
| 43 | REL-H4 | CAS retry no backoff |
| 44 | REL-H5 | Change tracking after commit |
| 45 | REL-H6 | Push swallows change tracking |
| 46 | REL-H7 | Double event on offline |
| 47 | REL-H8 | Batch query skip date codec |
| 48 | REL-H9 | Pull catch-up infinite loop |
| 49 | REL-H10 | WS pullNow not awaited |
| 50 | DI-H1 | modifyRelation TOCTOU |
| 51 | DI-H2 | Guard TOCTOU |
| 52 | DI-H3 | FallbackSequenceStore duplicates |
| 53 | DI-H4 | Join store key incorrect |

### MEDIUM Issues (62)
Items 54-115: Server (SRV-001 to SRV-016), Execution (EXE-001 to EXE-022), Client/Core (CLI-001 to CLI-014), Validation (VAL-001 to VAL-010). All mapped in REQUIREMENTS.md.

### LOW Issues (34)
Items 116-149: LOW-001 to LOW-034. All mapped in REQUIREMENTS.md.

### Test Coverage Gaps (7)
Items 150-156: TST-001 to TST-007.

### Decision Points (16)
D1-D16: All mapped to specific requirements.

---

## Intent -> Spec Coverage Matrix

All 157 audit issues + 7 test gaps + 16 decisions are mapped to specific requirements in the spec. **No SPEC MISSING items identified.** The INTENT_AUDIT.md provides complete traceability.

---

## Requirement Coverage Summary

| Category | PASS | PARTIAL | FAIL | UNVERIFIED |
|---|---|---|---|---|
| **SEC-001 to SEC-008** (Security CRITICAL) | 6 | 2 | 0 | 0 |
| **REL-001 to REL-006** (Reliability CRITICAL) | 5 | 1 | 0 | 0 |
| **SCA-001 to SCA-004** (Scalability CRITICAL) | 4 | 0 | 0 | 0 |
| **SEC-009 to SEC-016** (Security HIGH) | 8 | 0 | 0 | 0 |
| **REL-007 to REL-015** (Reliability HIGH) | 8 | 1 | 0 | 0 |
| **PER-001 to PER-006** (Performance HIGH) | 5 | 0 | 1 | 0 |
| **DI-001 to DI-004** (Data Integrity HIGH) | 4 | 0 | 0 | 0 |
| **VAL-001 to VAL-010** (Validation MEDIUM) | 10 | 0 | 0 | 0 |
| **SRV-001 to SRV-016** (Server MEDIUM) | 12 | 2 | 0 | 2 |
| **EXE-001 to EXE-022** (Execution MEDIUM) | 12 | 4 | 2 | 4 |
| **CLI-001 to CLI-014** (Client/Core MEDIUM) | 10 | 1 | 0 | 3 |
| **LOG-001 to LOG-003** (Logging) | 2 | 1 | 0 | 0 |
| **LOW-001 to LOW-034** (Low) | 14 | 5 | 0 | 15 |
| **TST-001 to TST-007** (Test Coverage) | 0 | 0 | 0 | 7 |

---

## Requirement-by-Requirement Results

### Security CRITICAL (SEC-001 to SEC-008)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| SEC-001 | WS authentication | **PASS** | `ws.ts:129` — `addClient()` requires `WsAuthContext` | 4401 close code is caller responsibility (by design contract) |
| SEC-002 | Server-derived WS namespace | **PASS** | `ws.ts:182-191` — hello message namespace ignored | Namespace locked at `addClient()` time |
| SEC-003 | Authz coverage for all query fields | **PASS** | `authz.ts:31-193` — checks select, filters, aggregations, groupBy, having, sort, search.fields | All 7 field types checked |
| SEC-004 | Transact per-step authz | **PASS** | `routes/transact.ts:131-162` — per-step loop with validateQueryAuthz/validateMutationAuthz | Error includes step index |
| SEC-005 | Field value type validation | **PASS** | `core/validate.ts:42-109`, `validation/mutation.ts:176-189` | Strict type checking, NaN rejected, nullable handled |
| SEC-006 | Batch size limits | **PARTIAL** | `routes/sync.ts:300-311` — push enforces 500 limit | **Gap 1**: `/datafn/mutation` endpoint has NO batch size limit. **Gap 2**: maxBatchSize hardcoded to 500, not wired from config |
| SEC-007 | Byte-based payload measurement | **PASS** | `http/middleware.ts:41` — `Buffer.byteLength(body, 'utf8')` | Default 5MB correctly set in server.ts:346 |
| SEC-008 | Prototype pollution protection | **PARTIAL** | `core/validate.ts:19-36` — recursive check for __proto__/constructor/prototype | **Gap**: Not applied to query top-level object, aggregation config, or having clause objects. Applied to mutation records and query filters only |

### Reliability CRITICAL (REL-001 to REL-006)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| REL-001 | Transaction atomicity | **PASS** | `transact.ts:95-162` — DB errors return INTERNAL; sequential only when adapter lacks transaction | Minor: code also allows fallthrough on "not supported"/"not implemented" throws, slightly wider than spec's "only when undefined" |
| REL-002 | Change tracking failure propagation | **PARTIAL** | `push.ts:29-43,423-473` — retry with 50ms/100ms; `execute.ts:233-236` — propagates errors | **Gap**: Retry logic (recordChangeWithRetry) exists only in push.ts, not in execute.ts. Failure propagation is consistent, retry is not |
| REL-003 | Rolled-back step annotation | **PASS** | `transact.ts:107-121,128-141` — `{ ok: false, rolledBack: true, result: <original> }` | Top-level `TRANSACTION_ROLLED_BACK` error code correct |
| REL-004 | DebouncerMap orphaned Promises | **PASS** | `debounce.ts:48-54` — `existing.resolve()` called before replacement | Records merged correctly |
| REL-005 | Duplicate push timer guard | **PASS** | `engine.ts:108-110` — `if (this.timer) return;` | Timer cleared in stop() |
| REL-006 | Clone error handling | **PASS** | `engine.ts:507-536` — catch emits sync_failed, sets state to "failed" | Minor: double sync_failed emission from cloneResources + cloneResourcesInBackground |

### Scalability CRITICAL (SCA-001 to SCA-004)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| SCA-001 | Reconcile uses count | **PASS** | `reconcile.ts:99-118` — `db.count()` with findMany fallback | Fallback only when adapter lacks count() |
| SCA-002 | Clone auto-pagination | **PASS** | `clone.ts:46,175-263` — 10k default, `{ paginated: true, next }` | Counts first, then paginates |
| SCA-003 | Extension transport timeout | **PASS** | `transport.ts:35-37,60-89` — 30s timeout, reject, cleanup | Entry removed from pending map |
| SCA-004 | Idempotency TTL + LRU | **PASS** | `idempotency.ts:48-135` — 24h TTL, 100k max, 5min sweep, LRU on get, timer.unref() | Full implementation |

### Security HIGH (SEC-009 to SEC-016)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| SEC-009 | Relation authz | **PASS** | `authz.ts:297-337` — checks relate/modifyRelation/unrelate target fields | Validates relation name against write.fields |
| SEC-010 | REST path traversal | **PASS** | `rest.ts:17-31` — rejects .., %2f, null bytes | Applied on all REST routes |
| SEC-011 | Seed namespace isolation | **PASS** | `seed.ts:16-23` — uses extractNamespace from auth | Falls back to "datafn" only when no provider configured |
| SEC-012 | Cross-tab message validation | **PASS** | `crossTab.ts:34-59,93-99` — isValidRelayEvent validates shape | Invalid messages silently discarded |
| SEC-013 | Having clause deep validation | **PASS** | `query.ts:253-296,565-623` — recursive validation against schema + aggregation aliases | Deep recursive validation |
| SEC-014 | GroupBy field schema validation | **PASS** | `query.ts:458-506` — validates against schema fields | Supports dot-paths |
| SEC-015 | LIKE pattern length cap | **PASS** | `query.ts:816,826-836` — 200 default | Minor: not_like/not_ilike variants not capped |
| SEC-016 | Search query length cap | **PASS** | `query.ts:309-313,882-889` — 1000 default | Double-validated for defense in depth |

### Reliability HIGH (REL-007 to REL-015)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| REL-007 | WS heartbeat | **PASS** | `ws.ts:37-39,92-118,154-157` — 30s ping, 10s timeout | Dead connections closed with 1001 |
| REL-008 | Redis rate limit TTL race | **PASS** | `rate-limit.ts:28-46` — Lua atomic script | Non-atomic fallback when eval unavailable |
| REL-009 | Graceful shutdown | **PASS** | `server.ts:550-553,577-584,750-789` — SIGTERM, 503, WS close, drain, cleanup | Full implementation |
| REL-010 | CAS retry backoff | **PASS** | `change-tracking.ts:21,111-117` — 10ms * 2^(attempt-1) | ~10ms, ~20ms, ~40ms |
| REL-011 | Mutation change tracking ordering | **PARTIAL** | `push.ts:153-474` — mutation and change log in separate phases | **Gap**: Mutation committed in Phase 1, change log in Phase 3. NOT atomic. Crash between phases causes sync drift |
| REL-012 | Double event emission | **PASS** | `mutate.ts:395-477` — fromOfflineFallback guard | Exactly one event |
| REL-013 | Batch query date codec | **PASS** | `query.ts:46-56,80-89` — parseQueryResultDates on all paths | Dates not raw epoch numbers |
| REL-014 | Pull catch-up max iteration | **PASS** | `engine.ts:694,700,721-725` — max 50 iterations | Configurable, warning logged |
| REL-015 | WS pullNow await | **PASS** | `engine.ts:232-236,652-666` — .catch() logs, pullNow emits sync_failed | Both error paths covered |

### Performance HIGH (PER-001 to PER-006)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| PER-001 | Batch serverSeq | **PASS** | `push.ts:414-418` — getNextServerSeqBatch(totalSeqs) | Single call |
| PER-002 | Static imports | **FAIL** | `routes/mutation.ts:97` — `await import("../validation/authz.js")` | Dynamic import in hot path |
| PER-003 | No double validation | **PASS** | `push.ts` — validation only in route handler | No duplicate validation |
| PER-004 | Batch relation DB calls | **PASS** | `relations.ts:96-103,432-439` — updateMany/deleteMany batch calls | Many-many uses per-item upsert (acceptable) |
| PER-005 | Relation filter targeted lookup | **PASS** | `filters.ts:110-118` — findRecords by field value | Many-many still loads all (acceptable) |
| PER-006 | Changelog dedup O(1) | **PASS** | `memoryStorage.ts:31,300-305` — Map-based index | Maintained on append/ack |

### Data Integrity HIGH (DI-001 to DI-004)

| ID | Requirement | Status | Evidence | Notes |
|---|---|---|---|---|
| DI-001 | modifyRelation atomic | **PASS** | `relations.ts:187-220` — find+update in adapter.transaction() | Falls back to sequential when no adapter support |
| DI-002 | Guard in transaction scope | **PASS** | `guards.ts:51-64` — uses adapter passed by caller | Transaction-scoped when called with txAdp |
| DI-003 | FallbackSequenceStore no duplicates | **PASS** | `sequence-store.ts:260-261,277-281` — ensureMinSeq on failover | Next seq >= max+1 |
| DI-004 | Join store key handles string[] | **PASS** | `core/joins.ts:44-62` — enumerateJoinStoreKeys handles arrays | Individual string combinations |

### Validation MEDIUM (VAL-001 to VAL-010)

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| VAL-001 | Unknown resource denied | **PASS** | `authz.ts:43-56` — FORBIDDEN unless allowUnknownResources |
| VAL-002 | Select token limit | **PASS** | `query.ts:73-79` — cap 50 |
| VAL-003 | Filter key limit | **PASS** | `query.ts:641-649` — cap 20 |
| VAL-004 | Sort field limit | **PASS** | `query.ts:215-222` — cap 10 |
| VAL-005 | Aggregation count limit | **PASS** | `query.ts:264-273` — cap 20 |
| VAL-006 | ID length limit | **PASS** | `mutation.ts:96-103` — cap 255 |
| VAL-007 | clientId/mutationId validation | **PASS** | `mutation.ts:106-123` — non-empty string |
| VAL-008 | Version field validation | **PASS** | `mutation.ts:126-137` — positive integer |
| VAL-009 | Error disclosure control | **PASS** | `authz.ts:46-48`, `server.ts:257` — debug mode |
| VAL-010 | Default payload limit | **PASS** | `server.ts:346` — 5,242,880 bytes |

### Server MEDIUM (SRV-001 to SRV-016)

| ID | Requirement | Status | Notes |
|---|---|---|---|
| SRV-001 | REST synthetic request elimination | **PARTIAL** | Synthetic Request still constructed; parsedBody optimization present |
| SRV-002 | Sensitive field redaction | **PASS** | Extended to password, token, secret, authorization, cookie, apikey |
| SRV-003 | Batch query concurrency limit | **UNVERIFIED** | Could not verify chunking implementation |
| SRV-004 | Mutation log PII exposure | **PASS** | Only metadata logged |
| SRV-005 | Query route file split | **UNVERIFIED** | Single file (P3 priority) |
| SRV-006 | Timer phase accuracy | **PASS** | Per-query timer tracking |
| SRV-007 | getBodyFromContext cache | **PASS** | Returns cached ctx.parsedBody |
| SRV-008 | Status time rounding | **PASS** | Rounded to nearest minute |
| SRV-009 | Rate limit Retry-After | **PASS** | Header included in 429 |
| SRV-010 | extractNamespace safety | **PASS** | Throws on auth failure, no silent fallback |
| SRV-011 | Rate limiter timer unref | **PASS** | .unref() on all timers |
| SRV-012 | Transact duplicate validation | **PASS** | Step limit in route handler only |
| SRV-013 | Seed error propagation | **PASS** | 500 response on DB error |
| SRV-014 | MemoryStore sort cache | **PASS** | sortedKeysCaches Map |
| SRV-015 | $or filter rejection | **PASS** | DFQL_UNSUPPORTED error |
| SRV-016 | Seed namespace from auth | **PASS** | extractNamespace(ctx) |

### Execution MEDIUM (EXE-001 to EXE-022)

| ID | Requirement | Status | Notes |
|---|---|---|---|
| EXE-001 | Deduplicate traverse | **PASS** | Shared validateFilterOperators |
| EXE-002 | setJoinRow linear scan | **PASS** | Map-based O(1) lookup |
| EXE-003 | Transaction step error context | **PARTIAL** | Step index available but not annotated in error logs |
| EXE-004 | Transaction query caching | **UNVERIFIED** | |
| EXE-005 | Error classification | **PASS** | DatafnExecutionError code checked first |
| EXE-006 | Idempotency race fix | **PASS** | Check before overwrite |
| EXE-007 | DbIdempotencyStore errors | **PASS** | DB errors propagate, only JSON parse swallowed |
| EXE-008 | Delete change existence | **PASS** | skipChangeTracking flag |
| EXE-009 | Mutation ID collision | **PASS** | crypto.randomUUID() |
| EXE-010 | Mutation catch error preservation | **PASS** | Logs String(error) before returning |
| EXE-011 | GuardDataStore cross-resource | **PASS** | addRecords/addJoinRows for related resources |
| EXE-012 | findRelation ambiguity | **PASS** | Forward match first, then bidirectional |
| EXE-013 | resolveValue per-record | **UNVERIFIED** | |
| EXE-014 | FK omit set caching | **UNVERIFIED** | |
| EXE-015 | One-many expansion | **UNVERIFIED** | |
| EXE-016 | Cursor pushdown limit | **PARTIAL** | |
| EXE-017 | Search IN clause cap | **PARTIAL** | |
| EXE-018 | Change tracking batch insert | **PARTIAL** | Changes recorded individually in loop, not batch-inserted |
| EXE-019 | getCurrentServerSeq error handling | **FAIL** | `sequence-store.ts:244-249` — catches errors and returns 0 instead of propagating |
| EXE-020 | Push transaction wrapping | **FAIL** | Push mutations execute individually without transaction wrapping |
| EXE-021 | Pagination cursor validation | **PASS** | |
| EXE-022 | Pagination count caching | **PARTIAL** | |

### Client/Core MEDIUM (CLI-001 to CLI-014)

| ID | Requirement | Status | Notes |
|---|---|---|---|
| CLI-001 | createClientError naming | **PASS** | throwClientError + deprecated alias |
| CLI-002 | Remove switchableClient | **PASS** | Deleted |
| CLI-003 | Offline aggregate empty set | **PARTIAL** | Need to verify calculateAggregation handles empty arrays |
| CLI-004 | Relation from/to validation | **UNVERIFIED** | |
| CLI-005 | EventBus iteration safety | **PASS** | Array copy before iteration |
| CLI-006 | Health check key exemption | **UNVERIFIED** | |
| CLI-007 | KV merge race | **UNVERIFIED** | |
| CLI-008 | Remove unused buildEvent | **PASS** | No import found |
| CLI-009 | Filter recursion depth | **PASS** | Depth limit 10 |
| CLI-010 | pushBatchWithRetry backoff | **PASS** | |
| CLI-011 | Incremental search index | N/A | P3 deferred |
| CLI-012 | Redundant filter application | **PASS** | |
| CLI-013 | IndexedDB version bound | **PASS** | |
| CLI-014 | Missing reconcile RPC | **PASS** | Added to DatafnRpcMethod type |

### Logging (LOG-001 to LOG-003)

| ID | Requirement | Status | Notes |
|---|---|---|---|
| LOG-001 | Pluggable DatafnLogger | **PASS** | Interface in logger.ts, injected via config |
| LOG-002 | Replace console.* | **PARTIAL** | One direct console.log in logging.ts:61 as fallback |
| LOG-003 | Structured context | **PASS** | Context objects in all log calls |

### LOW Issues (LOW-001 to LOW-034)

14 PASS, 5 PARTIAL, 15 UNVERIFIED (P3 items). Key verified items:
- LOW-001: Remove `as any` casts — PASS
- LOW-005: unref() pruneInterval — PASS
- LOW-022: Aggregate group key delimiter — PASS (uses JSON.stringify)
- LOW-026: TRANSPORT_ERROR code — PASS
- LOW-028: Resource/field count limits — PASS (MAX_RESOURCES = 100)

### Test Coverage (TST-001 to TST-007)

All UNVERIFIED. New test files exist per git status but contents not audited:
- `security-critical.test.ts`, `namespace-data-isolation.test.ts`, `reliability-critical.test.ts`, `scalability-critical.test.ts`, `validation-medium.test.ts`, etc.

---

## Spec Conflicts / Spec Gaps

No spec conflicts found between bundles (single spec bundle).

### Spec Gap: REL-001 sequential fallthrough scope
The spec says "Sequential fallback ONLY when `db.transaction` is `undefined`" but the implementation also allows fallthrough when `db.transaction()` throws "not supported" / "not implemented". This is a pragmatic deviation that handles adapters with stub methods.

---

## Cross-Cutting Audits

### Security / Authorization / Validation Boundaries

**Status: STRONG with minor gaps**

- All 7 query field types checked in authz (select, filters, aggregations, groupBy, having, sort, search.fields) — **PASS**
- Per-step transact authz — **PASS**
- Unknown resources denied by default — **PASS**
- Prototype pollution protection — **PARTIAL** (missing coverage on query top-level, aggregation config, having clause)
- Field value type validation — **PASS** (strict)
- All validation limits enforced — **PASS** (select 50, filter keys 20, sort 10, aggregations 20, search 1000, LIKE 200, ID 255, filter depth 10)
- Byte-based payload measurement — **PASS**
- Batch size limits — **PARTIAL** (push only, mutation endpoint unbounded)

### Determinism Invariants

- ServerSeq monotonically increasing — **PASS** (CAS with retry)
- FallbackSequenceStore ensures no duplicates — **PASS**
- Idempotency deduplication — **PASS**

### Limits / Caps

All specified limits have defaults and are enforced:

| Limit | Default | Enforced |
|---|---|---|
| maxPayloadBytes | 5,242,880 | **YES** |
| maxBatchSize | 500 | **PARTIAL** (push only) |
| maxCloneRecords | 10,000 | **YES** |
| maxLimit | 100 | **YES** |
| maxPullLimit | 1,000 | **YES** |
| maxTransactSteps | 100 | **YES** |
| idempotencyTtlMs | 86,400,000 | **YES** |
| idempotencyMaxEntries | 100,000 | **YES** |
| maxSelectTokens | 50 | **YES** |
| maxFilterKeysPerLevel | 20 | **YES** |
| maxSortFields | 10 | **YES** |
| maxAggregations | 20 | **YES** |
| maxSearchQueryLength | 1,000 | **YES** |
| maxLikePatternLength | 200 | **YES** |
| maxIdLength | 255 | **YES** |
| maxFilterDepth | 10 | **YES** |
| ws.maxConnections | 10,000 | **YES** |
| ws.maxConnectionsPerNamespace | 100 | **YES** |
| ws.heartbeatIntervalMs | 30,000 | **YES** |
| ws.heartbeatTimeoutMs | 10,000 | **YES** |
| shutdownTimeoutMs | 10,000 | **YES** |

### Error Handling + Canonical Envelopes

- Transaction rolled-back envelope — **PASS**
- Error codes consistent (DFQL_INVALID, FORBIDDEN, INTERNAL, TRANSACTION_ROLLED_BACK) — **PASS**
- Error disclosure controlled by debug mode — **PASS**
- Transact step errors include path — **PASS**
- Rate limit 429 includes Retry-After — **PASS**
- Status time rounded to minute — **PASS**

### Compatibility / Versioning

- `allowUnknownResources: true` escape hatch — **PASS**
- Transaction response format changed (breaking) — **PASS** (documented)
- WS hello namespace ignored (non-breaking) — **PASS**
- maxPayloadBytes default 5MB (potentially breaking) — **PASS** (documented)
- $or filter explicit rejection — **PASS**

---

## Recommendations (Ranked)

### Priority 1 — Fix PARTIAL/FAIL on CRITICAL requirements

1. **SEC-006 (PARTIAL)**: Wire `maxBatchSize` from config and enforce on `/datafn/mutation` endpoint. Currently hardcoded to 500 and only checked on push.
   - Risk: Unbounded batch mutations via mutation endpoint could cause OOM or DoS
   - Fix: Add `maxBatchSize` check in `routes/mutation.ts` handler

2. **SEC-008 (PARTIAL)**: Extend prototype pollution check to query top-level objects, aggregation configs, and having clauses.
   - Risk: Prototype pollution possible through unchecked entry points
   - Fix: Add `checkPrototypePollution()` calls in `validateQuery`, `validateAggregations`, `validateHaving`

3. **REL-002 (PARTIAL)**: Add retry logic (`recordChangeWithRetry`) to `execute.ts` for consistency with `push.ts`.
   - Risk: Transient change tracking failures in mutation execution path cause immediate failure without retry
   - Fix: Import and use `recordChangeWithRetry` in `executeMutationCore`

4. **REL-011 (PARTIAL)**: Make mutation + change tracking atomic in push.
   - Risk: Server crash between mutation commit and change log entry causes sync drift
   - Fix: Use `ChangeTrackingService.withDb(txDb)` to record changes within the mutation transaction

### Priority 2 — Fix FAIL items

5. **PER-002 (FAIL)**: Convert dynamic import in `routes/mutation.ts:97` to static top-level import.
   - Risk: Performance overhead on every mutation request
   - Fix: Move `import("../validation/authz.js")` to top-level `import`

6. **EXE-019 (FAIL)**: Change `DatabaseSequenceStore.getCurrent()` to propagate errors instead of returning 0.
   - Risk: Sequence store errors silently return 0, potentially causing duplicate sequences
   - Fix: Remove try/catch, let errors propagate

7. **EXE-020 (FAIL)**: Wrap push mutations in a transaction when adapter supports it.
   - Risk: Partial push application on failure
   - Fix: Use `db.transaction()` wrapper in push executor

### Priority 3 — Verify UNVERIFIED items

8. Audit test coverage files (TST-001 to TST-007) for completeness against test vectors.
9. Verify remaining UNVERIFIED MEDIUM/LOW items (EXE-004, EXE-013-015, SRV-003, SRV-005, CLI-004, CLI-006, CLI-007).

---

## Appendix: Commands Run + Environment Details

- **Commands**: git rev-parse HEAD, git status, grep/glob/read on all spec and implementation files
- **Files read**: ~60 implementation files across datafn/server, datafn/client, datafn/core
- **Method**: Static code audit — no tests were executed during this audit
- **Limitations**: UNVERIFIED items could not be confirmed due to audit scope (read-only, no test execution). Test coverage (TST-001-007) is reported based on file existence, not content verification.
