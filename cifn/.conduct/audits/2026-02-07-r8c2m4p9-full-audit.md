## Metadata

- **timestamp**: 2026-02-07T16:56:08Z (UTC)
- **agent_name**: unknown-agent
- **model**: GPT-5.2 (exact version string not provided by runtime)
- **launcher**: Cursor
- **workspace/project absolute path**: /Users/ar/dev/superfunctions/cifn
- **OS + shell**: darwin 25.0.0, zsh
- **repo metadata**:
  - **git repo**: yes (superfunctions monorepo)
  - **repo root**: /Users/ar/dev/superfunctions
  - **branch**: heads/next
  - **commit**: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - **dirty status**: dirty (many changes; not all scoped to `cifn/`)
- **intent/notes paths audited (authoritative intent)**:
  - /Users/ar/dev/superfunctions/cifn/SPEC.md
  - /Users/ar/dev/agent/intent/super functions/superfunctions-ar-notes.md
- **spec bundle paths audited**:
  - **bundle root**: /Users/ar/dev/superfunctions/cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec
  - **included files**:
    - SPEC.md
    - REQUIREMENTS.md
    - TEST_VECTORS.md
    - PLAN.md
    - INTENT_AUDIT.md
    - phases/PHASE_00.md
    - phases/PHASE_01.md
    - phases/PHASE_02.md
    - phases/PHASE_03.md
    - phases/PHASE_04.md
    - phases/PHASE_05.md
    - phases/PHASE_06.md
    - phases/PHASE_07.md
    - phases/PHASE_08.md
    - phases/PHASE_09.md
    - phases/PHASE_10.md
    - phases/PHASE_11.md
    - phase-reports/PHASE_00-2026-02-06-scqr9q8g-report.md
    - phase-reports/PHASE_01-2026-02-06-s9s9vsgd-report.md
    - phase-reports/PHASE_02-2026-02-06-76qu9aum-report.md
    - phase-reports/PHASE_03-2026-02-07-dbb2vv4x-report.md
    - phase-reports/PHASE_04-2026-02-07-9y7sj66m-report.md
    - phase-reports/PHASE_05-2026-02-07-jym5pyj9-report.md
    - phase-reports/PHASE_06-2026-02-07-kvvrrb32-report.md
    - phase-reports/PHASE_07-2026-02-07-7x9y2z1w-report.md
    - phase-reports/PHASE_08-2026-02-07-cli-report.md
    - phase-reports/PHASE_09-2026-02-07-q3md8p2k-report.md
    - phase-reports/PHASE_10-2026-02-07-ph10a7k2-report.md
    - phase-reports/PHASE_11-2026-02-07-ph11limits-report.md
    - logs.csv
