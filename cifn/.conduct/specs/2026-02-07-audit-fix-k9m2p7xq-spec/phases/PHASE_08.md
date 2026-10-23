# Phase 08 — `hostfn/deploy` step correctness (flags + env + hostfn-runner local)

## Phase goal (1 sentence)

Ensure `hostfn/deploy` executes with correct flags and secrets injection, including `--local --ci` semantics on hostfn-runner.

## In scope

- Ensure `hostfn/deploy` step:
  - always uses `--ci`
  - uses `--local` when job runs-on is `hostfn-runner`
  - receives required secrets via env (secfn injection rules)
- Add tests that lock the command invocation and redact any secret material.

## Out of scope

- hostfn implementation details (SSH, remote provisioning) are owned by hostfn.
- Autoscaling runners.

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/typescript/runner/src/steps/hostfn-deploy.ts`
  - `cifn/typescript/runner/src/runner.ts` (if it needs to pass runner/job context)
  - `cifn/typescript/runner/src/runner.test.ts`

## Requirements covered

- INT-007
- RUNNER-004
- RUN-008 (hostfn portion)

## Implementation tasks (ordered checklist)

- [ ] Update `hostfn-deploy.ts`:
  - [ ] Build commandline deterministically from `with.environment`, `with.ci`, job runs-on context.
  - [ ] Ensure `--ci` is present even if `with.ci` omitted (default true for CI execution).
  - [ ] Ensure `--local` is present iff runs-on is `hostfn-runner`.
- [ ] Ensure secrets are injected via env without logging.
- [ ] Extend tests:
  - [ ] TV-INT-007 (hostfn flags)
  - [ ] TV-RUNNER-002 (hostfn-runner local deploy)
  - [ ] TV-SEC-001 (no secret leakage)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/runner test`
- Expected:
  - All tests pass.
  - hostfn deploy command matches spec for both default runner and hostfn-runner.

## Stop condition (what to report back before starting the next phase)

Report:

- The exact hostfn commandline templates used for each runner type.
- Evidence that runner tests are green.

