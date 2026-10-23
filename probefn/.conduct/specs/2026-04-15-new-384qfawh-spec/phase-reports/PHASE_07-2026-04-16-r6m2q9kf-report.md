# Phase Completion Report

- Timestamp: `2026-04-16T03:24:50Z`
- Agent: `codex`
- Model: `gpt-5`
- Launcher: `Codex Desktop`
- Repo root: `.`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git branch: `main`
- Git commit: `unborn HEAD`
- Git dirty status: `yes`

## Phase

- `PHASE_07`
- Status: `PASS`

## Requirements Summary

### `BASELINE-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Deterministic baseline-key generation and parsing are implemented in `packages/visual-baselines/src/baseline-key.ts`, covering route identity, viewport tag, browser engine, color scheme, dimensions, and timezone tag, with the documented exact format `home.desktop.chromium.light.1440x900.utc`.
  - Baseline registry persistence and deterministic replacement policy are implemented in `packages/visual-baselines/src/baseline-registry.ts`; entries persist source session/run/checkpoint links, copied checkpoint evidence, effective deterministic settings, and `replacementPolicy: "replace"`.
  - `packages/visual-baselines/test/baseline-registry.test.ts` proves:
    - recording a baseline writes `.artifacts/baselines/registry.json` with a source checkpoint link,
    - mismatched key dimensions are treated as distinct records with warning `Baseline key dimensions differ from checkpoint viewport; a distinct baseline entry was recorded.`,
    - re-recording the same key deterministically replaces the earlier entry.
  - `pnpm probefn baseline record --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json` returned the expected success envelope with:
    - `baselineKey: "home.desktop.chromium.light.1440x900.utc"`
    - `registryPath: ".artifacts/baselines/registry.json"`
    - `sourceCheckpointId: "chk_landing"`
- Test status:
  - `pnpm --filter @probefn/visual-baselines test` passed.
  - `packages/visual-baselines/test/baseline-registry.test.ts` passed both tests.

### `BASELINE-002`

- Status: `PASS`
- Acceptance criteria evidence:
  - Hybrid comparison is implemented across:
    - `packages/visual-baselines/src/pixel-diff.ts` for PNG pixel diff generation,
    - `packages/visual-baselines/src/semantic-diff.ts` for missing-element, moved-element, and layout-change findings with severity classification,
    - `packages/visual-baselines/src/index.ts` for combined comparison, diff artifact writing, and machine-readable regression summaries.
  - `packages/visual-baselines/test/compare.test.ts` proves:
    - matching baseline comparison returns `status: "pass"` with `pixelDiffPercent: 0` and `findings: []`,
    - broken mobile regression returns `status: "fail"` with critical `rf_missing_cta`,
    - missing baselines return `E_BASELINE_NOT_FOUND`,
    - dimension mismatches return `E_BASELINE_MISMATCH`.
  - `pnpm probefn baseline compare --session sess_regression --checkpoint chk_mobile --key home.mobile.chromium.light.390x844.utc --json` returned the required failing regression summary, including:
    - `status: "fail"`
    - `pixelDiffPercent: 19.2`
    - `findingId: "rf_missing_cta"`
    - `severity: "critical"`
    - `summary: "Primary CTA is absent in the current checkpoint but present in the baseline."`
  - The comparison wrote a run-scoped diff artifact under `.artifacts/runs/run_regression/diffs/home.mobile.chromium.light.390x844.utc/`, satisfying the diff-artifact output requirement.
- Test status:
  - `pnpm --filter @probefn/visual-baselines test` passed.
  - `packages/visual-baselines/test/compare.test.ts` passed all 4 tests.

### `DETERMINISM-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Effective deterministic settings are persisted into baseline entries in `packages/visual-baselines/src/baseline-registry.ts`, so baseline operations stamp the fixed environment that produced the checkpoint evidence.
  - `packages/visual-baselines/src/index.ts` implements `buildDeterministicBaselineKey(...)`, deriving the baseline key from route identity, inferred viewport tag, browser, color scheme, viewport dimensions, and timezone, which ensures deterministic viewport changes alter the key dimensions.
  - `packages/visual-baselines/test/baseline-registry.test.ts` asserts the stored registry entry includes the deterministic viewport, and `packages/visual-baselines/test/compare.test.ts` seeds both desktop and mobile sessions using fixed deterministic settings (`viewport`, `locale`, `timezone`, `colorScheme`, `reducedMotion`, `animationPolicy`, `networkIdleMs`) before checkpoint capture.
  - The healthy and regression smoke comparisons both ran against sessions captured under deterministic settings and produced stable, reproducible outputs for the same keys.
