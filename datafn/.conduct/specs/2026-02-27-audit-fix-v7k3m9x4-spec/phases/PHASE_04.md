# PHASE 04: Client Reliability CRITICAL

## Phase goal
Fix client-side reliability issues: debouncer orphaned Promises, duplicate timers, clone error handling.

## In scope
- REL-C4: DebouncerMap orphaned Promises
- REL-C5: SyncEngine duplicate push timer guard
- REL-C6: Background clone error handling

## Out of scope
- Server-side reliability (Phase 02)
- HIGH client reliability (Phase 08)

## Deliverables
- `datafn/client/src/debounce.ts` — Resolve old Promise on supersede
- `datafn/client/src/sync/engine.ts` — Timer guard + clone error handling

## Requirements covered
REL-004, REL-005, REL-006

## Implementation tasks
1. **DebouncerMap fix** (`debounce.ts`):
   - In `set()`, when key already exists in pending map:
     - Call `oldEntry.resolve()` before replacing callbacks
     - This resolves the original caller's Promise (data was merged, not lost)
   - Verify no Promise leaks via test with repeated set() calls

2. **Timer guard** (`engine.ts`):
   - At start of `start()`:
     ```typescript
     if (this.pushTimer) return;
     ```
   - Ensure `stop()` sets `this.pushTimer = null` after clearing

3. **Clone error handling** (`engine.ts`):
   - Replace unhandled `setTimeout(async () => { await this.cloneResources(tables); }, 0)` with:
     ```typescript
     setTimeout(async () => {
       try {
         await this.cloneResources(tables);
       } catch (error) {
         this.emit("sync_failed", { error, operation: "clone", tables });
         // Mark tables as failed, not stuck in hydrating
         for (const table of tables) {
           this.hydrationState.set(table, "failed");
         }
       }
     }, 0);
     ```

## Verification steps
- `cd datafn/client && bun test` — all tests pass
- New tests:
  - DebouncerMap: `set("k", a)` → P1, `set("k", b)` → P2. Assert P1 resolves. Assert P2 works on flush
  - DebouncerMap: 100 rapid set() calls for same key → no hanging Promises
  - SyncEngine: `start()` twice → only one timer
  - SyncEngine: clone throws → `sync_failed` emitted, state not `hydrating`

## Stop condition
All 3 client CRITICAL reliability issues fixed. No orphaned Promises, no duplicate timers, no silent clone failures. Report results.
