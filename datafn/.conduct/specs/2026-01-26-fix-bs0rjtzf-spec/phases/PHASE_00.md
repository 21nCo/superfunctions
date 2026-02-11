# PHASE_00
## Phase goal
Define and export DFQL structural TypeScript types in `@datafn/core` required for compile-time DFQL shape checking.

## In scope
- Add `DfqlQuery`, `DfqlQueryFragment`, and supporting structural types to `@datafn/core`.
- Export the new types from `@datafn/core` public entrypoints.

## Out of scope
- Schema-level typing of DFQL fields/tokens (e.g., validating `select` strings against schema at compile time).

## Deliverables
- Modify: `datafn/core/src/index.ts`
- Create: `datafn/core/src/dfql.ts`
- (Optional) Add: `datafn/core/__tests__/dfql-types.test.ts` (type-only smoke via `tsc`)

## Requirements covered
- DFQL-001 (enabler)

## Implementation tasks
1. Create `datafn/core/src/dfql.ts` containing the structural DFQL types defined in `SPEC.md`.
2. Export these types from `datafn/core/src/index.ts`.
3. Ensure `@datafn/core` builds and typechecks.

## Verification steps
- `npm --prefix datafn/core test`
- `npm --prefix datafn/core typecheck`

Expected outcomes:
- Tests pass.
- Typecheck passes.

## Stop condition
Report the created/modified files and confirm `@datafn/core` typecheck passes before starting PHASE_01.
