# Metadata

- **timestamp**: 2026-03-11T16:12:49Z
- **agent_name**: unknown-agent
- **model**: gpt-5 (Codex)
- **launcher**: Codex Desktop
- **workspace/project path**: /Users/serro/Documents/dev/n/superfunctions
- **os**: Darwin 25.3.0 (arm64)
- **shell**: /bin/zsh
- **git.branch**: heads/next
- **git.commit**: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- **git.dirty**: true
- **spec_folder**: 2026-03-11-new-h3r9k2m7-spec
- **spec_path**: /Users/serro/Documents/dev/n/superfunctions/searchfn/.conduct/specs/2026-03-11-new-h3r9k2m7-spec
- **spec_type**: new
- **spec_id**: h3r9k2m7
- **input paths (notes/intent/docs read)**:
  - /Users/serro/Documents/dev/n/superfunctions/AGENTS.md
  - /Users/serro/.codex/skills/spec/SKILL.md
  - User request in thread: split `searchfn` adapters into separate packages with no backward compatibility; update monorepo dependencies
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/adapters/package.json
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/client/package.json
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/server/package.json
  - /Users/serro/Documents/dev/n/superfunctions/searchfn/datafn-provider/package.json
  - /Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/client/package.json
  - /Users/serro/Documents/dev/n/superfunctions/datafn/examples/todo-app/server/package.json
  - /Users/serro/Documents/dev/n/superfunctions/recfn/server/package.json

## Overview

This spec defines a full monorepo change to split `@searchfn/adapters` into dedicated adapter packages and remove the legacy aggregate package entirely.

The goal is to eliminate runtime dependency leakage (for example `pg` in browser bundles), tighten dependency boundaries, and make adapter ownership explicit. This change includes package creation, API relocation, import migration, dependency updates across all affected workspaces, tests, docs, and deletion of the old package.

## Context

- **Project name**: superfunctions monorepo
- **One-sentence goal**: Replace monolithic `@searchfn/adapters` with one-package-per-adapter and migrate all monorepo consumers without backward compatibility.
- **Target users**: maintainers of `searchfn`, `datafn`, `recfn`, and end users consuming published npm packages.
- **Target environments**:
  - Browser: adapter usage from `datafn` example and `@searchfn/client`
  - Node: server/integration usage from `@searchfn/server`, `datafn` server example, `recfn` server
- **Languages/packages required**: TypeScript/npm workspaces/turbo
- **Existing systems to integrate with**:
  - npm workspace layout in root `package.json`
  - turbo build/test execution
  - package exports and tsup build pipelines
- **Data model summary**: N/A (packaging/refactor only; runtime data models unchanged)
- **Security model**:
  - Supply-chain/runtime isolation: packages MUST not pull unnecessary runtime dependencies into unrelated targets
  - No auth/authz model change
- **Performance constraints**:
  - No functional regression in adapter behavior
  - Browser bundles SHOULD avoid node polyfill overhead introduced by adapter aggregation
- **Non-goals / out of scope**:
  - No feature additions to adapter behavior/scoring logic
  - No Python package migration in this change
  - No compatibility shim for `@searchfn/adapters`
- **Hard constraints**:
  - No nested monorepo creation
  - Preserve deterministic behavior of adapters
  - Remove old aggregate package after migration

## Glossary

- **Legacy aggregate package**: existing `@searchfn/adapters` workspace that exports all adapters.
- **Adapter contract**: shared types/interfaces/errors (`SearchAdapter`, `SearchParams`, etc).
- **Leaf adapter package**: a package that contains exactly one concrete adapter family.
- **Monorepo consumer**: any workspace importing adapters/types.
- **Runtime isolation**: browser packages do not depend on node-only modules unless explicitly needed.

## Goals / Non-goals

### Goals

1. `searchfn` adapter ecosystem MUST be split into dedicated packages.
2. `@searchfn/adapters` MUST be removed (no backward compatibility).
3. All monorepo imports and `package.json` dependencies MUST be migrated.
4. Shared adapter types MUST remain available through a stable dedicated package.
5. Build/test/docs/examples MUST be updated to reflect new package names.

### Non-goals

1. Changing adapter search semantics or scoring formulas.
2. Introducing runtime feature flags for old/new package names.
3. Supporting mixed old/new imports in the same commit series.

## Public API

### New package set (normative)

The monorepo MUST define and publish the following packages:

- `@searchfn/adapter-contracts`
- `@searchfn/adapter-memory`
- `@searchfn/adapter-indexeddb`
- `@searchfn/adapter-postgres`
- `@searchfn/adapter-elasticsearch`
- `@searchfn/adapter-opensearch`
- `@searchfn/adapter-meilisearch`

### Contract package API

`@searchfn/adapter-contracts` MUST export:

