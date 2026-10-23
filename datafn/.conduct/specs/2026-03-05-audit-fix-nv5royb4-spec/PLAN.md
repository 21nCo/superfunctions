# PLAN

## Architecture Sketch
- `server.ts`:
  - Central config plumbing for `maxBatchSize` and `maxBatchQueryConcurrency`.
  - REST bridge should call extracted execution functions, not synthetic HTTP layer.
- `routes/`:
  - `mutation.ts` and `sync.ts` enforce same batch-size cap.
  - `query.ts` refactored into composable modules:
    - `routes/query/validate.ts`
    - `routes/query/batch-executor.ts`
    - `routes/query/handler.ts`
- `execution/`:
  - Shared change-tracking retry helper reused by execute/push.
  - Push atomic mutation unit via transaction-aware path.
  - Query execution optimization fixes (omit-set cache, candidate chunking, no full-scan fallback).
  - Change-tracking write batching abstraction with explicit fallback.
- `logging.ts`:
  - Remove direct console fallback in request logger helper.

## Dependency Graph
1. Config plumbing (`maxBatchSize`, `maxBatchQueryConcurrency`) MUST exist before route enforcement.
2. Shared retry utility MUST exist before execute/push parity changes.
3. Push transaction atomicity depends on retry utility and clear per-mutation unit boundaries.
4. Query batch executor module (bounded concurrency) SHOULD be in place before route split completion.
5. Performance safety fixes (EXE-014/017/018/022) depend on stable execution module boundaries.

## Phases Overview
- Phase 00: Baseline and scaffolding; lock vectors and config contracts.
- Phase 01: Batch size contract (SEC-006).
- Phase 02: Prototype pollution completion (SEC-008).
- Phase 03: Retry parity and atomic push mutation unit (REL-002, REL-011).
- Phase 04: Route hot-path and bridge cleanup (PER-002, SRV-001, LOG-002).
- Phase 05: Bounded query concurrency queue (SRV-003).
- Phase 06: Execution perf/safety fixes (EXE-014, EXE-017, EXE-022).
- Phase 07: Change-tracking write batching (EXE-018).
- Phase 08: Query route modular split (SRV-005).
- Phase 09: Full regression validation and closure report.

## Definition of Done
No phase is complete unless its verification steps pass.
