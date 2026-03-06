# Metadata
- Timestamp (UTC): 2026-03-06T06:42:23Z
- agent_name: unknown-agent
- model: gpt-5 (Codex)
- launcher: Codex Desktop
- Workspace/project: /Users/serro/Documents/dev/n/superfunctions
- OS/Shell: Darwin 25.3.0 / /bin/zsh
- Git:
  - branch: next
  - commit: 664f92c880a6a5a150d115bf60e30f37c4107062
  - status: dirty
- Intent/notes paths audited:
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec/INTENT_AUDIT.md
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec/SPEC.md (intent/goals/non-goals sections)
- Spec bundle paths audited:
  - Bundle root: /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec
  - Included files audited:
    - SPEC.md
    - REQUIREMENTS.md
    - TEST_VECTORS.md
    - PLAN.md
    - INTENT_AUDIT.md
    - phases/PHASE_00.md ... phases/PHASE_09.md
    - phase-reports/PHASE_00-2026-03-05-k9m4x7r2-report.md ... phase-reports/PHASE_09-2026-03-06-k7m4x9r3-report.md
    - logs.csv
- Codebase scope audited:
  - Included: /Users/serro/Documents/dev/n/superfunctions/datafn/server, /Users/serro/Documents/dev/n/superfunctions/datafn/core, /Users/serro/Documents/dev/n/superfunctions/packages/db
  - Excluded: unrelated monorepo packages and non-impacted app/docs areas
- Commands executed during audit: yes (listed in Appendix)

# Audit scope
Full read-only audit of implementation against:
1. authoritative intent in `INTENT_AUDIT.md` and spec goal/constraint sections, and
2. full spec bundle (`SPEC`, `REQUIREMENTS`, `TEST_VECTORS`, `PLAN`, all `phases`, all `phase-reports`).

No implementation files were modified. Only audit artifacts were produced.

# Inputs audited (intent + spec bundles)
- Intent source-of-truth inventory is fully captured in `INTENT_AUDIT.md` (13 intent items).
- Requirements source-of-truth is `REQUIREMENTS.md` (13 requirement IDs: FIX-SEC-006..FIX-LOG-002).
- Vector source-of-truth is `TEST_VECTORS.md` (29 vector IDs covering the 13 requirements).
- Planning and execution evidence reviewed from `PLAN.md`, `phases/*`, and `phase-reports/*`.

# High-level findings
1. **FAIL (security): FIX-SEC-008 is not fully compliant.** Query payload pollution checks can be bypassed through objects nested inside arrays, which violates the requirement to recurse across full query payload.
2. **PARTIAL: FIX-REL-002 has behavior parity but helper-parity drift.** Retry behavior works for both execute/push in tested paths, but execute relation bulk path uses inline retry instead of the shared helper required by acceptance criteria.
3. **PARTIAL: FIX-SRV-005 structural split is present, but behavior-equivalence proof is incomplete.** Query route is thin + modules exist, but the query regression suite has a known failing vector (`TV-PUSHDOWN-008`) and `routes/query/validate.ts` is not part of runtime validation flow.
4. **Spec/vector traceability gap:** Several vector IDs in `TEST_VECTORS.md` are missing as exact test IDs in repository tests (`TV-REL-002-*`, `TV-REL-011-*`, `TV-PER-002-*`, `TV-SRV-001-*`, `TV-SRV-005-*`, `TV-LOG-002-*`).

# Intent Inventory (numbered)
1. Enforce configurable max batch size on push and mutation endpoints.
2. Apply prototype-pollution rejection to full query payload, aggregations, and having.
3. Make change-tracking retry behavior consistent between push and execute paths.
4. Ensure push mutation write + change-tracking write are atomic together when transactions are available.
5. Remove dynamic imports from route hot paths.
6. Remove synthetic REST request bridge and call internal execution directly.
7. Implement bounded queue-based query batch concurrency.
8. Split monolithic query route into modular files without behavior change.
9. Cache FK omit-set computation outside per-record loops.
10. Replace search candidate truncation with paged processing of all candidates.
11. Introduce batch write capability for change-tracking entries with deterministic fallback.
12. Remove full-table fallback loads for unhandled relation paths/types in secondary loading.
13. Remove direct console fallback in request logging helper and require logger path.

