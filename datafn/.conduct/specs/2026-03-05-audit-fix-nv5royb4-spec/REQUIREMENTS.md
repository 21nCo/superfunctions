# REQUIREMENTS

## Table of Contents
- FIX-SEC-006
- FIX-SEC-008
- FIX-REL-002
- FIX-REL-011
- FIX-PER-002
- FIX-SRV-001
- FIX-SRV-003
- FIX-SRV-005
- FIX-EXE-014
- FIX-EXE-017
- FIX-EXE-018
- FIX-EXE-022
- FIX-LOG-002

### FIX-SEC-006
- ID: FIX-SEC-006
- Priority: P0
- Statement: Server MUST enforce a configurable `limits.maxBatchSize` (default 500) on both `/datafn/push` and `/datafn/mutation` batch payloads.
- Rationale: Current enforcement is hardcoded and only complete on one endpoint, leaving DoS and config drift risk.
- Acceptance criteria:
  - `DatafnServerConfig.limits.maxBatchSize` exists and defaults to 500.
  - `/datafn/push` rejects `mutations.length > maxBatchSize` with `DFQL_INVALID`.
  - `/datafn/mutation` rejects array bodies with length `> maxBatchSize` with `DFQL_INVALID`.
  - Error message includes actual count and configured max.
- Test vectors: TV-SEC-006-P1, TV-SEC-006-N1, TV-SEC-006-P2, TV-SEC-006-N2
- Notes: This requirement does not alter single-mutation object payload behavior.

### FIX-SEC-008
- ID: FIX-SEC-008
- Priority: P0
- Statement: Validation MUST reject `__proto__`, `constructor`, and `prototype` recursively across full query payload, aggregations, and having clause in addition to existing mutation/filter checks.
- Rationale: Partial coverage still leaves prototype-pollution entry points.
- Acceptance criteria:
  - Query-level validation checks pollution keys before further parsing.
  - Aggregations object is checked recursively.
  - Having object is checked recursively.
  - Rejection code is `DFQL_INVALID` with message containing `Disallowed key`.
- Test vectors: TV-SEC-008-P1, TV-SEC-008-N1, TV-SEC-008-N2
- Notes: Behavior must be consistent with existing mutation/filter pollution errors.

### FIX-REL-002
- ID: FIX-REL-002
- Priority: P0
- Statement: Both execute-mutation and push paths MUST apply the same change-tracking retry policy (2 retries, 50ms then 100ms) and fail mutation if retries exhaust.
- Rationale: Push currently retries but execute path does not, creating inconsistent reliability.
- Acceptance criteria:
  - A shared retry helper is used by both paths.
  - Transient first/second attempt failures can recover and return success.
  - Persistent failures return mutation failure (`INTERNAL`) and do not report applied success.
- Test vectors: TV-REL-002-P1, TV-REL-002-N1
- Notes: Retries MUST not mask permanent errors.

### FIX-REL-011
- ID: FIX-REL-011
- Priority: P0
- Statement: Push mutation operation and its change-tracking writes MUST execute in the same transaction when adapter transactions are supported.
- Rationale: Current phased push path can commit data without durable change entry.
- Acceptance criteria:
  - In transaction-capable adapters, operation + change entry commit atomically per mutation.
  - Failure in change-tracking write rolls back mutation data write.
  - Non-transaction adapters keep explicit non-atomic fallback with warning log.
- Test vectors: TV-REL-011-P1, TV-REL-011-N1
- Notes: Atomicity is per mutation unit, not whole push batch.

### FIX-PER-002
- ID: FIX-PER-002
- Priority: P1
- Statement: Route hot paths MUST NOT use dynamic `await import(...)`; imports MUST be static top-level.
- Rationale: Dynamic imports add avoidable per-request overhead.
- Acceptance criteria:
  - No `await import(` remains in route handlers (`routes/*.ts`).
  - Existing functionality remains unchanged.
- Test vectors: TV-PER-002-P1, TV-PER-002-N1
- Notes: This includes mutation route authz import.

### FIX-SRV-001
- ID: FIX-SRV-001
- Priority: P1
- Statement: REST wrappers MUST invoke query/mutation execution without constructing synthetic `Request` objects.
- Rationale: Synthetic request wrapping is allocation-heavy and couples internal route contracts.
- Acceptance criteria:
  - REST bridge in server factory no longer constructs `new Request(...)` for internal dispatch.
  - REST behavior and envelopes stay unchanged.
