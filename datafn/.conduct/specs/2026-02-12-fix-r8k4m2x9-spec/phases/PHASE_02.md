# Phase 02 — Route Server Internal Tables Through `adapter.internal`

## Phase Goal

Update all DataFn server files that access `__datafn_*` internal tables to use `adapter.internal.*` instead of `adapter.create/findOne/findMany/update/delete`.

## In Scope

- `sequence-store.ts`: `__datafn_meta` → `adapter.internal`
- `change-tracking.ts`: `__datafn_meta` + `__datafn_changes` → `adapter.internal`
- `idempotency-db.ts`: `__datafn_idempotency` → `adapter.internal`
- `seed.ts`: `__datafn_seed` → `adapter.internal`
- Adding `ensureTable` calls with correct column definitions
- Updating tests that mock adapter calls for internal tables

## Out of Scope

- Join table changes (Phase 03)
- CLI changes (Phase 04)

## Deliverables

| File                                                  | Action                          |
| ----------------------------------------------------- | ------------------------------- |
| `datafn/server/src/execution/sync/sequence-store.ts`  | MODIFY — use `adapter.internal` |
| `datafn/server/src/execution/sync/change-tracking.ts` | MODIFY — use `adapter.internal` |
| `datafn/server/src/execution/idempotency-db.ts`       | MODIFY — use `adapter.internal` |
| `datafn/server/src/routes/seed.ts`                    | MODIFY — use `adapter.internal` |

## Requirements Covered

- SRV-001, SRV-002, SRV-003, SRV-004

## Implementation Tasks

### Define internal table column schemas (shared constants)

- [ ] Create `datafn/server/src/execution/internal-tables.ts` with `INTERNAL_TABLE_SCHEMAS` containing column defs for all 4 tables
- [ ] Export `ensureInternalTable(adapter, tableName)` helper that calls `adapter.internal.ensureTable` with correct columns

### Update `sequence-store.ts`

- [ ] Replace `this.db.findOne({ model: "__datafn_meta", ... })` with `this.db.internal.findOne("__datafn_meta", [...])`
- [ ] Replace `this.db.create({ model: "__datafn_meta", ... })` with `this.db.internal.create("__datafn_meta", { ... })`
- [ ] Replace `this.db.update({ model: "__datafn_meta", ... })` with `this.db.internal.update("__datafn_meta", [...], { ... })`
- [ ] Add `ensureInternalTable(this.db, "__datafn_meta")` call in `getCurrent()` on first invocation

### Update `change-tracking.ts`

- [ ] Same pattern for `__datafn_meta` calls
- [ ] Replace `__datafn_changes` calls with `adapter.internal.*`
- [ ] Add `ensureInternalTable` calls for both tables

### Update `idempotency-db.ts`

- [ ] Replace `this.db.findOne/create` with `this.db.internal.findOne/create` for `__datafn_idempotency`
- [ ] Add `ensureInternalTable` call

### Update `seed.ts`

- [ ] Replace `__datafn_seed` calls with `adapter.internal.*`
- [ ] Add `ensureInternalTable` call

## Verification Steps

```bash
# Run all DataFn server tests
cd /Users/ar/dev/superfunctions/datafn/server
npm test

# Rebuild packages/db and test example server manually
cd /Users/ar/dev/superfunctions/packages/db
npm run build

cd /Users/ar/dev/superfunctions/datafn/examples/todo-app/server
npm run dev
# Verify: mutations no longer produce "no table mapping" errors
```

**Expected**: All server tests pass (tests use memory adapter which now has `internal`). Example server mutations succeed without `__datafn_meta` errors.

## Stop Condition

Server tests all pass. Example server demo shows successful mutations with Drizzle adapter. Report push response and server logs.
