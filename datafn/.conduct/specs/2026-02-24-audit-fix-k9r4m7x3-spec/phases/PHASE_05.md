# PHASE 05: Mutation Optimization (Upsert + Direct Create)

## Phase Goal

Reduce mutation round-trips by using `db.upsert()` for merge operations and direct `db.create()` with error handling for insert operations, eliminating redundant `findOne` pre-checks.

## In Scope

- Refactor merge operation to use `db.upsert()` in both `executeMutation()` and `executePush()`
- Refactor insert operation to skip `findOne` pre-check in `executeMutation()`
- Catch unique constraint errors from `create()` and map to CONFLICT response

## Out of Scope

- Replace operation (still needs `findOne` to build the resolved record via `buildReplaceRecord`)
- Batch change log creation (deferred — requires adapter `createMany` support verification)
- Transaction wrapping for multi-step mutations

## Deliverables

| File | Action |
|---|---|
| `datafn/server/src/execution/mutation/execute.ts` | MODIFY — upsert for merge, direct create for insert |
| `datafn/server/src/execution/sync/push.ts` | MODIFY — upsert for merge in push path |
| `datafn/server/__tests__/mutation-optimization.test.ts` | CREATE — optimization-specific tests |

## Requirements Covered

- MUT-001 (Use upsert for merge)
- MUT-002 (Eliminate pre-existence check for insert)
- MUT-003 (Reduce push mutation round-trips)

## Implementation Tasks

1. Modify `executeMutation()` merge path:
   - Replace the `findOne` → conditional `create`/`update` block with:
   ```typescript
   case "merge":
     try {
       const coercedData = mutation.record || {};
       await db.upsert({
         model: mutation.resource,
         where: [{ field: "id", operator: "eq", value: mutation.id }],
         create: { id: mutation.id, ...coercedData },
         update: coercedData,
         namespace,
       });
       opResult = { ok: true };
     } catch (error) {
       opResult = { ok: false, code: "INTERNAL", message: "Internal error", path: "$" };
     }
     break;
   ```

2. Modify `executeMutation()` insert path:
   - Remove the `findOne` pre-check
   - Attempt `db.create()` directly
   - Catch errors and check for unique constraint patterns:
   ```typescript
   case "insert":
     try {
       await db.create({
         model: mutation.resource,
         data: { id: mutation.id, ...(mutation.record || {}) },
         namespace,
       });
       opResult = { ok: true };
     } catch (error: any) {
       const msg = error?.message?.toLowerCase() || "";
       if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("already exists") || msg.includes("conflict")) {
         opResult = { ok: false, code: "CONFLICT", message: "Record already exists", path: "id" };
       } else {
         opResult = { ok: false, code: "INTERNAL", message: error?.message || "Internal error", path: "$" };
       }
     }
     break;
   ```

3. Modify `executePush()` merge path:
   - Replace the `findOne` → conditional `create`/`update` pattern with `db.upsert()`:
   ```typescript
   case "merge":
   case "replace":
     try {
       const coercedData = applyDateCoercion(schema, mut.resource, mut.record || {});
       await db.upsert({
         model: mut.resource,
         where: [{ field: "id", operator: "eq", value: mut.id }],
         create: { id: mut.id, ...coercedData },
         update: coercedData,
         namespace,
       });
       opResult = { ok: true };
     } catch (innerError) {
       opResult = { ok: false, code: "INTERNAL", message: "Internal error", path: "$" };
     }
     break;
   ```
   Note: `replace` in push also uses the upsert pattern since push doesn't need field-clearing logic (the client sends the full record).

4. Tests:
   - TV-MUT-UPSERT-001: merge creates new record via upsert
   - TV-MUT-UPSERT-002: merge updates existing record via upsert
   - TV-MUT-INSERT-001: insert succeeds without findOne call
   - TV-MUT-INSERT-002: insert conflict detected from create error
   - TV-MUT-PUSH-001: push merge uses upsert
   - Regression: all existing mutation tests, sync tests pass

## Verification Steps

```bash
cd /Users/serro/Documents/dev/n/superfunctions/datafn/server
npx vitest run __tests__/mutation-optimization.test.ts
npx vitest run __tests__/sync.test.ts
npx vitest run
npx tsc --noEmit
```

**Expected**: All optimization tests pass. Round-trip count verified through mock adapter call counting. All existing tests pass.

## Stop Condition

Report: Merge uses upsert (1 DB call instead of 3). Insert skips findOne (1 DB call instead of 2). No regressions in mutation or sync behavior.
