# PHASE_08

## Phase goal
Ensure processing is triggered after upload completion and that FlowFn enqueue behavior matches spec expectations.

## In scope
- Trigger processing on upload completion when enabled.
- Enqueue processing via FlowFn when provided.
- Ensure retries are idempotent (no duplicate artifacts).

## Out of scope
- Adding new processors.

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/service.ts` (trigger processing)
  - `/Users/ar/dev/superfunctions/filefn/server/src/processing/service.ts` (enqueue/idempotency)
  - `/Users/ar/dev/superfunctions/filefn/server/src/index.ts` (processing config wiring)
- Tests:
  - Extend `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/processing.test.ts` (or add)

## Requirements covered
- PROCESS-003

## Implementation tasks
1. Define a stable processing job key (e.g., `${fileId}:${versionId}`) to enforce idempotency.
2. On upload completion:
   - if `processing.enabled !== true`, do nothing
   - else, trigger processing
3. If FlowFn is configured:
   - enqueue job to a stable queue name (e.g., `filefn.processing`)
   - handle enqueue failures by retrying (implementation-defined) or returning `FILEFN_PROCESSING_ENQUEUE_FAILED`.
4. Ensure reprocessing the same `(fileId, versionId)` does not create duplicate artifacts.

## Verification steps
1. Run server + processing tests:
   - `npm test -- --filter=@filefn/server --filter=@filefn/processing`
2. Confirm vectors pass:
   - TV-PROCESS-001 / TV-PROCESS-NEG-001
   - TV-PROCESS-FLOW-001 / TV-PROCESS-FLOW-NEG-001

## Stop condition
Report:
- the exact trigger point in upload completion,
- the job idempotency strategy,
- the queue name used for FlowFn.
