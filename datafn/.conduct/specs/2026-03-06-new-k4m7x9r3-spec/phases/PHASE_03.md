# PHASE 03: Server — Timestamps & Audit Field Injection

## Phase goal
Implement server-side auto-injection of `createdAt`, `updatedAt`, `createdBy`, `updatedBy` on mutation execution.

## In scope
- Strip readonly capability fields from client-provided records
- Inject `createdAt` and `updatedAt` on insert (timestamps capability)
- Inject `updatedAt` on merge/replace (timestamps capability)
- Inject `createdBy` and `updatedBy` on insert (audit capability)
- Inject `updatedBy` on merge/replace (audit capability)
- Preserve `createdAt` and `createdBy` immutability
- Extract actorId from server context and pass to execution
- Graceful null fallback when actorId unavailable

## Out of scope
- Trash/archive operations (Phases 4-5)
- Query filtering (Phase 6)

## Deliverables
- `datafn/server/src/execution/mutation/execute.ts` (updated — capability injection logic)
- `datafn/server/src/execution/mutation/dfql.ts` (updated — buildReplaceRecord uses capabilities)
- `datafn/server/src/routes/mutation.ts` (updated — pass actorId to execution)
- `datafn/server/src/execution/mutation/__tests__/capability-injection.test.ts` (new)

## Requirements covered
- CAP-007, TS-001, TS-002, TS-003, TS-004, AUD-001, AUD-002, AUD-003, AUD-004, AUD-005

## Implementation tasks
1. Create a `stripReadonlyCapabilityFields(record, resolvedCapabilities)` utility that removes `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `trashedAt`, `trashedBy` from the record if their capability is enabled
2. Create an `injectCapabilityFieldsOnInsert(record, resolvedCapabilities, actorId)` function:
   - If timestamps: set `createdAt = Date.now()`, `updatedAt = Date.now()`
   - If audit: set `createdBy = actorId ?? null`, `updatedBy = actorId ?? null`
3. Create an `injectCapabilityFieldsOnUpdate(record, resolvedCapabilities, actorId)` function:
   - If timestamps: set `updatedAt = Date.now()`
   - If audit: set `updatedBy = actorId ?? null`
   - MUST NOT set `createdAt` or `createdBy`
4. In `executeMutationCore()`, before each operation:
   - Call `stripReadonlyCapabilityFields()` on the mutation record
   - For insert: call `injectCapabilityFieldsOnInsert()`
   - For merge/replace: call `injectCapabilityFieldsOnUpdate()`
5. Update `buildReplaceRecord()` to use capability resolution instead of hardcoded field names
6. Pass `actorId` through from route handlers → `executeMutation()` → `executeMutationCore()`
7. Update `executeMutation` signature to accept `actorId?: string` parameter
8. In mutation route handler, extract actorId using `extractActorId(ctx)` and pass it through
9. Write tests:
   - Insert auto-sets createdAt, updatedAt, createdBy, updatedBy
   - Merge only updates updatedAt, updatedBy (not createdAt, createdBy)
   - Replace preserves createdAt, createdBy
   - Client-provided createdAt is stripped
   - No actorId → audit fields set to null
   - Non-capability resource: no injection occurs

## Verification steps
1. `cd datafn/server && npx vitest run src/execution/mutation/__tests__/capability-injection.test.ts` — all pass
2. `cd datafn/server && npx vitest run` — no regressions
3. `npx tsc --noEmit` — no type errors

## Stop condition
Timestamps and audit fields are auto-injected on all mutation paths. Readonly enforcement works. Existing tests pass.