- Test status:
  - `pnpm --filter @probefn/visual-baselines test` passed.
  - The deterministic baseline-key format and deterministic entry stamping were covered by the baseline registry and comparison fixture suite.

## Deliverables Summary

- Files changed/added:
  - `packages/visual-baselines/package.json`
  - `packages/visual-baselines/tsconfig.json`
  - `packages/visual-baselines/src/index.ts`
  - `packages/visual-baselines/src/baseline-registry.ts`
  - `packages/visual-baselines/src/baseline-key.ts`
  - `packages/visual-baselines/src/pixel-diff.ts`
  - `packages/visual-baselines/src/semantic-diff.ts`
  - `packages/visual-baselines/src/pngjs.d.ts`
  - `packages/visual-baselines/test/baseline-registry.test.ts`
  - `packages/visual-baselines/test/compare.test.ts`
  - `packages/dev-server/src/cli.ts`
  - `packages/dev-server/package.json`
  - `test/fixtures/vite-regression/server.mjs`
  - `pnpm-lock.yaml`
- Files deleted/modified:
  - None deleted.

## Verification Summary

- Phase verification steps executed:
  - `pnpm --filter @probefn/visual-baselines test` -> `PASS`
  - `pnpm probefn baseline record --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json` -> `PASS`
  - `pnpm probefn baseline compare --session sess_regression --checkpoint chk_mobile --key home.mobile.chromium.light.390x844.utc --json` -> `PASS`
- Additional verification executed:
  - `pnpm install` -> `PASS`
  - `pnpm --filter @probefn/visual-baselines typecheck` -> `PASS`
  - `pnpm --filter @probefn/dev-server typecheck` -> `PASS`
  - `pnpm probefn baseline compare --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json` -> `PASS`
  - `rg -n "TODO|FIXME" packages/visual-baselines packages/dev-server/src/cli.ts test/fixtures/vite-regression pnpm-lock.yaml` -> `PASS` (no matches)
- Test execution results:
  - `@probefn/visual-baselines`: 2 files passed, 6 tests passed, 0 failed.
  - Healthy comparison smoke command returned `ok: true`, `status: "pass"`, `pixelDiffPercent: 0`, and `findings: []`.
  - Regression comparison smoke command returned `ok: true`, `status: "fail"`, and the required critical `rf_missing_cta` regression finding.
  - Verification was executed under local Node `v20.20.0`, which emitted workspace engine warnings (`>=22.0.0`) but did not block successful test or CLI execution.

## Stop Condition Evidence

### Passing baseline comparison

- `pnpm probefn baseline compare --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json` returned:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "baselineKey": "home.desktop.chromium.light.1440x900.utc",
      "status": "pass",
      "pixelDiffPercent": 0,
      "findings": []
    },
    "warnings": []
  }
  ```

### Failing regression summary

- `pnpm probefn baseline compare --session sess_regression --checkpoint chk_mobile --key home.mobile.chromium.light.390x844.utc --json` returned:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "baselineKey": "home.mobile.chromium.light.390x844.utc",
      "status": "fail",
      "pixelDiffPercent": 19.2,
      "findings": [
        {
          "findingId": "rf_missing_cta",
          "severity": "critical",
          "category": "missing-element",
          "summary": "Primary CTA is absent in the current checkpoint but present in the baseline."
        }
      ]
    },
    "warnings": []
  }
  ```

### Exact baseline-key format

- Implemented and verified format:
  - `<routeIdentity>.<viewportTag>.<browser>.<colorScheme>.<width>x<height>.<timezoneTag>`
- Exact passing example:
  - `home.desktop.chromium.light.1440x900.utc`
- Exact failing regression example:
  - `home.mobile.chromium.light.390x844.utc`

## Notes

- Diff artifacts are now written under the active run root (`.artifacts/runs/<runId>/diffs/...`) so comparison output remains run-scoped and repository-relative.
- The baseline registry stores copied checkpoint evidence bundles under `.artifacts/baselines/entries/<baselineKey>/` and rewrites the registry deterministically in lexical key order.
- The regression fixture intentionally removes the primary CTA in the broken variant to exercise both semantic missing-element detection and a meaningful screenshot diff.
- A local `pngjs` declaration was added under `packages/visual-baselines/src/pngjs.d.ts` so the package typechecks cleanly in the current workspace without widening scope into unrelated repo typing changes.
- No new TODO or FIXME markers were introduced.

## Ready For Next Phase?

- Yes. `PHASE_07` baseline recording/comparison behavior, deterministic key stamping, CLI verification, and stop-condition evidence are complete, so the work can move to `PHASE_08`.

## Blockers

- None.
