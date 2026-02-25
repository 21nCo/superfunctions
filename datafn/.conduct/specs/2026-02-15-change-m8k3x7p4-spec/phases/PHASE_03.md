# Phase 03: Adapter Join Table Refactor

**Goal**: Unify all many-many join table operations to use standard adapter CRUD methods instead of `adapter.internal`.
**Duration Estimate**: 3-4 hours
**Prerequisites**: None (independent of Phase 01/02, but logically follows)

---

## In Scope

### Features
- All many-many join table operations use `adapter.create/findOne/update/delete`
- Remove `useNamed` / `!useNamed` branching in relation handlers
- Remove `ensureJoinTable()` function and all calls to it
- Ensure existing relation tests pass

### Technical Components
- Modified: `datafn/server/src/execution/mutation/relations.ts`
- Modified: `datafn/server/src/execution/internal-tables.ts`
- Verified: `datafn/server/src/execution/mutation/__tests__/relations.test.ts`

## Out of Scope
- Changes to internal system tables (`__datafn_meta`, `__datafn_changes`, etc.)
- Changes to `ensureInternalTable()` (system tables unchanged)
- Adapter interface changes (no new methods needed)

---

## Deliverables

### Modified: `datafn/server/src/execution/mutation/relations.ts`

#### Current Code Pattern (in `executeRelate`, lines 142-209):
```typescript
if (relation.type === "many-many") {
  const useNamed = !!relation.joinTable;
  const tableName = relation.joinTable || `__datafn_join_${mutation.resource}_${relName}`;
  const fromCol = relation.joinColumns?.from || "from";
  const toCol = relation.joinColumns?.to || "to";

  if (!useNamed) {
    await ensureJoinTable(adapter, tableName, relation.metadata);  // REMOVE
  }

  for (const item of items) {
    if (useNamed) {
      // ... adapter.findOne + adapter.create/update    // KEEP
    } else {
      // ... adapter.internal.findOne + adapter.internal.create/update  // REMOVE
    }
  }
}
```

#### New Code Pattern:
```typescript
if (relation.type === "many-many") {
  const tableName = relation.joinTable || `__datafn_join_${mutation.resource}_${relName}`;
  const fromCol = relation.joinColumns?.from || "from";
  const toCol = relation.joinColumns?.to || "to";

  for (const item of items) {
    const existing = await adapter.findOne({
      model: tableName,
      where: [
        { field: fromCol, operator: "eq", value: mutation.id },
        { field: toCol, operator: "eq", value: item.toId },
      ],
      namespace,
    });

    if (existing) {
      if (Object.keys(item.metadata).length > 0) {
        await adapter.update({
          model: tableName,
          where: [
            { field: fromCol, operator: "eq", value: mutation.id },
            { field: toCol, operator: "eq", value: item.toId },
          ],
          data: item.metadata,
          namespace,
        });
      }
    } else {
      await adapter.create({
        model: tableName,
        data: {
          id: `${mutation.id}:${item.toId}`,
          [fromCol]: mutation.id,
          [toCol]: item.toId,
          ...item.metadata,
        },
        namespace,
      });
    }
  }
}
```

#### Changes to `executeRelate()`:
1. **Remove** `useNamed` variable (line 143)
2. **Remove** `ensureJoinTable()` call (lines 148-150)
3. **Remove** the `else` branch (lines 185-209) that uses `adapter.internal.*`
4. **Keep** the `if (useNamed)` branch code but remove the `if` — make it the only code path
5. The `id` field in create: use `${mutation.id}:${item.toId}` (same pattern as current internal CRUD)

#### Changes to `executeModifyRelation()`:
1. **Remove** `useNamed` variable (line 251)
2. **Remove** `ensureJoinTable()` call (lines 256-258)
3. **Remove** the `else` branch (lines 287-308) that uses `adapter.internal.*`
4. **Keep** the named branch as the only code path

#### Changes to `executeUnrelate()`:
1. **Remove** `useNamed` variable (line 361)
2. **Remove** `ensureJoinTable()` call (lines 366-368)
3. **Remove** the `else` branch (lines 380-384) that uses `adapter.internal.*`
4. **Keep** the named branch as the only code path

