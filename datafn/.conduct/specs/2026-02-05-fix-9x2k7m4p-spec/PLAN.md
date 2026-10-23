## PLAN — CloneUp (offline user → cloud conversion)

### Architecture sketch

- **New module**: `datafn/client/src/sync/cloneUp.ts`
  - **Responsibility**: implement `sync.cloneUp(options?: CloneUpOptions)` as specified in `SPEC.md`.
  - **Inputs**: `{ schema, storage, remote, clientId, syncConfig, eventBus, getTimestamp }`.
  - **Outputs**: `CloneUpResult` (or throws `DatafnClientError` per error policy).

- **New helpers (client)**:
  - `datafn/client/src/sync/cloneUp/hash.ts`
    - FNV-1a 32-bit + base36 encoding over `JSON.stringify(normalizeDfql(hashInput))`.
  - `datafn/client/src/sync/cloneUp/order.ts`
    - deterministic sorting helpers (records by `id`, join rows by `(from,to,dfqlKey(metaFiltered))`).
  - `datafn/client/src/sync/cloneUp/batch.ts`
    - deterministic batching helper (pure partition of mutation list).

- **Wiring**:
  - `datafn/client/src/client.ts`
    - attach `cloneUp` onto `client.sync` (has access to `schema`, `eventBus`, `clientId`, `syncConfig`, `storage`, and `remote`).
  - `datafn/client/src/sync.ts`
    - extend `SyncFacade` type to include `cloneUp`.
    - re-export `CloneUpOptions`, `CloneUpResult` from `@datafn/client` public surface (via `client/src/index.ts`).

- **Dependencies (existing)**:
  - `@datafn/core`: `normalizeDfql`, `dfqlKey`, `DatafnSchema` typing.
  - `@datafn/client`: `isTransportError`, `createClientError`, `unwrapRemoteSuccess`.
  - `DatafnStorageAdapter`: `listRecords`, `listJoinRows`, cursor APIs, changelog APIs.

### Dependency graph (what must exist before what)

- **Hash + canonicalization** (`normalizeDfql` + FNV-1a) → required before deterministic `mutationId`.
- **Deterministic ordering** → required before batching.
- **Mutation generation** (records first, then many-many) → required before push.
- **Push batching + retry policy** → required before safe large uploads.
- **Failure policy + state finalization** → required before production safety (no cursor/changelog corruption).
- **Observability events** → required for UI/telemetry and debugging.

### Phases overview

Each phase is independently verifiable (local unit tests in `@datafn/client` via `vitest run`).

- **Phase 00**: Public API + types wired
  - **Goal**: `sync.cloneUp()` exists, types compile, exports are stable.
  - **Delivers**: `CloneUpOptions`, `CloneUpResult`, `SyncFacade.cloneUp` signature.
  - **Verify**: `npm test` + `npm run typecheck` in `datafn/client`.

- **Phase 01**: Deterministic record upload plan (Stage A)
  - **Goal**: enumerate in-scope resources, generate record mutations, deterministic ordering, deterministic mutationId.
  - **Delivers**: record mutation generator + hash helper; resource-scope validation.
  - **Verify**: implement + pass `TV-CLONEUP-002`, `TV-CLONEUP-008`, `TV-CLONEUP-010` (record-only path).

- **Phase 02**: Many-many join upload plan (Stage B)
  - **Goal**: enumerate join stores, validate join rows, metadata constraints, deterministic ordering, deterministic relation mutationId.
  - **Delivers**: join store enumerator + relate mutation generator.
  - **Verify**: implement + pass `TV-CLONEUP-001` (join row portion), `TV-CLONEUP-007`, `TV-CLONEUP-009`.

- **Phase 03**: Push batching + retry + server error aggregation
  - **Goal**: push in deterministic batches, retry only on transport errors, failFast behavior, aggregated `CloneUpResult.errors`.
  - **Delivers**: batching helper; push-with-retry helper; failure semantics.
  - **Verify**: implement + pass `TV-CLONEUP-011`, `TV-CLONEUP-012`, `TV-CLONEUP-013`, `TV-CLONEUP-014`.

- **Phase 04**: Finalization (cursor/changelog/pullAfter)
  - **Goal**: safe post-upload state: pullAfter loop, monotonic `__global_cursor__`, changelog drain.
  - **Delivers**: `pullAfter` loop per `SPEC.md`; changelog drain; cursor monotonic set.
  - **Verify**: implement + pass `TV-CLONEUP-001` (pullAfter + drain), `TV-CLONEUP-006`.

- **Phase 05**: Observability + hardening
  - **Goal**: emit `sync_applied`/`sync_failed` with `context.phase="cloneup"`, and ensure no payload leakage.
  - **Delivers**: event emission, minimal context payload, docs/README update if needed.
  - **Verify**: implement + pass `TV-CLONEUP-006`, `TV-CLONEUP-012` and add assertion that event context excludes record payloads.

### Definition of Done (global)

- All requirements in `REQUIREMENTS.md` are implemented.
- All vectors in `TEST_VECTORS.md` are implemented as unit tests and pass deterministically.
- `@datafn/client`:
  - `npm run typecheck` passes
  - `npm test` passes
- No new linter/type errors introduced.
- `sync.cloneUp()` is additive and does not break existing `sync.*` methods.

