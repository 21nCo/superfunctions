# Phase 02

## Phase goal

Implement the client-side clone up surfaces: transport method, sync facade delegator, and `cloneUpNow()` convenience method that uploads local storage to the server.

## In scope

- `DefaultHttpTransport.cloneUp(payload)`.
- `SyncFacade.cloneUp(payload)` delegation and envelope unwrapping.
- `client.sync.cloneUpNow(options)`:
  - Reads from configured storage
  - Resource-by-resource upload
  - Deterministic record sorting and chunking
  - Aggregates results

## Out of scope

- Advanced byte-size based chunking.
- Automatic cursor/hydration state updates (caller may optionally use returned cursor).

## Deliverables

- Modify:
  - `datafn/client/src/transport/http.ts`
  - `datafn/client/src/sync.ts`
  - `datafn/client/src/client.ts`
  - `datafn/client/src/index.ts` (exports if necessary)
- Tests:
  - Add `datafn/client/__tests__/cloneup.test.ts` implementing: TV-CLONEUP-009..011, TV-CLONEUP-013

## Requirements covered

- CLONEUP-009
- CLONEUP-010
- CLONEUP-011
- CLONEUP-012
- CLONEUP-013

## Implementation tasks

1. Transport:
   - Add `cloneUp(payload)` to the HTTP transport class and interface.

2. Sync facade:
   - Add `cloneUp(payload)` to `createSyncFacade` using the existing `callSyncMethod()` and `unwrapRemoteSuccess()` patterns.

3. Convenience:
   - Add `cloneUpNow(options)` to `createDatafnClient()`’s `sync` object.
   - Validate `batchSize` (must be positive integer).
   - Determine resources:
     - If `options.resources` provided, validate each exists in schema.
     - Otherwise use schema resources order.
   - For each resource:
     - `records = await storage.listRecords(resource)`
     - sort by `id`
     - chunk and call `sync.cloneUp({ clientId, resource, records: chunk })`
   - Aggregate results and return summary.

4. Tests:
   - Verify call ordering and batching.
   - Verify missing storage error.
   - Verify unknown resource filter error.
   - Verify envelope error unwrapping.

## Verification steps

Run:

```bash
npm -w @datafn/client test
npm -w @datafn/client typecheck
```

Expected outcomes:

- All tests pass.
- Typecheck passes.

## Stop condition

Report:

- The `cloneUpNow()` method signature and a minimal usage snippet.
- Confirmation that TV-CLONEUP-009..011/013 are covered.
