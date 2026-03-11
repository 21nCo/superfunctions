# PHASE 05

## Phase goal
Document and demonstrate relation capability behavior for developers.

## In scope
- Docs update for relation capability schema and runtime semantics.
- Example app schema update demonstrating explicit opt-in.
- Regenerated sample codegen artifacts for example app.

## Out of scope
- New end-user UI flows.
- Python package docs.

## Deliverables
- `datafn/docs/content/docs/dfql/schema/relations.mdx`
- `datafn/docs/content/docs/dfql/schema/system-fields.mdx`
- `datafn/examples/todo-app/server/src/schema.datafn.ts` (optional explicit example)
- `datafn/examples/todo-app/server/src/datafn-schema.drizzle.ts` (regenerated)
- `datafn/examples/todo-app/server/src/datafn-types.ts` (regenerated)

## Requirements covered
- COMP-001
- OBS-001

## Implementation tasks
1. Add docs section: relation capabilities are explicit and many-many-only.
2. Document readonly stripping and server-owned values for relation capability fields.
3. Add migration note: enabling relation capabilities requires schema + migration regeneration.
4. Update example schema to demonstrate opt-in relation capabilities (if maintaining demo parity).
5. Regenerate and validate example artifacts.

## Verification steps
1. `cd datafn/docs && npm run build`
   - Expected: docs build succeeds.
2. `cd datafn/examples/todo-app/server && npm run build`
   - Expected: example server build succeeds with generated artifacts.

## Stop condition
Phase is complete when docs clearly describe relation capabilities and example artifacts reflect the documented behavior.