# Intent → Spec coverage matrix (complete; no sampling)
| Intent # | Intent summary | Spec location(s) | Requirement ID(s) | Vector(s) | Intent→Spec status | Implementation status |
|---|---|---|---|---|---|---|
| 1 | Configurable batch size on push+mutation | SPEC Semantics: Batch limits; REQUIREMENTS FIX-SEC-006 | FIX-SEC-006 | TV-SEC-006-P1/N1/P2/N2 | COVERED | PASS |
| 2 | Recursive pollution rejection on full query payload/aggregations/having | SPEC Semantics: Prototype-pollution validation scope; Security | FIX-SEC-008 | TV-SEC-008-P1/N1/N2 | COVERED | FAIL |
| 3 | Retry parity execute vs push | SPEC Semantics: Change-tracking retry parity | FIX-REL-002 | TV-REL-002-P1/N1 | COVERED | PARTIAL |
| 4 | Push atomicity with transactions | SPEC Semantics: Push atomicity; Invariants | FIX-REL-011 | TV-REL-011-P1/N1 | COVERED | PASS |
| 5 | Remove dynamic imports in routes | REQUIREMENTS FIX-PER-002; Phase 04 | FIX-PER-002 | TV-PER-002-P1/N1 | COVERED | PASS |
| 6 | Remove synthetic Request bridge | REQUIREMENTS FIX-SRV-001; SPEC route behavior contract | FIX-SRV-001 | TV-SRV-001-P1/N1 | COVERED | PASS |
| 7 | Bounded query concurrency queue | SPEC Semantics: Batch query concurrency; Limits | FIX-SRV-003 | TV-SRV-003-P1/N1 | COVERED | PASS |
| 8 | Modular query route split, no behavior change | SPEC Semantics: Query route modularity | FIX-SRV-005 | TV-SRV-005-P1/N1 | COVERED | PARTIAL |
| 9 | Cache FK omit-set | SPEC Semantics: Execution perf/safety | FIX-EXE-014 | TV-EXE-014-P1/N1 | COVERED | PASS |
| 10 | Search candidate chunk processing beyond 1000 | SPEC Semantics: Search candidate handling | FIX-EXE-017 | TV-EXE-017-P1/N1 | COVERED | PASS |
| 11 | Batch writes for recordChanges with fallback | SPEC Internal APIs + Semantics | FIX-EXE-018 | TV-EXE-018-P1/N1 | COVERED | PASS |
| 12 | No full-scan fallback on unknown/unhandled relations | SPEC Invariants: no hidden full scan | FIX-EXE-022 | TV-EXE-022-P1/N1 | COVERED | PASS |
| 13 | No console fallback in logRequest | SPEC Observability/Security | FIX-LOG-002 | TV-LOG-002-P1/N1 | COVERED | PASS |

# Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)
Bundle: `2026-03-05-audit-fix-nv5royb4-spec`
- PASS: 10
- PARTIAL: 2
- FAIL: 1
- UNVERIFIED: 0

# Requirement-by-requirement results (tables + per-requirement notes)
| Requirement | Status | Evidence type |
|---|---|---|
| FIX-SEC-006 | PASS | Code + tests |
| FIX-SEC-008 | FAIL | Code + tests + adversarial runtime check |
| FIX-REL-002 | PARTIAL | Code + tests + runtime check |
| FIX-REL-011 | PASS | Code + runtime check |
| FIX-PER-002 | PASS | Static check |
| FIX-SRV-001 | PASS | Code + static check + REST tests |
| FIX-SRV-003 | PASS | Code + tests |
| FIX-SRV-005 | PARTIAL | Code + structural checks + regression suite |
| FIX-EXE-014 | PASS | Code + tests |
| FIX-EXE-017 | PASS | Code + tests |
| FIX-EXE-018 | PASS | Code + tests |
| FIX-EXE-022 | PASS | Code + tests |
| FIX-LOG-002 | PASS | Code + static check |

Per-requirement notes:
- **FIX-SEC-006 (PASS)**
  - Config defaults wired in server limits: `datafn/server/src/server.ts:352-353`.
  - Enforcement in push route: `datafn/server/src/routes/sync.ts:304-315`.
  - Enforcement in mutation route: `datafn/server/src/routes/mutation.ts:98-108`.
  - Vectors passed: `npx vitest run __tests__/security.test.ts` (includes `TV-SEC-006-*`).

- **FIX-SEC-008 (FAIL)**
  - Positive evidence: query-level recursive pollution check exists: `datafn/server/src/validation/query.ts:51-55` and vectors `TV-SEC-008-*` pass in `security-critical.test.ts` and `validation.test.ts`.
  - Failing evidence: `checkPrototypePollution` does not recurse into arrays (`datafn/core/src/validate.ts:20-31`).
  - Reproduced bypass (runtime): query `select: [{"constructor":{"prototype":{}}}]` returns `200` with `{ok:true}` instead of `DFQL_INVALID`.
  - This violates full-payload recursive requirement language in FIX-SEC-008.

