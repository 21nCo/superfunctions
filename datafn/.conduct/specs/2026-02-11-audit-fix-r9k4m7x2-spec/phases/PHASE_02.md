# PHASE 02 — Signal Lifecycle Management

## Phase Goal
Eliminate signal memory leaks by adding dispose() to signals and disposeAll() to the registry.

## In Scope
- Store unsubscribe function in signal state
- Add `dispose()` method to signal interface
- Add `disposeAll()` to SignalRegistry
- Mark disposed signals to prevent refresh after dispose
- Ensure disposed signal's `get()` returns last cached value

## Out of Scope
- Automatic dispose based on subscriber count (MAY, not required)
- Signal re-creation after dispose

## Deliverables
- `client/src/signals/querySignal.ts` — dispose logic, unsubscribe storage
- `client/src/signals/registry.ts` — disposeAll method
- `client/__tests__/signals.test.ts` — new dispose tests

## Requirements Covered
- SIG-001

## Implementation Tasks
1. In `createQuerySignal()`:
   - Store the return value of `eventBus.subscribe()` as `unsubscribeFn`
   - Add `disposed: boolean = false` flag
   - Add `dispose()` function that:
     a. Calls `unsubscribeFn()`
     b. Removes signal from SignalRegistry
     c. Sets `disposed = true`
   - Modify event handler to check `if (disposed) return` before refreshing
2. In `SignalRegistry`:
   - Add `disposeAll()` that iterates all signals and calls `dispose()` on each
   - Ensure `dispose()` removes the signal from the registry map
3. Ensure `get()` on disposed signal returns last cached value (no re-fetch)
4. Write test: dispose removes from registry
5. Write test: dispose unsubscribes from event bus
6. Write test: disposed signal does not refresh on mutation
7. Write test: disposed signal get() returns last value
8. Write test: double dispose is safe (no throw)
9. Write test: disposeAll clears all signals
10. Run full test suite

## Verification Steps
- New tests pass: dispose, disposeAll, double-dispose safety
- `npm test -w @datafn/client` → 0 failures
- TV-SIG-001 and TV-SIG-001N scenarios verified

## Stop Condition
Signal memory leak is fixed. All tests pass. Phase report written.
