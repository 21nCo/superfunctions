# Phase 0: Types + Row-Level Namespace Wrapper

## Goal
Add `rowLevelNamespace` configuration to `@superfunctions/db` adapter types and implement the `wrapWithRowLevelNamespace()` wrapper function.

## Scope
- `packages/db/src/adapter/types.ts`
- `packages/db/src/adapter/row-level-namespace.ts` (NEW)
- `packages/db/src/index.ts` (re-export)

## Requirements Covered
RLN-001, RLN-002, RLN-003, RLN-004, RLN-005, RLN-006, RLN-007, RLN-008, RLN-009, RLN-010, RLN-011, RLN-012

## Tasks

### 0.1 — Type extensions in `types.ts`
- Add `RowLevelNamespaceConfig` interface:
  ```ts
  interface RowLevelNamespaceConfig {
    enabled: boolean;
    columnName?: string;   // default "__ns"
    mandatory?: boolean;   // default true
  }
  ```
- Add optional `rowLevelNamespace?: RowLevelNamespaceConfig` to `AdapterFactoryConfig`.

### 0.2 — Implement `wrapWithRowLevelNamespace()`
Create `packages/db/src/adapter/row-level-namespace.ts`:

- **Input**: `(adapter: DatabaseAdapter, config: Required<RowLevelNamespaceConfig>)`
- **Output**: `DatabaseAdapter` (same interface, wrapped)
- **Behavior per method**:
  - `create(params)` → Inject `{ [col]: params.namespace }` into `params.data`. Strip `__ns` from returned record.
  - `createMany(params)` → Stamp each item. Strip from results.
  - `findMany(params)` → Inject `{ [col]: params.namespace }` into `params.where`. Strip from each result.
  - `findFirst(params)` → Same injection. Strip from result (if found).
  - `update(params)` → Inject into `params.where`. Strip from result.
  - `updateMany(params)` → Inject into `params.where`. Strip from results.
  - `delete(params)` → Inject into `params.where`.
  - `deleteMany(params)` → Inject into `params.where`.
  - `count(params)` → Inject into `params.where`.
  - `transaction(fn)` → Pass through, wrapping the inner adapter.
  - `db.internal` → Pass through unchanged (no injection).
- **Mandatory enforcement**: If `mandatory === true` and `params.namespace` is `undefined`/empty, throw `NamespaceRequiredError`.

### 0.3 — Export from package index
Re-export `wrapWithRowLevelNamespace` and `RowLevelNamespaceConfig` from `packages/db/src/index.ts`.

## Verification
- Unit tests in `packages/db/src/adapter/__tests__/row-level-namespace.test.ts`:
  - Test injection on every CRUD method using a mock adapter.
  - Test stripping of `__ns` from outputs.
  - Test mandatory enforcement (throw on missing namespace).
  - Test passthrough of `db.internal`.
  - Test custom column name.
  - Test that existing `where` conditions are AND-merged, not replaced.
- All existing `@superfunctions/db` tests still pass.

## Estimate
~2 days

## Exit Criteria
- `wrapWithRowLevelNamespace` function exists, is exported, and all unit tests pass.
- No regressions in existing `@superfunctions/db` test suite.
