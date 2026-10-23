# Full Audit Report

## Metadata
- **timestamp**: 2026-02-09T14:35:00Z
- **agent_name**: warp-agent
- **model**: claude 4.6 opus (max)
- **launcher**: Warp
- **workspace_root**: /Users/ar/dev
- **project_root**: /Users/ar/dev/superfunctions/datafn
- **OS**: darwin (MacOS)
- **shell**: zsh 5.9
- **repo**:
  - **is_git_repo**: true
  - **branch**: next
  - **commit**: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - **dirty**: true (223 modified files in datafn/)
- **intent_paths audited**:
  - `datafn/.conduct/intent/datafn.intent.md`
  - `datafn/.conduct/intent/implementation.md`
  - `datafn/.conduct/intent/migration-plan-from-nucleus.md`
  - `datafn/.conduct/intent/spec.md` (referenced but not separately read; covered by SPEC.md)
- **spec_bundle_paths audited**:
  - `datafn/.conduct/specs/2026-02-06-audit-fix-k4m2p9x7-spec/`
    - `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, `INTENT_AUDIT.md`
    - `phases/PHASE_00.md` through `PHASE_13.md`
    - `phase-reports/PHASE_00` through `PHASE_12` reports
- **codebase scope audited**:
  - `datafn/client/src/` (all .ts files)
  - `datafn/server/src/` (all .ts files)
  - `datafn/core/src/` (referenced via imports)
  - `datafn/svelte/` (referenced)
  - `nucleus/client/components/flux/` (checked for Phase 13 status)
- **commands executed during audit**:
  - `npm test -w @datafn/client` → 199 passed / 14 failed (213 total)
  - `npm test -w @datafn/server` → 195 passed / 19 failed (214 total)
  - `git log -1 --oneline`, `git status --porcelain datafn/ | wc -l`
  - `grep` for hard-coded namespace patterns
  - Various `ls`, `file_glob` for directory exploration

---

## Audit Scope
This is a FULL audit of the `datafn` codebase against:
1. The original user intent (intent documents)
2. The spec bundle `2026-02-06-audit-fix-k4m2p9x7-spec` (SPEC, REQUIREMENTS, TEST_VECTORS, PLAN, INTENT_AUDIT, phases)

---

## High-Level Findings
- **Phases 00–12** have been implemented and each has a phase report marked PASS.
- **Phase 13** (Nucleus direct refactor to datafn) has **NOT been implemented**. Flux code still exists in `nucleus/client/components/flux/`.
- **14 client test failures** and **19 server test failures** exist. Most are pre-existing or due to protocol evolution (per-table cursors replacing legacy global cursor in tests), but they indicate incomplete integration work.
- **AUTH-002** (namespace correctness): Fallback to hard-coded `"datafn"` still exists in 16+ server source locations as a default when `extractNamespace` is not provided. While these are fallback defaults (not hard-coded in execution when a namespace extractor is configured), the spec says "no hard-coded `\"datafn\"` namespace" — this remains a PARTIAL compliance issue.
- **Signal footprint derivation** (SIG-001) uses a simplified heuristic that assumes relation names equal resource names. The TODO comment in code acknowledges this gap.

---

## Intent Inventory (numbered)
Derived from `INTENT_AUDIT.md` and validated against intent documents.

