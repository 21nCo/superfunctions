# PHASE_04: Styling Foundations

## Phase Goal

Implement the split styling system packages.

## In Scope

- `@uifn/tokens`
- `@uifn/theme`
- `@uifn/theme-tailwind`
- `@uifn/recipes`
- Required first-party themes.
- OKLCH ramp generation.
- Contrast validation.
- Surface/depth recipes.

## Out of Scope

- Styled component implementation.
- App-specific themes.

## Deliverables

- `uifn/tokens/src/schema.ts`
- `uifn/tokens/src/validate.ts`
- `uifn/tokens/src/oklch.ts`
- `uifn/theme/src/provider.ts`
- `uifn/theme/src/mount.ts`
- `uifn/theme/src/themes/*.json`
- `uifn/theme-tailwind/src/index.ts`
- `uifn/recipes/src/index.ts`
- `uifn/recipes/src/surface.ts`
- `uifn/recipes/src/button.ts`
- tests for `TV-STYLE-001` through `TV-STYLE-006`

## Requirements Covered

STYLE-001, STYLE-002, STYLE-003, STYLE-004, STYLE-005, STYLE-006

## Implementation Tasks

1. Define token schema and validator.
2. Implement OKLCH ramp and brand theme generator.
3. Add first-party themes.
4. Implement runtime CSS variable mounting.
5. Implement Tailwind preset/plugin generation.
6. Implement recipes with multi-target output.
7. Reject unsafe dynamic Tailwind class fragments.

## Verification Steps

```bash
npm --workspace @uifn/tokens run test
npm --workspace @uifn/theme run test
npm --workspace @uifn/theme-tailwind run test
npm --workspace @uifn/recipes run test
```

Expected outcome: all styling vectors pass and contrast failures block validation.

## Stop Condition

Report token schema, first-party themes, and recipe output examples.
