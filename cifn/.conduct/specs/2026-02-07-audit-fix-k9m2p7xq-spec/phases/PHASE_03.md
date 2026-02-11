# Phase 03 — Deterministic expressions + `if` runtime semantics (+ continue-after-failure)

## Phase goal (1 sentence)

Implement the v1 expression engine (`if` + `${{ }}` + `hashFiles`) and wire it into runner execution semantics (default `success()`, `failure()`/`always()` support, and continue-after-failure behavior).

## In scope

- Deterministic expression parsing/evaluation:
  - operators: `==`, `!=`, `&&`, `||`, `!`, parentheses
  - symbols: `github.*`, `secrets.*`
  - functions: `success()`, `failure()`, `always()`
- `${{ ... }}` interpolation for:
  - `run` command strings
  - env values
  - step `with` values
  - cache keys
- `hashFiles('<glob>')` implementation (deterministic hashing)
- Runner step-loop semantics:
  - default step condition = `success()`
  - step failure does NOT hard-stop the job; later steps can run if `if` evaluates true

## Out of scope

- Runner-scoped auth (Phase 04).
- Full GitHub Actions expression parity (out of scope by spec).

## Deliverables (explicit list of files/modules)

- Create:
  - `cifn/typescript/control-plane/src/expressions/eval.ts`
  - `cifn/typescript/control-plane/src/expressions/interpolate.ts`
  - `cifn/typescript/control-plane/src/expressions/hash-files.ts`
  - `cifn/typescript/control-plane/src/expressions/types.ts`
- Modify:
  - `cifn/typescript/control-plane/src/secrets/expression.ts` (either remove or make it a thin wrapper)
  - `cifn/typescript/runner/src/runner.ts`
  - `cifn/typescript/runner/src/executor/run-step.ts`
  - `cifn/typescript/runner/src/steps/cache-restore.ts`
  - `cifn/typescript/runner/src/steps/cache-save.ts`
  - `cifn/typescript/runner/src/runner.test.ts`
  - `cifn/typescript/runner/src/secrets-steps.test.ts`

## Requirements covered

- PIPE-009
- PIPE-010
- RUN-004
- RUN-009
- RUN-006 (hashFiles in cache keys)

## Implementation tasks (ordered checklist)

- [ ] Implement expression types + evaluation:
  - [ ] Strict length cap 2048 (reject with PIPELINE_INVALID at validation time where possible).
  - [ ] Deterministic parsing (no Date.now / randomness).
  - [ ] Evaluation context includes:
    - [ ] github.ref/repository/sha/event_name
    - [ ] secrets.NAME (value provided by secfn; treated as secret)
    - [ ] prior step outcomes for `success()/failure()`
- [ ] Implement `hashFiles(pattern)`:
  - [ ] resolve globs relative to workspace root
  - [ ] deterministic sort of matched files before hashing
  - [ ] hash of empty string when no matches
- [ ] Implement `${{ }}` interpolation:
  - [ ] single-pass interpolation with clear error on unsupported expression
  - [ ] ensure interpolated values are strings
- [ ] Update runner step loop:
  - [ ] Evaluate job.if at job start; false → job skipped.
  - [ ] For each step, compute effective if (default `success()`), evaluate, run or skip.
  - [ ] On step failure:
    - [ ] mark job as “failed so far”
    - [ ] continue to subsequent steps so failure()/always() can run
    - [ ] preserve step indices and statuses deterministically
- [ ] Extend tests:
  - [ ] TV-EXPR-001 (failure() step runs after failure; default step skipped)
  - [ ] TV-EXPR-002 (job if false -> skipped; needs satisfied)
  - [ ] TV-EXPR-006 (unsupported operator rejected)
  - [ ] TV-EXPR-007 (hashFiles determinism)
  - [ ] TV-EXPR-008 (length cap)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
  - `npm -w cifn/typescript/runner test`
- Expected:
  - All tests pass.
  - Evidence that runner no longer hard-stops on first failure, while still producing correct final job status.

## Stop condition (what to report back before starting the next phase)

Report:

- Supported expression grammar and any intentionally unsupported constructs.
- A short trace (from test logs) showing failure() step execution after a failing step.
- Evidence that both control-plane and runner test suites are green.