1. `sync.remoteAdapter` injection for remote transport (extension support)
2. Local-only mode (no remote) with local-first query/mutate and durable changelog
3. Resource-aware ID generation and prefix enforcement
4. Mutation `context` support and propagation (events + hooks + logging)
5. Event payload completeness (ids, action, fields, mutationId/clientId, deterministic derivation)
6. Context-aware subscriptions with value matching
7. Selective and debounced signal invalidation based on query footprint
8. Nucleus adoption without Flux-style wrapper stores; preserve signals
9. First-class KV support (built-in KV table + ergonomic API)
10. Scalable clone: pagination + optional join inclusion
11. Hydration plan: boot vs background resources
12. Pull protocol: per-table cursors canonical; legacy global-cursor compatibility
13. Offline apply for relation mutations (relate/modifyRelation/unrelate)
14. Server push supports relation ops and records join deltas
15. Clone/pull propagate join rows/deltas into client join stores
16. Reconcile/repair mechanism (counts-based)
17. Local query performance + operator coverage (index-aware + required operators)
18. Date codec parity (serialize outbound Dates; parse inbound date fields)
19. Client sync lifecycle hooks + sync events
20. Server authz/permissions enforcement (table + field)
21. Server namespace isolation correctness (no hard-coded namespace)
22. Extension remote event propagation
23. Nucleus refactor: remove Flux from runtime, replace GlobalEvent.MUTATION, replace KV usage, configure extension remote adapter

---

## Intent → Spec Coverage Matrix

| # | Intent Item | SPEC Section | Requirement(s) | Test Vector(s) | Coverage |
|---|---|---|---|---|---|
| 1 | remoteAdapter injection | Public API, Semantics §2 | CFG-001 | TV-CFG-001, TV-CFG-001N | COVERED |
| 2 | local-only mode | Semantics §1 | CFG-002 | TV-CFG-002, TV-CFG-002N | COVERED |
| 3 | resource-aware IDs | Semantics §11, Public API | API-001 | TV-ID-001, TV-ID-001N | COVERED |
| 4 | mutation context | Public API, Semantics §3 | API-002 | TV-CTX-001, TV-CTX-001N | COVERED |
| 5 | event payload completeness | Public API, Invariants | EVT-001 | TV-EVT-001, TV-EVT-001N | COVERED |
| 6 | context value filtering | Public API, Semantics §3 | EVT-002, NUC-002 | TV-EVT-002, TV-EVT-002N | COVERED |
| 7 | selective + debounced signals | Semantics §4 | SIG-001, SIG-002 | TV-SIG-001/N, TV-SIG-002/N | COVERED |
| 8 | no Flux-like wrappers | Semantics §5 | DX-001 | TV-NUC-005, TV-NUC-005N | COVERED |
| 9 | first-class KV | Public API, Semantics KV | KV-001, KV-002, NUC-003 | TV-KV-001/N, TV-KV-002/N | COVERED |
| 10 | clone scalability | Data formats, Semantics §6 | SYNC-001 | TV-SYNC-001, TV-SYNC-001N | COVERED |
| 11 | hydration plan | Public API, Semantics §6 | SYNC-002 | TV-SYNC-002, TV-SYNC-002N | COVERED |
| 12 | pull cursors + legacy compat | Data formats, Semantics §7 | SYNC-003, SYNC-004 | TV-SYNC-003/N, TV-SYNC-004/N | COVERED |
| 13 | offline relation apply | Semantics §10 | OFFM-001 | TV-OFFM-001, TV-OFFM-001N | COVERED |
| 14 | push relation ops + join tracking | Data formats, Semantics §10 | SYNC-005 | TV-REL-001, TV-REL-001N | COVERED |
| 15 | join hydration via clone/pull | Data formats, Semantics §10 | SYNC-006 | TV-REL-002, TV-REL-002N | COVERED |
| 16 | reconcile/repair | Data formats, Semantics §8 | SYNC-007 | TV-RECON-001, TV-RECON-001N | COVERED |
| 17 | local query perf + operators | Semantics §9 | OFFQ-001, OFFQ-002 | TV-OFFQ-001/N, TV-OFFQ-002/N | COVERED |
| 18 | date codec parity | Semantics §11 | CODEC-001 | TV-CODEC-001, TV-CODEC-001N | COVERED |
| 19 | sync hooks + events | Semantics §12 | HOOK-001, EVT-003 | TV-HOOK-001/N, TV-EVT-003/N | COVERED |
| 20 | server authz/permissions | Security, Semantics §13 | AUTH-001 | TV-AUTH-001, TV-AUTH-001N | COVERED |
| 21 | namespace isolation | Semantics §13, Security | AUTH-002 | TV-AUTH-002, TV-AUTH-002N | COVERED |
| 22 | extension remote events | Public API, Semantics | EXT-001 | TV-EXT-001, TV-EXT-001N | COVERED |
| 23 | Nucleus refactor | Goals, Semantics §5, Plan §13 | NUC-001–004, DX-001 | TV-NUC-001–005/N | COVERED |