#### Remove Import:
```typescript
// DELETE this import:
import { ensureJoinTable } from "../internal-tables.js";
```

### Modified: `datafn/server/src/execution/internal-tables.ts`

**Delete `ensureJoinTable()` function** (lines 61-80):
```typescript
// DELETE entire function
export async function ensureJoinTable(...) { ... }
```

**Keep everything else**:
- `INTERNAL_TABLE_SCHEMAS` (system table definitions)
- `ensureInternalTable()` function (system tables)
- All column definitions (`META_COLUMNS`, etc.)

---

## Requirements Covered

- **FR-JT-CRUD-001**: Unified join table CRUD ✅
- **FR-REM-EJT-001**: Remove ensureJoinTable ✅

---

## Implementation Tasks

### Task 3.1: Refactor `executeRelate()`
- [ ] Remove `useNamed` branching
- [ ] Remove `ensureJoinTable()` call
- [ ] Remove `adapter.internal.*` code path
- [ ] Use `adapter.create/findOne/update` for all join tables
- [ ] Add `id` field to `adapter.create` data (composite key pattern)

### Task 3.2: Refactor `executeModifyRelation()`
- [ ] Remove `useNamed` branching
- [ ] Remove `ensureJoinTable()` call
- [ ] Remove `adapter.internal.*` code path
- [ ] Use `adapter.findOne/update` for all join tables

### Task 3.3: Refactor `executeUnrelate()`
- [ ] Remove `useNamed` branching
- [ ] Remove `ensureJoinTable()` call
- [ ] Remove `adapter.internal.*` code path
- [ ] Use `adapter.delete` for all join tables

### Task 3.4: Remove `ensureJoinTable()`
- [ ] Delete function from `internal-tables.ts`
- [ ] Remove import in `relations.ts`
- [ ] Verify no other files import `ensureJoinTable`

### Task 3.5: Verify Tests
- [ ] Run existing relation tests
- [ ] Verify all test scenarios pass with new code paths
- [ ] Add test for auto-generated join table name (no `joinTable` property)
- [ ] Verify `ensureInternalTable` still works for system tables

---

## Verification Steps

### Automated Testing
```bash
cd datafn/server && npm test -- --grep "relations"
cd datafn/server && npm test -- --grep "sync"
```

### Manual Verification
1. Grep for `adapter.internal` in `relations.ts` → zero results
2. Grep for `ensureJoinTable` across codebase → zero results
3. Grep for `ensureInternalTable` → still used for system tables

### Regression Testing
```bash
cd datafn/server && npm test
```

---

## Stop Condition

✅ Phase 03 is complete when:
1. All join table operations use `adapter.create/findOne/update/delete`
2. No `adapter.internal.*` calls for join tables remain in `relations.ts`
3. No `ensureJoinTable()` calls or imports remain
4. `ensureJoinTable()` function deleted from `internal-tables.ts`
5. `ensureInternalTable()` still works (system tables unaffected)
6. All existing relation tests pass
7. TV-JT-REL-001 test vector passes

---

## Risks & Issues

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Existing deployments with auto-created join tables break | High | High | Users MUST generate schema + run migrations BEFORE upgrading server |
| Test fixtures assume internal CRUD behavior | Medium | Medium | Update test fixtures if needed |
| Adapter doesn't handle join table model names | Low | Low | Drizzle adapter resolves from `db._.fullSchema` which will include join tables |

---

## Rollback Plan

Revert `relations.ts` and `internal-tables.ts` from git. The refactored code is self-contained in these two files.

---

## Migration Guide for Users

**Before upgrading to this version:**

1. Run `datafn generate --adapter drizzle --database postgres` to generate schema including join tables
2. Run `drizzle-kit generate` to create migration for any new/missing join tables
3. Run `drizzle-kit migrate` to apply the migration
4. THEN upgrade the server package

If join tables already exist in the database (created by previous `ensureJoinTable()` calls), `drizzle-kit` will detect them and either skip or create a no-op migration. The key is that the generated Drizzle schema must include them so the adapter can resolve them via `db._.fullSchema`.
