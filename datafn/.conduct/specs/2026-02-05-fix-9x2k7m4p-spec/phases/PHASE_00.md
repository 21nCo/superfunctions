## Phase goal

Add the `sync.cloneUp()` public surface (types + wiring) without changing existing sync behavior.

## In scope

- Add `CloneUpOptions`, `CloneUpResult`, and `sync.cloneUp()` type signature.
- Wire `cloneUp` onto the `client.sync` object (implementation may be a minimal stub in this phase).
- Ensure build/typecheck succeeds and existing tests remain green.

## Out of scope

- Full cloneUp semantics (mutation generation, batching, join stores, retries, pullAfter, changelog drain).
- Exhaustive test vectors (those are implemented in later phases).

## Deliverables

- Modify:
  - `datafn/client/src/sync.ts` (extend `SyncFacade`)
  - `datafn/client/src/client.ts` (attach `cloneUp` to `sync`)
  - `datafn/client/src/index.ts` (export types)
- Create:
  - `datafn/client/src/sync/cloneUp.ts` (stub entrypoint + exported types)

## Requirements covered

- `CLONEUP-API-001` (surface exists; additive)

## Implementation tasks

- [ ] Add `CloneUpOptions` and `CloneUpResult` types matching `SPEC.md`.
- [ ] Extend `SyncFacade` to include `cloneUp(options?: CloneUpOptions): Promise<CloneUpResult>`.
- [ ] Attach `cloneUp` to `client.sync` (in `client.ts`) and ensure it is callable.
- [ ] Export the new types from `@datafn/client` public entrypoint.
- [ ] Add minimal unit test asserting `typeof client.sync.cloneUp === "function"` and existing `sync.*` methods still exist.

## Verification steps

- Run (from `datafn/client`):
  - `npm run typecheck`
  - `npm test`

Expected outcomes:
- Typecheck passes.
- Tests pass.
- `client.sync.cloneUp` exists at runtime.

## Stop condition

Share the list of modified/created files and the test output summary (pass/fail).

