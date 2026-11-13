# Changelog

## 0.0.3 - 2026-11-03

- Declared `"sideEffects": false`. Every module only declares bindings when imported, so bundlers can drop primitives an app does not import. A new test parses every shipped module and denies module-level code by default. It accepts only imports with bindings, re-exports, declarations and default exports. It walks each of them in full: binding patterns (defaults and computed keys), initializers, enum values, non-ambient namespace bodies and class definitions. It skips only function, method and accessor bodies with their parameters, instance field initializers, types and ambient declarations. It reports side-effect imports, any other top-level statement, calls other than the allow-listed freeze/contract builders, `new`, tagged templates, `await`, `delete`, assignments and `++`/`--` anywhere in that code, including class `extends` expressions and computed member names, plus decorators and static initializers. Property reads, spreads and destructuring are accepted, because they run user code only through getters or iterators.
- Each per-primitive entry no longer bundles the QR-code contract and its generator. Before this, a top-level contract call counted as a side effect, so every app that imported one primitive shipped them.

## Unreleased

- Added the uniform public controller, typed part-composition, and explicit environment/scope contracts.
- Added reactive controlled-input synchronization, immutable snapshots, selector subscriptions, and synchronous idempotent teardown across all 25 current controller factories.
- Removed the public generic state-machine entrypoint, wildcard primitive implementation subpaths, legacy `createX` constructors, adapter wrappers, local store API, and process-global ID helpers without compatibility shims.
- Added a versioned removal manifest and breaking migration guide.

## 0.0.1 - 2026-03-20

- Declared `@uifn/core` as the canonical core package identity.
- Aligned the then-current export-path contract for `aria`, `state`, `utils`, and `primitives` (superseded by the Unreleased breaking cutover).
- Added release-hygiene metadata (`CHANGELOG.md` in packed files, Node engine range).
- Documented adapter-only ownership for display-helper surfaces (`Avatar`, `Badge`, `Label`, `Separator`, `VirtualizedList`).
