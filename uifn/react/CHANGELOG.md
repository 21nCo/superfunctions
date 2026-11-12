# Changelog

## 0.0.4 - 2026-11-03

- Imports `@uifn/core` types from the subpath that owns them (`controller`, `environment`, `parts`, `primitives`) instead of the root entry.
- An app that imports one primitive no longer bundles unrelated primitives such as the QR-code generator (Tabs fixture: 72,307 to 37,511 gzip bytes).
- Each primitive wires only the `@uifn/dom` bindings it uses (overlay, menu, popup, navigation menu, roving focus or range gesture), so a Tabs-only app no longer bundles the Dialog, Select, Menu or Slider bindings, and only primitives that position a popup bundle floating-ui.
- Depends on `@uifn/core` 0.0.3, `@uifn/dom` 0.0.2 and `@uifn/adapter-kit` 0.0.2.

## 0.0.1 - 2026-03-20

- Marked `@uifn/react` as GA in the initial release contract.
- Aligned React peer range with the supported compatibility matrix.
- Added package release-hygiene metadata and typecheck script entry.
- Documented deterministic Avatar fallback and adapter-only `VirtualizedList` overscan/render contract.
