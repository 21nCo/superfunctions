## Phase goal

Define and enforce server-side permissions/authz and guarantee namespace isolation correctness across all execution and sync paths.

## In scope

- Define a permissions policy shape supported by `DatafnSchema.resources[].permissions`.
- Enforce policy on:
  - query (select + filters + relations)
  - mutation (record fields + relation ops)
  - transact (all steps)
  - sync endpoints (clone/pull/push/reconcile)
- Fix namespace correctness:
  - no hard-coded `"datafn"` namespace in execution paths
  - extracted namespace used consistently for DB + change tracking + idempotency
- Tests for allowed/denied access and namespace isolation.

## Out of scope

- Advanced ABAC policy language beyond the defined shape (Undefined).

## Deliverables

- Modify:
  - `datafn/core/src/types.ts` (permissions typing if needed)
  - `datafn/server/src/validation/*` (policy-aware validation)
  - `datafn/server/src/server.ts` (wire auth context, namespace)
  - `datafn/server/src/execution/mutation/execute.ts` (namespace pass-through)
  - `datafn/server/src/execution/mutation/relations.ts` (namespace usage)
  - `datafn/server/src/execution/sync/*` (namespace usage)
- Add/modify tests:
  - `datafn/server/__tests__/namespace-isolation.test.ts` (already present; extend)
  - `datafn/server/__tests__/rest.test.ts` (authz failure cases)
  - New `datafn/server/__tests__/authz.test.ts` if needed

## Requirements covered

- AUTH-001
- AUTH-002

## Implementation tasks

- [ ] Define permissions policy shape (server-enforced):
  - Minimal shape (example):
    - `{ read: { fields: string[] }, write: { fields: string[] } }`
    - optional `ownerField?: "createdBy" | "<field>"` for owner scoping
  - Document the canonical error code: `FORBIDDEN`
- [ ] Enforce read policy:
  - reject select tokens/fields not in `read.fields`
  - reject filters referencing forbidden fields
  - enforce relation expansions only if both relation and target fields are allowed
- [ ] Enforce write policy:
  - reject record fields not in `write.fields`
  - reject relation mutations for relations not allowed (policy rule must be explicit)
- [ ] Namespace correctness:
  - ensure namespace extracted once per request and passed into all execution helpers
  - remove all hard-coded `"datafn"` namespace occurrences in server execution paths
  - ensure change tracking and idempotency are namespace-scoped
- [ ] Tests:
  - TV-AUTH-001/TV-AUTH-001N
  - TV-AUTH-002/TV-AUTH-002N

## Verification steps

```bash
npm test -w @datafn/server
```

## Stop condition

Before starting Phase 12, report:

- The final permissions policy shape and where it is enforced.
- A list of all previously hard-coded namespace usages eliminated.

