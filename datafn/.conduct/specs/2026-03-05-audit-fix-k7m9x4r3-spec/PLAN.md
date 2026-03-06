# PLAN: Error Handling Audit Fix

## Architecture Sketch

All changes are within these modules:

| Module | Responsibility | Changes |
|--------|---------------|---------|
| `datafn/server/src/routes/` | Route handlers — entry points | Pass `logger` to child functions |
| `datafn/server/src/execution/` | Execution layer — mutations, queries, sync | Add `logger` params, add logging to catch blocks |
| `datafn/server/src/ws.ts` | WebSocket manager | Add logging to catch blocks |
| `datafn/server/src/http/middleware.ts` | HTTP middleware | Add logging to catch block |
| `datafn/server/src/server.ts` | Server setup | Pass `logger` to REST routes, log namespace errors |

No new files are created. No new packages. No new exports.

## Dependency Graph

```
PHASE_00: Pass logger where function signatures already accept it
    ↓
PHASE_01: Add logger parameter to functions that lack it + update callers
    ↓
PHASE_02: Add logging to all catch blocks (now that logger is available) + fix RETURN-ZERO
    ↓
PHASE_03: Low-priority fixes — WebSocket logging, CAS retry logging, idempotency narrowing
```

PHASE_00 has no dependencies.
PHASE_01 depends on PHASE_00 only conceptually (could run independently).
PHASE_02 depends on PHASE_01 (logger must be available before catch blocks can log).
PHASE_03 depends on nothing (independent, low-priority).

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|-------|------|---------------------|--------------|
| PHASE_00 | Pass `logger` to 3 execution functions that already accept it + add outer catch logging | Mutation, transaction, and reconcile routes have full logging | `npx vitest run datafn/server` — all existing tests pass |
| PHASE_01 | Add `logger` parameter to 4 functions that lack it + wire from callers | `executeClone`, `createRestRoutes`, `DbDataStore.create/forPushdownResult` accept logger | `npx vitest run datafn/server` — all existing tests pass |
| PHASE_02 | Add logging to all 20+ catch blocks + fix RETURN-ZERO patterns | All catch blocks log errors. `getLatestServerSeq` and `getCurrent` propagate errors. | `npx vitest run datafn/server` — all existing tests pass + new error-logging tests |
| PHASE_03 | WebSocket logging, CAS retry logging, idempotency refinements | All remaining audit findings resolved | `npx vitest run datafn/server` — all tests pass |

## Definition of Done (Global)

No phase is complete unless:
1. All verification steps pass.
2. `npx vitest run datafn/server` passes with no regressions.
3. No new TypeScript compilation errors (`npx tsc --noEmit` in `datafn/server`).
4. The specific requirements listed for that phase are met.
