# DataFn Documentation Gaps Full Audit

## Metadata
- **timestamp**: 2026-03-07T18:27:12Z
- **agent_name**: unknown-agent
- **model**: GPT-5 Codex
- **launcher**: Codex desktop
- **workspace/project**: `/Users/serro/Documents/dev/n/superfunctions`
- **OS + shell**: `Darwin 25.3.0`, `/bin/zsh`
- **git metadata**:
  - branch: `heads/next`
  - commit: `635bf2853807d9d76dba07a460dd0594f57d9147`
  - working tree: `dirty`
- **intent/notes paths audited**:
  - `datafn/.conduct/intent/datafn.intent.md`
  - `datafn/.conduct/intent/dfql.intent.md`
  - `datafn/.conduct/intent/implementation.md`
  - `datafn/.conduct/intent/spec.md`
  - `datafn/.conduct/intent/migration-plan-from-nucleus.md`
  - `datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md`
  - `datafn/.conduct/intent/{query-sample.json,mutation-sample.json,transact-sample.json,table-schema-sample.json}`
- **spec bundle paths audited** (roots + included files):
  - `datafn/.conduct/specs/2026-01-18-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `IMPLEMENTATION_SUMMARY.md`, `phases/*`)
  - `datafn/.conduct/specs/2026-01-19-change-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `COVERAGE_MATRIX.md`, `phases/*`)
  - `datafn/.conduct/specs/2026-01-23-audit-fix-change-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`)
  - `datafn/.conduct/specs/2026-01-24-audit-fix-comprehensive-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `audits/*`)
  - `datafn/.conduct/specs/2026-01-26-fix-bs0rjtzf-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-05-fix-9x2k7m4p-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-06-audit-fix-k4m2p9x7-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-12-fix-r8k4m2x9-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-14-change-k7m9x4p2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `README.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-15-change-m8k3x7p4-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `README.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-16-new-k9m7x3p5-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-23-new-r4m9kx7v-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-24-audit-fix-k9r4m7x3-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-25-audit-fix-r7m4k9x2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-26-new-k7r4m9x2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-01-change-r7k4m9x3-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-02-change-k9m4x7r3-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-05-audit-fix-k7m9x4r3-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-05-fix-q9m4k7r2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-06-audit-fix-r7k9m4x3-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
  - `datafn/.conduct/specs/2026-03-07-new-q7m3k9r2-spec` (`REQUIREMENTS.md`, `SPEC.md`, `PLAN.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, `phases/*`, `phase-reports/*`)
- **codebase scope audited**:
  - docs: `datafn/docs/content/docs/**`
  - implementation: `datafn/{client,server,python,cli,core}/**`, `packages/db/**`
  - excluded: non-DataFn packages except `packages/db` cross-package adapter API checks
- **commands executed during audit**: `rg`, `find`, `ls`, `nl`, `sed`, `git rev-parse`, `git status --porcelain`, `date`, `uname`

## Audit scope
This audit is a read-only, documentation-gap audit focused on `datafn/docs` vs current implementation across DataFn packages and related adapter exports. The user’s constraint was applied: remove/avoid legacy/backward-compat guidance where not required (pre-release, no consumers). Existing historical audit reports were not used as compliance authority.

## Inputs audited (intent + spec bundles)
### Intent inputs
- Primary user intent for this audit: identify doc gaps where functionality exists in code but is missing/incorrect in docs, across all packages.
- `datafn/.conduct/intent/*` files listed in Metadata.

### Spec inputs
- 26 spec bundles under `datafn/.conduct/specs/*` were inventoried.
- Documentation-relevant requirement sets reviewed in detail:
  - `2026-03-02-change-k9m4x7r3-spec` (`DOC-001..011`, `SVL-001..006`, `DIA-001..003`, `PY-001..005`)
  - `2026-02-06-audit-fix-k4m2p9x7-spec` (`SYNC-007`, `EVT-003`, `CFG-001/002` context)
  - `2026-02-25-audit-fix-r7m4k9x2-spec` (`CLIENT-PULL-003`)
  - `2026-03-05-audit-fix-nv5royb4-spec` (`FIX-SEC-006`, `FIX-SRV-003`)
  - legacy docs/readme parity references: `2026-01-19-change-spec`, `2026-01-23-audit-fix-change-spec`, `2026-01-24-audit-fix-comprehensive-spec`

## High-level findings
1. **Event API docs are inconsistent with current client API** (`client.events.on` vs actual `client.subscribe`).
2. **Sync method docs are outdated** (`clone(resource)`, `pull()`, `push()` signatures), omitting actual payload requirements and engine methods.
3. **Remote adapter docs omit `reconcile(payload)`**, despite it being required in client transport interface.
4. **Transport docs claim timeout/network wrapping behavior not implemented in `DefaultHttpTransport`**.
5. **Hydration state docs still mention `failed` in user docs**, but type is only `notStarted | hydrating | ready`.
6. **Cross-tab docs use invalid config/API usage** (`crossTab` top-level and `client.stop()`).
7. **Server/database setup docs use incorrect DB adapter API/imports** (`createDrizzleAdapter`, `@superfunctions/db/drizzle`).
8. **CLI docs contain outdated flags/defaults/behavior** vs actual `datafn generate`/`validate` implementation.
9. **Python-tabbed server docs are not fully accurate to Python package exports and routes**.
10. **Server route docs include stale payload/response contracts** for pull/push/reconcile in at least one page.
11. **Server config docs miss new limit fields** (`maxBatchSize`, `maxBatchQueryConcurrency`) added in code.
12. **Base URL examples are inconsistent**: some pages omit `/datafn` even though default transport posts to `${baseUrl}/{endpoint}`.

## Intent Inventory (numbered)
1. Documentation must match implemented DataFn behavior across packages.
2. Missing features in docs (present in code) must be identified.
3. Stale/incorrect docs must be identified with concrete evidence.
4. Scope covers client, server, Python SDK/docs, CLI docs, and shared DB adapter integration references.
5. `.conduct` timeline/spec context should be used for evolution-aware auditing.
6. Legacy/backward-compat migration content is not needed for this pre-release codebase.
7. Route request/response contracts in docs must align with actual handlers.
8. Client API docs must align with exported client surface and sync behaviors.
9. Python docs merged into tabs must remain accurate to actual Python implementation.
10. Limits and security-related documented configs must track current server config.
11. Transport/error behavior docs must reflect real runtime behavior.
12. CLI docs must reflect actual command syntax, required flags, defaults, and output.
13. Cross-package references (`@superfunctions/db`) must use valid exported entrypoints.
14. Documentation should not preserve obsolete/deprecated usage patterns as primary guidance.

## Intent → Spec coverage matrix (complete; no sampling)
| Intent # | Intent statement | Spec mapping | Status |
|---|---|---|---|
| 1 | Docs align with implementation | `DOCS-CLIENT-001`, `DOCS-SERVER-001`, `DOC-004`, `DOC-005`, `PY-002`, `SYNC-007` | PARTIAL |
| 2 | Missing documented functionality identified | No single global “continuous docs parity” requirement in latest bundles | SPEC MISSING |
| 3 | Stale/incorrect docs detected with evidence | `DOC-*` cleanup + parity IDs provide partial mechanism | PARTIAL |
| 4 | Multi-package scope | `PY-001..005`, `SVL-001..006`, legacy `PY-SDK-*` | PASS |
| 5 | Use `.conduct` evolution | All 26 bundles inventoried; key requirement sets traced | PASS |
| 6 | No legacy/back-compat guidance | `DOC-001..011` (legacy cleanup) | PASS |
| 7 | Route contract accuracy | `PY-SDK-002`, `SYNC-007` | FAIL |
| 8 | Client API reference accuracy | `DOC-004`, `DOCS-CLIENT-001`, `CLIENT-PULL-003` | FAIL |
| 9 | Python tab accuracy | `PY-001`, `PY-002` | FAIL |
| 10 | Limits/security docs track server config | `FIX-SEC-006`, `FIX-SRV-003` | FAIL |
| 11 | Transport/error docs reflect runtime | `DOCS-CLIENT-001` (parity), no explicit new transport-doc req | SPEC MISSING |
| 12 | CLI docs track CLI behavior | No explicit post-change docs requirement in later bundles | SPEC MISSING |
| 13 | Cross-package import correctness | `DOCS-SERVER-001` intentually related, but docs/ pages not explicitly covered later | SPEC MISSING |
| 14 | Avoid obsolete primary guidance | `DOC-001..011` | PARTIAL |

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)
| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED | Notes |
|---|---:|---:|---:|---:|---|
| `2026-03-02-change-k9m4x7r3-spec` | 20 | 4 | 1 | 0 | Legacy cleanup mostly landed; Python merged docs have accuracy gaps |
| `2026-02-06-audit-fix-k4m2p9x7-spec` | 0 | 0 | 1 | 0 | `SYNC-007` docs drift in reconcile contracts/reference surfaces |
| `2026-02-25-audit-fix-r7m4k9x2-spec` | 0 | 1 | 0 | 0 | `CLIENT-PULL-003` partially documented (not complete in config reference) |
| `2026-03-05-audit-fix-nv5royb4-spec` | 0 | 0 | 2 | 0 | New limits not documented in server config docs |
| `2026-01-23-audit-fix-change-spec` | 0 | 0 | 0 | 6 | IDs mostly target package READMEs (outside `datafn/docs` scope) |
| `2026-01-19-change-spec` | 0 | 0 | 0 | 1 | `DOC-001` targets Svelte README, not docs site |
| Remaining 20 bundles | N/A | N/A | N/A | N/A | No direct docs-site requirement IDs impacting this audit scope |

## Requirement-by-requirement results (tables + per-requirement notes)
### Table A — `2026-03-02-change-k9m4x7r3-spec`
| Requirement | Status | Evidence summary |
|---|---|---|
| DOC-001 | PASS | Legacy `multiTenant`/auth-context patterns removed from target docs; no such references found in intended pages. |
| DOC-002 | PASS | `documentation/client/setup.mdx` has no `authContext`; factory signature uses namespace string. |
| DOC-003 | PASS | `documentation/server/setup.mdx` no `authContextProvider` references. |
| DOC-004 | PARTIAL | Legacy fields removed, but `reference/client/config.mdx` omits current fields and `reconcile` in remote adapter. |
| DOC-005 | PARTIAL | `authContextProvider` removed, but server config reference omits current limits (`maxBatchSize`, `maxBatchQueryConcurrency`). |
| DOC-006 | PASS | `reference/client/storage.mdx` reflects current factory/changelog shape. |
| DOC-007 | PASS | core types docs use `namespaced`; no `multiTenant` field in DatafnSchema docs. |
| DOC-008 | PASS | no `createForUser` references in IndexedDB docs. |
| DOC-009 | PARTIAL | legacy factory pattern cleaned, but storage overview still lists invalid hydration state `failed`. |
| DOC-010 | PASS | security docs do not reintroduce legacy authContextProvider pattern. |
| DOC-011 | PASS | schema concept docs avoid `multiTenant`. |
| SVL-001 | PASS | framework adapters page exists (`documentation/client/frameworks.mdx`). |
| SVL-002 | PASS | Svelte usage examples present in signals/framework docs. |
| SVL-003 | PASS | client setup includes framework adapter section with `@datafn/svelte`. |
| SVL-004 | PASS | Svelte API reference page exists (`reference/client/svelte.mdx`). |
| SVL-005 | PASS | framework adapter ecosystem pattern documented. |
| SVL-006 | PASS | Svelte examples appear in relevant client docs. |
| DIA-001 | PASS | mermaid system architecture diagram exists. |
| DIA-002 | PASS | diagram present in `docs/content/docs/index.mdx`. |
| DIA-003 | PASS | diagram present in `documentation/concepts/overview.mdx`. |
| PY-001 | PARTIAL | Python setup tab exists, but root import example uses non-exported symbol (`DatafnServerConfig` from `datafn`). |
| PY-002 | FAIL | Python routes merged in docs are not accurate to current Python route surface/contract for status/reconcile. |
| PY-003 | PASS | Python adapter tabbed content present in DB adapters docs. |
| PY-004 | PASS | Python authorization/handler examples present in server docs with tabs. |
| PY-005 | PASS | no Python top-level sidebar entry in `docs/content/docs/meta.json`. |

### Table B — Other critical requirement IDs
| Requirement | Status | Evidence summary |
|---|---|---|
| SYNC-007 | FAIL | Reconcile docs/adapter refs drift from current request shape and required client adapter method. |
| CLIENT-PULL-003 | PARTIAL | docs mention `maxPullIterations` in sync guide, but config reference omits it. |
| FIX-SEC-006 | FAIL | docs omit `limits.maxBatchSize` despite implementation support. |
| FIX-SRV-003 | FAIL | docs omit `limits.maxBatchQueryConcurrency` despite implementation support. |

### Per-requirement notes (failed/partial)
- **DOC-004 (PARTIAL)**
  - Docs: `datafn/docs/content/docs/reference/client/config.mdx:127-136` omit `reconcile` method in `DatafnRemoteAdapter`.
  - Code: `datafn/client/src/client.ts:32-41` includes required `reconcile(payload)`.
  - Docs also omit current `DatafnSyncConfig` fields (`pushRetryBackoff`, `pushIntervalBackoff`, `pullBatchSize`, `maxPullIterations`): compare `reference/client/config.mdx:38-74` vs `datafn/client/src/client.ts:126-163`.

- **DOC-005 (PARTIAL)**
  - Docs server config limits omit new fields: `datafn/docs/content/docs/reference/server/config.mdx:30-40`.
  - Code includes them: `datafn/server/src/server.ts:86-90`.

- **DOC-009 (PARTIAL)**
  - Docs storage overview says hydration includes `"failed"`: `datafn/docs/content/docs/documentation/storage/overview.mdx:86`.
  - Actual type: `datafn/client/src/storage.ts:5` (`"notStarted" | "hydrating" | "ready"`).

- **PY-001 (PARTIAL)**
  - Docs Python setup import: `from datafn import create_datafn_server, DatafnServerConfig` (`documentation/server/setup.mdx:103`).
  - Root Python exports only `create_datafn_server`: `datafn/python/datafn/__init__.py:1-3`.

- **PY-002 (FAIL)**
  - Docs merged routes page presents `GET /datafn/status` and `POST /datafn/reconcile` under unified available routes (`documentation/server/routes.mdx:91`, `:414`).
  - Python implementation routes are query/mutation/transact/seed/clone/pull/push only (`datafn/python/datafn/server.py:89-97`), with test comment explicitly noting status not implemented (`datafn/python/tests/test_server.py:25`).

- **SYNC-007 (FAIL)**
  - Reconcile contract docs in `documentation/server/routes.mdx:421-439` show `clientState/resolved` shape, which does not match current server reconcile request/result shape (`datafn/server/src/execution/sync/reconcile.ts:15-31`).
  - Remote adapter docs omit `reconcile` in both `reference/client/config.mdx:127-136` and `reference/client/transport.mdx:15-23`, while code requires it (`datafn/client/src/client.ts:40`).

- **CLIENT-PULL-003 (PARTIAL)**
  - Guide docs include `maxPullIterations` (`documentation/sync/pull-push.mdx:72-74`).
  - Reference config page omits it (`reference/client/config.mdx:38-74`), despite code support (`datafn/client/src/client.ts:157-163`).

- **FIX-SEC-006 (FAIL)**
  - Requirement expects documented `limits.maxBatchSize` parity with config (`2026-03-05.../REQUIREMENTS.md:21-27`).
  - Implementation has it (`datafn/server/src/server.ts:86-87`, `routes/sync.ts:308-318`), docs reference does not (`reference/server/config.mdx:30-40`).

- **FIX-SRV-003 (FAIL)**
  - Requirement expects documented bounded batch query concurrency (`.../REQUIREMENTS.md:93-99`).
  - Implementation has `maxBatchQueryConcurrency` (`datafn/server/src/server.ts:89`, route usage in `datafn/server/src/routes/query.ts:193`).
  - Docs reference omits this field (`reference/server/config.mdx:30-40`).

## Spec conflicts / spec gaps (explicit)
1. **SPEC GAP**: No durable, ongoing requirement in latest bundles enforces docs parity for new post-spec API changes (e.g., transport interface additions, CLI behavior changes, limits additions).
2. **SPEC GAP**: CLI docs parity is not explicitly governed by a current requirement ID despite active CLI changes.
3. **SPEC CONFLICT/DRIFT IN DOCS**: Route contracts conflict across docs pages and with implementation:
   - `documentation/server/routes.mdx` uses stale pull/push/reconcile examples.
   - sync guide pages use alternate/partial shapes.
4. **SPEC GAP (Python merged docs)**: `PY-002` required merged examples but did not force explicit “Python route availability differences” notes; current docs over-imply parity for unimplemented routes.

## Cross-cutting audits (security/determinism/limits/errors/compat)
### Security/authz/validation boundaries
- Docs are generally consistent on deny-by-default auth and envelope errors.
- Gaps:
  - Stale route payload examples may cause invalid calls and bypass expected validation semantics in client integrations.
  - Python route availability mismatch may lead integrators to expose non-existent paths.

### Determinism invariants
- Deterministic themes exist in docs, but protocol details are inconsistent:
  - Reconcile request/result shape drift from deterministic counts-based design (`SYNC-007`).
  - Pull response examples are inconsistent with canonical per-table cursor result used by sync engine.

### Limits/caps
- Major drift:
  - Missing docs for `limits.maxBatchSize` and `limits.maxBatchQueryConcurrency`.
  - This is high-risk because operators rely on config reference for operational controls.

### Error handling + canonical envelopes
- Docs claim default transport wraps network errors into `TRANSPORT_ERROR` envelopes and supports timeout config (`reference/client/transport.mdx:42-57`).
- Code behavior differs:
  - default transport has no timeout option and throws network errors (`datafn/client/src/transport/http.ts:10-18`, `57-100`), except AbortError mapping.

### Compatibility/versioning/migrations
- User constraint respected: legacy migration guidance is largely removed from docs.
- Remaining concern is not backward-compat content, but stale examples still documenting invalid current APIs.

## Recommendations (ranked)
1. **P0** Fix client event API usage across docs: replace `client.events.on(...)` with `client.subscribe(...)` in sync and advanced pages.
2. **P0** Fix sync API docs/signatures:
   - show `sync` methods with current payload contracts,
   - document `sync.start/stop/pullNow/cloneNow/reconcileNow`,
   - remove/replace `client.sync.clone([..])`, `client.sync.pull()`/`push()` no-arg examples where invalid.
3. **P0** Fix reconcile documentation end-to-end:
   - update request/response shapes in server routes docs,
   - add `reconcile` to `DatafnRemoteAdapter` docs in config + transport reference.
4. **P0** Fix DB adapter documentation imports/APIs to current exported surface:
   - use `drizzleAdapter` from `@superfunctions/db/adapters`.
5. **P0** Fix server config docs for current limits (`maxBatchSize`, `maxBatchQueryConcurrency`).
6. **P0** Fix Python tab examples:
   - remove root import of `DatafnServerConfig` from `datafn`,
   - clearly mark Python route availability differences (`status`/`reconcile` not implemented yet) or implement parity.
7. **P1** Fix CLI docs:
   - `--adapter` and `--database` are required,
   - adapter currently only `drizzle`,
   - output default is `./`,
   - `validate` success prints a confirmation line.
8. **P1** Normalize base URL examples:
   - pages using default HTTP transport should use `/datafn` base path consistently.
9. **P1** Correct transport docs to actual behavior (or implement documented timeout/wrapping behavior if intended).
10. **P1** Add docs CI parity checks for public API snippets (client/server/cli/python route map) to prevent future drift.

## Appendix: commands run + environment details
### Representative commands run
- `find datafn/.conduct/intent -maxdepth 2 -type f | sort`
- `find datafn/.conduct/specs -mindepth 1 -maxdepth 1 -type d | sort`
- `rg -n "client\.events\.on|sync\.pull\(|createDrizzleAdapter|datafn codegen drizzle|DatafnServerConfig|/datafn/reconcile" datafn/docs/content/docs -S`
- `rg -n "interface DatafnRemoteAdapter|reconcile\(|DatafnHydrationState|maxBatchSize|maxBatchQueryConcurrency" datafn/client/src datafn/server/src -S`
- `nl -ba <target-file> | sed -n '<range>'` on docs and implementation files for line evidence
- `rg -n "DOC-|SVL-|DIA-|PY-|SYNC-007|FIX-SEC-006|FIX-SRV-003|CLIENT-PULL-003" datafn/.conduct/specs/*/REQUIREMENTS.md -S`
- `git rev-parse --abbrev-ref HEAD && git rev-parse HEAD`
- `git status --porcelain`
- `date -u +"%Y-%m-%dT%H:%M:%SZ"`, `uname -sr`

### Environment details
- cwd: `/Users/serro/Documents/dev/n/superfunctions`
- timezone context: `Asia/Kolkata`
- timestamp reference used: UTC
- audit mode: static/read-only (no code changes, no test execution)
