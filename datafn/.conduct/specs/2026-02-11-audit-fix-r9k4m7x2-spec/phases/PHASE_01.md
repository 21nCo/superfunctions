# PHASE 01 — Event Bus Error Isolation

## Phase Goal
Make event bus delivery fault-tolerant so that a throwing handler does not prevent other handlers from receiving events.

## In Scope
- Modify `EventBus.emit()` to wrap each handler in try-catch
- Add configurable `onError` callback to EventBus constructor
- Default error handler: `console.error`
- Add `EventBus.clear()` method to remove all subscriptions

## Out of Scope
- Changing event handler registration order
- Async error handling (handlers are synchronous)

## Deliverables
- `client/src/events/bus.ts` — modified emit(), added onError option, added clear()
- `client/__tests__/bus.test.ts` — new/updated tests

## Requirements Covered
- BUS-001

## Implementation Tasks
1. Add `onError?: (error: unknown, event: DatafnEvent) => void` to EventBus constructor options
2. In `emit()`, wrap `subscription.handler(event)` in try-catch:
   ```typescript
   for (const subscription of this.subscriptions) {
     if (matchesFilter(event, subscription.filter)) {
       try {
         subscription.handler(event);
       } catch (error) {
         this.onError(error, event);
       }
     }
   }
   ```
3. Default `onError`: `console.error("[datafn] Event handler error:", error)`
4. Add `clear()` method: `this.subscriptions = []` (or `.clear()` if Set/Map)
5. Write test: handler A throws, handler B still receives event
6. Write test: custom onError callback is invoked with error and event
7. Write test: clear() removes all subscriptions
8. Run full test suite

## Verification Steps
- New tests pass: handler isolation, custom error handler, clear
- `npm test -w @datafn/client` → 0 failures
- TV-BUS-001 scenario verified

## Stop Condition
Event bus is fault-tolerant. All tests pass. Phase report written.
