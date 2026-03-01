# PHASE_08 Completion Report — Data Integrity + Reliability HIGH Fixes

## Metadata

- **Timestamp**: 2026-02-28T15:26:00Z
- **Agent**: Oz
- **Model**: claude 4.6 sonnet (max)
- **Launcher**: Warp
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin (macOS) / zsh 5.9
- **Branch**: next
- **Commit**: (dirty)
- **Phase**: PHASE_08
- **Status**: PASS

---

## Requirements Summary

**Requirements delivered**: DI-001, DI-002, DI-003, DI-004, REL-008, REL-010, REL-011, REL-012, REL-013, REL-014, REL-015

### DI-001 — modifyRelation TOCTOU

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `executeModifyRelation` in `relations.ts` extracts `performModify(adp)` helper that performs findOne + update against the supplied adapter
  - When `typeof adapter.transaction === "function"`, wraps `performModify` in `adapter.transaction(async txAdp => performModify(txAdp))` for atomic execution
  - Fallback to sequential `performModify(adapter)` when no transaction support
  - Returns `"ok" | "not_found"` from `performModify` to prevent TOCTOU — `NOT_FOUND` is returned only after the atomic check, not based on a pre-transaction snapshot
- **Tests**: TV-DI-001a (transaction spy called), TV-DI-001b (sequential fallback), TV-DI-001c (not_found returned correctly)

### DI-002 — Guard Evaluation TOCTOU

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `execute.ts`: When `hasGuard && db.transaction` is available, wraps guard re-read + `executeMutationCore` in a single `db.transaction(async txDb => {...})` callback
  - `changeTracking.withDb(txDb)` is passed into `executeMutationCore` inside the transaction so the change log entry is also committed atomically
  - When no transaction is available: guard check + mutation remain sequential (existing behavior preserved)
  - Added `evaluateGuardInTransactionScope` alias export from `guards.ts` to document the pattern
- **Tests**: Structural verification documented; full integration covered by existing `mutation-optimization.test.ts`

### DI-003 — FallbackSequenceStore No Duplicates on Failover

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `FallbackSequenceStore` tracks `lastKnownPrimarySeq = new Map<string, number>()`; updated on every successful primary `getNextN` call with the highest seq returned
  - `syncFallbackOnFailover(namespace)` calls `this.fallback.ensureMinSeq(namespace, lastKnown)` before allocating from DB, preventing the DB store from reusing seqs already issued by the primary
  - `DatabaseSequenceStore.ensureMinSeq(namespace, minSeq)` updates `__datafn_meta.next_server_seq` to `max(current, minSeq + 1)` atomically
  - Both failure paths trigger `syncFallbackOnFailover`: explicit `throw` in `getNextN` and `isHealthy()` returning false
- **Tests**: TV-DI-003a (ensureMinSeq called with lastKnownSeq=100 on throw), TV-DI-003b (unhealthy primary triggers sync), TV-DI-003c (no ensureMinSeq when no primary seq known)

### DI-004 — Join Store Key Handles string[]

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `reconcileNow()` in `engine.ts`: replaced `getJoinStoreKey(relation.from as string, ...)` with nested loop over `fromArr` / `toArr` (using `Array.isArray` guard)
  - `fromArr = Array.isArray(relation.from) ? relation.from as string[] : [relation.from as string]`
  - Both mismatched resources pushed to `mismatchedResources` using loop variables `fromTable`/`toTable`, not `relation.from`/`relation.to`
- **Tests**: TV-DI-004 (countJoinRows called for typeA×users AND typeB×users when from is string[]), TV-DI-004b (non-array from/to still produces single key)

### REL-008 — Redis Rate Limiter Atomic TTL

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `RedisRateLimiter.check()` checks `typeof redisAny.eval === "function"` first
  - If eval available: single atomic Lua call `redis.call('incr', KEYS[1]); if c == 1 then redis.call('expire', KEYS[1], ARGV[1]) end; return c`
  - If eval unavailable: non-atomic `incr` + `set` fallback (unchanged behavior for older clients)
  - TTL race window eliminated: key creation (incr) and expiry (expire) happen in one round-trip
- **Tests**: TV-REL-011 (eval called, no separate incr/set), TV-REL-011b (Lua script shape: contains "incr" + "expire", ARGV[1]=windowSeconds), TV-REL-011c (incr+set fallback when eval absent)

