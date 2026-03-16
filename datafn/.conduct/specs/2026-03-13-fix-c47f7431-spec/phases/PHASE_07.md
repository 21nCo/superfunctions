# PHASE_07

## Phase goal
Finalize documentation and run full regression gates for affected packages.

## In scope / Out of scope
In scope:
- Search documentation updates for new behavior.
- Targeted package tests and typechecks.
- Final checklist against intent audit.

Out of scope:
- Unrelated refactors.
- Additional feature work outside this issue scope.

## Deliverables
- `datafn/docs/content/docs/dfql/search.mdx`
- `datafn/client/README.md` (if search behavior section exists)
- `datafn/server/README.md` (if endpoint docs section exists)
- Final phase report artifact (during execution stage, not spec stage)

## Requirements covered
- DOC-001
- TST-001

## Implementation tasks
1. Update docs from MiniSearch-primary wording to provider-backed local-first wording.
2. Document `source=auto|local|remote` semantics and option fields.
3. Run targeted client/server tests and typechecks.
4. Validate every requirement has passing vector evidence.

## Verification steps
1. `npm run typecheck --workspace @datafn/client && npm run typecheck --workspace @datafn/server && npm run typecheck --workspace @datafn/core`
Expected outcome: all typechecks pass.
2. `npm test --workspace @datafn/client && npm test --workspace @datafn/server`
Expected outcome: all affected package tests pass.
3. `rg -n "MiniSearch|local-first|fieldBoosts|source" datafn/docs/content/docs/dfql/search.mdx`
Expected outcome: docs reflect updated architecture and options.

## Stop condition
Documentation and regression gates confirm implementation is complete and aligned with all intent items.
