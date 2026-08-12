# PHASE_02 - Render Every Component in Every Framework

## Phase Goal

Render all 45 components in every framework Workbench app from shared contracts.

## In Scope

- Component index routes.
- Component detail routes.
- State routes.
- QA fixture routes.
- Product scenario inclusion.

## Out of Scope

- Deep interaction assertions.
- Visual baseline approval.

## Deliverables

- Framework component renderer modules for React, Svelte, Vue, Solid, and Angular.
- Shared fixture data for every component.
- Route parity verifier.
- Browser smoke test for every component route.

## Requirements Covered

- WB-002
- WB-003
- WB-004
- QA-002

## Implementation Tasks

1. Add a renderer adapter in each framework app for component contracts.
2. Add component gallery, state, and QA pages for all 45 components.
3. Add product scenario pages that include every component at least once.
4. Add route parity checks across all frameworks.
5. Add a Playwright smoke that visits every component route and checks nonblank component roots.

## Verification Steps

```bash
npm run verify:uifn-examples -- --scope components
npm run verify:uifn-browser -- --scope smoke --family component
git diff --check
```

Expected outcome: 45 component slugs render in all five frameworks, with no blank routes.

## Stop Condition

Stop and report component count by framework and any unsupported route declarations.
