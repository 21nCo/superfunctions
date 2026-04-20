# Phase goal

Implement deterministic baseline recording and hybrid visual regression comparison.

# In scope / Out of scope

- In scope: baseline registry, baseline keys, pixel diffing, semantic/layout diffing, severity classification.
- Out of scope: report rendering polish, MCP tool server, fixture-suite documentation.

# Deliverables

- `packages/visual-baselines/package.json`
- `packages/visual-baselines/src/index.ts`
- `packages/visual-baselines/src/baseline-registry.ts`
- `packages/visual-baselines/src/baseline-key.ts`
- `packages/visual-baselines/src/pixel-diff.ts`
- `packages/visual-baselines/src/semantic-diff.ts`
- `packages/visual-baselines/test/baseline-registry.test.ts`
- `packages/visual-baselines/test/compare.test.ts`
- `test/fixtures/vite-regression/`

# Requirements covered

- `BASELINE-001`
- `BASELINE-002`
- `DETERMINISM-001`

# Implementation tasks

1. Implement baseline-key generation from route, viewport tag, browser engine, color scheme, and deterministic settings.
2. Implement baseline registry persistence and update policy.
3. Implement pixel diff generation and semantic/layout diff generation.
4. Emit structured regression findings with severity and evidence references.
5. Add baseline record/compare tests for pass, fail, missing baseline, and mismatched dimensions.

# Verification steps

1. Run `pnpm --filter @probefn/visual-baselines test`.
   Expected outcome: baseline record/compare tests pass.
2. Run `pnpm probefn baseline record --session sess_healthy --checkpoint chk_landing --key home.desktop.chromium.light.1440x900.utc --json`.
   Expected outcome: baseline registry entry is created.
3. Run `pnpm probefn baseline compare --session sess_regression --checkpoint chk_mobile --key home.mobile.chromium.light.390x844.utc --json`.
   Expected outcome: a failing comparison returns a critical missing-element regression finding.

# Stop condition

Report one passing baseline comparison, one failing regression summary, and the exact baseline-key format before starting Phase 08.
