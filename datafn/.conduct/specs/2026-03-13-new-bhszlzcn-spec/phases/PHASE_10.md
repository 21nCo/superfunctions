# PHASE_10

## Phase goal
Execute migration/cutover strategy with compatibility safeguards.

## In scope / Out of scope
In scope:
- Dual-read/dual-write migration implementation.
- Backfill tooling and rollback scripts.
- Compatibility telemetry and warnings.

Out of scope:
- Python parity.

## Deliverables
- `datafn/server/src/execution/migration/spv2.ts` (new)
- `datafn/cli/src/migrate-spv2.ts` (new)
- `datafn/server/src/execution/migration/__tests__/spv2-migration.test.ts` (new)
- `datafn/.conduct/migrations/spv2-rollout-runbook.md` (new)

## Requirements covered
- COMP-001
- COMP-002

## Implementation tasks
1. Implement idempotent backfill from per-resource tables to global table.
2. Add dual-read path with feature flag.
3. Add optional dual-write path during migration window.
4. Implement rollback path to v1 reads if needed.
5. Add telemetry warnings for deprecated legacy API usage.

## Verification steps
1. `npm test --workspace datafn/server -- spv2-migration`
Expected outcome: migration tests pass.
2. Dry run migration in staging snapshot.
Expected outcome: equivalent access decisions pre/post migration.

## Stop condition
Migration can be executed and rolled back without access drift.
