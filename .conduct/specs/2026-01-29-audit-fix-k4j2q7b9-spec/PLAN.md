# Implementation Plan

## Architecture sketch

### Packages/modules

- `datafn/core`
  - Extend `DatafnPlugin` sync phase union to include `"cloneup"`.
  - (Optional but recommended) Export shared protocol types `CloneUpRequest`/`CloneUpResult`.

- `datafn/server`
  - New executor: `src/execution/sync/cloneup.ts` implementing clone-up persistence + change tracking.
  - New route handler: `src/routes/sync.ts` adds `createCloneUpHandler()`.
  - Server wiring: `src/server.ts` registers `POST /datafn/cloneup` and extends `authorize` action union.
  - Plugin hooks: `src/plugins/run-hooks.ts` supports phase `"cloneup"`.
  - Tests: add server tests for endpoint semantics, idempotency, and namespace isolation.

- `datafn/client`
  - Transport: `src/transport/http.ts` adds `cloneUp()` → `POST {baseUrl}/cloneup`.
  - Remote adapter interface: extend `DatafnRemoteAdapter`.
  - Sync facade: extend `createSyncFacade()` to delegate `cloneUp(payload)`.
  - Convenience method: extend `createDatafnClient()`’s `client.sync` to include `cloneUpNow(options)`.
  - Tests: add client tests for delegation and cloneUpNow batching.

## Dependency graph

1) `@datafn/core` sync phase typing must land first (compilation dependency)
2) `@datafn/server` endpoint implementation
3) `@datafn/client` transport + facade + convenience
4) Integration test + final validation

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|---:|---|---|---|
| 00 | Add protocol + type plumbing | Codebase compiles with new phase and endpoint surface | `npm -w @datafn/core typecheck`, `npm -w @datafn/server typecheck`, `npm -w @datafn/client typecheck` |
| 01 | Implement server clone up | `/datafn/cloneup` persists records with change tracking + idempotency | `npm -w @datafn/server test` |
| 02 | Implement client clone up | `cloneUp` delegator + `cloneUpNow()` local-to-cloud uploader | `npm -w @datafn/client test` |
| 03 | Integration + hardening | Cross-package test verifying end-to-end local→cloud upload | `turbo run test --filter=@datafn/*` |

## Definition of Done (global)

- All requirements in `REQUIREMENTS.md` are implemented.
- All vectors in `TEST_VECTORS.md` are covered by automated tests (or explicit typecheck commands).
- `@datafn/core`, `@datafn/client`, and `@datafn/server` tests and typechecks pass.
- No behavioral regressions in existing sync endpoints (`clone`, `pull`, `push`, `seed`).
