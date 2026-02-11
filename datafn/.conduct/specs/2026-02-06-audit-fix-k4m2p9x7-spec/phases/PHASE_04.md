## Phase goal

Extend server sync push to accept and apply relation mutations and record deterministic join deltas in change tracking for propagation to other clients.

## In scope

- Server `push` execution supports `relate/modifyRelation/unrelate`.
- Idempotency for relation mutations.
- Change tracking records join deltas in a form that pull can later return.
- Tests covering relation push and error cases.

## Out of scope

- Pull/clone join hydration to clients (Phase 05).
- Paginated clone and hydration plan (Phase 06).

## Deliverables

- Modify:
  - `datafn/server/src/execution/sync/push.ts`
  - `datafn/server/src/execution/mutation/relations.ts` (as needed for deterministic join delta extraction)
  - `datafn/server/src/execution/sync/change-tracking.ts` (if join delta recording needs helper)
  - `datafn/server/src/validation/*` (allow relation ops in push validation)
- Add/modify tests:
  - `datafn/server/src/execution/mutation/__tests__/relations.test.ts` (extend for push path)
  - `datafn/server/__tests__/sync.test.ts` (extend to include relation mutations)

## Requirements covered

- SYNC-005

## Implementation tasks

- [ ] Update push mutation validation:
  - allow `operation` in `{insert,merge,replace,delete,relate,modifyRelation,unrelate}`
  - require `relations` payload for relation operations
  - ensure deterministic error codes/paths for unknown relation and invalid payload
- [ ] Implement relation ops in `executePush`:
  - reuse server relation execution logic (or factor a shared executor used by both `/mutation` and `/push`)
  - ensure namespace is used consistently (no hard-coded namespace)
- [ ] Define join delta encoding in change tracking:
  - resource name MUST be the client join-store key, e.g. `join_node_properties_property`
  - id MUST be deterministic composite key: `${from}::${to}`
  - record MUST contain at minimum `{ from, to, ...metadata }` for upserts; `null` for deletes
  - op MUST be `upsert` or `delete`
- [ ] For relation ops:
  - many-many relate/modifyRelation: record `upsert` on join store key
  - many-many unrelate: record `delete` on join store key
  - many-one/one-many: record record-level changes for the affected records AND (optionally) a “touch” event for invalidation (documented)
- [ ] Ensure idempotency:
  - store result in idempotency store keyed by `(clientId, mutationId)`
  - repeated pushes return deduped result and MUST NOT create duplicate join deltas
- [ ] Tests:
  - TV-REL-001/TV-REL-001N

## Verification steps

```bash
npm test -w @datafn/server
```

- Expected outcomes:
  - Relation mutations in push succeed and result in change tracking entries for join deltas.
  - Unknown relation rejects deterministically.

## Stop condition

Before starting Phase 05, report:

- The exact join delta resource/id encoding used.
- Confirmation that push relation ops and mutation relation ops share the same semantics.

