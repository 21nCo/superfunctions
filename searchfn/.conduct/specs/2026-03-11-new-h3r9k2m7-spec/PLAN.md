# Architecture Sketch

## Modules and responsibilities

- `searchfn/adapter-contracts`
  - Owns adapter interfaces, params, capability types, and `SearchAdapterError`.
  - Contains no concrete adapter runtime dependencies.
- `searchfn/adapter-memory`
  - Owns in-memory adapter implementation and tests.
- `searchfn/adapter-indexeddb`
  - Owns IndexedDB adapter implementation and browser-focused tests.
- `searchfn/adapter-postgres`
  - Owns Postgres adapter implementation and integration fixtures.
- `searchfn/adapter-elasticsearch`
  - Owns Elasticsearch adapter and elastic client internals.
- `searchfn/adapter-opensearch`
  - Owns OpenSearch adapter (or wrapper) with dedicated package boundary.
- `searchfn/adapter-meilisearch`
  - Owns Meilisearch adapter implementation.
- Consumer rewiring:
  - `@searchfn/client`, `@searchfn/server`, `@searchfn/datafn-provider`, `datafn/examples/todo-app/*`, `recfn/server`.

## Dependency graph

1. `@searchfn/adapter-contracts` (base)
2. Leaf adapters depend on `@searchfn/adapter-contracts` (+ runtime-specific deps)
3. Consumer packages depend on contracts + explicit leaf adapters as needed
4. Legacy `@searchfn/adapters` removed only after all consumers migrate

# Phases Overview

- **Phase 00**: Establish package split contract and migration inventory.
  - Capability: final mapping old exports/imports to new packages.
  - Verification: static inventory and mapping review.
- **Phase 01**: Create package scaffolds for contracts + each leaf adapter.
  - Capability: new workspaces compile empty/minimal entries.
  - Verification: per-package build/typecheck.
- **Phase 02**: Move adapter source/tests into leaf packages.
  - Capability: each adapter package owns implementation and tests.
  - Verification: package-local unit/conformance tests pass.
- **Phase 03**: Migrate internal `searchfn` consumers.
  - Capability: client/server/provider compile against new imports/deps.
  - Verification: filtered build/test for searchfn packages.
- **Phase 04**: Migrate external monorepo consumers.
  - Capability: `datafn` example and `recfn/server` imports/deps updated.
  - Verification: workspace build matrix and browser leak check.
- **Phase 05**: Update docs/examples/release metadata.
  - Capability: no stale docs; migration guide present.
  - Verification: grep + docs build where applicable.
- **Phase 06**: Delete legacy package and enforce no-compat gates.
  - Capability: `@searchfn/adapters` unavailable by design.
  - Verification: legacy import intentionally fails; full impacted matrix passes.

# Definition Of Done (Global)

No phase is complete unless its verification steps pass.

Global completion requires:

1. All requirements in `REQUIREMENTS.md` satisfied.
2. All positive vectors pass and negative vectors are demonstrably caught by checks.
3. `@searchfn/adapters` removed and zero monorepo references remain.
4. Build/test/docs checks for impacted workspaces pass.