- **FIX-REL-002 (PARTIAL)**
  - Shared helper exists: `recordChangeWithRetry` in `datafn/server/src/execution/sync/change-tracking.ts:29-45`.
  - Push path uses helper: `datafn/server/src/execution/sync/push.ts:301-304,338-340`.
  - Execute path uses helper for single-record changes: `datafn/server/src/execution/mutation/execute.ts:277-284`.
  - **Drift:** execute relation-bulk branch uses inline retry loop, not the shared helper (`execute.ts:253-262`).
  - Runtime checks:
    - execute transient failure recovered with 3 attempts and success.
    - execute persistent failure returned `INTERNAL` failure envelope.
    - push transient recovered; persistent produced explicit mutation error.

- **FIX-REL-011 (PASS)**
  - Transaction capability detection and warning fallback: `push.ts:125-134`.
  - Atomic transaction wrapper per mutation: `push.ts:281-305`.
  - Change-tracking inside tx using tx-scoped service: `push.ts:295-303`.
  - Runtime harness checks:
    - transaction-capable path + forced change-tracking failure: mutation record rolled back (`recordExists:false`), explicit `INTERNAL` mutation error.
    - non-transaction path: explicit warning includes non-atomic mode, mutation failure explicit.

- **FIX-PER-002 (PASS)**
  - No `await import(` in `datafn/server/src/routes` (static check exit 1/no matches).
  - Mutation authz import is static: `datafn/server/src/routes/mutation.ts:24`.

- **FIX-SRV-001 (PASS)**
  - REST bridge no longer constructs synthetic Request objects.
  - Direct internal execution helpers in server: `datafn/server/src/server.ts:720-733`.
  - Static check for `new Request("http://localhost/datafn/` in server.ts: no matches.
  - REST behavior regression check passes: `npx vitest run __tests__/rest.test.ts`.

- **FIX-SRV-003 (PASS)**
  - Config default exists: `server.ts:353`.
  - Bounded queue executor: `routes/query/batch-executor.ts:10-27`.
  - Query handler uses bounded executor: `routes/query.ts:143-162`.
  - Tests pass for over-concurrency acceptance and max in-flight bound (`security.test.ts` and `validation.test.ts`).

- **FIX-SRV-005 (PARTIAL)**
  - Structural split achieved:
    - thin entry: `datafn/server/src/routes/query.ts` (211 lines)
    - modules: `routes/query/validate.ts`, `routes/query/execute.ts`, `routes/query/batch-executor.ts`.
  - **Gap 1:** route runtime still validates via `validateQueryBody` in `validation/index.ts` (`routes/query.ts:99-108`), so extracted `routes/query/validate.ts` is not the active validation path.
  - **Gap 2:** behavior-equivalence evidence is incomplete: `npx vitest run __tests__/query*.test.ts` has a failing vector (`TV-PUSHDOWN-008`) with 97/98 pass.

- **FIX-EXE-014 (PASS)**
  - Omit-set cache introduced via `WeakMap`: `select.ts:63-85`.
  - Cache used outside per-record loops: `select.ts:101-103`, `159-163`, `495-500`, `602-607`.
  - `exe-phase06.test.ts` vectors pass.

- **FIX-EXE-017 (PASS)**
  - Chunk size constant 1000 and multi-chunk processing across all candidates: `search.ts:9,45-68`.
  - No truncation path remains.
  - `exe-phase06.test.ts` vectors pass.

- **FIX-EXE-018 (PASS)**
  - Batch capability detection and path: `change-tracking.ts:235-244`.
  - Deterministic sequential fallback: `change-tracking.ts:245-253`.
  - Optional internal API extension: `packages/db/src/adapter/types.ts:435-439`; memory adapter implementation: `packages/db/src/adapters/memory/index.ts:156-173`.
  - `performance.test.ts -t EXE-018` passes (3/3 vectors).

- **FIX-EXE-022 (PASS)**
  - Unknown direct relation path now returns empty with warning: `db-store.ts:779-788`.
  - Unhandled relation type returns empty with warning (no full scan): `db-store.ts:859-866`.
  - `exe-phase06.test.ts` vectors pass.

- **FIX-LOG-002 (PASS)**
  - `logRequest` no console fallback: `datafn/server/src/logging.ts:57-60`.
  - Logger always initialized in server factory: `datafn/server/src/server.ts:258`.
  - Static check `rg "console\." datafn/server/src/logging.ts`: no matches.

# Spec conflicts / spec gaps (explicit)
1. **Vector traceability gaps**
   - Exact vector IDs from `TEST_VECTORS.md` missing in tests: `TV-REL-002-P1/N1`, `TV-REL-011-P1/N1`, `TV-PER-002-P1/N1`, `TV-SRV-001-P1/N1`, `TV-SRV-005-P1/N1`, `TV-LOG-002-P1/N1`.
   - Equivalent coverage exists in some cases (static checks or differently-named tests), but ID-level traceability required by the spec bundle is incomplete.

