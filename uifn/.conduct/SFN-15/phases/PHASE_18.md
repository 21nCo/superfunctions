# PHASE_18: Storybook Workshop

## Phase Goal

Implement `@uifn/storybook` and make stories the consumer-facing inspection and test surface.

## In Scope

- Storybook preset.
- Theme/density/locale/viewport decorators.
- Reduced-motion decorator.
- Superfunction mock decorators.
- Compatibility panel.
- Generated docs pages.
- Story validation.

## Out of Scope

- Making Storybook the only source of truth.

## Deliverables

- `uifn/storybook/src/preset.ts`
- `uifn/storybook/src/decorators/*`
- `uifn/storybook/src/panel/*`
- `uifn/storybook/src/generate-docs.ts`
- `uifn/storybook/src/validate-stories.ts`

## Requirements Covered

STORY-001, STORY-002, DOCS-001, SEC-001

## Implementation Tasks

1. Implement Storybook preset.
2. Implement decorators.
3. Implement compatibility panel reading registry manifests.
4. Add generated docs pages.
5. Add story validation.
6. Wire stories into interaction/a11y/visual checks.

## Verification Steps

```bash
npm --workspace @uifn/storybook run test
npm run verify:uifn-stories
```

Expected outcome: Storybook validates stories and exposes compatibility metadata.

## Stop Condition

Report Storybook commands, decorators, and panel fields.
