# SFN-15 Implementation Plan

## Architecture Sketch

```txt
@uifn/core
  -> behavior controllers, ARIA, ids, state, keyboard, focus, positioning intents

@uifn/adapter-kit
  -> event/ref/lifecycle/focus/portal helpers, shared conformance harness

@uifn/{react,svelte,vue,solid,angular}
  -> unstyled framework-native primitive adapters

@uifn/tokens
  -> W3C-style semantic token schema and validation

@uifn/theme
  -> runtime CSS variable mounting, theme provider, scoped themes

@uifn/theme-tailwind
  -> generated Tailwind preset/plugin from tokens and recipes

@uifn/recipes
  -> typed multi-target style recipes

@uifn/components
  -> styled base components for every supported framework

@uifn/patterns
  -> controlled product patterns with no backend binding

@uifn/sf
  -> Superfunction-backed variants with injected clients

@uifn/registry
  -> manifests, registry compiler, CLI, source install, locks, diffs

@uifn/storybook
  -> workshop/test/docs preset, decorators, compatibility panel
```

## Dependency Graph

1. Package contract and clean-room policy must be locked first.
2. `core` and `adapter-kit` must exist before adapter parity work.
3. `tokens`, `theme`, `theme-tailwind`, and `recipes` must exist before styled components.
4. Component manifests must exist before registry, Storybook, and docs generation.
5. Controlled patterns must exist before Superfunction-backed variants.
6. Registry and Storybook must be integrated before the production release gate is final.

## Phases Overview

| Phase | Goal | Delivered capability | Verification |
| --- | --- | --- | --- |
| 00 | Baseline audit and contract lock | current-state inventory, Coss snapshot, package target lock | audit artifact and manifest draft |
| 01 | Package scaffold reset | target packages with clean manifests | package graph validation |
| 02 | Core controller model | shared controller API and primitive vectors | core unit tests |
| 03 | Adapter kit | shared adapter helpers and conformance harness | harness runs sample primitive |
| 04 | Styling foundations | tokens, theme, Tailwind, recipes packages | token and recipe tests |
| 05 | React adapter | React primitives with hook/component APIs | React conformance, SSR |
| 06 | Svelte adapter | Svelte primitives with components/actions | Svelte conformance, SSR |
| 07 | Vue adapter | Vue primitives with composables/components | Vue conformance, SSR |
| 08 | Solid adapter | Solid primitives with signals/JSX | Solid conformance, SSR |
| 09 | Angular adapter | Angular standalone directives/components | Angular conformance |
| 10 | Component manifest catalog | all Coss-target components and hooks represented | catalog gate |
| 11 | Styled components batch A | layout/display/feedback components | component tests and stories |
| 12 | Styled components batch B | forms/overlays/navigation components | component tests and stories |
| 13 | Data-rich components | command, data table, calendar, date picker, sidebar, resizable | interaction and large-data tests |
| 14 | Hooks | media query and clipboard helpers | SSR and cleanup tests |
| 15 | Patterns | controlled product patterns | pattern story/test matrix |
| 16 | Superfunction-backed patterns | authfn, plugfn, filefn, billfn panels | mock-client integration tests |
| 17 | Registry and CLI | source install, lock, diff, package guidance | CLI fixture tests |
| 18 | Storybook surface | preset, decorators, compatibility panel | story test runner |
| 19 | Production release gate | final gate across packages/docs/visual/a11y | `npm run verify:uifn-release` |

## Definition of Done

No phase is complete unless:

- all verification steps in the phase pass locally,
- all requirements listed in the phase are either implemented or explicitly reported as blocked,
- new or changed artifacts avoid local absolute paths,
- generated docs and manifests match package exports,
- release-gate JSON reports no false success.

## Execution Notes

- Priorities are sequencing guidance only. They do not reduce scope.
- Breaking changes are allowed before SFN-15 GA.
- Do not preserve deprecated compatibility scaffolding unless this spec explicitly names it.
- Do not add product-specific packages, tokens, or migration wrappers.
- Do not copy source code from Coss, shadcn, Radix, Base UI, Storybook, or Bit.
