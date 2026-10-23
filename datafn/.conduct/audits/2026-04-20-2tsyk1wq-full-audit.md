# Metadata
- Timestamp: `2026-04-20T10:08:31.687704Z`
- agent_name: `unknown-agent`
- model: `gpt-5-codex`
- launcher: `Codex Desktop`
- workspace/project path: `repo root`
- OS + shell: `Darwin arm64`, `zsh`
- repo metadata: source ref `next`; commit `591c1be834abad5ba0aaa432e9cd46f101b04e97`; audited via exported snapshot (clean by construction); report written from a detached reporting worktree with pre-existing audit artifacts.
- code under audit: `datafn/` plus the related shared packages required to execute isolated package tests (`packages/http`, `packages/db`)

# Audit scope
- This audit was run against the code present on the local `next` branch snapshot, not against the detached reporting worktree state.
- Existing audit reports under `datafn/.conduct/audits/` were ignored for pass/fail and used only as historical context after independent verification.
- Code scope audited: `datafn/core`, `datafn/client`, `datafn/server`, `datafn/swift`, `datafn/swift-bridge`, `datafn/python`, `datafn/docs`, `datafn/examples`, and the shared package dependencies required to run the isolated TypeScript server suite.
- Excluded from pass/fail: prior audit artifacts, issue trackers, and issue-completion notes under `datafn/.conduct/`.
- Verification limitation: repo-root npm workspace installation is currently broken, so TypeScript verification had to be performed through isolated package installs inside the temporary snapshot. That workaround is itself a release blocker because production readiness requires a reproducible repo-level verification path.

# Inputs audited (intent + spec bundles)
## Intent / notes paths
- `datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md`
- `datafn/.conduct/intent/2026-03-sharability/2025-03-12-datafn-sharing-scenarios.md`
- `datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-analysis-t1.md`
- `datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-permissions-sufficiency-report.md`
- `datafn/.conduct/intent/2026-03-sharability/2026-03-11-datafn-sharing-recommendations-beginner-guide.md`
- `datafn/.conduct/intent/2026-03-sharability/share-use-cases-list.md`
- `datafn/.conduct/intent/2026-03-sharability/spv2-architecture-decision.md`
- `datafn/.conduct/intent/2026-03-sharability/spv2-intent-inventory.md`
- `datafn/.conduct/intent/2026-03-sharability/visibility-column-ideation.md`
- `datafn/.conduct/intent/datafn.intent.md`
- `datafn/.conduct/intent/dfql.intent.md`
- `datafn/.conduct/intent/implementation.md`
- `datafn/.conduct/intent/migration-plan-from-nucleus.md`
- `datafn/.conduct/intent/mutation-sample.json`
- `datafn/.conduct/intent/query-sample.json`
- `datafn/.conduct/intent/spec.md`
- `datafn/.conduct/intent/table-schema-sample.json`
- `datafn/.conduct/intent/transact-sample.json`

