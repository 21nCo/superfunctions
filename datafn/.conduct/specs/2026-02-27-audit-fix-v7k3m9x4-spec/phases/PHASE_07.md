# PHASE 07: Performance HIGH

## Phase goal
Fix high-priority performance issues: batch serverSeq, static imports, deduplicate validation, batch relation calls, relation filter optimization, changelog dedup.

## In scope
- PER-H1: Batch serverSeq allocation in push
- PER-H2: Static imports in hot paths
- PER-H3: Deduplicate push validation
- PER-H4: Batch relation DB calls
- PER-H5: Relation filter targeted lookup
- PER-H6: Changelog dedup optimization

## Out of scope
- CRITICAL scalability (done in Phase 03)
- MEDIUM performance issues (Phase 10)

## Deliverables
- `datafn/server/src/execution/sync/push.ts` — Batch serverSeq, remove double validation
- `datafn/server/src/routes/query.ts` — Replace dynamic imports with static
- `datafn/server/src/routes/sync.ts` — Replace dynamic imports with static
- `datafn/server/src/execution/mutation/relations.ts` — Batch DB calls
- `datafn/server/src/execution/query/filters.ts` — Targeted relation filter
- `datafn/client/src/adapters/memoryStorage.ts` — Map-based dedup

## Requirements covered
PER-001, PER-002, PER-003, PER-004, PER-005, PER-006

## Implementation tasks
1. **Batch serverSeq** (`push.ts`):
   - Count mutations needing sequences
   - Call `changeTrackingService.getNextServerSeqBatch(count)` once
   - Assign sequences from returned range to individual mutations
   - Replace per-mutation `getNextServerSeq()` calls

2. **Static imports** (`routes/query.ts`, `routes/sync.ts`):
   - Move `await import(...)` to file-level static imports
   - Verify no circular dependency issues

3. **Deduplicate validation** (`push.ts` / `routes/sync.ts`):
   - Remove duplicate schema validation (keep handler-level, remove executor-level)
   - Or keep executor-level and remove handler-level (whichever is more appropriate)

4. **Batch relation calls** (`relations.ts`):
   - Group relate items by target resource
   - Use `db.insertMany()` for batch inserts on join tables
   - Use `db.deleteMany()` for batch deletes
   - Fallback to sequential if adapter lacks batch methods

5. **Relation filter** (`filters.ts`):
   - Replace `getRecords()` (all records of target) with `db.findMany({ where: <filter> })` on target
   - Only load records matching the filter condition

6. **Changelog dedup** (`memoryStorage.ts`):
   - Add `Map<string, number>` index mapping `mutationId → changelog index`
   - On append: O(1) check via Map instead of `.find()` scan
   - Keep Map in sync on clear/evict

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- `cd datafn/client && bun test` — all tests pass
- Verify:
  - Push with 50 mutations → 1 batch seq call (add log or test assertion)
  - No `await import(...)` in route handler functions
  - Relation bulk create with 50 items → <5 DB calls
  - Changelog append on 10k entries is fast (no scan)

## Stop condition
All 6 HIGH performance issues fixed. No regression in existing tests. Report results.
