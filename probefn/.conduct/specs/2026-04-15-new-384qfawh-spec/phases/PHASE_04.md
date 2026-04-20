# Phase goal

Implement deterministic page modeling, selector-first action execution, and atomic checkpoint creation.

# In scope / Out of scope

- In scope: page model extraction, deterministic actions, checkpoint creation, delta summaries.
- Out of scope: semantic disambiguation with vision, design analyzers, baselines.

# Deliverables

- `packages/browser-runner/src/page-model.ts`
- `packages/browser-runner/src/actions.ts`
- `packages/core/src/checkpoints.ts`
- `packages/core/src/deltas.ts`
- `packages/core/test/checkpoints.test.ts`
- `packages/browser-runner/test/actions.test.ts`

# Requirements covered

- `NAV-001`
- `SNAP-001`
- `EVENT-002`

# Implementation tasks

1. Build a normalized page model with element IDs, roles, names, visibility, and bounds.
2. Implement selector-first click, fill, select, hover, and key-press actions.
3. Implement atomic checkpoint capture for screenshot, DOM, accessibility, and layout artifacts.
4. Compute post-action delta summaries for new console, page, and network errors.
5. Add integration tests for successful deterministic actions and failed target-not-found/interactable cases.

# Verification steps

1. Run `pnpm --filter @probefn/browser-runner test -- --runInBand`.
   Expected outcome: action and checkpoint tests pass.
2. Run `pnpm --filter @probefn/core test`.
   Expected outcome: checkpoint atomicity and delta-summary tests pass.
3. Run `pnpm probefn checkpoint create --session sess_healthy --name landing --include-trace --json`.
   Expected outcome: returned checkpoint JSON lists the required artifacts.

# Stop condition

Report one successful deterministic action result, one target-not-found error result, and one committed checkpoint manifest before starting Phase 05.
