# Phase 00 Consumer Import/Dependency Inventory

Spec: `2026-03-11-new-h3r9k2m7-spec`
Phase: `PHASE_00`
Snapshot time: `2026-03-11`

## Monorepo TypeScript Import Inventory (`@searchfn/adapters`)

### `searchfn/client`

- `searchfn/client/src/client.ts`
  - Imports: `SearchAdapterError` and type contracts from legacy package.
  - Target:
    - `SearchAdapterError` -> `@searchfn/adapter-contracts`
    - contract types -> `@searchfn/adapter-contracts`

- `searchfn/client/src/types.ts`
  - Imports: adapter contract types from legacy package.
  - Target:
    - all contract types -> `@searchfn/adapter-contracts`

- `searchfn/client/src/constructors.ts`
  - Imports: `MemoryAdapter`, `IndexedDbAdapter`, `SearchAdapterConfig`, `IndexedDbAdapterOptions` from legacy package.
  - Target:
    - `MemoryAdapter` -> `@searchfn/adapter-memory`
    - `IndexedDbAdapter` + options -> `@searchfn/adapter-indexeddb`
    - `SearchAdapterConfig` -> `@searchfn/adapter-contracts`

- `searchfn/client/__tests__/client.test.ts`
  - Imports: `SearchAdapter`, `SearchAllResult` types from legacy package.
  - Target:
    - contract types -> `@searchfn/adapter-contracts`

### `searchfn/server`

- `searchfn/server/src/server.ts`
- `searchfn/server/src/routes/index.ts`
- `searchfn/server/src/routes/search.ts`
- `searchfn/server/src/routes/search-all.ts`
- `searchfn/server/src/routes/remove.ts`
- `searchfn/server/src/routes/clear.ts`
- `searchfn/server/src/routes/status.ts`
  - Imports: `SearchAdapter` type from legacy package.
  - Target:
    - `SearchAdapter` -> `@searchfn/adapter-contracts`

- `searchfn/server/src/http/errors.ts`
  - Imports: `SearchAdapterError`.
  - Target:
    - `SearchAdapterError` -> `@searchfn/adapter-contracts`

- `searchfn/server/__tests__/server-routes.test.ts`
  - Imports: `MemoryAdapter`, `SearchAdapter`, `SearchAdapterError`.
  - Target:
    - `MemoryAdapter` -> `@searchfn/adapter-memory`
    - `SearchAdapter`, `SearchAdapterError` -> `@searchfn/adapter-contracts`

### `searchfn/datafn-provider`

- `searchfn/datafn-provider/src/index.ts`
- `searchfn/datafn-provider/__tests__/factory.test.ts`
- `searchfn/datafn-provider/__tests__/fallback.test.ts`
  - Imports: `SearchAdapter` type from legacy package.
  - Target:
    - `SearchAdapter` -> `@searchfn/adapter-contracts`

- `searchfn/datafn-provider/tsup.config.ts`
  - External list includes `@searchfn/adapters`.
  - Target:
    - Replace with `@searchfn/adapter-contracts`

### `datafn/examples/todo-app`

- `datafn/examples/todo-app/client/src/lib/datafn.ts`
  - Imports: `IndexedDbAdapter`.
  - Target:
    - `IndexedDbAdapter` -> `@searchfn/adapter-indexeddb`

- `datafn/examples/todo-app/server/src/index.ts`
  - Imports: `ElasticsearchAdapter`, `MemoryAdapter`.
  - Target:
    - `ElasticsearchAdapter` -> `@searchfn/adapter-elasticsearch`
    - `MemoryAdapter` -> `@searchfn/adapter-memory`

### `recfn/server`

- `recfn/server/src/integrations/searchfn.ts`
  - Imports: `MemoryAdapter`.
  - Target:
    - `MemoryAdapter` -> `@searchfn/adapter-memory`

## Monorepo `package.json` Dependency Inventory (`@searchfn/adapters`)

1. `searchfn/client/package.json`
- current: `"@searchfn/adapters": "file:../adapters"`
- target:
  - `@searchfn/adapter-contracts`
  - `@searchfn/adapter-memory`
  - `@searchfn/adapter-indexeddb`

2. `searchfn/server/package.json`
- current: `"@searchfn/adapters": "file:../adapters"`
- target:
  - `@searchfn/adapter-contracts`
  - `@searchfn/adapter-memory` (test/runtime usage in `server-routes.test.ts`)

3. `searchfn/datafn-provider/package.json`
- current: `"@searchfn/adapters": "file:../adapters"`
- target:
  - `@searchfn/adapter-contracts`

4. `datafn/examples/todo-app/client/package.json`
- current: `"@searchfn/adapters": "*"`
- target:
  - `@searchfn/adapter-indexeddb`

5. `datafn/examples/todo-app/server/package.json`
- current: `"@searchfn/adapters": "*"`
- target:
  - `@searchfn/adapter-elasticsearch`
  - `@searchfn/adapter-memory`

6. `recfn/server/package.json`
- current: `"@searchfn/adapters": "*"`
- target:
  - `@searchfn/adapter-memory`

7. `searchfn/adapters/package.json`
- current: defines legacy package `@searchfn/adapters`.
- target:
  - package removed in final phase.

## Package Name and Workspace Placement Confirmation

- Root workspace config includes `"searchfn/*"` in `/package.json`.
- All target package directories under `searchfn/*` will be auto-included in workspace resolution.
- No nested monorepo is required.

## Phase 00 Output Status

- Export inventory: complete.
- Consumer import inventory: complete.
- Consumer dependency inventory: complete.
- Naming/workspace placement lock: complete.
- Mapping ambiguities: none.
