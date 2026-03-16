# PHASE_02 — Client, Server & DataFn-Provider Passthrough

## Phase Goal

Ensure `prefix` and `fieldBoosts` flow through the client defaults, server routes, and datafn-provider to the adapter.

## In Scope

- Client: add `prefix` and `fieldBoosts` to `SearchClientDefaults`, resolve in `createSearchClient`
- Server: pass `prefix` from request body in search and searchAll routes
- DataFn-provider: forward `fuzzy`, `prefix`, `fieldBoosts` to adapter calls

## Out of Scope

- Adapter-level changes (done in Phase 01/03)

## Deliverables

- `searchfn/client/src/types.ts` — modified
- `searchfn/client/src/client.ts` — modified
- `searchfn/client/__tests__/client.test.ts` — modified (new tests)
- `searchfn/server/src/routes/search.ts` — modified
- `searchfn/server/src/routes/search-all.ts` — modified
- `searchfn/server/__tests__/server-routes.test.ts` — modified (new tests)
- `searchfn/datafn-provider/src/index.ts` — modified
- `searchfn/datafn-provider/__tests__/factory.test.ts` — modified (new tests)

## Requirements Covered

CLT-001, CLT-002, SRV-001, SRV-002, DFP-001

## Implementation Tasks

### Client

1. [ ] Add `prefix?: boolean` and `fieldBoosts?: Record<string, number>` to `SearchClientDefaults`
2. [ ] In `createSearchClient.search()`: resolve `prefix` and `fieldBoosts` from defaults, pass to adapter
3. [ ] In `createSearchClient.searchAll()`: resolve `prefix` and `fieldBoosts` from defaults, pass to adapter
4. [ ] Write test TV-CLT-001: client resolves prefix from defaults
5. [ ] Write test TV-CLT-002: client query-time prefix overrides default

### Server

6. [ ] In `searchHandler`: add `prefix: body.prefix as boolean | undefined` to adapter.search call
7. [ ] In `searchAllHandler`: add `prefix: body.prefix as boolean | undefined` to adapter.searchAll call and fallback search calls
8. [ ] Write test TV-SRV-001: server search route passes prefix
9. [ ] Write test TV-SRV-002: server searchAll route passes prefix

### DataFn-Provider

10. [ ] In `createSearchProvider.search()`: forward `fuzzy`, `prefix`, `fieldBoosts` from params to adapter.search
11. [ ] In `createSearchProvider.searchAll()`: forward `fuzzy`, `prefix`, `fieldBoosts` from params to adapter.searchAll
12. [ ] Write test TV-DFP-001: provider forwards options to search
13. [ ] Write test TV-DFP-002: provider forwards options to searchAll

## Verification Steps

```bash
cd searchfn/client && npm test
# Expected: all tests pass

cd searchfn/server && npm test
# Expected: all tests pass

cd searchfn/datafn-provider && npm test
# Expected: all tests pass

cd searchfn/client && npm run typecheck
cd searchfn/server && npm run typecheck
cd searchfn/datafn-provider && npm run typecheck
# Expected: no type errors
```

## Stop Condition

All passthrough layers correctly forward prefix/fuzzy/fieldBoosts. Tests verify params reach the adapter. No regressions.
