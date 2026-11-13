# Changelog

## 0.0.4 - 2026-11-03

- Imports `@uifn/core` types from the subpath that owns them (`controller`, `environment`, `parts`, `primitives`) instead of the root entry.
- An app that imports one primitive no longer bundles unrelated primitives such as the QR-code generator (Tabs fixture: 70,367 to 39,091 gzip bytes).
- Each primitive's definition lists the shared `@uifn/dom` adapter installers it uses (overlay, menu, popup, navigation menu, roving focus or range gesture) with its own parts and state keys, so a Tabs-only app bundles neither the Dialog, Select, Menu or Slider bindings nor any other primitive's roving-focus, gesture or popup parts, and only primitives that position a popup bundle floating-ui.
- `SveltePrimitiveBridge` now wires only the `@uifn/dom` bindings a definition lists in `domBindings`. A hand-built `SveltePrimitiveDefinition` without `domBindings` no longer gets a focus trap, roving focus, menu or popup wiring, or range gestures. List the `@uifn/dom` adapter installers in `domBindings` (what generated definitions do, bundling only that primitive's bindings), or use the new `@uifn/svelte/dom-bindings` subpath: its installers and `svelteDomBindingsFor({ name, family })` look the definition's parts up by its catalog `name`, which bundles every primitive's bindings.
- Depends on `@uifn/core` 0.0.3, `@uifn/dom` 0.0.2 and `@uifn/adapter-kit` 0.0.2.

## Unreleased - 2026-07-18

- Replaced the partial handwritten adapter with generated Svelte 5 compounds for all 69 stable primitives and 465 anatomy parts.
- Routed reactive inputs through `controller.update` without recreating controllers or DOM ownership resources.
- Added typed snippets, render actions, bindable controlled values, element refs, portal targets, and native form participation.
- Switched publishing to standard Svelte packaging with compiled `dist` JavaScript, declarations, Svelte metadata, and direct primitive subpaths.
- Added clean packed-consumer SSR/hydration and production-build verification in Chromium, Firefox, and WebKit.
- Removed raw repository TypeScript entrypoints and legacy public machine factories.

## 0.0.1 - 2026-03-20

- Marked `@uifn/svelte` as GA in the initial release contract.
- Aligned Svelte peer range with the documented support matrix.
- Added package release-hygiene metadata and npm ignore rules for tests.
- Documented deterministic Avatar fallback and adapter-only `VirtualizedList` overscan/render contract.
