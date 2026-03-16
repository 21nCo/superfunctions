# PHASE 17

## Phase goal
Create root `docs/` app scaffold using Fumadocs and shared docs-theme.

## In scope / Out of scope

- **In scope:** docs workspace setup, layout/theme integration, nav scaffolding.
- **Out of scope:** full content population.

## Deliverables

- New root `docs/` workspace with Next.js + Fumadocs.
- Shared layout integration with `@superfunctions/docs-theme`.
- Initial docs nav and source loader setup.

## Requirements covered

- DOCS-001
- OPS-004

## Implementation tasks

1. Scaffold root docs app structure mirroring datafn/searchfn docs patterns.
2. Add workspace registration and scripts.
3. Wire layout to shared docs-theme root/layout config.
4. Add base navigation sections for shared packages and migration docs.

## Verification steps

1. Run:
```bash
npm -w docs run dev
```
Expected: docs app serves locally without runtime errors.

2. Run:
```bash
npm -w docs run build
```
Expected: production build succeeds.

## Stop condition
Root docs scaffold is operational and included in workspace pipelines.
