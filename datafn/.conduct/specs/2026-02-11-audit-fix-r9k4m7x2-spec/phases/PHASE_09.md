# PHASE 09 — Fine-Grained Signal Invalidation

## Phase Goal
Reduce unnecessary signal re-fetches by matching mutation event metadata against signal cached state.

## In Scope
- Track cached record IDs in signal state
- Compare `event.ids` against cached IDs for `merge` mutations
- Always refresh on `insert` (new record may match filter) and `delete` (record may be cached)
- Use schema lookup for relation footprint (replace heuristic)

## Out of Scope
- Field-level matching (comparing event.fields against select/omit) — too complex for initial implementation
- Query filter matching (determining if inserted record matches filter criteria)

## Deliverables
- `client/src/signals/querySignal.ts` — enhanced invalidation logic, cached ID tracking
- `client/__tests__/signals.test.ts` — selective invalidation tests

## Requirements Covered
- SIG-002

## Implementation Tasks
1. Add `cachedIds: Set<string> | null` to signal internal state
2. After each fetch, extract record IDs from result and populate `cachedIds`
3. Update footprint derivation to use schema relation lookup:
   - For each relation token in `select`, look up the relation in schema and use the target resource name
4. Modify invalidation check in event handler:
   ```typescript
   if (event.action === "insert" || event.action === "delete") {
     // Always refresh — insert may match filter, delete may remove cached record
     scheduleRefresh();
   } else if (event.action === "merge" || event.action === "replace") {
     if (!cachedIds || cachedIds.size === 0) {
       scheduleRefresh(); // Conservative: no cached IDs, always refresh
     } else if (event.ids?.some(id => cachedIds.has(id))) {
       scheduleRefresh(); // Mutation affects a cached record
     }
     // else: skip refresh — mutation doesn't affect cached records
   }
   ```
5. Write test: merge on non-cached record does NOT trigger refresh
6. Write test: merge on cached record DOES trigger refresh
7. Write test: insert always triggers refresh
8. Write test: delete always triggers refresh
9. Write test: signal with no cached IDs (first fetch) always refreshes (conservative)
10. Write test: relation footprint uses schema lookup
11. Run full test suite

## Verification Steps
- New tests pass: selective invalidation for merge, insert, delete
- `npm test -w @datafn/client` → 0 failures
- TV-SIG-002, TV-SIG-002N verified

## Stop Condition
Signals only refresh when mutations plausibly affect their results. All tests pass. Phase report written.
