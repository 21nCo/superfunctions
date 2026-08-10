# PHASE_07 - Visual, Accessibility, Reporting, and Sharding

## Phase Goal

Add full matrix visual/a11y coverage and structured evidence reporting.

## In Scope

- Axe coverage.
- Keyboard coverage.
- Theme matrix.
- Viewport matrix.
- Reduced motion.
- Screenshot baselines.
- JSON evidence.
- Sharding/filtering.

## Out of Scope

- Public hosted report UI.

## Deliverables

- uifn/examples/browser-qa/src/assertions/a11y.ts
- uifn/examples/browser-qa/src/assertions/visual.ts
- uifn/examples/browser-qa/src/reporting.ts
- uifn/examples/browser-qa/src/filters.ts
- uifn/examples/browser-qa/src/result-schema.ts

## Requirements Covered

- QA-007
- QA-008
- QA-010
- SEC-001

## Implementation Tasks

1. Add axe assertions for every QA route.
2. Add keyboard traversal and focus assertions by QA profile.
3. Add visual screenshots by framework, family, slug, route, state, theme, and viewport.
4. Add blank, clipping, overlap, and baseline drift checks.
5. Add JSON report schema validation.
6. Add sharding by framework, family, profile, slug, route, theme, and viewport.
7. Add sanitized failure artifacts.

## Verification Steps

```bash
npm run verify:uifn-browser -- --scope a11y
npm run verify:uifn-browser -- --scope visual
npm run verify:uifn-browser -- --framework react --slug popover
npm run verify:uifn-browser -- --framework angular --profile form
git diff --check
```

Expected outcome: all required visual/a11y/reporting checks pass and filtered runs produce valid JSON.

## Stop Condition

Stop and report route count, screenshot count, axe count, and result schema status.
