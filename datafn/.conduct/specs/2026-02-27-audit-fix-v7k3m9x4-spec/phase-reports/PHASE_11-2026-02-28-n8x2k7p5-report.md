# PHASE_11 Completion Report — Client/Core MEDIUM

## Metadata

- **Timestamp**: 2026-02-28T17:55:00Z
- **Agent**: Oz
- **Model**: claude 4.6 sonnet (max)
- **Launcher**: Warp
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin (macOS) / zsh 5.9
- **Branch**: next
- **Commit**: (dirty)
- **Phase**: PHASE_11
- **Status**: PASS

---

## Requirements Summary

**Requirements delivered**: CLI-001 through CLI-010, CLI-012, CLI-013, CLI-014  
**Skipped**: CLI-011 (P3 — incremental search index, optional)

---

## Client/Core Issues

### CLI-001 — throwClientError as primary API

- **Status**: PASS
- **Evidence**: `throwClientError` added as the primary export in `client/src/errors.ts`. `createClientError` kept as `@deprecated` alias pointing to the same function. `index.ts` exports `throwClientError`.

### CLI-002 — Remove switchableClient

- **Status**: PASS
- **Evidence**: `client/src/switchableClient.ts` deleted. Export removed from `index.ts`. Corresponding test file `__tests__/switchable-client.test.ts` (16 tests) also deleted since its subject no longer exists.

### CLI-003 — calculateAggregation empty set

- **Status**: PASS
- **Evidence**: `calculateAggregation` in `core/src/aggregate.ts` already correctly returns `null` for empty sets (min/max/sum/avg) and `0` for count. Tests added to `core/__tests__/aggregate.test.ts` (15 tests covering empty set, all-null values, and regression for normal operation).

### CLI-004 — Schema relation from/to validation

- **Status**: PASS
- **Evidence**: `core/src/schema.ts` `validateRelation` loop now calls `validateRelationRef()` for both `from` and `to` fields. References to undeclared resource names (including array form) produce `SCHEMA_INVALID` errors with path `relations.from` or `relations.to` and a message listing available resources.
- **Tests**: 5 tests added to `core/__tests__/schema.test.ts`.

### CLI-005 — EventBus emit snapshot

- **Status**: PASS
- **Evidence**: `client/src/events/bus.ts` `emit()` now copies `this.subscriptions` to `const subs = [...this.subscriptions]` before iteration. Handlers that unsubscribe themselves or others during an emit cannot affect delivery to already-snapshotted handlers.
- **Tests**: 3 tests added to `client/__tests__/bus.test.ts`.

### CLI-006 — IDB health-check store bypass

- **Status**: PASS
- **Evidence**: `validateTableName()` in `adapters/indexedDbStorage.ts` now skips validation for `__health_check__` and any store prefixed with `__datafn_`.

### CLI-007 — kv.ts per-key merge lock

- **Status**: PASS
- **Evidence**: `withMergeLock(key, fn)` added in `client/src/kv.ts`; the non-debounce path of `merge()` calls it to prevent concurrent CAS races on the same key.

### CLI-008 — Remove unused buildEvent import

- **Status**: PASS
- **Evidence**: `buildEvent` import removed from `client/src/sync/engine.ts` (was unused after refactor).

### CLI-009 — Filter recursion depth limit

- **Status**: PASS
- **Evidence**: `MAX_FILTER_DEPTH = 10` constant and `_depth = 0` parameter added to `evaluateFilter` in `core/src/filters.ts`. Calls depth > 10 throw `DFQL_INVALID` with message containing "depth".
- **Tests**: 3 tests added to `core/__tests__/filters.test.ts`.

### CLI-010 — pushBatchWithRetry exponential backoff

- **Status**: PASS
- **Evidence**: `client/src/sync/cloneUp.ts` `pushBatchWithRetry` now `await`s `new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempts - 1)))` before each retry. Backoff sequence: 1s, 2s, 4s, …
- **Tests**: 2 tests added to `client/__tests__/cloneUp.test.ts` using `vi.useFakeTimers()` / `vi.runAllTimersAsync()`.

### CLI-011 — Incremental search index

- **Status**: SKIPPED (P3, optional)

### CLI-012 — Skip redundant filter re-application

- **Status**: PASS
- **Evidence**: `client/src/offline/query.ts` tracks `filterFullySatisfied = true` when the indexed path (id eq or single-field eq) fully covers all filter conditions. The `applyFilter` pass is skipped when `filterFullySatisfied` is true. Multi-field filters still re-filter as before.

### CLI-013 — Max IDB version guard

- **Status**: PASS
- **Evidence**: `MAX_IDB_VERSION = 1000` constant in `adapters/indexedDbStorage.ts`. `ensureStores()` deletes and recreates the database if the next version would exceed 1000, preventing IndexedDB version overflow.

### CLI-014 — reconcile RPC method type

- **Status**: PASS
- **Evidence**: `"reconcile"` added to `DatafnRpcMethod` union in `client/src/extension/rpc.ts`.
- **Tests**: 3 tests added to `client/src/extension/__tests__/rpc.test.ts` verifying compile-time and runtime correctness.

---

## Test Results

| Suite  | Before PHASE_11 | After PHASE_11 |
|--------|----------------|----------------|
| Client tests passing | 501 (baseline) → 485 (post-CLI-002 module removal) | **493** |
| Client tests failing | 0 | **0** |
| Client test files | 49 | **48** (switchable-client removed) |
| Core tests passing | 191 | **214** |
| Core tests failing | 1 (pre-existing) | **1** (pre-existing, unchanged) |
| Core test files | 13 | **14** |

The client count reduction (501→485) reflects removing the 16 `switchable-client` tests whose module (CLI-002) was deleted. Eight new client tests and 23 new core tests were added.

**Pre-existing core failure** (unchanged): `schema.test.ts > validateSchema > normalizes indices object format`

---

## New Tests Added

- `datafn/core/__tests__/aggregate.test.ts` — CLI-003 (empty/null set aggregation, 15 tests)
- `datafn/core/__tests__/schema.test.ts` — CLI-004 (relation from/to validation, 5 tests added)
- `datafn/core/__tests__/filters.test.ts` — CLI-009 (depth limit, 3 tests added)
- `datafn/client/__tests__/bus.test.ts` — CLI-005 (unsubscribe-during-emit safety, 3 tests added)
- `datafn/client/__tests__/cloneUp.test.ts` — CLI-010 (exponential backoff, 2 tests added)
- `datafn/client/src/extension/__tests__/rpc.test.ts` — CLI-014 (reconcile RPC type, 3 tests added)
