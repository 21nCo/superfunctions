# PHASE_01: Add Logger Parameter to Functions That Lack It

## Phase Goal

Add `logger?: DatafnLogger` parameter to the 4 functions/constructors that currently lack it, and wire the parameter from all callers.

## In Scope

- LOG-004: Add `logger` param to `executeClone()` + pass from sync route
- LOG-005: Add `logger` param to `createRestRoutes()` + pass from `server.ts`
- LOG-006: Add `logger` param to `DbDataStore.create()` and `forPushdownResult()`
- LOG-010 (partial): Add `logger` to `DatabaseIdempotencyStore` (class property or constructor)
- LOG-011: Add `logger` param to `recordChangeWithRetry()`
- LOG-013: Add `logger` param to `readBodyWithLimit()`

## Out of Scope

- Actually adding logging statements to catch blocks (PHASE_02)
- WebSocket logging (PHASE_03)

## Deliverables

| File | Change |
|------|--------|
| `datafn/server/src/execution/sync/clone.ts` | Add `logger?: DatafnLogger` as last param to `executeClone()`. Add import. |
| `datafn/server/src/routes/sync.ts` | Pass `logger` to `executeClone()` call (~line 79-85) |
| `datafn/server/src/routes/rest.ts` | Add `logger?: DatafnLogger` as last param to `createRestRoutes()`. Add import. |
| `datafn/server/src/server.ts` | Pass `logger` to `createRestRoutes()` call |
| `datafn/server/src/execution/db-store.ts` | Add `logger?: DatafnLogger` to `create()` and `forPushdownResult()` signatures. Add import. |
| `datafn/server/src/execution/db-store.ts` callers | Pass `logger` where `DbDataStore.create()` / `forPushdownResult()` are called |
| `datafn/server/src/execution/idempotency-db.ts` | Add `logger?: DatafnLogger` to constructor. Store as `this.logger`. Add import. |
| `datafn/server/src/execution/sync/push.ts` | Add `logger?: DatafnLogger` to `recordChangeWithRetry()` |
| `datafn/server/src/http/middleware.ts` | Add `logger?: DatafnLogger` to `readBodyWithLimit()`. Add import. |
| All callers of `readBodyWithLimit` | Pass `logger` where available |

## Requirements Covered

LOG-004, LOG-005, LOG-006, LOG-010 (partial — constructor only), LOG-011, LOG-013

## Implementation Tasks

1. [ ] **`clone.ts`**: Add `logger?: DatafnLogger` as the last parameter to `executeClone()`. Add `import type { DatafnLogger } from "../../logger.js";`.
2. [ ] **`sync.ts`**: In the clone route handler, add `logger` as the last argument to `executeClone()` call (~line 85).
3. [ ] **`rest.ts`**: Add `logger?: DatafnLogger` as the last parameter to `createRestRoutes()`. Add the import.
4. [ ] **`server.ts`**: Find where `createRestRoutes()` is called. Pass `logger` as the last argument.
5. [ ] **`db-store.ts`**: Add `logger?: DatafnLogger` to `static async create()` and `static async forPushdownResult()` signatures. Add import. Store on the instance so catch blocks can use it in PHASE_02.
6. [ ] Find all callers of `DbDataStore.create()` and `DbDataStore.forPushdownResult()` and pass `logger` where available.
7. [ ] **`idempotency-db.ts`**: Add `logger?: DatafnLogger` to the constructor. Store as `private logger?: DatafnLogger`. Add import.
8. [ ] Find where `DatabaseIdempotencyStore` is constructed and pass `logger`.
9. [ ] **`push.ts`**: Add `logger?: DatafnLogger` as the last parameter to `recordChangeWithRetry()`. Update all calls to pass `logger`.
10. [ ] **`middleware.ts`**: Add `logger?: DatafnLogger` to `readBodyWithLimit()`. Add import. Update callers to pass `logger`.
11. [ ] Run `npx vitest run datafn/server` — all tests must pass.

## Verification Steps

1. `npx vitest run datafn/server` — all existing tests pass.
2. TypeScript compilation check — no errors.
3. Grep verification:
   - `grep "logger" datafn/server/src/execution/sync/clone.ts` — shows logger parameter
   - `grep "logger" datafn/server/src/routes/rest.ts` — shows logger parameter
   - `grep "logger" datafn/server/src/execution/db-store.ts` — shows logger in create/forPushdownResult
   - `grep "logger" datafn/server/src/execution/idempotency-db.ts` — shows logger in constructor

## Expected Outcomes

- All execution functions now have a `logger` parameter available.
- All callers pass `logger` through.
- No behavioral changes yet — catch blocks still swallow errors (fixed in PHASE_02).

## Stop Condition

Report: all files modified, all tests pass, grep confirms logger parameters added.
