# PHASE 03: Scalability CRITICAL

## Phase goal
Fix unbounded memory growth: reconcile count, clone pagination, extension transport timeout, idempotency TTL.

## In scope
- SCA-C1: Use `db.count()` in reconcile
- SCA-C2: Auto-paginate clone when exceeding maxCloneRecords
- SCA-C3: Extension transport request timeout
- SCA-C4: MemoryIdempotencyStore TTL + LRU eviction

## Out of scope
- HIGH scalability (Phase 07)
- WS connection limits (Phase 06)

## Deliverables
- `datafn/server/src/execution/sync/reconcile.ts` — Replace findMany.length with count
- `datafn/server/src/execution/sync/clone.ts` — Add maxCloneRecords enforcement + auto-pagination
- `datafn/client/src/extension/transport.ts` — Add per-request timeout
- `datafn/server/src/execution/idempotency.ts` — Add TTL sweep + LRU eviction

## Requirements covered
SCA-001, SCA-002, SCA-003, SCA-004

## Implementation tasks
1. **Reconcile count** (`reconcile.ts`):
   - Replace `db.findMany({ where: [] }).length` with `db.count({ where: [] })` or equivalent
   - If adapter lacks `count`, use `findMany` as fallback but log warning
   - Verify the DB adapter interface supports count (check `packages/db`)

2. **Clone pagination** (`clone.ts`):
   - Add `maxCloneRecords` config (default 10,000) from server config
   - When no `page` param provided:
     - Count total records across all tables
     - If total > maxCloneRecords: return first N records with `{ paginated: true, next: { table, afterId, limit } }`
     - If total <= maxCloneRecords: return full data (existing behavior)
   - Preserve existing paginated clone behavior when `page` is provided

3. **Extension transport timeout** (`transport.ts`):
   - Add `timeout` option (default 30000ms) to transport config
   - Per RPC request: set `setTimeout` that rejects the Promise and removes from `pending` map
   - Clear timeout on response received
   - Error message: `"RPC request timed out after {timeout}ms"`

4. **Idempotency TTL/LRU** (`idempotency.ts`):
   - Add `createdAt` timestamp to each stored entry
   - Add `sweepInterval` timer (5 min) that evicts entries older than `idempotencyTtlMs`
   - Use `Map` insertion order for LRU: on `get()`, delete+re-insert to move to end
   - On `set()`: if `size >= maxEntries`, delete oldest entry (first Map entry)
   - `unref()` the sweep timer
   - Add `destroy()` method to clear timer

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- `cd datafn/client && bun test` — all tests pass
- New/updated tests:
  - Reconcile returns correct count without loading records (mock db.count)
  - Clone with small dataset → full response
  - Clone with large dataset → paginated response with `next` cursor
  - Extension transport timeout → Promise rejects, pending map cleaned
  - Idempotency: entry evicted after TTL
  - Idempotency: oldest entry evicted when max entries exceeded
  - Idempotency: `destroy()` clears timer

## Stop condition
All 4 CRITICAL scalability issues fixed. No unbounded memory growth paths remain for these components. Report results.