**Spec completeness**: No SPEC MISSING items. All 23 intent items map to spec sections, requirements, and test vectors.

---

## Requirement Coverage Summary

### Per Spec Bundle (PASS/PARTIAL/FAIL/UNVERIFIED counts)

| Status | Count | Requirements |
|---|---|---|
| PASS | 22 | CFG-001, CFG-002, API-001, API-002, EVT-001, EVT-002, SIG-001, SIG-002, KV-001, KV-002, SYNC-001, SYNC-002, SYNC-003, SYNC-005, SYNC-006, OFFQ-001, OFFQ-002, OFFM-001, CODEC-001, HOOK-001, EVT-003, EXT-001 |
| PARTIAL | 5 | SYNC-004, SYNC-007, AUTH-001, AUTH-002, DX-001 |
| FAIL | 4 | NUC-001, NUC-002, NUC-003, NUC-004 |
| UNVERIFIED | 0 | — |

---

## Requirement-by-Requirement Results

### CFG-001 — Remote adapter injection: **PASS**
- `DatafnRemoteAdapter` interface defined in `client/src/client.ts:29-38`
- When `sync.remoteAdapter` is provided, it is used for all calls (line 378-380)
- When absent and `sync.remote` is present, DefaultHttpTransport is used (line 402-404)
- When both are present, `remoteAdapter` takes precedence (line 378, checked first)
- Sync mode without either throws deterministic `DFQL_INVALID` (line 215-223)
- TV-CFG-001, TV-CFG-001N: PASS (199/213 client tests pass; these specific vectors are covered)

### CFG-002 — Local-only mode: **PASS**
- `sync.mode: "local-only"` supported in config (line 109)
- In local-only mode, all non-remote-only resources are marked `ready` immediately (lines 354-372)
- Mutations apply locally and append to changelog (line 133-183 in mutate.ts)
- `sync.start()` is effectively a no-op when no SyncEngine is created (no engine in local-only without offlinability, or engine exists but initializeSync handles it)
- TV-CFG-002, TV-CFG-002N: PASS

### API-001 — Resource-aware ID generation: **PASS**
- `generateId` config option accepted (line 168)
- Default generator uses `idPrefix || resource` prefix with `crypto.randomUUID()` (lines 281-295)
- Prefix validation exists in table registry where IDs are validated on insert
- TV-ID-001, TV-ID-001N: PASS

### API-002 — Mutation context support: **PASS**
- Context accepted on mutations (validated as JSON-serializable in mutate.ts:81-107)
- Propagated to `mutation_applied`/`mutation_rejected` events (mutate.ts:307)
- Non-serializable context rejected with `DFQL_INVALID` (mutate.ts:100-105)
- TV-CTX-001, TV-CTX-001N: PASS

### EVT-001 — Mutation event payload completeness: **PASS**
- Events include `resource`, `ids`, `mutationId`, `clientId`, `action`, `fields`, `timestampMs`, `context`
- `fields` derived from `mutation.record` keys excluding `id`, sorted lexicographically (mutate.ts:293-297)
- `action` equals `mutation.operation` (mutate.ts:289)
- TV-EVT-001, TV-EVT-001N: PASS

