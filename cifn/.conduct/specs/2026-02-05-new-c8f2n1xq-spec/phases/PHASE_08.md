# Phase 08: CLI

## Phase goal
Implement CLI commands: cifn run, cifn status, cifn logs; config path via env or flag; no secret output.

## In scope
- CLI package: cifn (or cifn-cli); commands run, status, logs.
- cifn run [--config path] [--trigger type]: read pipeline from path (default .ci/pipeline.yml or cifn.yml or CIFN_CONFIG); validate; POST /api/v1/runs with pipelineRef or inline spec and trigger workflow_dispatch; print runId; exit 0 on success. Option --local: run pipeline locally without API (optional for phase).
- cifn status [runId]: if no runId, GET /api/v1/runs and print list; if runId, GET /api/v1/runs/:runId and print detail. --format json outputs JSON.
- cifn logs <runId> [jobKey]: GET /api/v1/runs/:runId/jobs/:jobKey/logs (or /runs/:runId/logs if jobKey omitted for all jobs); print log content; redact secrets.
- Config path: --config or env CIFN_CONFIG; default .ci/pipeline.yml then cifn.yml.
- All output MUST NOT include secret values; log stream redacted.

## Out of scope
- Local execution without API (--local); Python SDK.

## Deliverables
- `cifn/typescript/cli/` or `cifn/cli/` package: src/index.ts, commands/run.ts, status.ts, logs.ts.
- Read config from file; validate with pipeline validator; call control plane API with auth (env CIFN_API_URL, CIFN_API_KEY or CIFN_TOKEN).
- Tests: TV-CLI-001, TV-CLI-002, TV-CLI-003, TV-CLI-004, TV-PIPE-010.

## Requirements covered
- CLI-001, CLI-002, CLI-003, CLI-004.

## Implementation tasks
1. Create CLI package; add dependencies (yargs or commander, node-fetch or axios, js-yaml).
2. run command: parse --config, --trigger; load file; validate pipeline; POST /runs with body { trigger: { type: 'workflow_dispatch' }, pipelineSpec or pipelineRef }; print runId from response; exit 0 or 1.
3. status command: if no runId, GET /runs?limit=20 and print table or list; if runId, GET /runs/:runId and print jobs/steps; --format json prints JSON.
4. logs command: GET /runs/:runId/jobs/:jobKey/logs (or aggregate if no jobKey); print lines; ensure no secret in output (redact or server already redacted).
5. Config path: resolve from CIFN_CONFIG or --config; fallback .ci/pipeline.yml, cifn.yml; fail with clear error if file missing.
6. Tests: mock API or integration with control plane; TV-CLI-001 to TV-CLI-004.

## Verification steps
- cifn run (with valid pipeline and API) → exit 0, runId printed. TV-CLI-001.
- cifn run with invalid pipeline → exit non-zero, no runId. TV-CLI-002.
- cifn status → list of runs; cifn status <runId> → run detail; cifn status --format json → valid JSON. TV-CLI-003.
- cifn logs <runId> → log output; run that had secret in env → secret not in output. TV-CLI-004.
- CIFN_CONFIG=/other/cifn.yml cifn run → loads from other path. TV-PIPE-010.
- Run tests: `npm test` in CLI package.

## Stop condition
- CLI run, status, logs work against control plane; config path configurable; no secret in output. Report: "Phase 08 complete; CLI ready for Phase 09 (Docker runner, hostfn-runner)."
