# PHASE_08

## Phase goal
Introduce shared Fumadocs theme primitives and migrate DataFn docs to consume them.

## In scope / Out of scope
In scope:
- Create shared docs theme package.
- Migrate DataFn docs to shared theme package.
- Add parity validation scripts.

Out of scope:
- SearchFn docs content.

## Deliverables
- `packages/docs-theme/package.json` (new)
- `packages/docs-theme/src/index.ts` (new)
- `packages/docs-theme/src/layout.tsx` (new)
- `packages/docs-theme/src/tokens.css` (new)
- `packages/docs-theme/src/config.ts` (new)
- `datafn/docs/app/layout.tsx` (updated to shared package)
- `datafn/docs/app/layout.config.tsx` (updated)
- `datafn/docs/app/global.css` (updated)
- `scripts/check-docs-theme-parity.mjs` (new)

## Requirements covered
- DOC-002

## Implementation tasks
1. Build shared theme package exporting reusable layout/token helpers.
2. Replace direct DataFn docs local styling with shared package imports.
3. Implement parity check script to compare required theme primitives across docs apps.
4. Ensure datafn/docs build remains green.

## Verification steps
1. `npm --prefix datafn/docs run build`
- Expected: build passes using shared theme package.
2. `node scripts/check-docs-theme-parity.mjs datafn/docs`
- Expected: parity script passes.
3. `npm --prefix packages/docs-theme run typecheck`
- Expected: exit code 0.

## Stop condition
Shared theme package is usable and DataFn docs are migrated without regressions.