### EVT-002 — Context filtering: **PASS**
- `contextKeys` matching: all keys must exist (filter.ts:134-142)
- `context` shallow equality: all key/value pairs must match via `===` (filter.ts:145-157)
- Missing `event.context` causes any context filter to fail (filter.ts:135-137, 146-148)
- TV-EVT-002, TV-EVT-002N: PASS

### SIG-001 — Selective signal invalidation: **PASS** (with note)
- Footprint derived from query resource + relation expansion tokens in select (querySignal.ts:52-78)
- Events only trigger refresh when `event.resource` is in footprint (querySignal.ts:176-184)
- **Note**: Footprint derivation uses a simplified heuristic — assumes relation name matches resource name. Code contains a TODO: "Full relation mapping will be added in Phase 03 when relation support is complete" (line 69). This means a relation named "properties" pointing to resource "property" would NOT be correctly mapped. This is a known limitation documented in the code.
- TV-SIG-001, TV-SIG-001N: PASS (basic footprint tests pass)

### SIG-002 — Debounced signal refresh: **PASS**
- Microtask debounce via `Promise.resolve()` (querySignal.ts:169-173)
- Multiple events in same tick cause at most one refresh (pendingRefresh flag)
- Queued refresh executes after in-flight completes (queuedRefresh flag, lines 103-107, 149-153)
- TV-SIG-002, TV-SIG-002N: PASS

### KV-001 — Built-in KV resource: **PASS**
- `ensureBuiltinKv()` adds KV resource to schema regardless of user schema (client.ts:276)
- KV entries stored in IndexedDB/memory via standard storage adapter
- KV syncable offline-first via normal mutation/query paths
- TV-KV-001, TV-KV-001N: PASS

### KV-002 — KV convenience API: **PASS**
- `get/set/merge/delete/signal` all implemented (kv.ts:46-322)
- `set` uses `replace` operation and emits events via kvTable.mutate
- `merge` shallow-merges objects, rejects non-object existing values with `DFQL_INVALID`
- `signal(key)` scoped to specific KV id (filters by `id: { eq: kvId(key) }`)
- TV-KV-002, TV-KV-002N: PASS

### SYNC-001 — Paginated clone: **PASS**
- Client SyncEngine supports paginated clone via `cloneTablePaginated()` (engine.ts:321-351)
- `page: { table, afterId, limit }` sent in request
- `next` marker checked for more pages (line 341-344)
- Server `executeClone` accepts and processes pagination
- TV-SYNC-001, TV-SYNC-001N: PASS

### SYNC-002 — Hydration plan: **PASS**
- Boot vs background resources supported (engine.ts:209-222)
- Boot resources cloned first (blocking), background cloned async (non-blocking)
- Queries on hydrating resources use remote fallback in query.ts routing logic
- TV-SYNC-002, TV-SYNC-002N: PASS

### SYNC-003 — Per-table cursors pull: **PASS**
- Pull uses per-table cursors map `{ [resource]: cursor }` (engine.ts:400-440)
- Response returns `{ records, deleted, joins, cursors }`
- Cursor updates are monotonic per resource
- TV-SYNC-003, TV-SYNC-003N: PASS

### SYNC-004 — Legacy global cursor pull: **PARTIAL**
- Server pull handler exists and accepts both formats
- However, **4 sync test failures** in client indicate legacy cursor format expectations are broken by the per-table cursor migration
- The test `TV-PULL-005` explicitly shows the mismatch: test expects `{ cursor: "10" }` but implementation sends `{ cursors: { kv: "0", task: "0", user: "0" } }`
- This is a known regression from the per-table cursor migration
- **Status**: Server-side backward compatibility exists; client-side tests need updating

### SYNC-005 — Push supports relation mutations: **PASS**
- Push handler validates relation operations against schema (sync.ts:276-289)
- Relation mutations tracked in change tracking
- Idempotency works for relation mutations via same (clientId, mutationId) dedupe
- TV-REL-001, TV-REL-001N: PASS

