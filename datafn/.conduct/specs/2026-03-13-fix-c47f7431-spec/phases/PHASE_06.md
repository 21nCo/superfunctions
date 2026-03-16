# PHASE_06

## Phase goal
Update todo example app to demonstrate seamless local-first client search and server parity with SearchFn options.

## In scope / Out of scope
In scope:
- Client example search provider/default options wiring.
- UI search call payload updates for parity options.
- Server example search adapter configuration parity.

Out of scope:
- New UI features unrelated to search.
- Non-example application changes.

## Deliverables
- `datafn/examples/todo-app/client/src/lib/datafn.ts`
- `datafn/examples/todo-app/client/src/App.svelte`
- `datafn/examples/todo-app/server/src/index.ts`
- `datafn/examples/todo-app/server/README.md` (if needed to explain run behavior)

## Requirements covered
- EX-001

## Implementation tasks
1. Configure IndexedDB search adapter defaults suitable for prefix/fuzzy usage.
2. Configure server adapter defaults to match option parity.
3. Pass `prefix`, `fuzzy`, and `fieldBoosts` from UI search calls.
4. Ensure default search path remains local-first in sync mode.
5. Add/update smoke instructions for local and remote mode checks.

## Verification steps
1. `npm run build --workspace todo-app-client`
Expected outcome: example client builds successfully.
2. `npm run build --workspace todo-app-server`
Expected outcome: example server builds successfully.
3. Manual smoke:
- Insert todo `testing`, search `test`.
- Expected: result includes inserted todo in local-first mode.

## Stop condition
Example app demonstrates requested local/server search behavior without manual code edits after setup.
