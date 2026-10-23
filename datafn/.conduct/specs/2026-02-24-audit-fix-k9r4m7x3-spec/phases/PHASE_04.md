# PHASE 04: Bounded Sync Pull

## Phase Goal

Add limit enforcement to `getChangesSince()` and `executePullCanonical()` to prevent unbounded memory usage from long-dormant clients.

## In Scope

- Add `limit` parameter to `getChangesSince()` in `change-tracking.ts`
- Pass limit to internal `findMany` call
- Enforce server-side `maxPullLimit` in `executePullCanonical()`
- Add `limits.maxPullLimit` to `DatafnServerConfig`

## Out of Scope

- Global pull path (already has limit via `getGlobalChanges`)
- Client-side sync changes

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/sync/change-tracking.ts` | MODIFY — add limit to `getChangesSince()` |
| `datafn/server/src/execution/sync/pull.ts` | MODIFY — pass limit to per-resource fetches |
| `datafn/server/src/server.ts` | MODIFY — add `maxPullLimit` to limits config |
| `datafn/server/__tests__/sync-bounded.test.ts` | CREATE — bounded sync tests |

## Requirements Covered

- SYNC-001 (Bounded getChangesSince)
- SYNC-002 (Server-enforced pull limit)
- SYNC-003 (maxPullLimit config)

## Implementation Tasks

1. Modify `ChangeTrackingService.getChangesSince()`:
   - Change signature to accept `limit?: number`
   - Pass `limit` to `this.db.internal.findMany(...)` opts
   ```typescript
   async getChangesSince(params: {
     resource: string;
     sinceSeq: number;
     limit?: number;  // NEW
   }): Promise<ChangeEntry[]>
   ```
   - In the implementation: `{ orderBy: "server_seq", limit: params.limit }` when limit is provided

2. Modify `executePullCanonical()` in `pull.ts`:
   - Accept `maxPullLimit` parameter (or receive via config)
   - Compute effective limit: `Math.min(request.limit ?? 200, maxPullLimit)`
   - Pass `limit: effectiveLimit` to each `getChangesSince()` call
   - The existing `allChanges.slice(0, limit)` continues as the cross-resource cap

3. Add `maxPullLimit` to server config:
   - Type: `limits?: { ..., maxPullLimit?: number }`
   - Default: 1000
   - Thread through to `createPullHandler`

4. Tests:
   - TV-SYNC-BOUND-001: getChangesSince with limit returns bounded results
   - TV-SYNC-BOUND-002: getChangesSince without limit returns all (backward compat)
   - TV-SYNC-BOUND-003: Pull canonical with large client limit gets capped by server
   - Regression: existing sync.test.ts and sync-ordering.test.ts pass

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/sync-bounded.test.ts
npx vitest run __tests__/sync.test.ts
npx vitest run __tests__/sync-ordering.test.ts
npx tsc --noEmit
```

**Expected**: All bounded sync tests pass. Existing sync tests unaffected.

## Stop Condition

Report: Bounded sync implemented. getChangesSince respects limit. Server enforces maxPullLimit. No regressions.
