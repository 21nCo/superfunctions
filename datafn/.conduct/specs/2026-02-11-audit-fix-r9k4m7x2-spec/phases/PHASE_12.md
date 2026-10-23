# PHASE 12 — Sync Configurability and AbortSignal

## Phase Goal
Make pull batch size configurable and add AbortSignal support for queries.

## In Scope
- `DatafnSyncConfig.pullBatchSize` — configurable pull limit
- `signal?: AbortSignal` on query options
- `DFQL_ABORTED` error code
- Signal propagation through HTTP transport

## Out of Scope
- AbortSignal for mutations
- AbortSignal for local queries (fast enough to not need cancellation)

## Deliverables
- `client/src/sync/engine.ts` — use pullBatchSize config
- `client/src/query.ts` — AbortSignal support
- `client/src/client.ts` — pullBatchSize validation at init
- `client/__tests__/query.test.ts` — abort tests

## Requirements Covered
- CFG-001, QRY-001

## Implementation Tasks
1. Add `pullBatchSize?: number` to `DatafnSyncConfig` type
2. Validate at client init: must be positive integer between 10 and 10000
3. In `pullWithPerTableCursors()`, replace hardcoded `200` with `this.config.pullBatchSize ?? 200`
4. Add `signal?: AbortSignal` to `DfqlQuery` type (in core types)
5. In `executeQuery()`:
   - If query is routed to remote, pass `signal` to the remote adapter call
6. In `DefaultHttpTransport.query()`:
   - Pass `signal` to `fetch()` options
7. Define `DFQL_ABORTED` error code
8. In query error handling:
   - If error is `AbortError`, throw `createClientError("DFQL_ABORTED", "Query aborted", { path: "signal" })`
9. Write test: pullBatchSize configures pull limit
10. Write test: invalid pullBatchSize rejected at init
11. Write test: AbortSignal aborts remote query
12. Write test: aborted query rejects with DFQL_ABORTED
13. Write test: query without signal works normally
14. Run full test suite

## Verification Steps
- New tests pass: pullBatchSize config, AbortSignal
- `npm test -w @datafn/client` → 0 failures
- TV-CFG-001/N, TV-QRY-001/N verified

## Stop Condition
Pull batch size is configurable. AbortSignal works. All tests pass. Phase report written.
