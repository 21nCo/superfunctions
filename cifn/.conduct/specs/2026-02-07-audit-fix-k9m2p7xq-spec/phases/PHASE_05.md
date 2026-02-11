# Phase 05 — Secrets injection (secfn) + end-to-end redaction hardening

## Phase goal (1 sentence)

Implement end-to-end secret resolution/injection from secfn and guarantee that secret values (including checkout tokens) never appear in logs or API responses.

## In scope

- Resolve `${{ secrets.* }}` references via secfn adapter.
- Inject resolved secrets into runner environment and/or step `with` fields at execution time.
- Ensure control plane never persists plaintext secret values in store records.
- Harden runner redaction:
  - job secrets
  - checkout tokens
  - hostfn secrets
- Ensure logs endpoint returns redacted output.

## Out of scope

- Real flowfn/filefn/logfn production adapters (Phase 06).
- testfn SDK migration (Phase 07).

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/typescript/control-plane/src/secrets/secfn-client.ts`
  - `cifn/typescript/control-plane/src/api/routes.ts` (job payload creation)
  - `cifn/typescript/control-plane/src/store/memory-store.ts` (store secret names only)
  - `cifn/typescript/runner/src/reporting/redact.ts`
  - `cifn/typescript/runner/src/steps/checkout.ts`
  - `cifn/typescript/runner/src/secrets-steps.test.ts`
  - `cifn/typescript/control-plane/src/api/api.test.ts`
  - `cifn/typescript/control-plane/src/triggers/webhook.ts` (ensure token treated as secret if present)

## Requirements covered

- SEC-001
- SEC-006
- INT-003
- RUN-007
- RUNNER-005
- OBS-003

## Implementation tasks (ordered checklist)

- [ ] Implement secret discovery:
  - [ ] Scan pipelineSpec for `${{ secrets.NAME }}` usage in env/with/run strings and `if`.
  - [ ] Build a set of secret names required for the job (and optionally per-step granularity).
- [ ] Implement secret resolution:
  - [ ] Fetch secret values from secfn adapter at job start.
  - [ ] Ensure resolution failures are deterministic and do not leak secret values.
- [ ] Implement injection rules:
  - [ ] Secrets referenced in job env become actual env vars for the runner.
  - [ ] Secrets referenced in `with` are resolved before step execution (but never persisted).
  - [ ] Control plane persists only secret **names** or handles; never values.
- [ ] Harden checkout:
  - [ ] Avoid embedding token in clone URL where possible (use git credential helper/env).
  - [ ] Ensure any token that could reach git output is included in redaction set.
- [ ] Harden redaction:
  - [ ] Ensure redaction runs on stdout and stderr before log storage.
  - [ ] Ensure redaction runs on any control-plane side logs that might include secrets.
- [ ] Extend tests:
  - [ ] TV-SEC-001 (secret never appears in logs)
  - [ ] TV-RUN-007 / TV-OBS-003 (checkout token redacted)
  - [ ] TV-SEC-004 (no plaintext secrets in run detail)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
  - `npm -w cifn/typescript/runner test`
- Expected:
  - All tests pass.
  - No secret strings appear anywhere in test outputs (search should be unnecessary if tests are explicit).

## Stop condition (what to report back before starting the next phase)

Report:

- The exact rules for when secrets are resolved (control plane vs runner) and how they are transmitted.
- Evidence that both control-plane and runner tests are green and that secret-redaction vectors pass.

