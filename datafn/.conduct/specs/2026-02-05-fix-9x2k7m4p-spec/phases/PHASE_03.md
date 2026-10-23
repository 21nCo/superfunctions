## Phase goal

Make cloneUp safe under real network/server behavior: deterministic batching, transport retries, failFast, and server error aggregation.

## In scope

- Deterministic batch segmentation for push calls (pure partition of ordered mutations).
- Transport retry policy for push batches (retry only when `isTransportError(err)` is true; respect `maxRetries`).
- Failure policy:
  - `failFast=true`: abort on first non-empty `errors[]` from server
  - `failFast=false`: continue and aggregate errors (but still overall `ok=false`)
- Return `CloneUpResult` with correct `stats.batches` counting actual push calls (including retries).
- Compatibility: use only canonical `/datafn/push` envelope via `remote.push`.

## Out of scope

- pullAfter loop + cursor/changelog finalization (Phase 04).
- Event emission (Phase 05).

## Deliverables

- Modify:
  - `datafn/client/src/sync/cloneUp.ts` (push orchestration + retry + error aggregation)
  - `datafn/client/src/sync/cloneUp/batch.ts` (batch helper, if not complete)

- Tests:
  - Add vectors for retry + server errors + invalid batchSize/maxRetries.

## Requirements covered

- `CLONEUP-PUSH-001`
- `CLONEUP-PUSH-002`
- `CLONEUP-COMPAT-001`

## Implementation tasks

- [ ] Implement `batchSize` / `maxRetries` validation (`TV-CLONEUP-013`).
- [ ] Implement push retries for transport errors and throw on exhaustion (`TV-CLONEUP-011`).
- [ ] Implement server `errors[]` handling and `ok=false` result (`TV-CLONEUP-012`).
- [ ] Implement missing `remote.push` method behavior as `TRANSPORT_ERROR` (`TV-CLONEUP-014`).
- [ ] Ensure batches counter increments for each actual push call (including retries).
- [ ] Add/extend tests to pass these vectors.

## Verification steps

- Run (from `datafn/client`):
  - `npm run typecheck`
  - `npm test`

Expected outcomes:
- `TV-CLONEUP-011`, `TV-CLONEUP-012`, `TV-CLONEUP-013`, `TV-CLONEUP-014` pass.

## Stop condition

Report:
- how retry attempts are counted,
- how `stats.batches` is computed,
- and the passing test vector IDs.

