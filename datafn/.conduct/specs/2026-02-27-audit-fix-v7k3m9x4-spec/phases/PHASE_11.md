# PHASE 11: Client/Core MEDIUM

## Phase goal
Fix all 14 client/core MEDIUM issues.

## In scope
- CLI-001 through CLI-014

## Out of scope
- Server-side MEDIUM (Phase 10)
- LOW issues (Phase 12)

## Deliverables
- `datafn/client/src/errors.ts` — Rename or fix createClientError
- `datafn/client/src/switchableClient.ts` — Remove file
- `datafn/client/src/index.ts` — Remove switchableClient export
- `datafn/client/src/offline/aggregate.ts` — Fix empty set min/max
- `datafn/core/src/schema.ts` — Validate relation from/to against resource names
- `datafn/client/src/events/bus.ts` — Copy array before iteration
- `datafn/client/src/adapters/indexedDbStorage.ts` — Health check exemption, version bound
- `datafn/client/src/kv.ts` — Fix merge race
- `datafn/client/src/events/build.ts` — Remove unused import
- `datafn/core/src/filters.ts` — Add recursion depth limit
- `datafn/client/src/sync/cloneUp.ts` — Add backoff to pushBatchWithRetry
- `datafn/client/src/plugins/clientSearch.ts` — (Optional) Incremental index
- `datafn/client/src/offline/query.ts` — Remove redundant filter
- `datafn/client/src/extension/rpc.ts` — Add "reconcile" to RPC method type

## Requirements covered
CLI-001 through CLI-014

## Implementation tasks
1. **CLI-001**: Rename `createClientError` to `throwClientError` (or change to return Error instead of throw)
2. **CLI-002**: Delete `switchableClient.ts`, remove export from `index.ts`
3. **CLI-003**: In offline aggregate, check `values.length === 0` before `Math.min/max`; return `null` for empty sets
4. **CLI-004**: In `schema.ts` `validateRelation`, check that `from` and `to` reference declared resource names
5. **CLI-005**: In `EventBus.emit()`, copy subscribers array: `const subs = [...this.subscribers]` before iteration
6. **CLI-006**: In IndexedDB adapter, skip table validation for `__health_check__` key
7. **CLI-007**: In `kv.ts` `merge()`, use transaction or CAS: read-compute-write in single operation
8. **CLI-008**: Remove unused `buildEvent` import from wherever it's imported
9. **CLI-009**: In `core/src/filters.ts`, add `depth` parameter to `evaluateFilter`; if `depth > 10`, throw `DFQL_INVALID: "Filter nesting depth exceeds maximum of 10"`
10. **CLI-010**: In `pushBatchWithRetry`, add exponential backoff: `await sleep(1000 * Math.pow(2, attempt))` between retries
11. **CLI-011**: (P3/optional) Make search index incremental: only re-index changed records from pull delta
12. **CLI-012**: In `offline/query.ts`, remove redundant filter application when index already satisfied the query
13. **CLI-013**: Add max IndexedDB version (e.g., 1000); when exceeded, recreate database instead of version-bumping
14. **CLI-014**: Add `"reconcile"` to `DatafnRpcMethod` type union

## Verification steps
- `cd datafn/client && bun test` — all tests pass
- `cd datafn/core && bun test` — all tests pass
- Tests:
  - Offline aggregate min/max on empty → null
  - Schema with relation referencing non-existent resource → validation error
  - Filter with depth 11 → DFQL_INVALID
  - EventBus emit during unsubscribe → no crash
  - pushBatchWithRetry has increasing delays

## Stop condition
All 14 client/core MEDIUM issues addressed. Report results.
