# PHASE 04 — Debounced Mutations

## Phase Goal
Implement per-record-key debouncing for merge mutations to reduce write amplification.

## In Scope
- Debounce infrastructure (DebouncerMap)
- `debounceKey` + `debounceMs` on mutation options
- Only `merge` operations are coalesced; others execute immediately
- `flush(key)` and `flushAll()` methods on client
- Immediate local storage update (optimistic) on each call
- Debounced changelog append + event emission
- Flush on destroy (integrate with Phase 03)

## Out of Scope
- Debouncing for queries
- Debouncing for non-merge operations

## Deliverables
- `client/src/debounce.ts` — DebouncerMap class (NEW FILE)
- `client/src/mutate.ts` — debounce integration
- `client/src/client.ts` — flush/flushAll on client, flush-before-destroy
- `client/__tests__/debounce.test.ts` — debounce tests

## Requirements Covered
- DEB-001

## Implementation Tasks
1. Create `DebouncerMap` class:
   ```typescript
   class DebouncerMap {
     private pending: Map<string, { timer: ReturnType<typeof setTimeout>; mutation: DfqlMutation; resolve: Function }>;
     set(key: string, mutation: DfqlMutation, delayMs: number, executor: (m: DfqlMutation) => Promise<void>): void;
     flush(key?: string): Promise<void>;
     flushAll(): Promise<void>;
     destroy(): void; // clear all timers
   }
   ```
2. In `set()`:
   - If key already pending, clear existing timer and merge record fields
   - Set new timer for `delayMs`
   - On timer fire: call executor, remove from pending
3. In mutation path (`mutate.ts`):
   - If `debounceKey` is present and operation is `merge`:
     a. Apply optimistically to local storage immediately
     b. Add to DebouncerMap instead of immediately appending to changelog
   - If `debounceKey` is present and operation is NOT `merge`:
     - Execute immediately (no debounce for insert/delete/replace)
4. The executor callback (called after debounce) should:
   - Append to changelog
   - Emit `mutation_applied` event
   - The coalesced record includes all merged fields
5. Expose `client.flush(key?)` and `client.flushAll()`
6. In `client.destroy()`, call `debouncerMap.flushAll()` before teardown
7. Write test: two merges with same key coalesce into one changelog entry
8. Write test: flush forces immediate execution
9. Write test: flushAll flushes all pending
10. Write test: destroy flushes before teardown
11. Write test: non-merge with debounceKey executes immediately
12. Run full test suite

## Verification Steps
- New tests pass: coalescing, flush, flushAll, destroy-flush
- `npm test -w @datafn/client` → 0 failures
- TV-DEB-001, TV-DEB-001N verified

## Stop Condition
Debounced mutations work correctly. All tests pass. Phase report written.
