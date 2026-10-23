# CiFn Audit-Fix Plan

This plan delivers full compliance with the audit-fix spec (`SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`) by incrementally implementing verifiable slices.

## Architecture sketch

### Packages (existing)

- `cifn/schemas/pipeline.schema.json`
- `cifn/typescript/control-plane/`:
  - `src/api/{routes.ts,auth.ts,envelope.ts}`: HTTP API, auth, envelopes
  - `src/pipeline/{parser.ts,validator.ts,dag.ts,types.ts}`: parse/validate/normalize pipeline and DAG
  - `src/secrets/expression.ts`: current placeholder expression/secret resolver (to be replaced/expanded)
- `cifn/typescript/runner/`:
  - `src/runner.ts`: job execution loop + status/log reporting
  - `src/steps/*`: checkout/cache/artifact/testfn/hostfn step implementations
  - `src/reporting/*`: log client + redaction
- `cifn/typescript/cli/`:
  - `src/commands/{run.ts,status.ts,logs.ts}` + `src/utils/*`
- `cifn/typescript/dashboard/`:
  - `src/api.ts` + pages for run list/detail/logs/artifacts

### New modules (to add)

- `control-plane/src/pipeline/resolver.ts`: resolves `pipelineRef` (repo/ref/configPath) → pipeline document string
- `control-plane/src/expressions/*`: expression parse/eval + interpolation + hashFiles
- `control-plane/src/integrations/*`: adapter interfaces + memory + real adapters for flowfn/filefn/secfn/logfn/plugfn (as needed)

## Dependency graph

1. **Contract fixes** (API envelope + dashboard model) unblock all client verification.
2. **Pipeline schema + normalization** (schedule + with shapes + caps) must exist before correct pipelineRef execution.
3. **pipelineRef resolver** must exist before webhook-realistic run creation can be correct.
4. **Expression + if semantics** must exist before correct runtime behavior and skip propagation.
5. **Runner-scoped auth** must exist before secure multi-runner operation.
6. **Secret injection + redaction hardening** must exist before compliance with “must not leak secrets”.
7. **Real integrations (flowfn/filefn/secfn/logfn)** must exist before intent-complete ecosystem-native behavior.
8. **Step correctness** (testfn/hostfn) and **CLI local mode** finalize user-facing flows.
9. **Self-deploy artifacts** ship the operational intent.

## Phases overview

No phase is complete unless its verification steps pass locally.

| Phase | Goal | Delivered capability | Verification |
|---:|---|---|---|
| 00 | Contract alignment | JSON envelope everywhere; error codes set; dashboard uses `runId`; heartbeat returns `{job:null}` | control-plane + dashboard tests; TV-API-006/007, TV-RUNNER-006, TV-DASH-001 |
| 01 | pipelineRef run creation | `POST /runs` supports `pipelineRef` + default configPath search | control-plane tests; TV-API-001..005 |
| 02 | Schema + normalization | schedule array/object normalization; step `with` shapes enforced; caps enforced | pipeline tests; TV-PIPE-010..016, TV-LIMIT-001..003 |
| 03 | Expressions + `if` runtime | deterministic eval + `${{ }}` + `hashFiles`; job+step `if`; continue-after-failure semantics | runner + control-plane tests; TV-EXPR-001..008 |
| 04 | Runner-scoped auth | registration returns runnerSecret; heartbeat auth uses runnerSecret; hashed storage | control-plane tests; TV-RUNNER-003..005 |
| 05 | Secrets injection + redaction | secfn resolves secrets.*; no plaintext persistence; redaction covers checkout tokens | runner + API tests; TV-SEC-001..006, TV-OBS-003 |
| 06 | Real integrations | configurable adapters: flowfn queue, filefn artifacts, secfn, logfn events | integration/unit tests; TV-INT-001..004 |
| 07 | testfn/run correctness | runner step uses testfn SDK and produces JSON report artifact | runner tests; TV-INT-006 |
| 08 | hostfn/deploy correctness | hostfn flags/env injection aligned; hostfn-runner `--local --ci` | runner tests; TV-INT-007, TV-RUNNER-002 |
| 09 | CLI completeness | `--local` mode; URL/credentials config; safe logs | cli tests; TV-CLI-001..006 |
| 10 | Self-deploy artifacts | docker compose + hostfn deployment option + docs | manual smoke; TV-DEPLOY-001..003N |

## Definition of Done (global)

- All P0 requirements are implemented and verified by their referenced test vectors.
- P1/P2 requirements are implemented unless they are explicitly `MAY` (OBS-002, DASH-002).
- All workspace test suites pass:
  - `npm -w cifn/typescript/control-plane test`
  - `npm -w cifn/typescript/runner test`
  - `npm -w cifn/typescript/cli test`
  - `npm -w cifn/typescript/dashboard test`
- No secrets appear in any test logs or API responses when running the vectors.

