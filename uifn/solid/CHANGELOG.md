# Changelog

## 0.0.2 - 2026-11-03

- Imports `@uifn/core` types from the subpath that owns them instead of the root entry. With `verbatimModuleSyntax`, the old type-only import compiled to `import {} from '@uifn/core'`, which loaded every primitive.
- An app that imports one primitive no longer bundles unrelated primitives such as the QR-code generator (Tabs fixture: 71,734 to 41,381 gzip bytes).
- Each primitive wires only the `@uifn/dom` bindings it uses (overlay, menu, popup, navigation menu, roving focus or range gesture), so a Tabs-only app no longer bundles the Dialog, Select, Menu or Slider bindings, and only primitives that position a popup bundle floating-ui.
- Depends on `@uifn/core` 0.0.3, `@uifn/dom` 0.0.2 and `@uifn/adapter-kit` 0.0.2.

## Unreleased

- Replace the partial handwritten and generic Solid APIs with 69 catalog-generated native compound families and all 465 anatomy components.
- Preserve fine-grained Solid input accessors, deterministic SSR/hydration IDs, synchronous owner cleanup, and shared `@uifn/dom` services.
- Publish standard Solid JSX plus declarations and direct primitive subpaths without React-transformed output or legacy factory exports.
