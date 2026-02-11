## Phase goal

Implement client configuration changes for `sync.remoteAdapter`, local-only mode, and resource-aware ID generation so the datafn client can operate without Flux in both web and extension contexts.

## In scope

- `sync.remoteAdapter?: DatafnRemoteAdapter` config support and resolution.
- `sync.mode: "local-only"` support (no remote required).
- Resource-aware ID generation (`generateId({ resource, idPrefix })`) and prefix enforcement on inserts.
- Unit tests covering config validation and adapter call routing.

## Out of scope

- Mutation context propagation and signal invalidation (Phase 01).
- KV support (Phase 02).
- Sync protocol changes (clone/pull/push) (Phases 04–06).
- Nucleus refactor (Phase 13).

## Deliverables

- Modify:
  - `datafn/client/src/client.ts`
  - `datafn/client/src/tables/table.ts`
  - `datafn/client/src/index.ts` (export updated types if needed)
- Add/modify tests:
  - `datafn/client/__tests__/client-create.test.ts` (or add new `__tests__/config-remote-adapter.test.ts`)
  - `datafn/client/__tests__/generate-id.test.ts` (if not already present)

## Requirements covered

- CFG-001
- CFG-002
- API-001

## Implementation tasks

- [ ] Update `DatafnSyncConfig` in `datafn/client/src/client.ts`:
  - add `remoteAdapter?: DatafnRemoteAdapter`
  - add `mode?: "sync" | "local-only"`
  - add `wsUrl?: string` and `hydration?: ...` fields as specified (fields may be unused until later phases but MUST validate deterministically).
- [ ] Implement deterministic config validation:
  - if `sync.mode === "sync"`:
    - require `sync.remoteAdapter` OR `sync.remote`
  - if `sync.mode === "local-only"`:
    - require `storage` when `offlinability` is true (existing rule)
    - forbid `ws === true` unless `remote` or `wsUrl` is present (disable websocket)
- [ ] Resolve remote adapter:
  - if `sync.remoteAdapter` present, use it
  - else if `sync.remote` present, use `DefaultHttpTransport(sync.remote)`
  - else create a throwing adapter only used if code violates routing invariants (deterministic message).
- [ ] Ensure local-only query routing correctness:
  - set hydration state to `ready` for all non-remote-only resources on client creation OR implement a local-only routing override so `executeQuery` runs locally.
- [ ] Replace `generateId(): string` usage:
  - change internal ID generator contract to `generateId({ resource, idPrefix }): string`
  - update `createTable(..., generateId)` and insert auto-ID logic accordingly
  - enforce prefix requirements; reject invalid generated IDs with `DFQL_INVALID` pointing to `id`.
- [ ] Add tests for:
  - remoteAdapter precedence and call routing
  - local-only mode success without remote
  - sync mode rejection without remote/remoteAdapter
  - prefix enforcement rejection

## Verification steps

- From `/Users/ar/dev/superfunctions`:

```bash
npm test -w @datafn/client
```

- Expected outcomes:
  - All tests pass.
  - Added tests for `CFG-001/CFG-002/API-001` pass and are deterministic.

## Stop condition

Before starting Phase 01, report:

- The final config resolution rules implemented (bullet summary).
- Any breaking TypeScript API changes (and whether they were additive/backward compatible).
- Confirmation that test coverage includes both positive and negative vectors for CFG-001/CFG-002/API-001.

