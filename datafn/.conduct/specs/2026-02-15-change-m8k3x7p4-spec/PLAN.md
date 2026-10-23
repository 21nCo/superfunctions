# Implementation Plan

## Overview

This document outlines the phased implementation strategy for the unified schema generation and join table refactor.

---

## Implementation Strategy

### Approach

**Replace and Simplify**: Remove DataFn's custom migration system, add Drizzle schema generation, unify the CLI, and refactor join table handling — in 4 independently verifiable phases.

### Phases

1. **Phase 01**: Core Drizzle schema codegen function (`generateDrizzleSchema()`)
2. **Phase 02**: Unified `generate` CLI command, remove old commands, delete migration code
3. **Phase 03**: Adapter join table refactor (uniform `adapter.*` CRUD)
4. **Phase 04**: Tests, documentation, cleanup

---

## Phase Breakdown

### Phase 01: Core Drizzle Schema Codegen

**Duration**: ~3-4 hours
**Deliverables**: `generateDrizzleSchema()` function with full type mapping, modifiers, indices, and join tables for all 3 dialects

**Scope**:
- New function `generateDrizzleSchema(schema, dialect)` in `datafn/cli/src/drizzle-codegen.ts`
- Type mapping for Postgres, MySQL, SQLite
- Field modifiers: required, unique, default, primaryKey
- camelCase → snake_case column naming
- Index generation from `indices.base`
- Join table generation from many-many relations
- Metadata fields in join tables
- Custom joinTable/joinColumns support
- Schema export object
- Generated file header
- Deterministic output (sorted)
- Import tree-shaking
- Unit tests for all codegen scenarios

**Stop Condition**: All TV-DRZ-* test vectors pass

**Detailed Plan**: See `phases/PHASE_01.md`

---

### Phase 02: Unified `generate` CLI Command

**Duration**: ~2-3 hours
**Deliverables**: New `generate` command, old commands removed, migration code deleted

**Scope**:
- New `generate` command in `cli.ts` with `--adapter` and `--database` flags
- Wire up `generateDrizzleSchema()` + `generateTypes()`
- Both files written to output directory
- Deprecation notices for `generate-types` and `generate-migration`
- Remove imports of migration modules
- Delete `migrations/` directory entirely
- Update `package.json` exports
- Update help text

**Stop Condition**: `datafn generate --adapter drizzle --database postgres` succeeds. Old commands print migration notices. All TV-CLI-* test vectors pass.

**Detailed Plan**: See `phases/PHASE_02.md`

---

### Phase 03: Adapter Join Table Refactor

**Duration**: ~3-4 hours
**Deliverables**: All join table operations use standard adapter CRUD

**Scope**:
- Modify `executeRelate()` to use `adapter.create/findOne` for all join tables
- Modify `executeModifyRelation()` to use `adapter.findOne/update` for all join tables
- Modify `executeUnrelate()` to use `adapter.delete` for all join tables
- Remove `useNamed` branching logic
- Remove all `adapter.internal.*` calls for join tables
- Remove `ensureJoinTable()` import and calls
- Delete `ensureJoinTable()` function from `internal-tables.ts`
- Verify existing relation tests pass

**Stop Condition**: All relation tests pass. No `adapter.internal` calls for join tables. `ensureJoinTable()` deleted. TV-JT-REL-001 passes.

**Detailed Plan**: See `phases/PHASE_03.md`

---

### Phase 04: Cleanup, Tests & Documentation

**Duration**: ~2-3 hours
**Deliverables**: Complete test coverage, updated documentation, clean codebase

**Scope**:
- Remove `migrations.test.ts`
- Full test suite run (all existing + new tests pass)
- Update `datafn/cli/README.md` with new `generate` command documentation
- Remove migration-related sections from README
- Update todo-app example to use generated schema (if applicable)
- Verify no dead imports or unused code
- Final review of all generated output for correctness

**Stop Condition**: All tests pass. README updated. No dead code. PR ready.

**Detailed Plan**: See `phases/PHASE_04.md`

---

## Dependencies & Prerequisites

### External Dependencies

