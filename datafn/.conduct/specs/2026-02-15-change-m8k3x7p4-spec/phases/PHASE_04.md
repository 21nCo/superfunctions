# Phase 04: Cleanup, Tests & Documentation

**Goal**: Complete test coverage, update documentation, clean up dead code, and finalize the PR.
**Duration Estimate**: 2-3 hours
**Prerequisites**: Phase 01, 02, and 03 complete

---

## In Scope

### Features
- Full test suite verification
- README documentation update
- Dead code and import cleanup
- Migration test removal verification
- Example app update considerations

### Technical Components
- Modified: `datafn/cli/README.md`
- Deleted: `datafn/cli/__tests__/migrations.test.ts` (if not already deleted in Phase 02)
- Verified: All test files compile and pass

## Out of Scope
- New feature development
- Adapter interface changes
- Example app schema migration (can be done separately)

---

## Deliverables

### Modified: `datafn/cli/README.md`

Replace the current CLI Usage section with documentation for the `generate` command:

**Remove**:
- `generate-types` CLI section
- `generate-migration` CLI section
- Migration options table
- ORM Adapter Generators section
- SQL Renderers programmatic API (renderPostgres, renderMySQL, renderSQLite)
- diffSchemas programmatic API
- MigrationPlan & MigrationChange types
- MigrationContext type
- Database Dialect Differences table
- Migration-related exports

**Add**:
- `generate` CLI command section with options table
- Production workflow section
- Generated Drizzle schema example output
- Updated Exports section

**Update**:
- Features table to reflect new functionality
- Programmatic API to include `generateDrizzleSchema`

### Updated Features Table:
```markdown
| Feature | Description |
|---------|-------------|
| **Schema Generation** | Generate Drizzle ORM schema (pgTable, mysqlTable, sqliteTable) from DataFn schema |
| **Type Generation** | Generate TypeScript interfaces, `Tables` map, and `TypedClient` from DataFn schema |
| **Multi-Database** | PostgreSQL, MySQL, SQLite — each with dialect-specific Drizzle column types |
| **CLI Interface** | `npx @datafn/cli generate` command for schema + type generation |
```

### Updated Exports:
```markdown
## Exports

```typescript
// Schema generation
export { generateDrizzleSchema }

// Type generation
export { generateTypes }

// Types
export type { ... }
```

### Verification Checklist

- [ ] `npm test` passes in `datafn/cli`
- [ ] `npm test` passes in `datafn/server`
- [ ] `tsc --noEmit` passes in `datafn/cli`
- [ ] No dead imports (unused import warnings)
- [ ] No references to deleted migration files
- [ ] No references to `ensureJoinTable`
- [ ] `datafn --help` shows correct help text
- [ ] README accurately describes current functionality

---

## Requirements Covered

No new requirements — Phase 04 verifies all previous phases.

---

## Implementation Tasks

### Task 4.1: Update README
- [ ] Replace CLI Usage section with `generate` command docs
- [ ] Remove migration-related sections
- [ ] Add production workflow section
- [ ] Add generated Drizzle schema example
- [ ] Update Features table
- [ ] Update Exports section
- [ ] Update programmatic API section

### Task 4.2: Dead Code Cleanup
- [ ] Verify no migration imports remain in any file
- [ ] Verify no `ensureJoinTable` imports remain
- [ ] Verify `migrations/` directory is fully deleted
- [ ] Check for any unused type definitions
- [ ] Run TypeScript compiler to catch issues

### Task 4.3: Full Test Suite
- [ ] Run all CLI tests
- [ ] Run all server tests
- [ ] Run all DB adapter tests
- [ ] Verify no test failures

### Task 4.4: Final Review
- [ ] Review all generated output for correctness
- [ ] Verify test vector coverage
- [ ] Check for any TODO comments left behind
- [ ] Ensure package.json is clean

---

## Verification Steps

### Full Test Suite
```bash
# CLI tests
cd datafn/cli && npm test

# Server tests
cd datafn/server && npm test

# DB adapter tests
cd packages/db && npm test
```

### Compile Check
```bash
cd datafn/cli && npx tsc --noEmit
cd datafn/server && npx tsc --noEmit
```

### Dead Reference Check
```bash
grep -r "generate-migration" datafn/cli/src/  # Should return 0 results (except deprecation notice)
grep -r "ensureJoinTable" datafn/  # Should return 0 results
grep -r "diffSchemas" datafn/cli/src/  # Should return 0 results (except if re-exported)
grep -r "renderPostgres" datafn/cli/src/  # Should return 0 results
```

---

## Stop Condition

✅ Phase 04 is complete when:
1. All tests pass across cli, server, and db packages
2. No TypeScript compilation errors
3. No dead imports or references to deleted code
4. README accurately documents current functionality
5. PR is ready for review

---

## Risks & Issues

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Forgotten test references to migration code | Low | Low | Compile check catches |
| README inconsistency | Low | Low | Manual review |

---

## Rollback Plan

Phase 04 is documentation and cleanup only — no behavioral changes. Rollback is trivial.
