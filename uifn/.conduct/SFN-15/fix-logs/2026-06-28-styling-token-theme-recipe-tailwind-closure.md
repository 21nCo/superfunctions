# 2026-06-28 Styling Token Theme Recipe Tailwind Closure

## Scope

- Requirements: STYLE-001, STYLE-002, STYLE-003, STYLE-004, STYLE-005, STYLE-006
- Related evidence update: COMP-002, TEST-001

## Previous State

- Token validation accepted partial themes and did not enforce the full semantic public token inventory.
- Non-color token paths were weakly validated, and motion easing tokens were typed as `number` while containing `cubic-bezier(...)` strings.
- First-party theme JSON files lacked radius, density, and motion groups.
- Runtime theme mounting covered scoped/root CSS variables but not shadow-root adopted stylesheet mounting.
- Recipes did not directly emit all static hover classes from component recipes and did not support bounded `surfaceDepth` in `buttonRecipe`.
- Tailwind output covered a narrow static button case rather than the token-derived semantic color map and all emitted recipe utilities.
- Styled component renderers declared recipe dependencies but did not consume `@uifn/recipes` output for root classes/CSS vars/data.

## Final State

- `@uifn/tokens` has strict required public token paths, path-specific token type validation, `cubicBezier` token support, missing required-token rejection, unknown non-color path rejection, and cryptic alias rejection.
- All first-party themes include strict `color`, `radius`, `density`, and `motion` groups.
- `createBrandTheme` emits `cubicBezier` easing tokens and full accent/danger/warning/success contrast groups.
- `@uifn/theme` supports scoped/root mounting plus shadow-root adopted stylesheet mounting with cleanup.
- `@uifn/recipes` validates semantic surfaces and numeric depth, supports `surfaceDepth` in button recipes, emits static hover classes, defaults to `tint`, and keeps `stripe` optional.
- `@uifn/theme-tailwind` derives semantic colors from the public token contract and emits static utilities/safelist entries for recipe classes and hover effects.
- React, Svelte, Vue, Solid, and Angular styled component renderers consume the shared recipe resolver for classes, CSS variables, and data attributes.
- Registry/catalog checksums were refreshed after the component recipe-adoption test changed.

## Verification

- `npm --workspace @uifn/tokens run typecheck`
- `npm --workspace @uifn/tokens run test`
- `npm --workspace @uifn/tokens run build`
- `npm --workspace @uifn/theme run typecheck`
- `npm --workspace @uifn/theme run test`
- `npm --workspace @uifn/theme run build`
- `npm --workspace @uifn/recipes run typecheck`
- `npm --workspace @uifn/recipes run test`
- `npm --workspace @uifn/recipes run build`
- `npm --workspace @uifn/theme-tailwind run typecheck`
- `npm --workspace @uifn/theme-tailwind run test`
- `npm --workspace @uifn/theme-tailwind run build`
- `npm --workspace @uifn/components run typecheck`
- `npm --workspace @uifn/components run test`
- `npm --workspace @uifn/components run build`
- `node scripts/verify-uifn-components.mjs`
- `node scripts/verify-uifn-catalog.mjs`
- `node scripts/verify-uifn-registry.mjs`
- `npm --workspace @uifn/registry run test`
- `npm --workspace @uifn/storybook run test -- src/__tests__/storybook.test.ts`
- `node scripts/verify-uifn-stories.mjs`
- `node scripts/verify-uifn-release.mjs`

## Result

STYLE-001 through STYLE-006 are complete. COMP-002 remains in progress for richer per-component behavior beyond the shared styled root and recipe contract. TEST-001 remains in progress until every unrelated open SFN-15 row is complete.
