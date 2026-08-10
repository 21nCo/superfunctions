# PHASE_15 — Styled packages, tokens, themes, recipes, and hooks

## Objective

Deliver composable styling and utilities without all-framework coupling, product-demo content, or behavior forks.

## Entry

- Phase 14 semantic-parity implementation gate (`ADAPT-001`, `PARITY-001`) passes. Phase 14 compatibility certification may remain open, but no compatibility/support/release claim may be made from that state.
- Existing `@uifn/components` demo/factory content is classified for deletion, example relocation, or reusable definition conversion.

## Requirements

- `COMP-001`, `STYLE-001`, `HOOK-001`.

## Work

1. Make `@uifn/components` framework-neutral definitions/metadata only; create `@uifn/components-react`, `@uifn/components-svelte`, and `@uifn/components-solid` as isolated styled compound packages.
2. Delete/move fixed Team workspace, invoice, settings, identity, command, date, navigation, and other product-scene content from reusable packages into examples; keep compounds open by anatomy/slots.
3. Complete typed tokens, themes, Tailwind bridge and recipes for system/light/dark, contrast, density, RTL, forced colors, reduced motion, zoom/reflow, consumer overrides, and part/data-attribute targeting.
4. Audit framework hooks; retain behavior-neutral utilities only, inject environments, enforce SSR/lifecycle cleanup, and delete any primitive/DOM fork.
5. Compare styled and headless semantic/a11y traces and enforce framework-isolated dependency/tarball/tree-shaking rules.

## Required evidence

- `TV-COMP-001-P/N`, `TV-STYLE-001-P/N`, `TV-HOOK-001-P/N`.
- One-framework clean installs, tarball/content scans, theme/preference/visual matrices, and hook stress/SSR suites.
- Seeded product-content, cross-framework peer, low-contrast/motion, and hook outside-click defects fail intended gates.

## Exit gate

Styled packages are framework-isolated/open/composable, styling respects user preferences, hooks are behavior-neutral, and headless semantics remain unchanged.

## Do not

- Do not hide reusable product workflows inside styled compounds.
- Do not make visual snapshots substitute for semantic/accessibility assertions.

## Handoff

Phase report lists package split/migrations, relocated examples, token/recipe schemas, and exact styled/headless trace results.