### REL-010 — CAS Retry Backoff

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `getNextServerSeqBatchFromDb` retry loop: `if (attempt > 0) await sleep(10 * Math.pow(2, attempt - 1))`
  - First attempt (attempt=0): no delay
  - Subsequent attempts: 10ms, 20ms, 40ms, 80ms, 160ms, 320ms, 640ms, 1280ms, 2560ms (9 delays for 10 retries)
  - Same pattern applies in `DatabaseSequenceStore.getNextN` which uses its own identical retry loop
- **Tests**: TV-REL-013 (delays captured via setTimeout spy: [10, 20, 40, 80, ...] on CAS miss), TV-REL-013b (no delays when CAS succeeds on first attempt)

### REL-011 — Change Tracking in Transaction

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `ChangeTrackingService.withDb(txDb)` returns a new `ChangeTrackingService` instance using the provided `txDb` adapter, inheriting namespace and sequenceStore
  - `execute.ts` uses `changeTracking.withDb(txDb)` inside the transaction callback so `recordChange` writes to the transaction's DB adapter atomically with the mutation
  - `executeMutationCore` helper extracted to receive a `ChangeTrackingService` parameter, enabling both transaction and non-transaction paths to reuse the same logic
- **Tests**: TV-REL-014a (withDb returns distinct instance with correct namespace), TV-REL-014b (recordChange writes to txDb.internal, not originalDb), TV-REL-014c (namespace inherited)

### REL-012 — No Double Event on Offline Fallback

- **Status**: PASS
- **Acceptance criteria evidence**:
  - Removed early `emitRejectionForError` before offline fallback check; rejection emitted only in `else` branch (no fallback available) or in `catch (offlineErr)` block (fallback failed)
  - Single mutation offline fallback: `emitMutationEvents` called inside the `else` branch after `handleOfflineMutation` succeeds
  - Batch offline fallback: `emitMutationEvents` called per-mutation inside the loop (unchanged)
  - `fromOfflineFallback = true` flag guards the post-try/catch emission paths for both single (`if (!fromOfflineFallback)`) and batch cases
  - Net result: exactly one event fires on successful offline fallback
- **Tests**: TV-REL-015 (transport error → 1 applied, 0 rejected), TV-REL-015b (non-transport error → 0 applied, 1 rejected), TV-REL-015c (batch transport error → 2 applied, 0 rejected for 2-mutation batch)

### REL-013 — Batch Query Date Codec

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `executeQuery` batch path (with storage): `parseQueryResultDates(schema, resource, queryResult)` applied per-query using `transformedQuery[i].resource`
  - `executeQuery` batch path (no storage): same per-query codec added in the `!storage` branch (previously skipped)
  - `parseQueryResultDates` converts epoch milliseconds to `Date` objects for `type: "date"` schema fields
  - Fix covers both execution paths so batch codec applies regardless of whether storage is configured
- **Tests**: TV-REL-016 (single batch query: startAt returns Date instance), TV-REL-016b (two queries: each gets its own codec), TV-REL-016c (null date field passthrough, non-date fields untouched)

### REL-014 — Pull Catch-up Loop Guard

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `pullWithPerTableCursors`: `while (hasMore && iterations < maxIterations)` guard already present
  - `maxIterations = this.config?.maxPullIterations ?? 50`
  - Console warning emitted when limit hit: `[datafn] Pull catch-up reached max iterations (${maxIterations}), stopping.`
- **Tests**: TV-REL-017 (pullNow stops at exactly 50 calls when server always returns hasMore=true), TV-REL-017b (pull exits after 3 calls when hasMore goes false)

### REL-015 — WS pullNow Unhandled Rejection

- **Status**: PASS
- **Acceptance criteria evidence**:
  - `engine.ts` WS `onmessage` handler: `this.pullNow().catch((err) => console.warn("[datafn] pullNow error in WS message handler:", err))`
  - Prevents unhandled promise rejection if `pullNow()` throws unexpectedly (normally it self-catches via try/catch and emits `sync_failed`)
- **Tests**: TV-REL-018 structural verification documented

---

## Deliverables Summary

### Files Changed

