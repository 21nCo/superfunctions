# Changelog

## 0.0.4 - 2026-11-03

- Imports `@uifn/core` types from the subpath that owns them (`controller`, `environment`, `parts`, `primitives`) instead of the root entry.
- An app that imports one primitive no longer bundles unrelated primitives such as the QR-code generator (Tabs fixture: 70,367 to 39,326 gzip bytes).
- Each primitive wires only the `@uifn/dom` bindings it uses (overlay, menu, popup, navigation menu, roving focus or range gesture), so a Tabs-only app no longer bundles the Dialog, Select, Menu or Slider bindings, and only primitives that position a popup bundle floating-ui.
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
