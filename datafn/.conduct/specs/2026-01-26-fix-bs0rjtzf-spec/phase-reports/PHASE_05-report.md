# Phase 5 Completion Report

## Summary
Implemented the client pull engine with global cursor support, pagination, and trigger logic.

### Changes
- **`datafn/client/src/sync/apply.ts`**:
    - Updated `PullResult` to support global cursor (`nextCursor`) and `changes` array (upsert/delete).
    - Updated `applyPullResult` to process change entries and update the global cursor (`__global_cursor__`).
    - Updated `applyCloneResult` to initialize the global cursor from the max of per-resource cursors.
- **`datafn/client/src/sync/engine.ts`**:
    - Implemented `initializeSync()`: detects fresh install (via table hydration state) to choose between `cloneNow` and `pullNow`.
    - Implemented `cloneNow()`: executes clone and applies results.
    - Implemented `pullNow()`: executes pull loop (pagination using `nextCursor`) and applies changes.
    - Updated `processPush`: triggers `pullNow` if server response cursor is greater than stored global cursor.
    - Added visibility change listener to trigger `pullNow` when the app becomes visible.
- **`datafn/client/src/client.ts`**:
    - Wired `client.sync.start/stop` to `SyncEngine`.
    - Exposed `client.sync.pullNow` and `client.sync.cloneNow` for manual control.
    - Passed `schema` to `SyncEngine` constructor for hydration checks.
- **Tests**:
    - Updated `datafn/client/__tests__/sync.test.ts` to use new mocks (global cursor) and verify push-triggered pull.
    - Updated `datafn/client/__tests__/sync-apply.test.ts` to match new `PullResult` structure and verify monotonic cursor updates.

## Verification
- **Tests**: Ran `npm --prefix datafn/client test`. All 104 tests passed.
- **Build**: Ran `npm run build --prefix datafn/client`. Build successful.

## Requirements Covered
- **SYNC-QUERY-001**: Indirectly supported (hydration state management).
- **SYNC-PULL-001**: `initializeSync` logic (clone vs pull).
- **SYNC-PULL-002**: Triggers (visibility, push response).
- **SYNC-PULL-003**: Pagination loop and monotonic cursor update.

## Cursor Storage
The global cursor is stored in the `DatafnStorageAdapter` using the key `__global_cursor__`. It is updated monotonically in `applyPullResult` and `applyCloneResult`.
