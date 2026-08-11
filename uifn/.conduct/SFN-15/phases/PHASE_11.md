# PHASE_11: Styled Components Batch A

## Phase Goal

Implement foundational display, layout, feedback, and simple action components across supported frameworks.

## In Scope

- Aspect Ratio
- Avatar
- Badge
- Button
- Card
- Label
- Progress
- Separator
- Skeleton
- Table
- Typography
- Toast/Sonner visual shell

## Out of Scope

- Data Table behavior.
- Complex overlays.
- Patterns.

## Deliverables

- `uifn/components/src/{react,svelte,vue,solid,angular}/...`
- `uifn/components/registry/components/*`
- stories, fixtures, tests for batch A

## Requirements Covered

COMP-001, COMP-002, STYLE-001 to STYLE-006, STORY-002

## Implementation Tasks

1. Implement shared recipe contracts for batch A.
2. Implement framework-specific components.
3. Add `unstyled` and part override APIs.
4. Add stories and fixtures.
5. Add accessibility and visual tests.
6. Add registry items.

## Verification Steps

```bash
npm --workspace @uifn/components run test -- batch-a
npm run verify:uifn-stories -- --scope batch-a
```

Expected outcome: batch A components pass render, a11y, visual, recipe, and registry checks.

## Stop Condition

Report completed components and any API normalization decisions.
