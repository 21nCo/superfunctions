# Metadata
- **timestamp**: 2026-03-08T07:07:50Z
- **agent_name**: unknown-agent
- **model**: gpt-5-codex (inferred)
- **launcher**: Codex Desktop
- **workspace/project**: /Users/serro/Documents/dev/n/superfunctions
- **os/shell**: Darwin 25.3.0 (arm64), /bin/zsh
- **repo**: git repo
  - branch: `next`
  - commit: `635bf2853807d9d76dba07a460dd0594f57d9147`
  - dirty status: `dirty (247 files changed in working tree)`
- **intent/notes paths audited**:
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec/INTENT_AUDIT.md`
- **spec bundle paths audited**:
  - bundle root: `/Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec`
  - included files:
    - `SPEC.md`
    - `REQUIREMENTS.md`
    - `TEST_VECTORS.md`
    - `PLAN.md`
    - `INTENT_AUDIT.md`
    - `phases/PHASE_00.md`
    - `phases/PHASE_01.md`
    - `phases/PHASE_02.md`
    - `phases/PHASE_03.md`
    - `phases/PHASE_04.md`
    - `phases/PHASE_05.md`
    - `phases/PHASE_06.md`
    - `phase-reports/PHASE_00-2026-03-08-b4x2m7p1-report.md`
    - `phase-reports/PHASE_01-2026-03-08-c5r9k1n3-report.md`
    - `phase-reports/PHASE_02-2026-03-08-h2v5p8n3-report.md`
    - `phase-reports/PHASE_03-2026-03-08-e7a2f9k4-report.md`
    - `phase-reports/PHASE_04-2026-03-08-j9n3r6t2-report.md`
    - `phase-reports/PHASE_05-2026-03-08-x3t7m9k2-report.md`
    - `phase-reports/PHASE_06-2026-03-08-m2k4p7r9-report.md`
- **codebase scope audited**:
  - root: `/Users/serro/Documents/dev/n/superfunctions`
  - primary implementation scope: `searchfn/{core,adapters,datafn-provider,client}`, `datafn/{core,server,client}`
  - secondary check scope: `packages/db` (fallback capability surface)
  - excluded from deep audit: `node_modules/`, generated `dist/`, unrelated monorepo packages
- **commands executed during audit**: included in Appendix

# Audit scope
This is a full, requirement-by-requirement audit of the implemented code against:
1. intent (`INTENT_AUDIT.md`), and
2. all provided spec artifacts (`SPEC`, `REQUIREMENTS`, `TEST_VECTORS`, `PLAN`, `phases`, phase reports).

Implementation verification used both static code inspection and targeted test execution.

# Inputs audited (intent + spec bundles)
- Intent source: `/Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec/INTENT_AUDIT.md`
- Spec bundle: `/Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec`
- Implementation audited:
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/src/*`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/datafn-provider/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/core/src/*`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/client/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/core/src/search-provider.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/{server.ts,search-provider.ts,routes/search.ts,execution/search/cross-resource.ts,execution/query/search.ts,routes/query/execute.ts,execution/mutation/execute.ts,validation/query.ts}`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/client/src/{client.ts,transport/http.ts,sync/engine.ts}`

# High-level findings
1. **Major drift remains in DataFn search semantics**: canonical no-provider fallback, canonical error codes/messages, and abort behavior are not implemented per spec (PROV-010, XSRC-006, DET-002, VLIM-001/002/004).
2. **Adapter/provider architecture exists and is mostly solid**: `@searchfn/core`, `@searchfn/adapters`, `@searchfn/datafn-provider`, and stubs/compat exports are implemented and tested.
3. **Lifecycle and deterministic requirements are only partially met**: adapter re-initialize-after-dispose path is blocked; IndexedDB initialize semantics are weaker than specified; deterministic tie-break is not consistently enforced for all result surfaces.
4. **Compatibility/migration goals are achieved**: `SearchFnPlugin` scanning removal and `@searchfn/client` backward-compat surfaces are present and tested.
5. **Spec conflict exists inside bundle artifacts** (details below), especially around startup failure semantics and limit behavior.

# Intent Inventory (numbered)
1. Core engine internals shared across adapters.
2. Memory and IndexedDB are first-class adapters.
3. Unified adapter contract for all backends.
4. External adapter surface exists (stub-level).
5. Dedicated `SearchProvider` (not `DatafnPlugin`).
6. Config-slot integration on server/client (`searchProvider`).
7. `createSearchProvider(adapter)` bridge.
8. `searchAll` fallback in provider bridge.
9. Built-in mutation index wiring (fail-soft).
10. Built-in sync index wiring.
11. Clone deferral + async rebuild lifecycle for local-first scale.
12. Provider lifecycle init/dispose.
13. Single-resource DFQL search uses provider.
14. First-class `DatafnServer.search()`.
15. First-class `DatafnClient.search()`.
16. `POST /datafn/search` route.
17. Per-resource post-candidate filtering.
18. Hydration from DB + select projection.
19. AbortSignal behavior.
20. Offline behavior canonical and deterministic.
21. Empty-query boundary (`.search()` is not recents/default API).
22. Linking-search profile via scoped/bounded `.search()`.
23. Highlighting/strict behavior boundary explicitly client-side.
24. Deterministic ordering and tie-breaks.
25. Canonical error mapping across entry points.
26. Query/resource/filter caps.
27. Deterministic large-batch indexing behavior.
28. Backward compatibility for `InMemorySearchFn` + `SearchFn` core/advanced APIs.
29. Export-surface compatibility guard.
30. DataFn plugin-search migration completeness.

# Intent → Spec coverage matrix (complete; no sampling)
| Intent # | Intent summary | Spec refs | Requirement IDs | Test vectors | Intent→Spec status | Implementation status |
|---|---|---|---|---|---|---|
| 1 | Core internals shared | §1, §14 | CORE-004 | TV-CORE-003 | COVERED | PARTIAL |
| 2 | Memory + IndexedDB adapters | §5.2, §5.3 | CORE-002, CORE-003 | TV-MEM-*, TV-IDB-* | COVERED | PARTIAL |
| 3 | Unified adapter contract | §5.1 | CORE-001 | TV-CORE-001, TV-CORE-002 | COVERED | PASS |
| 4 | External adapter stubs | §5.4 | CORE-011 | TV-STUB-001 | COVERED | PASS |
| 5 | Dedicated SearchProvider | §5.5 | PROV-001 | TV-PROV-001 | COVERED | PASS |
| 6 | Config-slot integration | §5.6 | PROV-002, PROV-003 | TV-PROV-002, TV-PROV-003 | COVERED | PARTIAL |
| 7 | Provider factory bridge | §5.7 | PROV-004 | TV-PROV-004, TV-PROV-005 | COVERED | PASS |
| 8 | Provider-side searchAll fallback | §7.4 | PROV-005 | TV-FALL-001..003 | COVERED | PASS |
| 9 | Mutation index wiring fail-soft | §7.6 | PROV-006 | TV-HOOK-001, TV-HOOK-002 | COVERED | PARTIAL |
| 10 | Sync index wiring | §7.7 | PROV-007 | TV-SYNC-001 | COVERED | PARTIAL |
| 11 | Clone deferral + rebuild lifecycle | §7.7 | PROV-012 | TV-SYNC-002, TV-REIDX-001 | COVERED | FAIL |
| 12 | Provider lifecycle init/dispose | §7.8 | PROV-008, PROV-009 | TV-INIT-001, TV-DISP-001 | COVERED | FAIL |
| 13 | DFQL search uses provider | §7.9 | PROV-011 | TV-DFQL-001 | COVERED | PARTIAL |
| 14 | Server.search first-class | §5.8, §7.5 | XSRC-001 | TV-XSRV-* | COVERED | PARTIAL |
| 15 | Client.search first-class | §5.8, §7.5 | XSRC-002 | TV-XCLI-*, TV-OFFL-001 | COVERED | PARTIAL |
| 16 | HTTP search route | §5.9 | XSRC-003 | TV-HTTP-* | COVERED | PARTIAL |
| 17 | Per-resource filters | §7.5, §9 | XSRC-004 | TV-FILT-001 | COVERED | PASS |
| 18 | Hydration + select | §7.5 | XSRC-005 | TV-HYDR-001 | COVERED | PASS |
| 19 | AbortSignal behavior | §7.5 | XSRC-006 | TV-ABRT-001 | COVERED | FAIL |
| 20 | Canonical offline/no-provider behavior | §7.5 | XSRC-007, PROV-010 | TV-OFFL-001, TV-NOPROV-* | COVERED | FAIL |
| 21 | Empty query boundary | §7.5, §7.10 | XSRC-008 | TV-HTTP-003, TV-USEC-001 | COVERED | FAIL |
| 22 | Linking-search profile | §7.10 | XSRC-009 | TV-USEC-002 | COVERED | PASS |
| 23 | No highlight payload contract | §4, §7.10 | XSRC-010 | TV-USEC-003 | COVERED | PASS |
| 24 | Deterministic ordering/tie-break | §6.3, §8 | DET-001 | TV-DET-001 | COVERED | PARTIAL |
| 25 | Canonical errors | §6.4, §8 | DET-002 | TV-ERR-001 | COVERED | FAIL |
| 26 | Caps for query/resources/filters | §10 | VLIM-001, VLIM-002, VLIM-004 | TV-VLIM-* | COVERED | FAIL |
| 27 | Large-batch indexing determinism | §10 | VLIM-003 | TV-VLIM-004 | COVERED | FAIL |
| 28 | Backward compatibility classes | §12 | BKWD-001, BKWD-002 | TV-BKWD-001..004 | COVERED | PASS |
| 29 | Export compatibility guard | §12 | BKWD-003 | TV-BKWD-003, TV-BKWD-005 | COVERED | PASS |
| 30 | Plugin-search migration completeness | §12 | BKWD-004 | TV-MIGR-001 | COVERED | PASS |

# Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)
| Spec bundle | Total reqs | PASS | PARTIAL | FAIL | UNVERIFIED |
|---|---:|---:|---:|---:|---:|
| `2026-03-08-new-q4k7m2r8-spec` | 43 | 17 | 16 | 10 | 0 |

# Requirement-by-requirement results (tables + per-requirement notes)
| Req ID | Status | Evidence | Notes |
|---|---|---|---|
| CORE-001 | PASS | `searchfn/adapters/src/types.ts`, `searchfn/adapters/src/index.ts` | Interface shape and exports match required methods and optional lifecycle/searchAll. |
| CORE-002 | PASS | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/__tests__/memory.test.ts` | Uses `PipelineEngine`, `Indexer`, `DocumentStatsManager`, `scorePostings`; fuzzy + fieldBoost supported. |
| CORE-003 | PARTIAL | `searchfn/adapters/src/indexeddb.ts`, `searchfn/adapters/__tests__/indexeddb.test.ts` | Core internals/persistence present; but `initialize()` does not open DB as required. |
| CORE-004 | PARTIAL | `searchfn/core/package.json`, `searchfn/core/src/index.ts`, `searchfn/client/src/*` | Core package exists and exports internals; however modules are duplicated in `searchfn/client/src` (not a strict move). |
| CORE-005 | FAIL | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/src/indexeddb.ts` | After `dispose()`, `initialize()` is also blocked (`assertNotDisposed`), violating explicit re-init allowance. |
| CORE-006 | PASS | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/src/indexeddb.ts`, contract tests | Resource isolation behavior implemented and tested. |
| CORE-007 | PASS | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/src/indexeddb.ts` | Upsert semantics implemented (remove existing id before ingesting replacement). |
| CORE-008 | PASS | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/src/indexeddb.ts` | `searchAll` implemented with resource scoping + deterministic sort. |
| CORE-009 | PARTIAL | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/src/indexeddb.ts` | Memory supports `fieldBoosts`; IndexedDB adapter ignores `fieldBoosts` in query flow. |
| CORE-010 | PARTIAL | `searchfn/adapters/src/memory.ts`, `searchfn/adapters/src/indexeddb.ts` | Memory supports fuzzy; IndexedDB adapter does not apply fuzzy expansion. |
| CORE-011 | PASS | `searchfn/adapters/src/{meilisearch,elasticsearch,postgres}.ts` | Stub adapters exist and throw not-implemented errors. |
| PROV-001 | PASS | `datafn/core/src/search-provider.ts`, `datafn/server/src/search-provider.ts` | Dedicated provider interface exists and is not a plugin extension. |
| PROV-002 | PARTIAL | `datafn/server/src/server.ts`, `datafn/server/src/routes/query.ts` | Config slot exists; canonical no-provider fallback behavior is missing (see PROV-010). |
| PROV-003 | PARTIAL | `datafn/client/src/client.ts` | Config slot exists; offline error contract/message differs from required canonical behavior. |
| PROV-004 | PASS | `searchfn/datafn-provider/src/index.ts` | Factory delegates `search`, `updateIndices`, lifecycle methods. |
| PROV-005 | PASS | `searchfn/datafn-provider/src/index.ts`, fallback tests | Fallback implemented with resource derivation, deterministic sorting, limit handling, concurrency cap 10. |
| PROV-006 | PARTIAL | `datafn/server/src/execution/mutation/execute.ts` | Built-in mutation wiring exists and is fail-soft; logs `warn` not required error-level logging. |
| PROV-007 | PARTIAL | `datafn/client/src/sync/engine.ts` | Pull/clone indexing hooks present; skip-clone-indexing + rebuild lifecycle contract not implemented. |
| PROV-008 | FAIL | `datafn/server/src/server.ts`, `datafn/client/src/client.ts` | Server swallows initialize failures (warn-only) and includes resources lacking search indices; client does not call initialize. |
| PROV-009 | PARTIAL | `datafn/server/src/server.ts`, `datafn/client/src/client.ts` | Server dispose hook called; client-side provider dispose path missing. |
| PROV-010 | FAIL | `datafn/server/src/routes/search.ts`, `datafn/server/src/server.ts`, `datafn/server/src/routes/query/execute.ts` | No DB-native fallback implemented for server `.search()`/route/DFQL path when provider absent. |
| PROV-011 | PARTIAL | `datafn/server/src/execution/query/search.ts`, `datafn/server/src/routes/query/execute.ts` | Provider path exists; no-provider behavior does not follow PROV-010 fallback policy. |
| PROV-012 | FAIL | `datafn/client/src/client.ts`, `datafn/client/src/sync/engine.ts` | `skipCloneIndexing`, async rebuild states/progress/retry are not implemented. |
| XSRC-001 | PARTIAL | `datafn/server/src/server.ts`, `datafn/server/src/execution/search/cross-resource.ts` | Server method exists with hydration/filtering/sorting; lacks required no-provider DB fallback + signal handling. |
| XSRC-002 | PARTIAL | `datafn/client/src/client.ts`, `datafn/client/src/transport/http.ts` | Client method exists; type contract is weak (`unknown`), local fallback only works with `searchAll`, no per-resource fallback path. |
| XSRC-003 | PARTIAL | `datafn/server/src/routes/search.ts` | Route exists and uses envelopes/auth; no DB-native no-provider success path, and validation/error contracts differ. |
| XSRC-004 | PASS | `datafn/server/src/execution/search/cross-resource.ts` | Per-resource filters applied post-candidate fetch/hydration. |
| XSRC-005 | PASS | `datafn/server/src/execution/search/cross-resource.ts` | Hydration + select projection + silent exclusion of missing records implemented. |
| XSRC-006 | FAIL | `datafn/server/src/execution/search/cross-resource.ts`, `datafn/server/src/server.ts`, `datafn/client/src/client.ts` | End-to-end AbortSignal handling missing on server and local-offline client path. |
| XSRC-007 | PARTIAL | `datafn/client/src/client.ts` | Offline local-provider path exists; canonical offline detection/error behavior and fallback semantics are incomplete. |
| XSRC-008 | FAIL | `datafn/server/src/routes/search.ts`, `datafn/client/src/client.ts` | Server rejects empty query but not with canonical message; client `.search()` does not enforce empty-query boundary. |
| XSRC-009 | PASS | `datafn/server/src/execution/search/cross-resource.ts`, `searchfn/datafn-provider/src/index.ts` | Supports resource scoping/limits and deterministic ordering suitable for linking profile. |
| XSRC-010 | PASS | `datafn/server/src/execution/search/cross-resource.ts` | No highlight payload injection; response shape limited to resource/id/score/data. |
| BKWD-001 | PASS | `searchfn/client/src/index.ts`, `searchfn/client/__tests__/backward-compat.test.ts` | `InMemorySearchFn` remains importable and functional. |
| BKWD-002 | PASS | `searchfn/client/src/index.ts`, backward-compat tests | `SearchFn` and `SearchEngine` exports preserved with required methods. |
| BKWD-003 | PASS | `searchfn/client/__tests__/exports-baseline.json`, backward-compat tests | Export baseline guard present and passing for existing surface. |
| BKWD-004 | PASS | `datafn/server/src/plugins/`, `datafn/server/src/routes/query/execute.ts`, grep results | Search plugin scanning artifacts removed; config-slot approach used. |
| VLIM-001 | FAIL | `datafn/server/src/routes/search.ts` | Query length and empty-query checks use non-canonical code/message (`DFQL_INVALID` + different text). |
| VLIM-002 | FAIL | `datafn/server/src/routes/search.ts`, `datafn/server/src/execution/search/cross-resource.ts` | `limitPerResource` is rejected >1000 instead of clamped; defaulting behavior differs from requirement. |
| VLIM-003 | FAIL | `searchfn/adapters/src/{memory,indexeddb}.ts` | No explicit deterministic chunking/batching contract for >10k documents in adapter APIs. |
| VLIM-004 | FAIL | `datafn/server/src/routes/search.ts` | `resources` cap uses wrong code and filter depth/condition caps are not enforced. |
| DET-001 | PARTIAL | `searchfn/core/src/query/scoring.ts`, `datafn/server/src/execution/search/cross-resource.ts` | Cross-resource tie-break implemented; core scorer sorts by score only (no explicit tie-break). |
| DET-002 | FAIL | `datafn/server/src/routes/search.ts`, `datafn/server/src/server.ts`, `datafn/client/src/client.ts`, `datafn/client/src/transport/http.ts` | Canonical code/message mapping not preserved across route/server/client entry points. |

# Spec conflicts / spec gaps (explicit)
1. **SPEC CONFLICT: PROV-008 startup semantics**
   - `REQUIREMENTS.md` says provider `initialize()` failure MUST fail startup.
   - `phase-reports/PHASE_05-...` and tests document/expect fail-soft startup (`warn` only).
   - Resolution needed: decide fail-closed vs fail-soft and align requirements/tests/code.

2. **SPEC CONFLICT: VLIM-002 limitPerResource behavior**
   - `REQUIREMENTS.md` says `limitPerResource > 1000` should be clamped.
   - Current phase tests and implementation reject values >1000 as invalid.
   - Resolution needed: pick clamp or reject; update vectors and implementation consistently.

3. **SPEC CONFLICT: HTTP vector labeling drift**
   - `TEST_VECTORS.md` defines `TV-HTTP-003` as empty-query rejection.
   - route tests use `TV-HTTP-003` label for no-provider behavior.
   - Resolution needed: normalize vector IDs/messages and update test labels.

4. **SPEC GAP/AMBIGUITY: CORE-004 “moved” vs retained client internals**
   - `SPEC.md` package-structure and phase docs imply move; code keeps duplicate internals in client and core.
   - Resolution needed: decide whether duplication is allowed as compatibility strategy or whether true move is required.

# Cross-cutting audits (security/determinism/limits/errors/compat)
## Security/authz/validation boundaries
- **Pass**: `/datafn/search` is routed through existing auth middleware path (`withAuth("search", ...)`).
- **Pass**: per-resource filters are applied after search candidate selection and before return.
- **Fail/Gap**: search route validation does not enforce filter complexity caps (depth/condition count), increasing risk of expensive pathological filters.

## Determinism invariants
- **Pass**: cross-resource merge in server/provider fallback uses deterministic `score DESC, resource ASC, id ASC`.
- **Partial**: core scorer (`scorePostings`) sorts only by score; tie-break for equal scores is not explicit in single-resource flows.

## Limits/caps
- **Fail**: canonical limit behavior drift (`clamp` vs `reject`) for `limitPerResource`.
- **Fail**: resources/filter-complexity caps do not fully match requirement codes/behavior.
- **Fail**: large-batch indexing cap/chunking behavior not formalized in adapter APIs.

## Error handling + canonical envelopes
- **Pass**: envelope structure (`ok` + `result/error`) is used for route responses.
- **Fail**: canonical code/message mapping is inconsistent (`DFQL_INVALID` vs `LIMIT_EXCEEDED`; message text drift; unsupported paths use non-canonical text).
- **Fail**: `DFQL_ABORTED` handling is not consistent end-to-end for search entry points.

## Compatibility/versioning/migrations
- **Pass**: `@searchfn/client` backward compatibility preserved for legacy classes and advanced APIs.
- **Pass**: export baseline guard exists and is tested.
- **Pass**: DataFn migration away from `SearchFnPlugin` scanning is complete.

# Recommendations (ranked)
1. **Implement canonical no-provider behavior everywhere** (Intent 20, 14, 16, 13; PROV-010, XSRC-001/003, PROV-011, DET-002).
2. **Normalize error contract and text** across route/server/client/transport (Intent 25, 21, 26; DET-002, XSRC-008, VLIM-001/002/004).
3. **Fix provider lifecycle contract** (fail-closed init policy decision + client init/dispose paths) (Intent 12; PROV-008, PROV-009).
4. **Implement clone deferral + rebuild lifecycle** with progress and retry (Intent 11, 10; PROV-012, PROV-007).
5. **Add end-to-end AbortSignal support** in server and offline client paths (Intent 19; XSRC-006, DET-002).
6. **Align adapter lifecycle semantics** to allow reinitialize after dispose and ensure IndexedDB initialize opens resources (Intent 2, 24; CORE-003, CORE-005).
7. **Bring IndexedDB adapter feature parity** for fuzzy and field boosts (Intent 2; CORE-009, CORE-010).
8. **Formalize and enforce large-batch indexing constraints** in adapter layer and tests (Intent 27; VLIM-003).
9. **Resolve spec conflicts explicitly** (PROV-008, VLIM-002, vector labeling, CORE-004 move semantics) and update REQUIREMENTS/TEST_VECTORS/phase docs together.

## Fix order (ranked, with intent/requirement refs)
1. Intent #20/#25: `PROV-010`, `DET-002`, `XSRC-003`, `XSRC-001`
2. Intent #21/#26: `XSRC-008`, `VLIM-001`, `VLIM-002`, `VLIM-004`
3. Intent #12: `PROV-008`, `PROV-009`
4. Intent #11/#10: `PROV-012`, `PROV-007`
5. Intent #19: `XSRC-006`
6. Intent #2/#24: `CORE-003`, `CORE-005`, `DET-001`
7. Intent #2: `CORE-009`, `CORE-010`
8. Intent #27: `VLIM-003`

# Appendix: commands run + environment details
## Environment
- cwd: `/Users/serro/Documents/dev/n/superfunctions`
- shell: `/bin/zsh`
- os: `Darwin 25.3.0`
- git branch: `next`
- git commit: `635bf2853807d9d76dba07a460dd0594f57d9147`
- git dirty files (count): `247`

## Commands run (audit)
- Repository/spec inventory and reads:
  - `pwd`, `ls -la`
  - `rg --files .../searchfn/.conduct/specs/2026-03-08-new-q4k7m2r8-spec`
  - `sed -n ... SPEC.md REQUIREMENTS.md TEST_VECTORS.md PLAN.md INTENT_AUDIT.md phases/*.md phase-reports/*.md`
  - `rg -n '^#{1,4} ' ...`
  - `wc -l ...`
- Implementation discovery and inspection:
  - `rg --files searchfn`, `rg --files datafn`
  - `rg -n "searchProvider|createSearchProvider|/datafn/search|..." searchfn datafn`
  - `sed -n ...` on key source/test files in `searchfn/*` and `datafn/*`
  - `rg -n "SearchFnPlugin|isSearchPlugin|hasSearchPlugin|plugins/searchfn" datafn searchfn`
- Validation/test execution:
  - `npm --prefix searchfn/adapters test`
  - `npm --prefix searchfn/datafn-provider test`
  - `npm --prefix searchfn/core test`
  - `npm --prefix searchfn/core run typecheck`
  - `npm --prefix searchfn/client test -- __tests__/backward-compat.test.ts`
  - `npm --prefix searchfn/client test` (1 failing pre-existing test observed)
  - `npm --prefix datafn/server test -- src/routes/__tests__/search.test.ts src/execution/search/__tests__/cross-resource.test.ts src/execution/mutation/__tests__/search-wiring.test.ts`
  - `npm --prefix datafn/client test -- __tests__/search.test.ts`
- Metadata collection:
  - `git branch --show-current`, `git rev-parse HEAD`, `git status --porcelain | wc -l`
  - `uname -a`, `echo $SHELL`, `date -u`

## Known verification limitation
- This audit did not execute every monorepo test suite; it executed targeted suites for searchfn/datafn search integration and compatibility.
