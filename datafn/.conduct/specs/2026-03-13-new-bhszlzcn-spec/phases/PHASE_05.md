# PHASE_05

## Phase goal
Implement SPV2 share/unshare mutation semantics including principal and scope grants.

## In scope / Out of scope
In scope:
- Principal-aware payload validation.
- Legacy `userId` canonicalization.
- Scope grant create/revoke behavior.
- Cross-namespace share-time policy checks.

Out of scope:
- Sync feed changes.

## Deliverables
- `datafn/server/src/execution/mutation/dfql.ts`
- `datafn/server/src/validation/mutation.ts`
- `datafn/server/src/execution/mutation/share.ts`
- `datafn/server/src/execution/mutation/__tests__/share-spv2.test.ts` (new)
- `datafn/client/src/mutate.ts`
- `datafn/client/src/tables/table.ts`

## Requirements covered
- API-001
- API-002
- ARCH-002
- ARCH-005

## Implementation tasks
1. Add `principalId` and `scope` payload shapes.
2. Canonicalize legacy `userId` to `principalId`.
3. Enforce scope/id validity matrix.
4. Persist scope grants with `resourceId = null`.
5. Apply crossNsShareable policy enforcement with deterministic errors.
6. Add client API overloads for principal and scope sharing.

## Verification steps
1. `npm test --workspace datafn/server -- share-spv2`
Expected outcome: mutation tests pass.
2. `npm test --workspace datafn/client -- share-methods`
Expected outcome: client share methods tests pass.

## Stop condition
Share/unshare supports SPV2 and legacy payloads with deterministic validations.
