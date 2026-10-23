# Phase 07 — `testfn/run` step implemented via testfn SDK

## Phase goal (1 sentence)

Replace the current ad-hoc `npx vitest` test step with a `testfn/run` step that uses the testfn SDK and produces deterministic JSON report output.

## In scope

- Update runner `testfn/run` step to use `@testfn/core` (or the canonical testfn package) APIs.
- Support at least:
  - `framework: vitest`
  - `testPattern`
  - JSON reporter output to a configurable `outputPath`
- Ensure test step failure updates step/job status correctly.
- Optionally upload the JSON report via `artifact/upload` in the same job (pipeline-defined).

## Out of scope

- Playwright/Jest support beyond what testfn already provides (optional).
- Persisting test analytics to a separate service (Undefined).

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/typescript/runner/src/steps/testfn-run.ts`
  - `cifn/typescript/runner/package.json` (add dependency on testfn SDK package)
  - `cifn/typescript/runner/src/runner.test.ts`
  - `cifn/typescript/runner/src/artifacts-cache.test.ts` (if used for report upload)

## Requirements covered

- INT-006
- RUN-008

## Implementation tasks (ordered checklist)

- [ ] Add dependency on the testfn SDK package (`@testfn/core` as currently published in-repo).
- [ ] Implement `testfn/run` step:
  - [ ] Map `with` fields to `TestFnConfig` (framework, testPattern, parallel, timeout, retries, env).
  - [ ] Configure JSON reporter output at `outputPath` deterministically.
  - [ ] Run tests and capture results summary.
  - [ ] Mark step status success/failure based on results.
- [ ] Add/extend tests to cover:
  - [ ] TV-INT-006 positive case (JSON report written)
  - [ ] Invalid framework negative case (fails deterministically)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/runner test`
- Expected:
  - All tests pass.
  - `testfn/run` step uses SDK codepath and produces JSON report.

## Stop condition (what to report back before starting the next phase)

Report:

- The final mapping from pipeline `with` → `TestFnConfig`.
- Evidence (test output summary) that runner tests are green and include the new vectors.

