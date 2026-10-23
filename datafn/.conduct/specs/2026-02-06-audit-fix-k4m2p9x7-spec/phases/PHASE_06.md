## Phase goal

Make clone scalable via pagination and implement a hydration plan (boot vs background resources) so Nucleus can hydrate large datasets without blocking.

## In scope

- Server clone pagination:
  - deterministic `id:asc` paging via `{ page: { table, afterId, limit } }`
  - optional join inclusion
- Client sync hydration plan:
  - `bootResources` cloned to `ready` before reporting boot completion
  - `backgroundResources` cloned asynchronously
  - query routing respects `hydrating` vs `ready`
- Tests for clone paging and hydration ordering.

## Out of scope

- Reconcile endpoint (Phase 07).

## Deliverables

- Modify server:
  - `datafn/server/src/execution/sync/clone.ts`
  - `datafn/server/src/routes/sync.ts` (clone request/response shape)
- Modify client:
  - `datafn/client/src/sync/engine.ts`
  - `datafn/client/src/sync/apply.ts` (incremental apply)
  - `datafn/client/src/query.ts` (routing rules for hydrating)
- Add/modify tests:
  - `datafn/server/__tests__/sync.test.ts` (clone paging)
  - `datafn/client/__tests__/sync.test.ts` (hydration plan ordering)

## Requirements covered

- SYNC-001
- SYNC-002

## Implementation tasks

- [ ] Server clone:
  - accept `{ tables, page?, includeJoins? }`
  - return `{ data, joins?, cursors, next? }`
  - ensure deterministic ordering by id
  - compute `next` marker as last returned id (or null)
- [ ] Client SyncEngine initialization:
  - if `hydration.bootResources` provided:
    - clone only those tables initially
    - mark them `ready`
    - mark background resources `hydrating` and start async clones
  - if no hydration plan:
    - default behavior clones all non-ready tables (but still paginates)
- [ ] Query routing:
  - if table is `hydrating` and remote exists, route to remote
  - if local-only mode, route to local even if hydrating
- [ ] Tests:
  - TV-SYNC-001/TV-SYNC-001N (clone paging)
  - TV-SYNC-002/TV-SYNC-002N (hydration plan behavior)

## Verification steps

```bash
npm test -w @datafn/server && npm test -w @datafn/client
```

## Stop condition

Before starting Phase 07, report:

- The final clone pagination contract and any limitations (max page size).
- How join rows are paginated (with parent table or separately) and determinism guarantees.

