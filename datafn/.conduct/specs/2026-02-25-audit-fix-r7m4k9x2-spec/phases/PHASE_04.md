# PHASE 04: Client Pull Pagination

## Phase Goal

Add `hasMore` to the server's canonical pull response and implement a client-side catch-up loop that repeats pulls until all changes are retrieved.

## In Scope

- CLIENT-PULL-001: Server emits `hasMore` in canonical pull response
- CLIENT-PULL-002: Client catch-up loop
- CLIENT-PULL-003: Max pull iterations safeguard
- CLIENT-PULL-004: Hook and event semantics during catch-up

## Out of Scope

- Changes to the legacy pull path (global cursor) — only the canonical per-table cursor path is modified
- Changes to `cloneUp` pagination (already implements its own loop)
- WebSocket real-time push behavior

## Deliverables

- Modified: `datafn/server/src/execution/sync/pull.ts` (add `hasMore` to response)
- Modified: `datafn/client/src/sync/apply.ts` (add `hasMore` to `PullResultCanonical` type)
- Modified: `datafn/client/src/sync/engine.ts` (add catch-up loop in `pullWithPerTableCursors`)
- Modified: `datafn/client/src/client.ts` (add `maxPullIterations` to config type)
- New/Modified: `datafn/server/__tests__/sync.test.ts` (add hasMore test vectors)
- New/Modified: `datafn/client/__tests__/sync.test.ts` (add catch-up loop test vectors)

## Requirements Covered

- CLIENT-PULL-001, CLIENT-PULL-002, CLIENT-PULL-003, CLIENT-PULL-004

## Implementation Tasks

### Server: hasMore (CLIENT-PULL-001)

- [ ] **T1**: In `pull.ts` `executePullCanonical()`, after collecting `allChanges` and before `slice(0, limit)`, compute `hasMore`:
  ```typescript
  const hasMore = allChanges.length > limit;
  const limitedChanges = allChanges.slice(0, limit);
  ```
- [ ] **T2**: Add `hasMore` to the returned `PullResultCanonical` object:
  ```typescript
  const result: PullResultCanonical = {
    ok: true,
    records,
    deleted,
    cursors,
    hasMore,
  };
  ```
- [ ] **T3**: Update the `PullResultCanonical` type in `pull.ts` or wherever it's defined server-side to include `hasMore?: boolean`.
- [ ] **T4**: Add test TV-CLIENT-PULL-001: 150 changes, limit 100 → `hasMore: true`.
- [ ] **T5**: Add test TV-CLIENT-PULL-002: 50 changes, limit 100 → `hasMore: false`.

### Client: Type Update

- [ ] **T6**: In `apply.ts`, add `hasMore?: boolean` to `PullResultCanonical` type definition.
- [ ] **T7**: In `client.ts` (or wherever `DatafnClientConfig` is defined), add `maxPullIterations?: number` (default: 50).

### Client: Catch-Up Loop (CLIENT-PULL-002, CLIENT-PULL-003)

- [ ] **T8**: In `engine.ts` `pullWithPerTableCursors()`, refactor the single pull call into a loop:
  ```typescript
  let hasMore = true;
  let iterations = 0;
  const maxIterations = this.config?.maxPullIterations ?? 50;
  let lastResult: any = null;

  while (hasMore && iterations < maxIterations) {
    iterations++;
    const response = await this.remote.pull(transformedPayload);

    if (response.ok && response.result?.ok) {
      lastResult = response.result;
      const { applyPullResult } = await import("./apply.js");
      await applyPullResult(this.storage, lastResult);

      hasMore = lastResult.hasMore === true;
      if (hasMore) {
        // Update cursors for next iteration
        transformedPayload.cursors = { ...transformedPayload.cursors, ...lastResult.cursors };
      }
    } else {
      throw new Error(response.error?.message || "Pull rejected by server");
    }
  }

  if (iterations >= maxIterations && hasMore) {
    console.warn(`[datafn] Pull catch-up reached max iterations (${maxIterations}), stopping. Will resume on next sync cycle.`);
  }
  ```
- [ ] **T9**: Move the `runBeforeSync()` call BEFORE the loop and `runAfterSync()` call AFTER the loop exits.
- [ ] **T10**: Move the `sync_applied` event emission AFTER the loop, computing `cursorDelta` from the initial cursors vs the final cursors.

### Client: Hook and Event Semantics (CLIENT-PULL-004)

- [ ] **T11**: Verify `runBeforeSync()` is called exactly once (before loop), using the initial payload.
- [ ] **T12**: Verify `runAfterSync()` is called exactly once (after loop), using the last successful result.
- [ ] **T13**: Verify `sync_applied` event is emitted once with aggregated cursor deltas.
- [ ] **T14**: Verify `sync_failed` event is emitted if any iteration throws (loop exits on first failure).

### Tests

- [ ] **T15**: Add test TV-CLIENT-PULL-003: mock server returns hasMore=true then hasMore=false → 2 pull calls, 2 apply calls, 1 event.
- [ ] **T16**: Add test TV-CLIENT-PULL-004: mock server returns hasMore=false → 1 pull call, no regression.
- [ ] **T17**: Add test TV-CLIENT-PULL-005: mock server always returns hasMore=true, maxPullIterations=3 → exactly 3 pulls, warning emitted.
- [ ] **T18**: Add test TV-CLIENT-PULL-006: hooks run once across all iterations.
- [ ] **T19**: Run all existing client sync tests to verify no regressions.

## Verification Steps

1. Run: `cd datafn/server && npx vitest run --reporter=verbose __tests__/sync.test.ts`
   - Expected: TV-CLIENT-PULL-001, TV-CLIENT-PULL-002 pass, existing sync tests pass.
2. Run: `cd datafn/client && npx vitest run --reporter=verbose __tests__/sync.test.ts`
   - Expected: TV-CLIENT-PULL-003..006 pass, existing client tests pass.
3. Run: `cd datafn/server && npx vitest run --reporter=verbose`
   - Expected: All server tests pass.
4. Run: `cd datafn/client && npx vitest run --reporter=verbose`
   - Expected: All client tests pass.
5. Run: `cd datafn/server && npx tsc --noEmit && cd ../client && npx tsc --noEmit`
   - Expected: No type errors in either package.

## Stop Condition

Report: (a) all new test results for both server and client, (b) a demonstration scenario showing: "200 pending changes, pullBatchSize=100 → 2 pull iterations, client fully caught up", (c) confirmation existing tests pass in both packages.
