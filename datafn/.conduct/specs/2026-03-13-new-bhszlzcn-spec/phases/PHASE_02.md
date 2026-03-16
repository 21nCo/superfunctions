# PHASE_02

## Phase goal
Add SPV2 data model/codegen support and migration scaffolding.

## In scope / Out of scope
In scope:
- Global permissions table generation.
- Membership and hierarchy table generation.
- Visibility column generation on share-enabled resources.
- Required index generation.
- Migration scaffold for v1 table backfill.

Out of scope:
- Runtime ACL enforcement.

## Deliverables
- `datafn/cli/src/drizzle-codegen.ts`
- `datafn/cli/src/codegen.ts`
- `datafn/cli/src/__tests__/drizzle-codegen-capabilities.test.ts`
- `datafn/cli/src/__tests__/drizzle-codegen-spv2.test.ts` (new)
- `datafn/.conduct/migrations/spv2-permissions-migration.md` (new)

## Requirements covered
- ARCH-002
- ARCH-003
- PERF-001
- COMP-001

## Implementation tasks
1. Add codegen for `__datafn_permissions_global`.
2. Add codegen for `__datafn_principal_memberships` and `__datafn_principal_hierarchy`.
3. Add visibility system column generation and readonly constraints.
4. Generate indexes required by PERF-001.
5. Add migration scaffold doc and script shape for v1 -> v2 copy.
6. Add snapshot tests for generated schema.

## Verification steps
1. `npm test --workspace datafn/cli`
Expected outcome: CLI/codegen tests pass.
2. `npm run build --workspace datafn/cli`
Expected outcome: build succeeds.
3. Manual: inspect generated schema output for one share-enabled resource.
Expected outcome: includes visibility column and global tables.

## Stop condition
Codegen deterministically emits SPV2 tables/indexes and migration scaffolding with passing tests.