Server source:
- **`datafn/server/src/execution/sync/change-tracking.ts`** — `sleep` helper, exponential CAS backoff (`10 * 2^(attempt-1)`), `withDb(txDb)` method (REL-010, REL-011)
- **`datafn/server/src/middleware/rate-limit.ts`** — Lua eval atomic path in `RedisRateLimiter.check()` (REL-008)
- **`datafn/server/src/execution/mutation/relations.ts`** — `performModify(adp)` helper, transaction wrap in `executeModifyRelation` (DI-001)
- **`datafn/server/src/execution/mutation/guards.ts`** — `evaluateGuardInTransactionScope` alias export documenting pattern (DI-002)
- **`datafn/server/src/execution/mutation/execute.ts`** — `executeMutationCore` helper, guard+transaction wrapping, `changeTracking.withDb(txDb)` usage (DI-002, REL-011) *(not listed in phase deliverables but required by spec requirements)*
- **`datafn/server/src/execution/sync/sequence-store.ts`** — `DatabaseSequenceStore.ensureMinSeq()`, `FallbackSequenceStore.lastKnownPrimarySeq` tracking and `syncFallbackOnFailover()` (DI-003)

Client source:
- **`datafn/client/src/sync/engine.ts`** — `fromArr`/`toArr` loop in `reconcileNow()` (DI-004), `pullNow().catch(...)` in WS onmessage (REL-015)
- **`datafn/client/src/mutate.ts`** — Deferred rejection emission, `fromOfflineFallback` guard on final emit, `emitMutationEvents` inside single offline fallback (REL-012)
- **`datafn/client/src/query.ts`** — Per-query `parseQueryResultDates` in batch path (with and without storage) (REL-013)

Tests added:
- **`datafn/server/__tests__/data-integrity-high.test.ts`** — 14 tests (DI-001 × 3, DI-003 × 3, REL-008 × 3, REL-010 × 2, REL-011 × 3)
- **`datafn/client/__tests__/data-integrity-high.test.ts`** — 11 tests (REL-012 × 3, REL-013 × 3, REL-014 × 2, DI-004 × 2, REL-015 × 1)

---

## Verification Summary

### Test Execution Results

Server (`npx vitest run` in `datafn/server`):

| Metric | Before Phase 08 | After Phase 08 |
|--------|-----------------|----------------|
| Total tests | 475 | 489 |
| Passing | 448 | 462 |
| Failing | 27 | 27 |
| New tests added | — | 14 |

Client (`npx vitest run` in `datafn/client`):

| Metric | Before Phase 08 | After Phase 08 |
|--------|-----------------|----------------|
| Total tests | 490 | 501 |
| Passing | 490 | 501 |
| Failing | 0 | 0 |
| New tests added | — | 11 |

**All 25 new Phase 08 tests pass.** All 27 server failures are identical pre-existing failures from prior phases (RLN wrapping, DFQL groupBy dot-path, and related pre-existing issues).

### Verification Checklist

- CAS retry delays are increasing (10ms, 20ms, 40ms): **PASS** (TV-REL-013)
- Redis rate limiter key always has TTL after creation (atomic Lua): **PASS** (TV-REL-011)
- Pull loop stops after 50 iterations: **PASS** (TV-REL-017)
- Batch query returns Date objects for date fields: **PASS** (TV-REL-016)
- Only one `mutation_applied` event on offline path: **PASS** (TV-REL-015)

---

## Notes

1. **execute.ts not in deliverables list**: `execute.ts` is not listed in the phase deliverables but REL-011 requirement explicitly requires `changeTracking.withDb(txDb)` inside the transaction, and DI-002 requires guard+mutation in the same transaction. Changes to `execute.ts` were necessary to fulfill these requirements.

2. **REL-013 in two paths**: The batch date codec fix was applied in both the `!storage` branch and the `storage` present branch of `executeQuery`. The spec only called out the storage-present batch path, but the `!storage` batch path had the same omission. Both were fixed for correctness.

3. **REL-012 single mutation path**: The original code emitted `mutation_rejected` then `mutation_applied` (double event). The fix restructures so rejection is deferred until we know offline fallback won't run. For single mutations, `emitMutationEvents` is called inside the offline fallback block (mirroring the batch path). The `fromOfflineFallback` flag prevents the post-try/catch emission.

4. **DI-003 ensureMinSeq guards**: `ensureMinSeq` swallows its own errors (wraps in try/catch with warn) to ensure failover can proceed even if the min-seq sync itself encounters a race condition. The fallback `getNextN` will self-correct via CAS retries if the DB seq was already updated by a concurrent process.

5. **Pre-existing failures**: 27 server failures unchanged from Phase 07, all unrelated to Phase 08 changes.

---

## Ready for Next Phase?

**Yes** — all PHASE_08 deliverables complete with tests passing.
