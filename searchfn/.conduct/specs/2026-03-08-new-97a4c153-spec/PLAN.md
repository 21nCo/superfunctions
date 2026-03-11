# PLAN

## Architecture sketch
- `searchfn/core`
  - Keeps reusable search primitives (pipeline/indexing/scoring/storage/cache utilities).
  - No wrapper-specific request validation or HTTP logic.
- `searchfn/adapters`
  - Owns canonical `SearchAdapter` contract.
  - Provides implementations: memory, indexeddb, postgres, elastic-compatible (elasticsearch+opensearch), meilisearch.
  - Owns conformance suite and adapter-specific integration harnesses.
- `searchfn/server`
  - Thin wrapper over `SearchAdapter` using `@superfunctions/http`.
  - Handles envelopes, validation, auth callback, limits, logging, lifecycle.
- `searchfn/client`
  - Thin app-facing wrapper over `SearchAdapter`.
  - Exposes generic factory and convenience constructors for memory/indexeddb.
- `searchfn/datafn-provider`
  - SearchAdapter -> DataFn SearchProvider bridge.
- `searchfn/docs`
  - New Fumadocs site with complete SearchFn coverage.
- `packages/docs-theme` (new)
  - Shared docs tokens/layout helpers consumed by `datafn/docs` and `searchfn/docs`.
- Internal consumers
  - `recfn/*` and any other package importing old SearchFn APIs are migrated.

## Dependency graph
1. `ARCH/API contract rewrite` -> required by all downstream phases.
2. `server/client thin wrappers` -> depend on stable adapter contract.
3. `external adapter implementations` -> depend on adapter contract and shared test harness.
4. `datafn-provider hardening + consumer migration` -> depends on wrappers and adapters.
5. `legacy removal` -> depends on migrations complete.
6. `docs shared theme` -> depends on package structure stable.
7. `searchfn docs content` -> depends on final APIs/behaviors.
8. `production readiness + QA matrix` -> depends on all core implementations.

## Phases overview
- **Phase 00**
  - Goal: Freeze rewrite architecture, contract deltas, and migration inventory.
  - Delivered capability: Implementable baseline and checklists.
  - Verification: Typecheck/lint scaffolds compile with new contract stubs.
- **Phase 01**
  - Goal: Rewrite `@searchfn/server` as thin adapter transport.
  - Delivered capability: Functional HTTP endpoints over adapter.
  - Verification: Route tests and envelope/validation tests pass.
- **Phase 02**
  - Goal: Rewrite `@searchfn/client` as thin adapter wrapper.
  - Delivered capability: New client API + convenience constructors.
  - Verification: Client contract tests pass; no legacy export remains.
- **Phase 03**
  - Goal: Implement Postgres adapter fully.
  - Delivered capability: Durable SQL backend for production.
  - Verification: Postgres integration tests + conformance tests pass.
- **Phase 04**
  - Goal: Implement elastic-compatible adapter for Elasticsearch/OpenSearch.
  - Delivered capability: Unified backend adapter with dialect config.
  - Verification: Dual-backend integration tests + conformance tests pass.
- **Phase 05**
  - Goal: Implement Meilisearch adapter fully.
  - Delivered capability: Meili backend support with robust error mapping.
  - Verification: Meili integration tests + conformance tests pass.
- **Phase 06**
  - Goal: Harden DataFn bridge and migrate internal consumers.
  - Delivered capability: Stable DataFn SearchProvider flow and updated in-repo usage.
  - Verification: DataFn provider tests and affected package tests pass.
- **Phase 07**
  - Goal: Remove legacy code and stale modules.
  - Delivered capability: Clean codebase with no fallback paths.
  - Verification: Grep gates for legacy symbols return zero; build remains green.
- **Phase 08**
  - Goal: Build shared docs theme package and migrate DataFn docs.
  - Delivered capability: Reusable cross-site docs styling/layout primitives.
  - Verification: DataFn docs build + theme parity checks pass.
- **Phase 09**
  - Goal: Build SearchFn Fumadocs site with comprehensive content.
  - Delivered capability: Full SearchFn docs experience and references.
  - Verification: SearchFn docs build + docs coverage checks pass.
- **Phase 10**
  - Goal: Production readiness validation (resilience, observability, perf, matrix E2E).
  - Delivered capability: Release-quality behavior gates and test matrix.
  - Verification: Full integration matrix + benchmark gates + redaction checks pass.

## Definition of Done (global)
No phase is complete unless its verification steps pass.
Additionally:
- All requirements mapped to that phase are implemented and tested.
- No unresolved failing tests in touched packages.
- No legacy imports/exports remain after legacy-removal phases.
- Spec artifacts (phase reports in execution) can cite exact passing commands.
