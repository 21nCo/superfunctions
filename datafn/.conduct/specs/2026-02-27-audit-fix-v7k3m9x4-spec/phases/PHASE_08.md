# PHASE 08: Data Integrity + Reliability HIGH

## Phase goal
Fix TOCTOU races, sequence failover, client reliability issues (double event, date codec, pull loop, pullNow, CAS backoff, Redis TTL race).

## In scope
- DI-H1: modifyRelation TOCTOU
- DI-H2: Guard evaluation TOCTOU
- DI-H3: FallbackSequenceStore dedup
- DI-H4: Join store key for multi-resource
- REL-H2: Redis rate limiter TTL race
- REL-H4: CAS retry backoff
- REL-H5: Mutation change tracking ordering
- REL-H7: Double event emission
- REL-H8: Batch query date codec
- REL-H9: Pull catch-up loop guard
- REL-H10: WS pullNow await

## Out of scope
- CRITICAL issues (done in Phases 01-04)

## Deliverables
- `datafn/server/src/execution/mutation/relations.ts` — Atomic modifyRelation
- `datafn/server/src/execution/mutation/guards.ts` — Guard in transaction scope
- `datafn/server/src/execution/sync/sequence-store.ts` — Failover dedup
- `datafn/client/src/sync/engine.ts` — Pull loop guard, pullNow await, join store key fix
- `datafn/client/src/mutate.ts` — Single event emission
- `datafn/client/src/query.ts` — Batch date codec
- `datafn/server/src/execution/sync/change-tracking.ts` — CAS backoff
- `datafn/server/src/middleware/rate-limit.ts` — Atomic Redis TTL

## Requirements covered
DI-001, DI-002, DI-003, DI-004, REL-008, REL-010, REL-011, REL-012, REL-013, REL-014, REL-015

## Implementation tasks
1. **modifyRelation atomic** (`relations.ts`):
   - Wrap `findOne` + `update` in transaction when adapter supports it
   - If no transaction: use optimistic check (verify record still exists during update)

2. **Guard in transaction** (`guards.ts` or `execute.ts`):
   - Move guard evaluation inside the mutation's transaction scope
   - Guard re-reads record within transaction, ensuring consistency

3. **Sequence failover** (`sequence-store.ts`):
   - On Redis→DB failover, read max existing serverSeq from DB before allocating
   - Ensure next allocated seq > max(existing)

4. **Join store key** (`engine.ts`):
   - Check `Array.isArray(from)` / `Array.isArray(to)` before constructing key
   - Use sorted join with separator for array values

5. **CAS backoff** (`change-tracking.ts`):
   - Replace zero-delay retry with exponential backoff: `await sleep(10 * Math.pow(2, attempt))`

6. **Redis TTL race** (`rate-limit.ts`):
   - Replace `incr` + separate `set` TTL with atomic operation:
     - Lua script: `EVAL "local c = redis.call('incr', KEYS[1]); if c == 1 then redis.call('expire', KEYS[1], ARGV[1]) end; return c"`
     - Or use `SET key 1 NX EX windowSec` + `INCR` pattern

7. **Change tracking in transaction** (`execute.ts`):
   - When `db.transaction` is available, include `recordChange` call inside the transaction callback
   - Ensure atomicity of mutation + change log

8. **Double event** (`mutate.ts`):
   - Identify the two emission points for offline fallback
   - Guard with `let emitted = false` flag, only emit once

9. **Batch date codec** (`query.ts`):
   - Apply same date codec transform to batch query results as single query

10. **Pull loop guard** (`engine.ts`):
    - Verify `maxIterations` guard is enforced in the pull catch-up while loop
    - If missing: add `if (iterations++ >= 50) break;`

11. **pullNow await** (`engine.ts`):
    - For WS-triggered pullNow calls, use `.catch(err => this.emit("sync_failed", { error: err }))`

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- `cd datafn/client && bun test` — all tests pass
- Tests:
  - CAS retry has increasing delays
  - Redis rate limiter: key always has TTL after creation
  - Pull loop stops after 50 iterations
  - Batch query returns Date objects for date fields
  - Only one `mutation_applied` event on offline path

## Stop condition
All data integrity and HIGH reliability issues fixed. Report results.
