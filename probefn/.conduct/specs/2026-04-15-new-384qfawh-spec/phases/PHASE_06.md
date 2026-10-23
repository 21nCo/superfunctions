# Phase goal

Implement structured design-audit analyzers for layout, spacing, responsive behavior, token drift, focus states, and touch targets.

# In scope / Out of scope

- In scope: design findings, severity rules, token map support, unstable finding markers from checkpoint metadata.
- Out of scope: baseline persistence and comparison, auth persistence.

# Deliverables

- `packages/analyzers/package.json`
- `packages/analyzers/src/index.ts`
- `packages/analyzers/src/design/overflow.ts`
- `packages/analyzers/src/design/clipping.ts`
- `packages/analyzers/src/design/spacing.ts`
- `packages/analyzers/src/design/alignment.ts`
- `packages/analyzers/src/design/responsive.ts`
- `packages/analyzers/src/design/token-drift.ts`
- `packages/analyzers/src/design/focus.ts`
- `packages/analyzers/src/design/touch-targets.ts`
- `packages/analyzers/test/design.test.ts`
- `test/fixtures/vite-overflow/`
- `test/fixtures/vite-token-drift/`

# Requirements covered

- `DESIGN-001`
- `DESIGN-002`
- `DETERMINISM-002`

# Implementation tasks

1. Implement layout analyzers for overflow, clipping, overlap, spacing, alignment, and responsive wrapping.
2. Implement token-drift, focus-state, touch-target, and contrast-metadata checks.
3. Thread checkpoint instability metadata into analyzer outputs.
4. Define severity thresholds and structured finding outputs.
5. Add fixture tests for healthy, overflow, and token-drift pages.

# Verification steps

1. Run `pnpm --filter @probefn/analyzers test`.
   Expected outcome: design analyzer fixtures produce expected findings.
2. Run `pnpm probefn audit design --session sess_overflow --checkpoint chk_mobile --json`.
   Expected outcome: overflow and clipping findings are returned.
3. Run `pnpm probefn audit design --session sess_hmr --checkpoint chk_mobile --json`.
   Expected outcome: findings are marked unstable when hot reload occurred.

# Stop condition

Report the severity policy table, one healthy fixture with zero findings, and one unstable finding example before starting Phase 07.