```ts
export interface SearchDocument { id: string | number; fields: Record<string, string> }
export interface IndexParams { resource: string; documents: SearchDocument[]; signal?: AbortSignal }
export interface SearchParams { resource: string; query: string; fields?: string[]; limit?: number; fuzzy?: boolean | number; fieldBoosts?: Record<string, number>; signal?: AbortSignal }
export interface SearchAllParams { query: string; resources?: string[]; fields?: string[]; limit?: number; limitPerResource?: number; fuzzy?: boolean | number; fieldBoosts?: Record<string, number>; signal?: AbortSignal }
export interface SearchAllResult { resource: string; id: string | number; score: number }
export interface RemoveParams { resource: string; ids: Array<string | number>; signal?: AbortSignal }
export interface InitializeResourceConfig { name: string; searchFields: string[] }
export interface InitializeParams { resources: InitializeResourceConfig[] }
export interface SearchAdapterCapabilities { persistent?: boolean; searchAll?: boolean; fuzzy?: boolean; fieldBoosts?: boolean; maxBatchSize?: number }
export interface SearchAdapter { readonly name: string; readonly capabilities?: SearchAdapterCapabilities; initialize?(params: InitializeParams): Promise<void>; index(params: IndexParams): Promise<void>; search(params: SearchParams): Promise<Array<string | number>>; searchAll?(params: SearchAllParams): Promise<SearchAllResult[]>; remove(params: RemoveParams): Promise<void>; clear(resource: string, signal?: AbortSignal): Promise<void>; dispose?(): Promise<void> }
export const SEARCH_ADAPTER_DISPOSED: "SEARCH_ADAPTER_DISPOSED"
export class SearchAdapterError extends Error { readonly code: string }
export interface SearchAdapterConfig { pipeline?: import("@searchfn/core").PipelineOptions }
```

### Leaf adapter package APIs

Each leaf package MUST expose only its own adapter class(es) and options:

- `@searchfn/adapter-memory`: `MemoryAdapter`
- `@searchfn/adapter-indexeddb`: `IndexedDbAdapter`, `IndexedDbAdapterOptions`
- `@searchfn/adapter-postgres`: `PostgresAdapter`, `PostgresAdapterOptions`
- `@searchfn/adapter-elasticsearch`: `ElasticsearchAdapter`, `ElasticsearchAdapterOptions`
- `@searchfn/adapter-opensearch`: `OpenSearchAdapter`, `OpenSearchAdapterOptions`
- `@searchfn/adapter-meilisearch`: `MeilisearchAdapter`, `MeilisearchAdapterOptions`

Each leaf adapter package SHOULD re-export contract types from `@searchfn/adapter-contracts` for ergonomics.

## Data formats / protocol

### Package-level dependency envelope (canonical)

Each consumer package MUST satisfy one of:

```json
{
  "dependencies": {
    "@searchfn/adapter-contracts": "*"
  }
}
```

or

```json
{
  "dependencies": {
    "@searchfn/adapter-contracts": "*",
    "@searchfn/adapter-memory": "*"
  }
}
```

plus additional leaf adapters only when directly instantiated.

### Import path canonicalization

Old import path:

```ts
import { MemoryAdapter } from "@searchfn/adapters";
```

MUST be replaced with:

```ts
import { MemoryAdapter } from "@searchfn/adapter-memory";
```

Type-only old import path:

```ts
import type { SearchAdapter } from "@searchfn/adapters";
```

MUST be replaced with:

```ts
import type { SearchAdapter } from "@searchfn/adapter-contracts";
```

## Semantics

1. Concrete adapter behavior MUST remain functionally equivalent pre/post split.
2. Constructor signatures and adapter names MUST remain unchanged unless explicitly documented here (none).
3. Import side effects MUST be reduced: importing one adapter MUST NOT eagerly import another adapter package.
4. Consumer compile semantics:
   - Consumer builds that still import `@searchfn/adapters` MUST fail after package removal.
   - Consumer builds with migrated imports MUST pass.

## Invariants

1. **Determinism**: For identical adapter inputs, outputs MUST match legacy implementation behavior.
2. **Isolation**: Browser-targeted consumers MUST NOT transitively include `pg` unless they explicitly depend on `@searchfn/adapter-postgres`.
3. **No-compat policy**: `@searchfn/adapters` MUST not exist after migration completion.
4. **Workspace integrity**: New packages MUST remain under `searchfn/*` and be picked up by root workspaces.

## Security

1. This refactor MUST NOT weaken existing credential handling in Postgres/Elasticsearch/Meilisearch adapters.
2. Documentation/examples MUST avoid leaking secrets in committed sample code.
3. Runtime isolation MUST reduce accidental inclusion of unnecessary node dependencies in browser bundles.

## Limits/caps

1. No adapter API payload limits are changed by this spec.
2. Existing adapter-specific limits (timeouts, retries, batch sizes) remain as implemented.
3. Package split does not introduce dynamic runtime loading requirements.

## Observability

1. Existing adapter logger behavior MUST remain unchanged.
2. Build/test scripts MUST clearly report missing package migration via compile error.
3. Migration validation MUST include bundle-level sanity check for browser consumers (absence of `pg` import path unless explicitly required).

## Compatibility / versioning strategy

1. This is a breaking change by design.
2. The old package name `@searchfn/adapters` MUST be removed.
3. All updated packages MUST bump versions according to monorepo release policy for breaking changes.
4. CHANGELOG/README sections MUST explicitly document the migration map.

## Error codes and failure behavior

- `E_IMPORT_PATH_LEGACY`: build-time module resolution failure when importing removed `@searchfn/adapters`.
- `E_DEP_MISSING_CONTRACTS`: type build failure when consumer does not add `@searchfn/adapter-contracts`.
- `E_DEP_MISSING_LEAF`: runtime/module-not-found when concrete adapter dependency not declared.
- `E_BROWSER_NODE_LEAK`: browser bundle analysis detects node-only dependency in a browser target without explicit node adapter usage.

Error handling requirements:

1. Migration checks MUST fail fast on first unresolved import path.
2. CI/local verification scripts MUST expose actionable package/import path in error output.

## Undefined / Explicitly user-deferred only

Undefined (not required by this spec):

1. Python `searchfn` package naming and adapter split.
2. External third-party repository migration outside this monorepo.
3. Automatic codemod publishing to downstream users.

No user-deferred items were provided.
