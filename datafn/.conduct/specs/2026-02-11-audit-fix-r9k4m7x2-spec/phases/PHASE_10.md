# PHASE 10 — Optimistic Signal Updates (Back-Propagation)

## Phase Goal
Eliminate perceptible UI lag by immediately patching signal cached data on merge mutations.

## In Scope
- Patch cached data on `merge` mutations for records in cache
- Immediate subscriber notification with patched data
- Background re-fetch for eventual consistency
- `disableOptimistic: true` option on signal creation

## Out of Scope
- Optimistic patching for `insert`/`delete`/`replace` (these trigger full re-fetch)
- Optimistic patching for relation changes

## Deliverables
- `client/src/signals/querySignal.ts` — optimistic patch logic
- `client/__tests__/signals.test.ts` — optimistic update tests

## Requirements Covered
- SIG-003

## Implementation Tasks
1. Add `disableOptimistic?: boolean` to signal creation options
2. When a `merge` `mutation_applied` event matches:
   - If `disableOptimistic` is true, fall through to normal re-fetch
   - If cached data contains a record with matching ID:
     a. Create patched copy: `{ ...cachedRecord, ...event.record }`
     b. Update cached data array with patched record
     c. Emit patched data to subscribers immediately
     d. Schedule a debounced background re-fetch for consistency
   - If record ID not in cache, fall through to re-fetch
3. For `insert`, `delete`, `replace` events: always re-fetch (no patching)
4. The background re-fetch replaces the optimistic value once complete
5. Write test: merge patches cached data immediately
6. Write test: subscribers receive patched value within same microtask
7. Write test: background re-fetch scheduled after patch
8. Write test: delete triggers full re-fetch (no patch)
9. Write test: disableOptimistic skips patching
10. Write test: record not in cache triggers re-fetch
11. Run full test suite

## Verification Steps
- New tests pass: optimistic patch, re-fetch fallback, disable option
- `npm test -w @datafn/client` → 0 failures
- TV-SIG-003, TV-SIG-003N verified

## Stop Condition
Optimistic signal updates provide instant UI feedback. All tests pass. Phase report written.