- Test vectors: TV-SRV-001-P1, TV-SRV-001-N1
- Notes: Internal helper extraction is allowed.

### FIX-SRV-003
- ID: FIX-SRV-003
- Priority: P1
- Statement: Batch query handling MUST enforce bounded in-flight concurrency (default 20) by queueing excess queries, not by rejecting batches over concurrency.
- Rationale: Current behavior rejects over threshold and still uses unbounded `Promise.all` for accepted batches.
- Acceptance criteria:
  - `limits.maxBatchQueryConcurrency` config exists (default 20).
  - Batch size > concurrency is accepted and processed fully.
  - In-flight execution count never exceeds configured concurrency.
- Test vectors: TV-SRV-003-P1, TV-SRV-003-N1
- Notes: This requirement does not remove payload-size controls.

### FIX-SRV-005
- ID: FIX-SRV-005
- Priority: P2
- Statement: Query route implementation MUST be split into focused modules (validation, batch orchestration, execution bridge) with no behavior changes.
- Rationale: Current monolith is difficult to audit and maintain.
- Acceptance criteria:
  - `routes/query.ts` becomes thin composition/orchestration.
  - New modules exist with single responsibility.
  - Existing API behavior remains byte-for-byte equivalent for golden vectors.
- Test vectors: TV-SRV-005-P1, TV-SRV-005-N1
- Notes: Refactor-only requirement, no protocol changes.

### FIX-EXE-014
- ID: FIX-EXE-014
- Priority: P2
- Statement: FK omit-set derivation in select materialization MUST be computed once per query context rather than repeatedly per record.
- Rationale: Current per-record recomputation increases CPU with large result sets.
- Acceptance criteria:
  - Omit-set cache keyed by target resource/relation context is used.
  - CPU profile for large one-many expansions drops relative to baseline.
- Test vectors: TV-EXE-014-P1, TV-EXE-014-N1
- Notes: Output ordering/content must remain unchanged.

### FIX-EXE-017
- ID: FIX-EXE-017
- Priority: P2
- Statement: Search candidate processing MUST page through all candidate IDs beyond chunk size (1000) instead of truncating to first 1000.
- Rationale: Truncation causes silent false negatives in query results.
- Acceptance criteria:
  - Candidate IDs are processed in deterministic chunks.
  - Final filter semantics include all candidates.
  - No silent truncation warning-only path remains.
- Test vectors: TV-EXE-017-P1, TV-EXE-017-N1
- Notes: Chunk size MAY be configurable but default MUST remain 1000.

### FIX-EXE-018
- ID: FIX-EXE-018
- Priority: P2
- Statement: `recordChanges` MUST perform batched writes when batch capability is available, with deterministic fallback behavior when unavailable.
- Rationale: Sequential internal inserts increase latency under high change volume.
- Acceptance criteria:
  - Preferred path performs one batched write call per group.
  - If batch capability is unavailable, fallback path remains correct and deterministic.
  - Error behavior remains fail-fast and explicit.
- Test vectors: TV-EXE-018-P1, TV-EXE-018-N1
- Notes: Capability detection MUST be explicit and logged.

### FIX-EXE-022
- ID: FIX-EXE-022
- Priority: P2
- Statement: Secondary resource loading in `forQuery` MUST NOT fall back to full-table scan (`where: []`) on unknown/unhandled relation types.
- Rationale: Full-table fallback can violate performance and isolation assumptions.
- Acceptance criteria:
  - Unknown direct relation path returns empty-target behavior with warning.
  - Unhandled relation type path also avoids full scan.
  - No `findMany(... where: [])` branch remains for this fallback.
- Test vectors: TV-EXE-022-P1, TV-EXE-022-N1
- Notes: Preserve existing explicit fallback warning logging.

### FIX-LOG-002
- ID: FIX-LOG-002
- Priority: P1
- Statement: Request logging helpers MUST NOT use direct `console.*` fallback and MUST route through `DatafnLogger`.
- Rationale: Direct console calls break pluggable logging guarantees and structured logging consistency.
- Acceptance criteria:
  - `logRequest` has no `console.log` fallback.
  - Server initialization guarantees a logger instance for all routes.
- Test vectors: TV-LOG-002-P1, TV-LOG-002-N1
- Notes: Existing `createDefaultLogger` may still use console internally by design.
