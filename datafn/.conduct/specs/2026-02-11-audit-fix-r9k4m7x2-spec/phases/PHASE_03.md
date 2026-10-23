# PHASE 03 — Client Destroy and Clear

## Phase Goal
Add `client.destroy()` and `client.clear()` methods for proper lifecycle management.

## In Scope
- `destroy()`: stop sync, close WS, dispose signals, clear event bus, close storage
- `clear()`: wipe all data, reset hydration, keep client usable
- Destroyed client guard (throw on subsequent method calls)
- Storage adapter: `close()` and `clearAll()` methods

## Out of Scope
- Storage adapter refactoring beyond adding close/clearAll
- Connection pooling

## Deliverables
- `client/src/client.ts` — destroy(), clear() methods, destroyed flag
- `client/src/storage.ts` — close(), clearAll() interface additions
- `client/src/storage/indexedDbStorage.ts` — close(), clearAll() implementations
- `client/__tests__/client.test.ts` — lifecycle tests

## Requirements Covered
- CLN-001, CLN-002

## Implementation Tasks
1. Add `close(): Promise<void>` and `clearAll(): Promise<void>` to `DatafnStorageAdapter` interface
2. Implement `close()` in IndexedDB adapter: close the IDB connection
3. Implement `clearAll()` in IndexedDB adapter: delete all records from all object stores, clear cursors and changelog
4. Add `destroyed: boolean = false` flag to client internal state
5. Implement `destroy()`:
   ```typescript
   async destroy(): Promise<void> {
     if (this.destroyed) return;
     // 1. Flush all pending debounced mutations (Phase 04 dependency — skip if not yet implemented)
     // 2. Stop sync engine
     if (this.syncEngine) await this.syncEngine.stop();
     // 3. Dispose all signals
     this.signalRegistry.disposeAll();
     // 4. Clear event bus
     this.eventBus.clear();
     // 5. Close storage
     if (this.storage) await this.storage.close();
     // 6. Set flag
     this.destroyed = true;
   }
   ```
6. Implement `clear()`:
   ```typescript
   async clear(): Promise<void> {
     this.guardDestroyed();
     if (this.storage) await this.storage.clearAll();
     // Reset hydration states
     for (const resource of this.schema.resources) {
       if (!resource.isRemoteOnly && this.storage) {
         await this.storage.setHydrationState(resource.name, "notStarted");
       }
     }
   }
   ```
7. Add `guardDestroyed()` check to all public methods (query, mutate, subscribe, sync, etc.)
8. Write test: destroy stops sync engine
9. Write test: destroy disposes all signals
10. Write test: destroy clears event bus
11. Write test: query after destroy throws DFQL_INVALID
12. Write test: clear wipes data, client still usable
13. Write test: clear resets hydration state
14. Run full test suite

## Verification Steps
- New tests pass: destroy, clear, destroyed guard
- `npm test -w @datafn/client` → 0 failures
- TV-CLN-001, TV-CLN-001N, TV-CLN-002, TV-CLN-002N verified

## Stop Condition
Client lifecycle management is complete. All tests pass. Phase report written.
