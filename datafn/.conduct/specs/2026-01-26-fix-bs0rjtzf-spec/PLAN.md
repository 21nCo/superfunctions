# Plan — DataFn Client Typing + Sync/Remote Fix
## Architecture sketch
Packages/modules impacted:
- `datafn/core`
  - Add DFQL structural TypeScript types (`DfqlQuery`, `DfqlQueryFragment`, etc.) to enable compile-time shape checking.
- `datafn/client`
  - Make `createDatafnClient` generic over schema to enable `client.<tableName>` typing.
  - Update table handle signatures (`query`, `signal`) to take `DfqlQueryFragment`.
  - Implement built-in HTTP transport from `sync.remote` (remove required `remote` adapter for default use).
  - Implement sync engine:
    - push loop (local-first mutations + changelog + batching + retries)
    - pull loop (clone on first run, pull on subsequent runs, pagination, triggers)
    - optional websocket listener for pull notifications
- `datafn/server`
  - Extend `/datafn/push` to include `cursor` in result.
  - Implement `/datafn/pull` cursor+limit pagination returning `{ changes, nextCursor }`.
  - Implement websocket endpoint `/datafn/ws` that notifies clients of new cursors.

## Dependency graph (high level)
- Core DFQL types → Client typing and query/signal compile-time validation.
- Server sync protocol changes → Client sync engine correctness (push cursor, pull pagination).
- Client transport wrapper → Client sync engine (push/pull calls).
- WebSocket server → WebSocket client pull trigger.

## Phases overview
- Phase 00: Core DFQL structural types + exports
  - Goal: Provide compile-time DFQL shapes to client.
  - Verification: `npm --prefix datafn/core test` and `npm --prefix datafn/core typecheck`.
- Phase 01: Client generic typing + table registry type inference
  - Goal: Fix `client.<table>` and typed `client.table(name)`.
  - Verification: `npm --prefix datafn/client test` plus TypeScript typecheck.
- Phase 02: Built-in HTTP transport + config migration to `sync.remote`
  - Goal: Remove required custom remote adapter for default HTTP use.
  - Verification: client tests + any new transport tests.
- Phase 03: Push engine (local-first mutations + batching + retries + events)
  - Goal: Meet push semantics from intent.
  - Verification: new unit tests for changelog ordering, batching, retries.
- Phase 04: Server sync protocol v1 (push cursor + pull pagination)
  - Goal: Make server speak the protocol required by the new client engine.
  - Verification: `npm --prefix datafn/server test` including new sync tests.
- Phase 05: Pull engine (clone vs pull, triggers, pagination loop, cursor monotonic)
  - Goal: Client keeps local DB up to date via HTTP pull.
  - Verification: new client sync tests with mocked server responses.
- Phase 06: WebSocket notifications
  - Goal: When `ws:true`, client reacts to server cursor notifications.
  - Verification: integration-style tests using a local WS server in tests.

## Definition of Done (global)
- All requirements in `REQUIREMENTS.md` are implemented.
- All test vectors in `TEST_VECTORS.md` have corresponding automated tests (or deterministic manual verification steps where automation is not feasible) and pass.
- `npm --prefix datafn/core test` and `npm --prefix datafn/core typecheck` pass.
- `npm --prefix datafn/client test` passes.
- `npm --prefix datafn/server test` passes.
- No phase is complete unless its verification steps pass.
