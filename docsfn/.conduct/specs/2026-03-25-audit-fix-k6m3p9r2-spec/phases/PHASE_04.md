# PHASE_04

- Phase goal: Make `docsfn/docs` truthful by aligning search/API semantics and eliminating per-request content recompilation.

## In scope

- dogfood site config
- dogfood source loader
- dogfood docs/blog route loaders
- search scope alignment for API pages

## Out of scope

- example app rewrites
- public README/guide wording changes outside dogfood site content

## Deliverables

- Modify `docsfn/docs/docsfn.config.ts`
- Modify `docsfn/docs/src/lib/server/docs-site-source.ts`
- Modify `docsfn/docs/src/routes/docs/[...slug]/+page.server.ts`
- Modify `docsfn/docs/src/routes/blog/[slug]/+page.server.ts`
- Add dogfood tests covering cache reuse and search scope truthfulness

## Requirements covered

- `API-001`
- `SEARCH-001`
- `SITE-001`
- `CACHE-001`

## Implementation tasks

1. Add canonical `routeScopeOverrides` for dogfood API-markdown pages under `/docs/api/**`.
2. Build compiled content caches at source-load time for pages/posts.
3. Wire dogfood search loading/query behavior through the same adapter-based search runtime path defined by the revised `PHASE_01` contract.
4. Replace per-request compilation in docs/blog loaders with cache lookups.
5. Add tests that prove API pages appear in `api` search scope and that repeated route loads reuse compiled artifacts.

## Verification steps

1. Run dogfood route/load tests.
   Expected outcome: no per-request recompilation; API-markdown pages appear in `api` search scope; dogfood search uses the same adapter-based runtime path as docsfn core.
2. Run a docs-site build or route integration harness after bootstrap.
   Expected outcome: dogfood site remains buildable with aligned API/search semantics.

## Stop condition

- Report the chosen dogfood API scope strategy, the cache keys in use, and the search runtime path exercised by the dogfood site.
