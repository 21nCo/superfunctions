# Phase 03

## Phase goal

Add an end-to-end integration test that simulates the offline-first signup transition: local records exist, then `cloneUpNow()` uploads them into an isolated namespace and future sync can proceed.

## In scope

- A cross-package test that wires:
  - `@datafn/server` (`createDatafnServer`) backed by a test DB adapter
  - `@datafn/client` (`createDatafnClient`) backed by a storage adapter
  - A transport/fetch shim that routes client HTTP calls to the server handler
- Test verifies:
  - Client uploads local records
  - Server persists + tracks changes
  - Idempotent retries do not inflate cursor

## Out of scope

- WebSocket behavior.
- Long-running sync engine scheduling.

## Deliverables

- Add integration test file (choose one location):
  - Option A: `datafn/server/__tests__/cloneup.integration.test.ts`
  - Option B: `datafn/client/__tests__/cloneup.integration.test.ts`

## Requirements covered

- Reinforces CLONEUP-001..005 and CLONEUP-011.

## Implementation tasks

1. Build a fetch shim:
   - Implement a minimal `fetch(url, init)` that calls the server router with `Request` objects.

2. Create server with deterministic schema + Memory DB adapter.

3. Create client with Memory/IndexedDB test storage and the fetch shim.

4. Seed local storage with records, call `cloneUpNow()`, then verify:
   - Server `clone` returns those records.
   - Second `cloneUpNow()` returns `ok: true` with `skipped` and cursor unchanged.

## Verification steps

Run:

```bash
turbo run test --filter=@datafn/*
```

Expected outcomes:

- All `@datafn/*` tests pass.

## Stop condition

Report:

- The integration test location and what it validates.