**None new**. The CLI does NOT depend on `drizzle-orm` — it generates code that imports from `drizzle-orm` in the user's project.

### Internal Dependencies

**Phase ordering**:
- Phase 02 depends on Phase 01 (CLI needs `generateDrizzleSchema()`)
- Phase 03 is independent of Phase 01/02 (server-side change, can be done in parallel)
- Phase 04 depends on Phase 01, 02, and 03

---

## Risk Mitigation

| Risk | Mitigation Phase | Strategy |
|------|------------------|----------|
| Generated Drizzle schema has type errors | Phase 01 | Exact expected output in test vectors; compile check |
| Breaking existing users on `generate-migration` | Phase 02 | Migration notice; changelog; README docs |
| Removing `ensureJoinTable` breaks runtime | Phase 03 | Users must run codegen + migrations before upgrading server |
| camelCase → snake_case edge cases | Phase 01 | Explicit test vectors for naming |
| Dead imports after migration code removal | Phase 04 | Final cleanup pass; TypeScript compile check |

---

## Testing Strategy

### Phase 01 Testing
- Unit tests for `generateDrizzleSchema()` with all 3 dialects
- Test vectors: TV-DRZ-PG-001, TV-DRZ-MY-001, TV-DRZ-SL-001, TV-DRZ-MOD-001, TV-DRZ-IDX-001, TV-DRZ-JOIN-001, TV-DRZ-JOIN-002, TV-DRZ-COL-001, TV-DRZ-IMP-001, TV-DRZ-DET-001

### Phase 02 Testing
- CLI integration tests for `generate` command
- Deprecation notice tests
- Test vectors: TV-CLI-GEN-001, TV-CLI-GEN-002, TV-CLI-DEP-001, TV-CLI-DEP-002, TV-CLI-ERR-001, TV-CLI-ERR-002

### Phase 03 Testing
- Relation mutation tests (existing + new)
- Test vector: TV-JT-REL-001
- Verify no `adapter.internal` calls for join tables

### Phase 04 Testing
- Full test suite: `npm test` in datafn/cli, datafn/server
- Compile check: `tsc --noEmit`
- Dead code analysis

---

## Rollout Plan

### Development

1. Create feature branch: `feat/unified-schema-generation`
2. Implement Phase 01, commit: `feat(cli): add Drizzle schema codegen`
3. Implement Phase 02, commit: `feat(cli): unified generate command, remove migrations`
4. Implement Phase 03, commit: `refactor(server): unify join table CRUD via adapter`
5. Implement Phase 04, commit: `chore: cleanup, tests, documentation`
6. Final integration testing

### Review

- Code review focusing on:
  - Generated Drizzle schema correctness
  - Breaking change documentation
  - Join table refactor safety
  - No dead code or imports

### Deployment

- Merge to `next` branch
- Publish as **major version bump** (breaking: removes `generate-migration`, `generate-types`)
- Changelog documents migration path
- README documents new workflow

---

## Success Metrics

Implementation is considered complete when:

- All 17 test vectors pass
- All existing tests continue to pass (except removed migration tests)
- Generated Drizzle schemas compile with `drizzle-orm` installed
- `drizzle-kit generate` works with generated schemas
- No `adapter.internal` calls for join tables
- No `ensureJoinTable` references remain
- Migration code fully removed
- README updated
- PR merged to next branch

---

## Timeline Estimate

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 01: Core Drizzle Codegen | 3-4 hours | 3-4 hours |
| Phase 02: Unified CLI | 2-3 hours | 5-7 hours |
| Phase 03: Join Table Refactor | 3-4 hours | 8-11 hours |
| Phase 04: Cleanup & Docs | 2-3 hours | 10-14 hours |
| **Total** | **10-14 hours** | |

---

## Open Questions & Decisions

All design decisions have been finalized:

- **Adapter scope**: Drizzle only (Prisma/Kysely deferred)
- **CLI command**: Single `generate` replacing both old commands
- **Join tables**: In generated ORM schema, queried via adapter CRUD
- **Migration code**: Fully removed
- **Breaking change**: Major version bump with migration notice

No open questions remain.
