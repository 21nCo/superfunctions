# PHASE_07

## Phase goal
Remove obsolete SearchFn legacy code, stale server logic, and deprecated docs/plugin paths.

## In scope / Out of scope
In scope:
- Delete legacy `searchfn/client` engine internals not part of thin API.
- Delete stale schema-coupled `searchfn/server` legacy logic.
- Remove stale `datafn/client` miniSearch plugin path if no longer used.

Out of scope:
- New docs content writing.
- Production benchmark gates.

## Deliverables
- Removal of legacy files under `searchfn/client/src/*` not used by rewritten API
- Removal/replacement of stale files in `searchfn/server/src/indexing.ts` and `searchfn/server/src/search.ts`
- `datafn/client/src/plugins/clientSearch.ts` removal or de-registration from public exports
- Updated imports/exports and tests after deletions

## Requirements covered
- ARCH-002
- LEG-001

## Implementation tasks
1. Remove legacy modules and compatibility exports from `@searchfn/client`.
2. Remove stale old searchfn server indexing/search modules and keep only thin transport logic.
3. Remove outdated DataFn client search plugin path if not required by rewritten architecture.
4. Update tests/typechecks to reflect removals.
5. Add grep guard test to prevent reintroduction of removed symbols.

## Verification steps
1. `rg --files searchfn/client/src | rg '(compat|search-engine|in-memory-search|pipeline|indexing|cache|storage|query)'`
- Expected: no matches (or only intentionally retained files explicitly listed in commit notes).
2. `rg -n "createClientSearchPlugin" datafn/client/src`
- Expected: no public API export usage if removed by design.
3. `npm --prefix searchfn/client run typecheck && npm --prefix searchfn/server run typecheck`
- Expected: pass.

## Stop condition
Legacy paths are removed, references are gone, and packages still pass tests/typechecks.
