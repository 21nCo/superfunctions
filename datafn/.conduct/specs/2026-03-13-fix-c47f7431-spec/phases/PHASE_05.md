# PHASE_05

## Phase goal
Unify client-side search systems by making `clientSearch` plugin provider-aware and deprecating MiniSearch-only primary usage.

## In scope / Out of scope
In scope:
- Provider-delegation mode in plugin when `searchProvider` exists.
- Legacy MiniSearch mode retained only for no-provider compatibility.
- Deprecation signaling for legacy-only mode in docs/comments.

Out of scope:
- Removing plugin from package exports.
- Breaking existing no-provider plugin users.

## Deliverables
- `datafn/client/src/plugins/clientSearch.ts`
- `datafn/client/__tests__/plugins/clientSearch.test.ts`

## Requirements covered
- UNI-001
- UNI-002

## Implementation tasks
1. Add provider delegation path in plugin config/runtime.
2. Use provider search results to inject deterministic candidate ID filters.
3. Route plugin lifecycle index updates through provider in delegation mode.
4. Keep legacy MiniSearch path for no-provider mode and add deprecation notice.
5. Expand plugin tests for delegation mode and legacy mode behavior.

## Verification steps
1. `npm test --workspace @datafn/client -- --run plugins/clientSearch.test.ts`
Expected outcome: delegation and legacy-mode tests both pass.
2. `rg -n "deprecated|legacy|provider" datafn/client/src/plugins/clientSearch.ts`
Expected outcome: explicit migration/deprecation messaging present.

## Stop condition
Provider-configured clients use one search backend (SearchProvider) for plugin-managed query search behavior.