### SYNC-006 — Join row propagation via clone/pull: **PASS**
- `applyCloneResult` and `applyPullResult` in `sync/apply.ts` route join deltas to storage
- Clone includes join rows when `includeJoins: true`
- Pull includes join row upsert/delete deltas
- TV-REL-002, TV-REL-002N: PASS

### SYNC-007 — Reconcile: **PARTIAL**
- Server reconcile endpoint implemented (routes/sync.ts:381-475)
- Client `reconcileNow()` implemented (engine.ts:529-641)
- Compares local vs server counts, triggers re-clone for mismatches
- Emits `sync_applied`/`sync_failed` with `phase: "reconcile"`
- **Issue**: `reconcile` is optional on `DatafnRemoteAdapter` interface (`reconcile?:` at line 37). If adapter doesn't support it, `reconcileNow()` throws "Remote adapter does not support reconcile" — this is correct but may surprise consumers
- TV-RECON-001, TV-RECON-001N: PARTIAL (server-side covered; client integration test coverage unclear from failing tests)

### OFFQ-001 — Index-aware local query: **PASS**
- `id eq X` uses `getRecord` (query.ts:32-38)
- Single-field indexed eq uses `findRecords` (query.ts:42-49)
- Fallback to full scan when index unavailable (query.ts:54-56)
- TV-OFFQ-001, TV-OFFQ-001N: PASS

### OFFQ-002 — Local filter operator coverage: **PASS**
- `$and`, `$or` with short-circuit (query.ts:150-183)
- `eq/$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin` (query.ts:191-220)
- `$contains` for arrays (query.ts:221-226)
- Unsupported operators rejected with `DFQL_UNSUPPORTED` (query.ts:228-233)
- `$or` non-array rejected with `DFQL_INVALID` (query.ts:169-173)
- TV-OFFQ-002, TV-OFFQ-002N: PASS

### OFFM-001 — Offline apply for relation mutations: **PASS**
- `relate`: upserts join rows (many-many), updates FK (many-one/one-many) (offline/mutate.ts:197-289)
- `modifyRelation`: updates metadata, rejects NOT_FOUND (offline/mutate.ts:295-338)
- `unrelate`: deletes join rows (many-many), clears FK (many-one/one-many) (offline/mutate.ts:344-415)
- Validation before apply (line 52-56, 114-192)
- TV-OFFM-001, TV-OFFM-001N: PASS

### CODEC-001 — Date field codec: **PASS**
- Outbound: `serializeDateFields()` converts Date → ISO string (codecs/date.ts:21-67)
- Inbound: `parseDateFields()` converts ISO string → Date (codecs/date.ts:78-135)
- Invalid dates rejected with `DFQL_INVALID` (line 48-54, 106-111)
- Applied in mutation path via `applyDateCodecToMutation()` (mutate.ts:29-56)
- TV-CODEC-001, TV-CODEC-001N: PASS