- **codebase scope audited**:
  - **root**: /Users/ar/dev/superfunctions/cifn
  - **included**:
    - schemas/pipeline.schema.json
    - typescript/control-plane/src/**
    - typescript/runner/src/**
    - typescript/cli/src/**
    - typescript/dashboard/src/**
    - package.json files for these workspaces
  - **excluded**:
    - generated/build/deps artifacts (e.g. node_modules/, dist/, coverage/, .turbo/) not audited for source-of-truth behavior
- **commands executed during audit**:
  - `date -u "+%Y-%m-%dT%H:%M:%SZ"` (to capture report timestamp)
  - `npm -w cifn/typescript/control-plane test && npm -w cifn/typescript/runner test && npm -w cifn/typescript/cli test && npm -w cifn/typescript/dashboard test`
  - `git rev-parse --is-inside-work-tree && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain`

## Audit scope

This is a **full, read-only audit** of the CiFn implementation under `/Users/ar/dev/superfunctions/cifn` against:

1) **Authoritative intent/notes** (root `cifn/SPEC.md` + `superfunctions-ar-notes.md`), and  
2) The provided spec bundle `cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec` (SPEC/REQUIREMENTS/TEST_VECTORS/PLAN/phases/INTENT_AUDIT, plus bundle-local phase reports).

No implementation code was modified as part of this audit. Only this audit report was created.

## Inputs audited (intent + spec bundles)

### Intent / notes (authoritative)

- `/Users/ar/dev/superfunctions/cifn/SPEC.md`
- `/Users/ar/dev/agent/intent/super functions/superfunctions-ar-notes.md`

### Spec bundle(s)

- `/Users/ar/dev/superfunctions/cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec/*` (listed in Metadata)

## High-level findings

- **Pipeline parsing + schema validation**: Implemented and well-tested (YAML/JSON, triggers, step-type allowlist, DAG constraints, limits).  
- **Core control-plane endpoints**: Implemented for run lifecycle (create via inline `pipelineSpec`, list, detail, cancel), plus logs and artifacts endpoints.  
- **Major spec mismatch: pipelineRef-based run creation**: The API requirement expects `pipelineRef` (repo/ref/configPath) fetch; implementation returns `RUN_CREATE_FAILED` for `pipelineRef` and only supports inline `pipelineSpec`.  
- **Major missing runtime semantics: `if` conditions + expression evaluation**: Spec requires `if` semantics (`failure()`, branch gating), plus expressions in `env`/`with` including `hashFiles(...)`. Implementation provides a limited `${{ secrets.* }}` / `${{ github.* }}` resolver, but does **not** evaluate `if`, does **not** implement `failure()`, and does **not** implement `hashFiles(...)`.  
- **Runner auth is not runner-scoped**: Heartbeat uses the **global registration token** as the “runner secret”, not a per-runner secret, diverging from requirements.  
- **Ecosystem integrations are largely in-memory stubs**: queue/file/secrets/log clients exist as memory implementations; real flowfn/filefn/secfn/logfn/testfn/plugfn integrations are not present in this package scope.  
- **Dashboard likely broken against the actual API contract**: Dashboard pages expect `run.id`, but control-plane responses provide `runId` (and no `id`), which would break UI rendering/navigation without an adapter.  
- **Error-code set drift**: Implementation uses `UNAUTHORIZED` error code, but spec-defined canonical error codes do not include it.  
- **Tests pass, but they do not fully prove spec compliance**: All CiFn workspace test suites passed in this audit run; however, several requirements are not satisfied despite test green-ness (notably pipelineRef fetch, `if` semantics, runner-scoped auth, and true superfunctions service integrations).

## Intent Inventory (numbered)

Derived from authoritative intent sources (`cifn/SPEC.md` + `superfunctions-ar-notes.md`), exhaustively enumerating features/constraints/invariants/must-nots stated or implied there.

1. CiFn is **self-hosted CI/CD** (CircleCI/GitHub Actions-like) for the superfunctions ecosystem; runs pipelines (build → test → deploy) on user-controlled infra.
2. **Pipeline-as-config** in repo: YAML/JSON pipeline config, familiar to GHA/CircleCI users.
3. **Config path**: pipeline stored in repo at `.ci/pipeline.yml` or `cifn.yml` (configurable path).
4. **Trigger types**: push, pull_request, schedule (cron), workflow_dispatch (manual).
5. **Interop triggers**: push/PR via plugfn webhooks; schedule via flowfn scheduler/cron; manual via API.
6. **Control plane** exists: API + scheduler; stores pipeline configs and run history; dispatches work.
7. **Flowfn orchestration**: use flowfn for job queue, DAG execution, retries, scheduling.
8. **Run model**: a run comprises jobs and steps, with DAG dependencies via `needs`.
9. **Job DAG semantics**: jobs/needs form a DAG; dependent jobs wait on prerequisites.
10. **Determinism**: job and step ordering should be deterministic given the same pipeline + trigger inputs.
11. **Runner model**: runners execute jobs as processes or containers.
12. **Default runner**: runs-on default; may run per-job in Docker; supports optional `image`.
13. **runs-on dispatch**: job `runs-on` matches runner labels/types (e.g. default, hostfn-runner, docker-ubuntu-22).
14. **hostfn-runner**: runner that executes on a hostfn-managed node; deploy step can be local via `hostfn deploy <env> --local --ci`.
15. **Self-hosted runners**: user can register runners with the control plane (token from secfn); runners pull jobs.
16. **Step types** include:
    - `run` (shell)
    - `uses: checkout`
    - `uses: cache/restore`, `cache/save`
    - `uses: artifact/upload`, `artifact/download`
    - `uses: testfn/run`
    - `uses: hostfn/deploy`
17. **Checkout semantics**: checkout clones the repo at the trigger ref; workspace becomes clone root.
18. **Cache semantics**: cache steps store/restore dependencies using cachefn or filefn-backed cache; keys may use expressions like `hashFiles(...)`.
19. **Artifact semantics**: artifacts uploaded/downloaded via filefn; used for passing build outputs across jobs.
20. **Test step semantics**: test step uses testfn (intent describes testfn as ecosystem test runner).
21. **Deploy step semantics**: deploy uses hostfn CLI with `--ci` and secrets from secfn.
22. **Ecosystem-native** integrations (explicit intent):
    - hostfn (deploy)
    - testfn (test)
    - flowfn (queue/orchestration/schedule)
    - logfn + watchfn (observability)
    - secfn (secrets)
    - filefn (artifacts)
    - plugfn (repo access + webhooks)
    - sendfn (optional notifications)
23. **Secrets**: job secrets come from secfn; must not be logged; should not be persisted in plaintext.
24. **Observability**: logs in logfn; metrics in watchfn; dashboards can surface run history and logs.
25. **Self-deployability**: CiFn control plane + runners deployable via hostfn; alternative Docker Compose/K8s acceptable; no required SaaS dependency.
26. **Hybrid usage** (optional patterns): use GitHub Actions only as trigger; CiFn runs heavy jobs; or CiFn produces artifacts consumed elsewhere.
27. **Limits/caps** (intent specifies concrete values):
    - pipeline doc size 500KB
    - jobs ≤ 100
    - steps/job ≤ 100
    - needs depth ≤ 10
    - GET /runs limit ≤ 100
    - expression length ≤ 2KB
    - artifact name length ≤ 256
    - cache key length ≤ 1KB
28. **Performance targets** (best-effort in v1):
    - parse+validate < 500ms for pipelines up to 500KB
    - dispatch-to-runner < 5s p99 when runner available
    - list runs < 2s for 1000 runs (paged)
29. **Scaling notes**: v1 fixed runner pool; no auto-scaling; queue depth bounded by flowfn.
30. **Dashboard** exists (intent): run list, run detail, logs, artifact list; auth same as API.
31. **CLI** exists (intent): `cifn run`, `cifn status`, `cifn logs`; must not leak secrets in output.
32. **Non-goals** (explicitly deferred):
    - full GitHub Actions marketplace parity
    - native Kubernetes job execution (v1)
    - built-in SaaS offering
33. **“Must not”** (security/UX): secrets must not appear in logs or dashboards; CI should be safe by default.

## Intent → Spec coverage matrix (complete; no sampling)

Mapping each intent item to where it is specified in the provided spec bundle (SPEC sections, REQUIREMENTS IDs, TEST_VECTORS).

Legend:
- **Spec status**: OK | SPEC MISSING | SPEC CONFLICT

| Intent # | Intent item (short) | Spec status | Spec references (bundle) |
|---:|---|---|---|
| 1 | Self-hosted CI/CD for superfunctions | OK | SPEC.md Overview/Goals; REQUIREMENTS.md (overall) |
| 2 | Pipeline-as-config YAML/JSON | OK | PIPE-001; TV-PIPE-001/002 |
| 3 | Config path defaults (.ci/pipeline.yml, cifn.yml) | OK | PIPE-006, CLI-004; TV-PIPE-010 |
| 4 | Triggers: push/PR/schedule/workflow_dispatch | OK | PIPE-004; TV-PIPE-007 |
| 5 | Triggers wired to plugfn/flowfn/API | PARTIAL (Spec does not fully require plugfn implementation) | PIPE-004 (semantics), INT-005 (checkout/plugfn), INT-001 (cron via flowfn); TEST_VECTORS TV-SEC-004/TV-PIPE-007 |
| 6 | Control plane API + scheduler + run history | OK | API-* + RUN-* + RUNNER-*; PLAN.md |
| 7 | Use flowfn for orchestration/schedule/retries | OK (specified), but heavy reliance on external system | INT-001; Phase 02/04/11 docs; TV-INT-001 |
| 8 | Run model: run/jobs/steps | OK | RUN-001..RUN-004; API-004 |
| 9 | DAG semantics via needs | OK | PIPE-007, RUN-002; TV-RUN-002/003 |
| 10 | Determinism | OK | RUN-002; SPEC.md Determinism section |
| 11 | Runner model: process/container | OK | RUNNER-001; PHASE_09.md |
| 12 | Default runner + Docker via image | OK | PIPE-008, RUNNER-001; (image is in schema; not a standalone requirement) |
| 13 | runs-on label dispatch | OK | PIPE-008; RUNNER-001/004; TV-RUNNER-001/005 |
| 14 | hostfn-runner + --local deploy | OK | RUNNER-006; TV-RUNNER-006 |
| 15 | Self-hosted runners register + pull model | OK | RUNNER-002/004; API-010; TV-RUNNER-002/003/005 |
| 16 | Step types list | OK | PIPE-003; TV-PIPE-005/006 |
| 17 | Checkout clones at ref | OK | RUN-007; INT-005; TV-INT-005 |
| 18 | Cache restore/save + hashFiles | OK for cache steps; hashFiles is specified but not fully test-vectorized | RUN-006; PIPE-005; TV-INT-003; (hashFiles referenced in PIPE-005 statement) |
| 19 | Artifacts via filefn | OK | RUN-005; INT-002; API-007; TV-INT-002/TV-API-014 |
| 20 | Test step via testfn | OK (specified) | RUN-008; INT-006; TV-INT-004 |
| 21 | Deploy step via hostfn CLI + secrets | OK (specified) | RUN-008; INT-006; TV-INT-006 |
| 22 | Ecosystem-native integrations (hostfn/testfn/flowfn/logfn/watchfn/secfn/filefn/plugfn/sendfn) | OK (specified) | INT-001..INT-006; OBS-*; DASH-002 |
| 23 | Secrets from secfn; not logged/persisted | OK | SEC-001, INT-003, OBS-002; TV-SEC-003/TV-PIPE-009/TV-OBS-002 |
| 24 | Observability via logfn/watchfn | OK | INT-004; OBS-001..OBS-003; TV-OBS-001..003 |
| 25 | Self-deployability via hostfn or Docker/K8s | SPEC MISSING (requirements do not enforce deployment topology) | Mentioned in bundle SPEC.md Overview/Undefined; no MUST requirements in REQUIREMENTS.md |
| 26 | Hybrid usage patterns | SPEC MISSING (not required) | Mentioned in intent; not formalized into requirements/tests |
| 27 | Concrete limits table | OK | PIPE-010; LIMIT-001; TV-LIMIT-001/002/003 |
| 28 | Performance targets | OK but best-effort | LIMIT-002; TV-LIMIT-004 (benchmark) |
| 29 | v1 fixed runner pool | OK | LIMIT-003 |
| 30 | Dashboard | OK (specified) | DASH-001; TV-DASH-001 |
| 31 | CLI | OK (specified) | CLI-001..CLI-004; TV-CLI-001..004 |
| 32 | Non-goals | OK | bundle SPEC.md Non-goals/Undefined |
| 33 | Must-not: secrets in logs/dash/cli | OK | SEC-001; OBS-002; PIPE-005; CLI-001/003; TV-SEC-003/TV-PIPE-009/TV-CLI-004 |

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)

Spec bundle: `/Users/ar/dev/superfunctions/cifn/.conduct/specs/2026-02-05-new-c8f2n1xq-spec`

- **PASS**: 23
- **PARTIAL**: 27
- **FAIL**: 6
- **UNVERIFIED**: 1

## Requirement-by-requirement results (tables + per-requirement notes)

Statuses apply to the **implementation** in `/Users/ar/dev/superfunctions/cifn` with evidence from code + tests executed during this audit run.

### Pipeline and config (PIPE-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| PIPE-001 | P0 | PASS | `schemas/pipeline.schema.json`, `control-plane/src/pipeline/parser.ts`, `validator.ts`, `pipeline.test.ts` | YAML/JSON accepted; produces typed PipelineSpec after validation. |
| PIPE-002 | P0 | PASS | `validator.ts` (Ajv), `pipeline.test.ts` | Schema validation enforced; rejects unknown top-level keys; semantic checks applied (jobs/steps/depth/cycle). |
| PIPE-003 | P0 | PASS | schema uses `enum` for `uses`; `pipeline.test.ts` TV-PIPE-005/006 | Step-type allowlist is enforced. **Gap**: `with` is not step-type-specific schema. |
| PIPE-004 | P0 | PASS | schema triggers; `pipeline.test.ts` TV-PIPE-007; `triggers/*` | All trigger types parse; webhook + cron-scheduler + workflow_dispatch exist. |
| PIPE-005 | P1 | PARTIAL | `control-plane/src/secrets/expression.ts`, `runner/src/reporting/redact.ts`, `runner/src/secrets-steps.test.ts` | Supports `${{ secrets.* }}` and `${{ github.* }}` substitution helpers + log redaction (when secret values are known). **Missing**: `hashFiles(...)`; expression evaluation wiring into pipeline runtime; `if` evaluation semantics. |
| PIPE-006 | P1 | PARTIAL | `cli/src/utils/config.ts` | CLI resolves default config paths and env override. **Missing**: server-side `pipelineRef.repo/ref/configPath` fetch. |
| PIPE-007 | P0 | PARTIAL | `validator.ts` (cycle/needs), `pipeline/dag.ts`, runner DAG tests | DAG constraints enforced; dependent job enqueued after dependency success. **Missing**: “dependency satisfied by skipped” semantics (no `if` engine → no skip propagation). |
| PIPE-008 | P0 | PASS | `runner/src/runner.ts` label matching; `control-plane/src/api/routes.ts` heartbeat dispatch | runs-on label dispatch is implemented. |
| PIPE-009 | P1 | FAIL | Grep shows no `if` evaluator; runner never reads `stepSpec.if` / `jobSpec.if` | Required skip semantics (incl. `failure()`) are not implemented. |
| PIPE-010 | P0 | PASS | parser doc-size cap; validator caps; `limits.test.ts`, `pipeline.test.ts` | Limits enforced (500KB, job/step counts, needs depth). |

### Control plane API (API-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| API-001 | P0 | PARTIAL | `control-plane/src/api/envelope.ts`, `routes.ts`, API tests | Most endpoints return `{ok,data}` / `{ok:false,error}`. **Potential mismatch**: heartbeat returns HTTP 204 with empty body (spec ambiguity). |
| API-002 | P0 | FAIL | `routes.ts` returns 422 “Pipeline fetch from repo not yet supported” when `pipelineRef` used | Spec requires `pipelineRef`-based run creation; implementation only supports inline `pipelineSpec`. |
| API-003 | P0 | PARTIAL | `routes.ts` GET /runs; `MemoryStore.listRuns` | Paging works, limit enforced. **Gap**: invalid cursor yields empty list (200) rather than 400 per test vector guidance. |
| API-004 | P0 | PASS | `routes.ts` GET /runs/:runId; `api.test.ts` | Returns run detail with job/step tree; 404 RUN_NOT_FOUND. |
| API-005 | P0 | PASS | `routes.ts` cancel; `api.test.ts` | Cancel sets status cancelled; 409 RUN_ALREADY_FINISHED. |
| API-006 | P1 | PASS | `routes.ts` logs endpoint; `runner` writes logs; tests cover TV-API-012/013 | Returns logs by job; relies on runner redaction to avoid secret leakage. |
| API-007 | P1 | PASS | `routes.ts` artifacts endpoint; `MemoryStore.getArtifacts` | Artifact list returns `{name,fileId,url?}`. |
| API-008 | P0 | PASS | `api/auth.ts`, `routes.ts` middleware application; tests | API auth enforced for `/api/v1/*` except excluded runner endpoints; tokens sourced from secfn secret `CIFN_API_KEYS`. |
| API-009 | P0 | FAIL | `envelope.ts` includes/uses `UNAUTHORIZED`; `auth.ts` returns `UNAUTHORIZED` | Spec requires only listed codes; `UNAUTHORIZED` is outside spec list (requires spec resolution). |
| API-010 | P1 | PARTIAL | `runners/register.ts`, `routes.ts` runner endpoints, `api.test.ts` | Register works; heartbeat returns job or 204. **Gap**: heartbeat auth is not runner-scoped secret (uses global registration token). |

### Runs, jobs, steps (RUN-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| RUN-001 | P0 | PASS | `MemoryStore.updateRunStatus`, `cancelRun` | Terminal-state immutability enforced (no transitions out of success/failure/cancelled). |
| RUN-002 | P0 | PARTIAL | `pipeline/dag.ts` + runner enqueueDependentJobs | Needs gating implemented for success dependencies; no support for “skipped satisfies needs” because `if` engine absent. |
| RUN-003 | P0 | PARTIAL | runner step loop preserves array order; no `if` eval | Step ordering passes; `if` skip semantics missing. |
| RUN-004 | P0 | PASS | `MemoryStore` uses UUID v4 for run/job/step ids | Uniqueness satisfied. |
| RUN-005 | P1 | PARTIAL | `MemoryFileFnClient`, artifact steps, store artifacts | Implements filefn-like semantics via in-memory client; real filefn integration unverified/missing. |
| RUN-006 | P1 | PARTIAL | cache steps using filefn-backed cache | Cache works with literal keys; expression-based keys (`hashFiles`) not implemented/evaluated. |
| RUN-007 | P0 | PARTIAL | `runner/src/steps/checkout.ts` uses `git clone`; tests clone public repo | Public checkout works; private-repo credential sourcing from secfn/plugfn not implemented. Potential secret leakage risk if token is embedded in clone URL and emitted by git errors (see Security section). |
| RUN-008 | P1 | FAIL | `runner/src/steps/testfn-run.ts` runs `npx vitest run` (not testfn SDK); hostfn deploy env injection not wired from control plane | Step implementations exist, but do not match requirement’s integration contract (testfn SDK; hostfn secrets from secfn via control plane). |

### Runners (RUNNER-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| RUNNER-001 | P0 | PASS | runner label dequeue; heartbeat dispatch; runnerType | Default and hostfn-runner selection via runs-on/labels works in the in-memory topology. |
| RUNNER-002 | P0 | FAIL | `routes.ts` heartbeat compares Bearer token to `CIFN_RUNNER_REGISTRATION_TOKEN` | Requirement demands runner-scoped secret after registration; implementation uses the registration token for heartbeat auth. |
| RUNNER-003 | P0 | PASS | runner executes only steps present in payload; tests | Runner step execution surface is constrained to declared step list. |
| RUNNER-004 | P1 | PASS | register stores labels; dispatch matches labels | Labels-based self-hosted dispatch is implemented. |
| RUNNER-005 | P0 | PARTIAL | `MemoryLogFnClient` + store updates | Implemented via in-memory log client/store; real logfn and control-plane persistence beyond memory not implemented. |
| RUNNER-006 | P1 | PARTIAL | hostfn-runner defaults to `--local` deploy; tests check command string | `--local --ci` behavior implemented; “runs on hostfn-managed node” is environmental and not verifiable here. |

### Security (SEC-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| SEC-001 | P0 | PARTIAL | runner redaction; helper expression resolver; store lacks env persistence | Secrets can be redacted when provided, but control plane does not enforce “secrets from secfn only” or systematically inject secrets at job start. |
| SEC-002 | P0 | PASS | `triggers/webhook.ts` HMAC verification; tests | Webhook signature verification enforced before run creation. |
| SEC-003 | P0 | PARTIAL | schema rejects unknown uses; `with` is unconstrained | Unknown `uses` rejected; **missing**: rejection of invalid `with` keys for known actions at parse/validation time. |
| SEC-004 | P1 | PARTIAL | secfn used for API keys, runner token, webhook secret | Uses secfn abstraction; but operational hardening (no plaintext, rotation, etc.) and job-secret injection is incomplete. |
| SEC-005 | P1 | PARTIAL | single-tenant implicit; no authz model beyond token validity | No tenant isolation model exists (single-tenant). Requirement mentions 404/403 for unauthorized run access; current model is “any valid API key can see all runs”. |

### Integrations (INT-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| INT-001 | P0 | PARTIAL | `MemoryQueueClient`; CronScheduler setInterval | Queue/scheduler are in-memory stubs; no real flowfn SDK/HTTP integration. |
| INT-002 | P0 | PARTIAL | `MemoryFileFnClient`; artifact steps | filefn semantics implemented in-memory; no real filefn integration/URLs. |
| INT-003 | P0 | PARTIAL | `MemorySecFnClient` used for API keys/tokens; expression resolver | secfn stub exists; job secret injection + enforcement is incomplete. |
| INT-004 | P0 | PARTIAL | `MemoryLogFnClient`; runner emits lines | logfn semantics implemented in-memory; control-plane does not systematically emit all required events to logfn. |
| INT-005 | P1 | PARTIAL | checkout via git; no plugfn | Git clone exists; plugfn OAuth/webhook/repo-access story is not implemented in this package. |
| INT-006 | P0 | PARTIAL | hostfn CLI executor exists; testfn uses vitest | hostfn CLI path exists; testfn SDK integration not implemented (uses vitest). |

### CLI (CLI-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| CLI-001 | P0 | PARTIAL | `cli/src/commands/run.ts`, config loader | Creates runs via API from local config; **missing**: `--local` execution mode. Secret non-printing depends on server responses. |
| CLI-002 | P0 | PASS | `cli/src/commands/status.ts` | List + detail, supports `--format json`. |
| CLI-003 | P0 | PARTIAL | `cli/src/commands/logs.ts` | Fetches logs per job or aggregates by querying run then per-job logs. **No client-side redaction**; relies on server redaction. |
| CLI-004 | P1 | PASS | `cli/src/utils/config.ts` | Config path supports `--config`, `CIFN_CONFIG`, and defaults. |

### Observability (OBS-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| OBS-001 | P0 | PARTIAL | runner emits job/step events into MemoryLogFnClient | Some required events (job/step start/complete) are logged. Missing: control-plane-side events (run created/status change, runner registered/heartbeat, API errors) to logfn. |
| OBS-002 | P0 | PARTIAL | `runner/src/reporting/redact.ts`; tests ensure env secrets redacted | Env-secret redaction is implemented; **gap**: checkout tokens in clone URL are not included in secret redaction set by default. |
| OBS-003 | P1 | PASS | optional | watchfn metrics are optional (“MAY”); not implemented here (acceptable). |

### Limits (LIMIT-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| LIMIT-001 | P0 | PASS | parser/validator caps; artifact/cache validators; API limit cap | All enumerated limits are enforced and tested. |
| LIMIT-002 | P1 | UNVERIFIED | `limits.test.ts` includes best-effort benchmark | Performance depends on environment; test does not enforce strict <500ms; dispatch + listing bounds not benchmarked under realistic load. |
| LIMIT-003 | P1 | PASS | no autoscaling implemented; docs + architecture | Fixed-runner v1 aligns with stated intent. |

### Dashboard (DASH-*)

| ID | Priority | Status | Evidence (non-exhaustive) | Notes |
|---|---:|---|---|---|
| DASH-001 | P1 | FAIL | dashboard expects `run.id`; API returns `runId` | UI pages exist, but API contract mismatch likely breaks core run list/detail flows without an adapter. |
| DASH-002 | P2 | PASS | sendfn client + callback + tests | Optional notifications are implemented and tested via MemorySendFnClient. |

## Spec conflicts / spec gaps (explicit)

### Spec conflicts

1. **API create-run shape conflict**:
   - REQUIREMENTS `API-002` mandates `pipelineRef`-based run creation.
   - PHASE_01.md explicitly allows inline `pipelineSpec` as a phase convenience.
   - Implementation supports inline `pipelineSpec` and rejects `pipelineRef` fetch.
   - **Impact**: unclear pass/fail target unless precedence is clarified; for this audit, pass/fail is judged against `REQUIREMENTS.md`, so this is a **FAIL** for API-002.

2. **Error code set conflict**:
   - REQUIREMENTS `API-009` enumerates allowed codes and does **not** include `UNAUTHORIZED`.
   - Implementation uses `UNAUTHORIZED` for auth failures.
   - **Impact**: clients/spec compliance ambiguity; requires spec update or implementation change.

3. **Schedule trigger shape drift** (intent vs spec):
   - Intent example uses GHA-like `on.schedule: - cron: ...` (array).
   - Bundle schema expects `on.schedule: { cron: string }` (object).
   - **Impact**: migration friction; needs spec clarification or schema update.

### Spec gaps (relative to authoritative intent)

1. **Self-deployability is not formalized as requirements/tests**:
   - Intent includes hostfn + Docker/K8s deployment options.
   - REQUIREMENTS.md contains no MUST requirements for deploy topology or config artifacts (e.g. hostfn config).

2. **Hybrid usage patterns are not requirements/tests**:
   - Intent includes optional hybrid trigger patterns.
   - Not specified in REQUIREMENTS.md; acceptable if truly optional.

## Cross-cutting audits (security/determinism/limits/errors/compat)

### Security / authz / validation boundaries

- **API authn**: implemented via secfn-backed API-key allowlist (`CIFN_API_KEYS`).
- **Runner authn**: **weak relative to spec**; heartbeat reuses global registration token (no runner-scoped secret).
- **Webhook verification**: HMAC SHA-256 with timing-safe compare is implemented.
- **Secrets handling**:
  - Redaction exists for known secret values in runner log capture.
  - There is no end-to-end “resolve secrets from secfn and inject only at job start” pipeline in control plane.
  - Checkout token path (`with.token`) is not automatically treated as a secret for redaction, and it is embedded into the clone URL; potential leakage if git emits URL/token in stderr.
- **Code execution**:
  - `run` steps execute arbitrary shell commands as expected for CI; this is inherently high-risk and should be bounded by workspace isolation + runner authentication + least privilege.
  - No explicit sandboxing beyond optional Docker execution; no explicit command allowlist for `run` steps (intent expects `run` to exist; “no arbitrary code beyond declared step types” applies more to remote control-plane-to-runner interface).

### Determinism invariants

- **DAG order**: deterministic for a given object key order; tests cover ordering constraints.
- **Step order**: deterministic (array iteration).
- **IDs**: UUIDs are intentionally non-deterministic but satisfy uniqueness.
- **Missing**: determinism for expression evaluation and conditional `if` (not implemented).

### Limits / caps

- Limits in intent/spec are enforced: doc size, job/step counts, depth, API paging, expression length (in resolver), artifact name length, cache key length.

### Error handling + canonical envelopes

- Canonical `{ok,data}` / `{ok:false,error}` is used broadly.
- **Spec deviation**: `UNAUTHORIZED` code not in spec; heartbeat uses 204 without JSON body (spec ambiguity).

### Compatibility / versioning / migrations

- API versioning is in the path (`/api/v1`).
- No explicit pipeline schema versioning field is enforced; schema is implicitly v1.
- CLI and dashboard are versioned independently; no explicit compatibility checks between CLI/dashboard and API response shapes (dashboard mismatch suggests this is needed).

## Recommendations (ranked)

1. **Implement `pipelineRef` fetch + configPath resolution (API-002)**: this is the largest functional gap vs both intent and spec; without it, webhooks and real CI usage are constrained to inline specs and test harnesses.
2. **Implement `if` semantics + expression evaluation (PIPE-005, PIPE-009, RUN-003)**: add an expression evaluator supporting at least:
   - `github.ref` equality
   - `failure()` (based on prior step results)
   - `secrets.*` resolution + redaction
   - `hashFiles(...)` (or explicitly de-scope it in spec)
3. **Fix runner auth to be runner-scoped (RUNNER-002, API-010)**: issue a per-runner secret at registration and require it for heartbeat/job polling.
4. **Resolve API error code set (API-009)**: either add `UNAUTHORIZED` to spec codes or change implementation to use `BAD_REQUEST`/`RUNNER_TOKEN_INVALID`/etc. consistently.
5. **Make dashboard compatible with API response shapes (DASH-001)**: align `Run` model (`id` vs `runId`) or add mapping in API client layer.
6. **Harden secret redaction for checkout tokens**: treat `with.token` as secret material; never log clone URLs with embedded tokens; ensure stderr is redacted.
7. **Clarify schedule trigger schema (array vs object)**: update schema + tests or update intent docs to match.
8. **Decide on “real superfunctions integrations” vs in-memory stubs**: for flowfn/filefn/secfn/logfn/testfn/plugfn, either:
   - implement real clients, or
   - explicitly define in REQUIREMENTS.md that in-memory adapters are acceptable for v1/dev and mark production integration as future work.

## Appendix: commands run + environment details

### Commands run

1. `date -u "+%Y-%m-%dT%H:%M:%SZ"`
2. `npm -w cifn/typescript/control-plane test && npm -w cifn/typescript/runner test && npm -w cifn/typescript/cli test && npm -w cifn/typescript/dashboard test`
3. `git rev-parse --is-inside-work-tree && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD && git status --porcelain`

### Test results (as executed during audit)

- control-plane: 111 tests passed
- runner: 62 tests passed
- cli: 8 tests passed
- dashboard: 6 tests passed