## Spec bundle paths
- `datafn/.conduct/specs/2026-01-18-spec` (files: `IMPLEMENTATION_SUMMARY.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, phase_01_completion_report.md, phase_02_completion_report.md, phase_03_completion_report.md, phase_04a_completion_report.md, phase_04b_completion_report.md, phase_05_completion_report.md`)
- `datafn/.conduct/specs/2026-01-19-change-spec` (files: `COVERAGE_MATRIX.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md`)
- `datafn/.conduct/specs/2026-01-23-audit-fix-change-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md`)
- `datafn/.conduct/specs/2026-01-24-audit-fix-comprehensive-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-01-26-fix-bs0rjtzf-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-05-fix-9x2k7m4p-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-06-audit-fix-k4m2p9x7-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-12-fix-r8k4m2x9-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-14-change-k7m9x4p2-spec` (files: `INTENT_AUDIT.md, PLAN.md, README.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-15-change-m8k3x7p4-spec` (files: `INTENT_AUDIT.md, PLAN.md, README.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-16-new-k9m7x3p5-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-23-new-r4m9kx7v-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-24-audit-fix-k9r4m7x3-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md`)
- `datafn/.conduct/specs/2026-02-25-audit-fix-r7m4k9x2-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-26-new-k7r4m9x2-spec` (files: `INTENT_AUDIT.md, MIGRATION.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-01-change-r7k4m9x3-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-02-change-k9m4x7r3-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-05-audit-fix-k7m9x4r3-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-05-fix-q9m4k7r2-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-06-audit-fix-r7k9m4x3-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-07-new-q7m3k9r2-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-13-new-bhszlzcn-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-14-new-s7h4r2p9-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-15-new-ug0uwash-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-27-new-t8vzvg1r-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)
- `datafn/.conduct/specs/2026-03-28-new-d8k4m2p7-spec` (files: `INTENT_AUDIT.md, PLAN.md, REQUIREMENTS.md, SPEC.md, TEST_VECTORS.md, logs.csv`)

# High-level findings
1. Overall verdict: `datafn` on local `next` is **not production-ready** for an overall release sign-off.
2. The TypeScript runtime has materially improved since the March audit. In isolated verification from the `next` snapshot, `@datafn/core` passed 20 files / 314 tests, `@datafn/client` passed 63 files / 552 tests, `@datafn/server` passed 82 files / 854 tests, and `@datafn/swift-bridge` passed 5 files / 25 tests.
3. Python verification is also stronger than before: `python3 -m pytest datafn/python/tests -q` passed across 20 Python test modules.
4. The strongest remaining release blockers are operational rather than purely feature-level: repo-root npm workspace packaging for `@datafn/swift-bridge` is broken, the Swift package test suite does not compile, the public docs rewrite bundle is still unmet, and Python route-surface parity remains incomplete.
5. Public documentation remains the least conformant area. The docs tree still publishes migration and legacy content, still lacks the required public `documentation/sharing/*` structure, still overstates Python applicability for TypeScript-only server features, and still has no local `docs:audit` command.
6. Package documentation is also drifting from the shipped API: the client README still teaches `authContext`, and the server README still teaches `authContextProvider`, while the actual code exposes `namespace` and `namespaceProvider`.
7. Swift functionality exists and much of the package compiles, but the release gate is still red because `swift test --package-path datafn/swift` fails at compile time in `DatafnSwiftUITests`.

# Intent Inventory
1. DataFn must remain a schema-driven, local-first data layer with typed client/server authoring surfaces and DFQL as the canonical wire format.
2. Deterministic envelopes, validation, ordering, and cursor behavior remain core invariants across client and server runtimes.
3. Offline sync remains first-class: clone, pull, push, seed, and reconcile semantics must stay stable under retries and partial connectivity.
4. Namespace isolation and actor-derived server context are mandatory; clients must not choose server namespaces directly.
5. Search integration must stay deterministic and schema-bounded, with native-backed Apple search delegating to SearchFn rather than duplicating search engine logic.
6. Capability-native sharing (SPV2) is a production requirement, including principal-based grants, cross-namespace access, scope grants, relation inheritance, and revoke-safe sync.
7. Python parity is required for production equivalence, especially for authorization and sync visibility semantics.
8. Apple-native support must include a Swift runtime, a WKWebView bridge package, native-backed storage/sync ownership, and CloudKit-aware topology support.
9. Repository packaging must allow the Apple bridge surface to be built and tested through the monorepo workspace graph.
10. Public docs must be newcomer-friendly, guide/reference-separated, accurate about TypeScript vs Python applicability, and free of public migration/deprecation guidance.
11. Examples and package documentation must reflect the current namespace-based APIs and supported topologies.
12. Security-sensitive behavior must remain capability-native and endpoint-consistent rather than plugin-only or docs-only.
13. Observability, rate limiting, WebSocket invalidation, and search functionality must only be documented for runtimes that actually expose them.
14. Release readiness requires reproducible verification from the repository checkout, not only ad hoc package-level workarounds.

# Intent → Spec coverage matrix (complete)
| Intent # | Intent theme | Authoritative intent source(s) | Spec bundle coverage | Status |
| --- | --- | --- | --- | --- |
| 1 | Core local-first runtime + DFQL | `datafn.intent.md, dfql.intent.md, spec.md` | `2026-01-18-spec; 2026-01-19-change-spec; 2026-01-23-audit-fix-change-spec` | PARTIAL |
| 2 | Determinism / envelope / limits / validation | `spec.md, implementation.md` | `2026-01-18-spec; 2026-01-23-audit-fix-change-spec; 2026-02-16-new-k9m7x3p5-spec; 2026-02-27-audit-fix-v7k3m9x4-spec` | PARTIAL |
| 3 | Client runtime and offline sync | `datafn.intent.md, implementation.md` | `2026-01-19-change-spec; 2026-01-26-fix-bs0rjtzf-spec; 2026-02-23-new-r4m9kx7v-spec` | PARTIAL |
| 4 | Capability-native sharing / SPV2 | `2026-03-sharability/*, spv2-intent-inventory.md` | `2026-03-13-new-bhszlzcn-spec; 2026-03-06-new-k4m7x9r3-spec; 2026-03-07-new-q7m3k9r2-spec` | PARTIAL |
| 5 | Python parity | `implementation.md, spec.md, sharability inventory` | `2026-03-13-new-bhszlzcn-spec (PY-001); implementation milestone 13` | PARTIAL |
| 6 | Apple native-backed runtime | `datafn.intent.md (extension/native requirement), examples/Apple docs` | `2026-03-27-new-t8vzvg1r-spec` | PARTIAL |
| 7 | Native search via SearchFn | `datafn intent/spec search notes` | `2026-03-28-new-d8k4m2p7-spec` | PARTIAL |
| 8 | Public docs rewrite + runtime truthfulness | `datafn.intent.md, 2026-03-11 beginner-guide intent` | `2026-03-15-new-ug0uwash-spec` | FAIL |

# Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)
| Spec bundle | Parsed IDs | PASS | PARTIAL | FAIL | UNVERIFIED | SPEC CONFLICT | SPEC MISSING |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `2026-01-18-spec` | 24 | 0 | 0 | 0 | 24 | 0 | 0 |
| `2026-01-19-change-spec` | 49 | 0 | 0 | 0 | 49 | 0 | 0 |
| `2026-01-23-audit-fix-change-spec` | 39 | 0 | 0 | 0 | 39 | 0 | 0 |
| `2026-01-24-audit-fix-comprehensive-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-01-26-fix-bs0rjtzf-spec` | 16 | 0 | 0 | 0 | 16 | 0 | 0 |
| `2026-02-05-fix-9x2k7m4p-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-02-06-audit-fix-k4m2p9x7-spec` | 31 | 0 | 0 | 0 | 31 | 0 | 0 |
| `2026-02-11-audit-fix-r9k4m7x2-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-02-12-fix-r8k4m2x9-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-02-14-change-k7m9x4p2-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-02-15-change-m8k3x7p4-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-02-16-new-k9m7x3p5-spec` | 15 | 0 | 0 | 0 | 15 | 0 | 0 |
| `2026-02-23-new-r4m9kx7v-spec` | 31 | 0 | 0 | 0 | 31 | 0 | 0 |
| `2026-02-24-audit-fix-k9r4m7x3-spec` | 29 | 0 | 0 | 0 | 29 | 0 | 0 |
| `2026-02-24-fix-k7m4x9p2-spec` | 27 | 0 | 0 | 0 | 27 | 0 | 0 |
| `2026-02-25-audit-fix-r7m4k9x2-spec` | 16 | 0 | 0 | 0 | 16 | 0 | 0 |
| `2026-02-26-new-k7r4m9x2-spec` | 27 | 0 | 0 | 0 | 27 | 0 | 0 |
| `2026-02-27-audit-fix-v7k3m9x4-spec` | 78 | 0 | 0 | 0 | 78 | 0 | 0 |
| `2026-03-01-change-r7k4m9x3-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-03-02-change-k9m4x7r3-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-03-05-audit-fix-k7m9x4r3-spec` | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `2026-03-05-audit-fix-nv5royb4-spec` | 13 | 0 | 0 | 0 | 13 | 0 | 0 |
| `2026-03-05-fix-q9m4k7r2-spec` | 8 | 0 | 0 | 0 | 8 | 0 | 0 |
| `2026-03-06-audit-fix-r7k9m4x3-spec` | 53 | 0 | 0 | 0 | 53 | 0 | 0 |
| `2026-03-06-new-k4m7x9r3-spec` | 60 | 0 | 0 | 0 | 60 | 0 | 0 |
| `2026-03-07-new-q7m3k9r2-spec` | 15 | 0 | 0 | 0 | 15 | 0 | 0 |
| `2026-03-13-fix-c47f7431-spec` | 15 | 0 | 0 | 0 | 15 | 0 | 0 |
| `2026-03-13-new-bhszlzcn-spec` | 32 | 0 | 1 | 1 | 30 | 0 | 0 |
| `2026-03-14-new-s7h4r2p9-spec` | 18 | 0 | 0 | 0 | 18 | 0 | 0 |
| `2026-03-15-new-ug0uwash-spec` | 21 | 0 | 0 | 5 | 16 | 0 | 0 |
| `2026-03-27-new-t8vzvg1r-spec` | 20 | 3 | 1 | 1 | 15 | 0 | 0 |
| `2026-03-28-new-d8k4m2p7-spec` | 10 | 3 | 2 | 0 | 5 | 0 | 0 |

# Requirement-by-requirement results (tables + per-requirement notes)
## `2026-01-18-spec`
- Bundle path: `datafn/.conduct/specs/2026-01-18-spec`
| ID | Status | Note |
| --- | --- | --- |
| `API-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCHEMA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QUERY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QUERY-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QUERY-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QUERY-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DETERMINISM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NORM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EVENTS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `LIMIT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `GROUP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEARCH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PLUG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `COMP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-01-19-change-spec`
- Bundle path: `datafn/.conduct/specs/2026-01-19-change-spec`
| ID | Status | Note |
| --- | --- | --- |
| `CLIENT-API-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-REG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-REG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-REMOTE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-QUERY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-TX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-SUB-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-SIGNAL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-DB-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-DB-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SEED-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-ENVELOPE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-STATUS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-CONFLICT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SYNC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SYNC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PLUG-CLIENT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PLUG-SERVER-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SUB-EXTRA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-OMIT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-RELIDS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-NESTEDSELECT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-FILTER-PATH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-FILTER-RELQ-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-HTREE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-COUNT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-GROUPBY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-PAGE-BEFORE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-FILTER-OPS-EXTRA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEARCH-PLUGIN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STORAGE-ADAPTER-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STORAGE-MEM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STORAGE-IDB-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-OFFLINE-QUERY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-OFFLINE-MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-CHANGELOG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-SYNC-APPLY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-HYDRATION-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EXT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CODEGEN-TS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PY-SDK-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MIG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-GEN-REST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-GEN-GQL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-01-23-audit-fix-change-spec`
- Bundle path: `datafn/.conduct/specs/2026-01-23-audit-fix-change-spec`
| ID | Status | Note |
| --- | --- | --- |
| `CORE-ENV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CORE-EVENT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CORE-UTIL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-ENV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-ENV-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-ENV-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-DB-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-STATUS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-PLUG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-PLUG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SEQ-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-CHANGES-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-IDEMP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SEED-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SERVER-SYNC-CLIENTID-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REST-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REST-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REST-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-PLUG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-EVENT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-FILTER-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-SIGNAL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STORAGE-MEM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STORAGE-IDB-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-OFFLINE-QUERY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-OFFLINE-MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-CHANGELOG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EXT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-VALIDATE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-CODEGEN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-MIG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PY-SDK-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PY-SDK-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOCS-SVELTE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOCS-CLIENT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOCS-CORE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOCS-SERVER-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-01-24-audit-fix-comprehensive-spec`
- Bundle path: `datafn/.conduct/specs/2026-01-24-audit-fix-comprehensive-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-01-26-fix-bs0rjtzf-spec`
- Bundle path: `datafn/.conduct/specs/2026-01-26-fix-bs0rjtzf-spec`
| ID | Status | Note |
| --- | --- | --- |
| `TYPES-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYPES-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CFG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-QUERY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-TX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-PUSH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-PUSH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-PULL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-PULL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-PULL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `WS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROTO-PUSH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROTO-CLONE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROTO-PULL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-05-fix-9x2k7m4p-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-05-fix-9x2k7m4p-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-02-06-audit-fix-k4m2p9x7-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-06-audit-fix-k4m2p9x7-spec`
| ID | Status | Note |
| --- | --- | --- |
| `DX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NUC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NUC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NUC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NUC-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CFG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CFG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EVT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EVT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `KV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `KV-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OFFQ-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OFFQ-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OFFM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CODEC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `HOOK-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EVT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EXT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-11-audit-fix-r9k4m7x2-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-02-12-fix-r8k4m2x9-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-12-fix-r8k4m2x9-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-02-14-change-k7m9x4p2-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-14-change-k7m9x4p2-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-02-15-change-m8k3x7p4-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-15-change-m8k3x7p4-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-02-16-new-k9m7x3p5-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-16-new-k9m7x3p5-spec`
| ID | Status | Note |
| --- | --- | --- |
| `VAL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYP-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYP-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYP-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-23-new-r4m9kx7v-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-23-new-r4m9kx7v-spec`
| ID | Status | Note |
| --- | --- | --- |
| `SIG-LIVE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SIG-LIVE-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REG-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REG-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PROXY-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYPE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYPE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TYPE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SVELTE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SVELTE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SVELTE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DEPR-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DEPR-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `APP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `APP-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `APP-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `APP-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-24-audit-fix-k9r4m7x3-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-24-audit-fix-k9r4m7x3-spec`
| ID | Status | Note |
| --- | --- | --- |
| `SCALE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCALE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCALE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCALE-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCALE-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCALE-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCALE-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RET-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RET-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RET-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RET-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RET-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RATE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RATE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RATE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RATE-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RATE-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PY-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-24-fix-k7m4x9p2-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec`
| ID | Status | Note |
| --- | --- | --- |
| `SYS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYS-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `IDX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `IDX-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `IDX-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FLT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FLT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FLT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FLT-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DTE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DTE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DTE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DTE-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `HKS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `HKS-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `HKS-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VLD-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STR-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EVT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TST-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-25-audit-fix-r7m4k9x2-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-25-audit-fix-r7m4k9x2-spec`
| ID | Status | Note |
| --- | --- | --- |
| `INMEM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `INMEM-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `INMEM-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `INMEM-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEQ-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `BATCH-SEQ-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `BATCH-SEQ-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `BATCH-SEQ-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `BATCH-CHG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `BATCH-CHG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-OPT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-OPT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-PULL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-PULL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-PULL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLIENT-PULL-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-26-new-k7r4m9x2-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-26-new-k7r4m9x2-spec`
| ID | Status | Note |
| --- | --- | --- |
| `RLN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RLN-012` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFN-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCH-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCH-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCH-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCH-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MIG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-02-27-audit-fix-v7k3m9x4-spec`
- Bundle path: `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec`
| ID | Status | Note |
| --- | --- | --- |
| `SEC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-012` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-013` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-014` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-015` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-016` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-012` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-013` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-014` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-015` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SCA-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PER-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PER-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PER-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PER-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PER-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PER-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DI-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DI-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DI-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-012` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-013` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-014` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-015` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-016` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-01-change-r7k4m9x3-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-01-change-r7k4m9x3-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-03-02-change-k9m4x7r3-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-02-change-k9m4x7r3-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-03-05-audit-fix-k7m9x4r3-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-05-audit-fix-k7m9x4r3-spec`
- No stable requirement IDs were parseable from this bundle's `REQUIREMENTS.md`; it was still reviewed for intent, drift, and conflict context, but it does not contribute requirement-level counts in this report.

## `2026-03-05-audit-fix-nv5royb4-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec`
| ID | Status | Note |
| --- | --- | --- |
| `FIX-SEC-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-SEC-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-REL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-REL-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-PER-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-SRV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-SRV-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-SRV-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-EXE-014` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-EXE-017` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-EXE-018` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-EXE-022` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FIX-LOG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-05-fix-q9m4k7r2-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-05-fix-q9m4k7r2-spec`
| ID | Status | Note |
| --- | --- | --- |
| `ADP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MRG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MRG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MRG-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `KV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ERR-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-06-audit-fix-r7k9m4x3-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-06-audit-fix-r7k9m4x3-spec`
| ID | Status | Note |
| --- | --- | --- |
| `FILT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FILT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FILT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FILT-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `FILT-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SORT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SORT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SORT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DATE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AGG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NORM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JOIN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `NS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VAL-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TXN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TXN-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYN-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYN-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYN-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYN-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYN-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-06-new-k4m7x9r3-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec`
| ID | Status | Note |
| --- | --- | --- |
| `CAP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CAP-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CAP-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CAP-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CAP-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CAP-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CAP-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TS-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TS-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TS-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUD-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUD-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUD-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUD-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUD-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TR-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AR-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-010` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SH-011` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CG-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-007` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-008` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CL-009` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SY-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SY-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VA-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `VA-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-07-new-q7m3k9r2-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-07-new-q7m3k9r2-spec`
| ID | Status | Note |
| --- | --- | --- |
| `RCAP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RCAP-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RCAP-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RCAP-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JCG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JCG-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JRT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JRT-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JRT-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JRT-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JSY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `JSY-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `COMP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-13-fix-c47f7431-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-13-fix-c47f7431-spec`
| ID | Status | Note |
| --- | --- | --- |
| `CON-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CON-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CON-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `IDX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `IDX-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SRV-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `UNI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `UNI-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-13-new-bhszlzcn-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-13-new-bhszlzcn-spec`
| ID | Status | Note |
| --- | --- | --- |
| `ARCH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ARCH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ARCH-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ARCH-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ARCH-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ARCH-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-005` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-006` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REL-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PERF-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PERF-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PERF-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `COMP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `COMP-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `PY-001` | PARTIAL | Python SPV2 tests passed, but the Python server still exposes only seven POST routes and omits the canonical `GET /datafn/status`; `reconcile` and `search` surfaces are absent, so production equivalence to the TypeScript runtime is incomplete. |
| `SEC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `USE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOC-001` | FAIL | Public sharing documentation is still split across legacy locations and remains migration-heavy instead of delivering the beginner-friendly sharing path required by the sharing bundle. |
| `TEST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-14-new-s7h4r2p9-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-14-new-s7h4r2p9-spec`
| ID | Status | Note |
| --- | --- | --- |
| `EXAPP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DATA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `API-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `UI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `UI-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `UI-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SHARE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SHARE-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SHARE-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SHARE-004` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ISO-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TEST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DOC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-15-new-ug0uwash-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-15-new-ug0uwash-spec`
| ID | Status | Note |
| --- | --- | --- |
| `IA-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `IA-002` | FAIL | `datafn/docs/content/docs/documentation/meta.json` still uses title `Documentation`, still publishes `migrations` and `use-cases`, and still lacks the required `sharing` top-level guide subtree. |
| `IA-003` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `LEG-001` | FAIL | Public docs still publish legacy and migration content, including `shareWith.userId`, `Legacy Compatibility`, and `/docs/documentation/migrations/spv2`. |
| `META-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `TERM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `GUIDE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CONCEPT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `START-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SETUP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SHARE-001` | FAIL | Sharing guidance was not consolidated into `documentation/sharing/*`; the current public tree still uses `concepts/sharing-v2.mdx`, `sync/sharing-sync-lifecycle.mdx`, and `use-cases/sharing-patterns.mdx`. |
| `SYNC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEARCH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DFQL-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REF-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `ADV-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `RUNTIME-001` | FAIL | Runtime applicability remains inaccurate: WebSocket manager, rate limiting, and observability pages are marked `applies_to: both`, but the Python runtime does not expose those surfaces. |
| `EXAMPLE-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QA-001` | FAIL | `datafn/docs/package.json` does not expose the required `docs:audit` command, so the docs rewrite is not locally enforced. |
| `QA-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-27-new-t8vzvg1r-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-27-new-t8vzvg1r-spec`
| ID | Status | Note |
| --- | --- | --- |
| `PKG-001` | FAIL | `datafn/swift-bridge` exists and the example app depends on it, but repo-root workspace resolution does not recognize `@datafn/swift-bridge`; `npm --workspace @datafn/swift-bridge ...` fails with `No workspaces found`. |
| `API-001` | PASS | The isolated `@datafn/client` suite passed, including native-backed configuration and sync-owner tests (`native-backed-mode`, `native-backed-icloud-mode`, `native-backed-server-sync`, `native-sync-config`). |
| `API-002` | PASS | The isolated `@datafn/swift-bridge` suite passed (5 files / 25 tests), covering the WKWebView bus plus native-backed storage, remote, sync, and search adapter exports. |
| `API-003` | PARTIAL | Swift products and targets are present, but the full Swift package test suite does not compile because `ObservedQueryTests.swift` calls `LockedBox.withValue` while the local `LockedBox` test helper only provides `get()` and `set()`. |
| `BRG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STO-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `STO-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `QRY-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `REM-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `MUT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SYN-001` | PASS | Client-side native sync delegation paths were exercised by the passing isolated client suite. |
| `SYN-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLD-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `CLD-002` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SWUI-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `AUTH-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `SEC-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `EVT-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `OBS-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `COMP-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |

## `2026-03-28-new-d8k4m2p7-spec`
- Bundle path: `datafn/.conduct/specs/2026-03-28-new-d8k4m2p7-spec`
| ID | Status | Note |
| --- | --- | --- |
| `DARCH-001` | PASS | `datafn/swift/Package.swift` exports `DatafnSearchContracts` and `DatafnSearchFnBackend`, and the backend depends on the companion `searchfn/swift-package`. |
| `DAPI-001` | PASS | `createNativeBackedSearchProvider(bus)` is exported from `@datafn/swift-bridge`, and the isolated bridge suite passed its native search provider coverage. |
| `DCFG-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DJS-001` | PASS | The isolated client suite passed both `native-backed-search.test.ts` and `native-backed-search-browser-regression.test.ts`, indicating that native-backed search routing is wired on the JavaScript side. |
| `DRT-001` | PARTIAL | Runtime search contracts and backend targets exist, but the full Swift suite is blocked by the SwiftUI test compile failure, so end-to-end native runtime verification is incomplete. |
| `DIDX-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DREB-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DPST-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DERR-001` | UNVERIFIED | No direct requirement-level mapping was established in this audit run; see bundle summary and broad package-suite evidence above. |
| `DDOC-001` | PARTIAL | Examples and native-backed README material were updated, but the public docs-site rewrite remains incomplete and there is still no local docs audit command. |

# Spec conflicts / spec gaps (explicit)
- **Public legacy docs**: 2026-03-13-new-bhszlzcn-spec COMP-002 requires backward-compatible legacy share APIs to remain available and documented, while 2026-03-15-new-ug0uwash-spec LEG-001 forbids public legacy/deprecation/migration guidance. The current docs still publish legacy share guidance, which satisfies the compatibility bundle but violates the public-docs bundle. No precedence was provided, so this remains a spec conflict for pass/fail.
- **Python mounting surface drift**: Implementation milestone 13 still describes Python as exposing `superfunctions.http.Route[]`, while the current implementation returns a dictionary keyed by `"METHOD /path"`. This is intent/implementation drift even though the Python tests currently pass against the concrete return shape.
- **README governance gap**: The 2026-03-15 docs rewrite bundle explicitly scopes public docs-site work, not package READMEs. That leaves the current README drift (`authContext` / `authContextProvider` vs `namespace` / `namespaceProvider`) as a production-readiness risk without a clearly authoritative spec owner.

# Cross-cutting audits (security/determinism/limits/errors/compat)
## Security / authz / validation boundaries
- The TypeScript server surface is materially stronger than in the March snapshot. The isolated `@datafn/server` run passed 82 files / 854 tests, including `security.test.ts`, `rate-limit.test.ts`, `spv2-parity.test.ts`, `spv2-conformance.test.ts`, `server-search.test.ts`, and the relation-inheritance suites.
- The Python runtime passed its test suite, including SPV2/authz coverage, but its externally visible route surface is still missing canonical parity points. `datafn/python/datafn/server.py` exposes only `POST /datafn/query`, `mutation`, `transact`, `seed`, `clone`, `pull`, and `push`; it still omits `GET /datafn/status` and has no `reconcile` or `search` handler surface.
- Public docs overstate runtime truthfulness by marking WebSocket manager, rate limiting, and observability pages as `applies_to: both` while the Python runtime does not implement those surfaces.

## Determinism invariants
- The executed TypeScript package suites provide strong evidence that determinism-focused paths are in better shape: core normalization/validation, client sync/search routing, and server status/envelope/query/sync suites all passed in isolated runs.
- Release verification is not yet deterministic at the repo level because the root workspace graph cannot resolve `@datafn/swift-bridge`. That forces ad hoc snapshot-only package installation workarounds, which is itself a reproducibility failure for release engineering.
- The Swift package is still non-deterministic from a release perspective because its test suite does not compile end-to-end. The concrete failure is in `datafn/swift/Tests/DatafnSwiftUITests/ObservedQueryTests.swift:124`, which calls `loaderCallCount.withValue(...)`, while the local helper at `ObservedQueryTests.swift:8-27` defines only `get()` and `set()`.

## Limits / caps
- The TypeScript server suite exercised rate limiting and bounded sync behavior successfully in the isolated run, which is strong positive evidence for the TS server release surface.
- The public docs still describe those operational controls as if they apply equally to Python, which is not truthful today and creates an operator-expectation risk.

## Error handling + canonical envelopes
- `@datafn/core`, `@datafn/client`, and `@datafn/server` all passed their isolated suites, including envelope/validation/status/error-surfacing tests. This is a substantial improvement from the prior audit state.
- Python still lacks the canonical status route, so client-side capability probing and status-based parity checks remain incomplete on the Python backend surface.

## Compatibility / versioning / migrations
- Runtime compatibility for legacy share APIs still exists and is tested on the client and server sides. That is acceptable at runtime, but it is in direct tension with the public-docs bundle that forbids publishing legacy/deprecation/migration guidance before release.
- Package READMEs are no longer aligned with the shipped namespace APIs. This is outside the narrow docs-site bundle scope, but it is still a production-readiness problem because it misleads adopters even when the code itself is correct.

# Recommendations (ranked)
1. Fix monorepo workspace/installability for `@datafn/swift-bridge` and verify that repo-root `npm install` plus repo-root test orchestration work without snapshot-only workarounds.
2. Fix the Swift compile regression in `datafn/swift/Tests/DatafnSwiftUITests/ObservedQueryTests.swift`, then rerun `swift test --package-path datafn/swift` as a real release gate.
3. Finish the public docs rewrite bundle: remove `migrations` and `use-cases` from the public tree, introduce the `documentation/sharing/*` cluster, correct runtime applicability, and add `npm --prefix datafn/docs run docs:audit`.
4. Bring the Python server to canonical route-surface parity, starting with `GET /datafn/status`; decide explicitly whether `reconcile` and `search` are part of the supported Python release surface, and document that choice truthfully.
5. Align `datafn/client/README.md` and `datafn/server/README.md` with the actual `namespace` / `namespaceProvider` APIs before release.
6. Resolve the public-docs vs compatibility-docs spec conflict so that legacy runtime compatibility can remain in code without forcing legacy guidance into the published docs site.

# Appendix: commands run + environment details
## Commands run
- `git rev-parse next`
- `git archive next | tar -x -C <temp-snapshot>`
- `find datafn/.conduct/intent -maxdepth 3 -type f`
- `find datafn/.conduct/specs -mindepth 1 -maxdepth 1 -type d`
- `python3 -m pytest datafn/python/tests -q`
- `swift test --package-path datafn/swift`
- `npm --workspace @datafn/swift-bridge run test -- --help`
- `(cd datafn/core && npm install --workspaces=false && npm test && npm run build && npm pack)`
- `(cd datafn/client && npm install --workspaces=false --no-save ../core/datafn-core-0.0.2.tgz && npm test && npm run build && npm pack)`
- `(cd datafn/swift-bridge && npm install --workspaces=false --no-save ../core/datafn-core-0.0.2.tgz ../client/datafn-client-0.0.2.tgz && npm test)`
- `(cd packages/http && npm install --workspaces=false && npm run build && npm pack)`
- `(cd packages/db && npm install --workspaces=false && npm run build && npm pack)`
- `(cd datafn/server && npm install --workspaces=false --no-save ../core/datafn-core-0.0.2.tgz ../../packages/http/superfunctions-http-0.1.2.tgz ../../packages/db/superfunctions-db-0.1.3.tgz && npm install --workspaces=false --no-save better-sqlite3 drizzle-orm && npm test)`

## Environment details
- Audited source ref: local branch `next` at commit `591c1be834abad5ba0aaa432e9cd46f101b04e97`
- Node/npm used during audit: `node v22.22.1`, `npm 10.9.4`
- Python: `Python 3.9.6`
- Swift: `Apple Swift 6.3`
- Verified package-suite results from the exported `next` snapshot:
  - `@datafn/core`: 20 files / 314 tests passed
  - `@datafn/client`: 63 files / 552 tests passed (after installing the local packed `@datafn/core` artifact into the snapshot)
  - `@datafn/swift-bridge`: 5 files / 25 tests passed (after installing the local packed `@datafn/core` and `@datafn/client` artifacts into the snapshot)
  - `@datafn/server`: 82 files / 854 tests passed (after installing the local packed `@datafn/core`, `@superfunctions/http`, `@superfunctions/db`, and the test-only `better-sqlite3` / `drizzle-orm` packages into the snapshot)
  - `datafn/python/tests`: passed (20 test modules)
- Repo-root workspace verification failures from the same snapshot:
  - `npm --workspace @datafn/swift-bridge run test -- --help` failed with `No workspaces found`
  - `swift test --package-path datafn/swift` failed to compile `DatafnSwiftUITests` because `LockedBox.withValue` is missing