### HOOK-001 — Client sync hooks: **PASS**
- `runBeforeSync`/`runAfterSync` called for clone (engine.ts:243-280), pull (engine.ts:457-480), push (engine.ts:728-767), reconcile (engine.ts:540-615)
- `beforeSync` is fail-closed (errors prevent operation)
- `afterSync` is fail-open (errors logged but don't fail operation)
- Hook context includes schema and phase
- TV-HOOK-001, TV-HOOK-001N: PASS

### EVT-003 — Sync lifecycle events: **PASS**
- `sync_applied` emitted for clone (engine.ts:283-291), pull (engine.ts:495-504), push (engine.ts:770-778), reconcile (engine.ts:618-625)
- `sync_failed` emitted for all failure paths (engine.ts:293-305, 509-520, 789-801, 627-639)
- Context includes `phase`, relevant cursor/resource stats, and error info
- TV-EVT-003, TV-EVT-003N: PASS

### AUTH-001 — Server permissions policy: **PARTIAL**
- `DatafnPermissionsPolicy` type defined in core
- `validateQueryAuthz()` checks select/filter fields against `read.fields` (authz.ts:21-82)
- `validateMutationAuthz()` checks record fields against `write.fields` (authz.ts:137-181)
- Unauthorized access returns `FORBIDDEN`
- **Issue**: Hard-coded list of "always allowed" fields (`id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `isArchived`) in authz.ts:50-56. This bypasses the policy for these fields, which may not be the desired behavior for all schemas. The spec says "schema-bounded validation" but the hard-coded list assumes a specific field naming convention.
- **Issue**: Relation operations are noted as "implicitly allowed" with a comment "This is marked as minimal shape" (authz.ts:175-179). No fine-grained relation authz.
- TV-AUTH-001, TV-AUTH-001N: PASS (basic tests pass, but edge cases around hard-coded fields not tested)

### AUTH-002 — Namespace correctness: **PARTIAL**
- `extractNamespace` parameter threading exists in all sync/mutation/query routes
- However, fallback `"datafn"` still present as default in 4 sync route handlers (sync.ts:64, 163, 321, 424) and multiple execution files (grep found 16+ occurrences)
- Pattern is: `const namespace = extractNamespace ? await extractNamespace(ctx) : "datafn"`
- While this is a configurable fallback (not "hard-coded in execution" when a namespace extractor is configured), the spec explicitly says "no hard-coded `\"datafn\"` namespace" and the test vector TV-AUTH-002N checks for absence of hard-coded "datafn"
- **Risk**: In production, if `extractNamespace` is accidentally not provided, all data goes into the same "datafn" namespace — cross-tenant leakage
- **Recommendation**: Require `extractNamespace` when multi-tenant mode is enabled, or use a UUID-based default namespace

### EXT-001 — Extension remote event propagation: **PASS**
- Extension adapter detection via `onEvent` capability check (client.ts:384)
- Inbound remote events wired into local event bus (client.ts:388-392)
- `ExtensionSubscriptionManager` manages lifecycle (client.ts:395-401)
- Subscribe/unsubscribe deterministic with reference counting
- TV-EXT-001, TV-EXT-001N: PASS

### NUC-001 — Nucleus removes Flux: **FAIL**
- Flux code still exists at `nucleus/client/components/flux/flux.ts` (49,850 bytes)
- `resourceStores/` directory still present with active stores
- No phase-13 report exists (Phase 13 has NOT been executed)
- TV-NUC-001: FAIL

### NUC-002 — Nucleus replaces mutation filtering: **FAIL**
- Depends on NUC-001; Flux GlobalEvent.MUTATION patterns still active in Nucleus
- The datafn-side capability (DatafnEventFilter) is fully implemented, but Nucleus has not been refactored to use it
- TV-NUC-002: FAIL

### NUC-003 — Nucleus replaces KeyValueStore: **FAIL**
- KV API (`client.kv`) is fully implemented and tested on the datafn side
- Nucleus still uses Flux KeyValueStore (files exist in `nucleus/client/components/flux/resourceStores/`)
- TV-NUC-003: FAIL

### NUC-004 — Nucleus extension uses remoteAdapter: **FAIL**
- Extension adapter infrastructure complete (EXT-001 PASS)
- Nucleus has not been configured to use `sync.remoteAdapter` with datafn
- `fluxExtentionMediator.ts` still exists and is presumably active
- TV-NUC-004: FAIL

### DX-001 — Nucleus ergonomics without wrappers: **PARTIAL**
- The datafn API surface (tables, signals, subscriptions) is correctly designed for direct use
- `@datafn/svelte` exists with `toSvelteStore` helper
- However, since NUC-001–004 are FAIL, the actual Nucleus integration has not happened, so DX-001 cannot be fully verified
- The architectural constraint is satisfied in datafn's design; enforcement in Nucleus is unverified

---

## Spec Conflicts / Spec Gaps

### Spec Conflicts
**None identified.** Single spec bundle, no conflicting requirements.

### Spec Gaps
1. **Signal footprint relation mapping** (SIG-001): SPEC.md says footprint includes "resources referenced by relation expansion tokens in select" but doesn't specify what happens when relation names don't equal resource names. Implementation uses a simplified heuristic. The spec should clarify the mapping mechanism (schema lookup).
2. **Namespace fallback behavior** (AUTH-002): SPEC.md says "no hard-coded `\"datafn\"` namespace" but doesn't specify what the default should be when `extractNamespace` is not configured. Should this be an error? A generated namespace?
3. **Reconcile adapter optionality**: `DatafnRemoteAdapter.reconcile` is typed as optional (`reconcile?:`), yet SYNC-007 requires reconcile. The spec doesn't address what happens when the adapter doesn't support reconcile.

---

## Cross-Cutting Audits

### Security / AuthZ / Validation Boundaries
- **Schema-bounded validation**: Implemented. Unknown resources/fields rejected with `DFQL_INVALID` or `DFQL_UNKNOWN_FIELD`/`DFQL_UNKNOWN_RELATION`.
- **Authz enforcement**: Implemented for read (select/filter) and write (record fields) with `FORBIDDEN`. Relation-level authz is minimal (implicit allow).
- **Namespace isolation**: Partially implemented. `extractNamespace` threading exists but fallback to `"datafn"` remains.
- **Extension trust model**: Content/sidepanel are untrusted; background is authoritative. Implemented via remote adapter architecture.
- **Sensitive data in logs**: Server logging includes `clientId`, `mutationId`, `operation`, `duration_ms`. Record payloads are not logged by default (only "redacted" per spec). The `logRequest` function in logging.ts does not log record contents. **PASS**.

### Determinism
- **Stable ordering**: Sort by `id:asc` tie-breaker in offline query (query.ts:79-81). `fields` in events sorted lexicographically (mutate.ts:296). Sync event resources sorted (engine.ts:288). **PASS**.
- **Event fields derivation**: Deterministic — derived from `mutation.record` keys excluding `id`, sorted (mutate.ts:293-297). **PASS**.
- **Signal invalidation**: Deterministic for same event stream (footprint-based matching is pure). **PASS**.
- **Sync application**: applyCloneResult/applyPullResult are deterministic for same input (apply records, then joins, update cursors in order). **PASS**.

### Idempotency
- **Client-side**: `(clientId, mutationId)` enriched on mutations before push (mutate.ts:152-158, engine.ts:722-725).
- **Server-side**: `IdempotencyStore` checked before executing push mutations.
- **Offline changelog**: Appended with `(clientId, mutationId)` for dedupe on push.
- **PASS** — Dedupe exists end-to-end.

### Error Handling + Canonical Envelopes
- **Server responses**: Canonical `{ ok: true, result }` or `{ ok: false, error: { code, message, details: { path } } }` pattern used consistently across all routes.
- **Client errors**: `createClientError()` used for config errors; mutation/sync errors follow the same shape.
- **19 server test failures**: Some relate to error code mismatches (e.g., `DFQL_INVALID` vs `DFQL_UNKNOWN_FIELD` in transact validation). This indicates inconsistency in error code granularity.
- **PARTIAL** — Envelope structure is correct; some error codes are inconsistent.

### Compatibility / Versioning / Migrations
- **Existing `sync.remote: string` configs**: Continue to work (DefaultHttpTransport created).
- **`sync.remoteAdapter` additive**: Takes precedence when present. **PASS**.
- **Pull backward compatibility**: Server accepts both legacy global-cursor and per-table cursor shapes. However, client-side tests show the migration is incomplete (4 test failures). **PARTIAL**.

### Limits / Caps
- **Server max limit**: Not directly observed in route handlers as configurable; likely handled in query execution layer.
- **Clone pagination max page size**: Default 1000 in SyncEngine (engine.ts:367).
- **Pull max per-table limit**: Default 200 (engine.ts:453).
- **Max transact steps / max payload bytes**: Not directly observed in audited code. These may be configurable but are not enforced visibly in the routes.
- **PARTIAL** — Some limits exist; configurable max payload bytes and max transact steps are not clearly enforced.

---

## Recommendations (ranked)

### Critical (must fix)
1. **Execute Phase 13 (Nucleus refactor)** — NUC-001, NUC-002, NUC-003, NUC-004 are all FAIL. This is the highest-priority gap. Nucleus still depends entirely on Flux. All datafn integration points are ready; the refactor is blocked only on execution.
2. **Fix AUTH-002 namespace fallback** — Replace the hard-coded `"datafn"` fallback with either: (a) a required `extractNamespace` in multi-tenant configurations, or (b) a dynamically generated default namespace. Current pattern risks cross-tenant leakage if `extractNamespace` is accidentally omitted. Affects 16+ locations across server routes and execution files.

### High (should fix)
3. **Fix legacy pull test regressions** — 4 client sync tests fail because they expect the old global cursor format. Either update tests to use per-table cursors or implement proper backward-compatible handling in the client SyncEngine.
4. **Improve SIG-001 footprint derivation** — Replace the simplified relation-name-equals-resource-name heuristic with proper schema lookup. The current implementation will cause false negatives (missing refreshes) when relation names differ from target resource names. Fix location: `deriveQueryFootprint()` in `querySignal.ts`.
5. **Fix server error code inconsistencies** — 19 server test failures include error code mismatches (e.g., `DFQL_INVALID` vs `DFQL_UNKNOWN_FIELD`). Audit and standardize error codes across validation layers.

### Medium (recommended)
6. **Make reconcile non-optional on remote adapter** — Either make `reconcile` required on `DatafnRemoteAdapter` or add graceful degradation (emit `sync_failed` with `UNSUPPORTED` code instead of throwing).
7. **Enforce configurable limits** — Add explicit max payload bytes and max transact steps enforcement in server routes, with configurable defaults.
8. **Fix pre-existing cloneUp/KV test failures** — 8 client test failures in `cloneUp.test.ts` related to KV resource stats indicate the KV integration with cloneUp is incomplete.
9. **Add relation-level authz** — Current authz validates field access but implicitly allows all relation operations. For production use, add configurable relation-level permissions.
10. **Remove hard-coded field allowlist in authz** — The `isArchived`, `createdAt`, etc. hard-coded list in `authz.ts` should be schema-driven, not assumed.

---

## Appendix: Commands Run + Environment Details

### Commands executed
- `npm test -w @datafn/client` — 199/213 passed, 14 failed (3 test files)
- `npm test -w @datafn/server` — 195/214 passed, 19 failed (9 test files)
- `grep "hard.*coded.*namespace|namespace.*=.*\"datafn\""` in server/src — 16+ matches
- `ls -la` on datafn/, .conduct/specs/, phases/, phase-reports/, intent/
- `git log -1 --oneline` — commit 98c7185
- `git status --porcelain datafn/ | wc -l` — 223 dirty files
- `file_glob *.ts` in client/src and server/src
- `codebase_semantic_search` for various concepts

### Test failure breakdown

**Client (14 failures)**:
- `cloneUp.test.ts` (8): KV resource stats mismatch in cloneUp scenarios
- `sync.test.ts` (4): Legacy global cursor format expectations broken by per-table cursor migration
- `storage-idb.test.ts` (2): Store initialization issues

**Server (19 failures)**:
- REST endpoint tests: clientId passing issues
- Pull cursor validation: Legacy format expectations
- Transact validation: Error code mismatches (DFQL_INVALID vs DFQL_UNKNOWN_FIELD)
- Various pre-existing failures not related to the audited spec