2. **Phase-report vs test-vector naming drift**
   - Phase reports assert completion using IDs (`TV-REL-003/004`) that do not match this bundle’s vector IDs (`TV-REL-002-P1/N1`), creating audit ambiguity.

3. **SRV-005 validation-module ambiguity**
   - Phase plan/spec expects query-route validation module split; runtime still uses centralized validator path. Module exists but is not authoritative runtime path.

4. **SEC-008 requirement precision vs implementation**
   - Spec requires recursive checks across full query payload. Current recursive primitive excludes arrays, causing observable bypass.

# Cross-cutting audits (security/determinism/limits/errors/compat)
## Security/authz/validation boundaries
- Authz checks remain present in query/mutation/push routes.
- Batch caps are centrally configured and enforced (SEC-006).
- **Security finding:** prototype-pollution recursion is incomplete for array-contained objects (SEC-008 fail).

## Determinism invariants
- Bounded queue preserves input order by index (`runBounded` writes results by task index).
- Search chunking is deterministic by fixed chunk size and final unified pass.
- Change-entry order in fallback insert path is deterministic.

## Limits/caps
- `maxBatchSize` and `maxBatchQueryConcurrency` defaults and wiring are in place.
- Search chunk cap uses 1000-size paging and processes all candidates.
- Existing payload-size limits remain unchanged.

## Error handling + canonical envelopes
- Validation failures consistently use `DFQL_INVALID` where expected.
- Internal change-tracking failures surface explicit `INTERNAL` errors (route-level envelope observed).
- One nuance: mutation route returned status `400` with `INTERNAL` code in forced persistent execute-path test; code-level requirement only mandates `INTERNAL` code, not status.

## Compatibility/versioning/migrations
- New limits are additive in config.
- Routes and envelope shape preserved.
- No new external dependency introduced for these requirement areas.

# Recommendations (ranked)
1. **[Highest] Fix SEC-008 recursive coverage across arrays** (Intent #2, FIX-SEC-008)
   - Update `checkPrototypePollution` to recurse into arrays and inspect object elements.
   - Add explicit negative vectors for array-nested payload keys in query body/aggregations/having.

2. **Align execute-path retry to shared helper in all branches** (Intent #3, FIX-REL-002)
   - Replace execute relation-bulk inline retry loop with shared retry abstraction (or shared bulk-retry helper) to satisfy acceptance criteria exactly.

3. **Resolve SRV-005 behavioral-proof gap** (Intent #8, FIX-SRV-005)
   - Either route runtime through extracted validation module or remove dead/duplicate validation module to avoid split ambiguity.
   - Stabilize and pass `TV-PUSHDOWN-008` (or document as formal deferred item if explicitly out of scope).

4. **Restore vector ID traceability** (all relevant requirements)
   - Add/rename tests to match `TEST_VECTORS.md` IDs exactly, or update vector doc IDs to canonical implemented IDs and regenerate phase traceability.

# Appendix: commands run + environment details
Environment:
- CWD: `/Users/serro/Documents/dev/n/superfunctions`
- Node/Vitest used from repo workspace

Command log (major):
- Inventory/docs:
  - `find .../2026-03-05-audit-fix-nv5royb4-spec -type f | sort`
  - `nl -ba` on all bundle files (`SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
- Static checks:
  - `rg -n "await import\(" datafn/server/src/routes`
  - `rg -n "new Request\(\"http://localhost/datafn/" datafn/server/src/server.ts`
  - `rg -n "console\." datafn/server/src/logging.ts`
  - `wc -l datafn/server/src/routes/query.ts && rg --files datafn/server/src/routes/query`
- Tests:
  - `cd datafn/server && npx vitest run __tests__/security.test.ts`
  - `cd datafn/server && npx vitest run __tests__/security-critical.test.ts src/validation/__tests__/validation.test.ts`
  - `cd datafn/server && npx vitest run __tests__/reliability-critical.test.ts`
  - `cd datafn/server && npx vitest run __tests__/query*.test.ts` (1 known failing test: `TV-PUSHDOWN-008`)
  - `cd datafn/server && npx vitest run __tests__/exe-phase06.test.ts`
  - `cd datafn/server && npx vitest run __tests__/performance.test.ts -t "EXE-018"`
  - `cd datafn/server && npx vitest run __tests__/rest.test.ts`
- Adversarial/runtime verification:
  - `node --import tsx --input-type=module -e ...` SEC-008 array-nested payload bypass reproduction
  - `node --import tsx --input-type=module -e ...` REL-002 execute and push retry behavior checks
  - `node --import tsx --input-type=module -e ...` REL-011 transaction/non-transaction behavior checks

