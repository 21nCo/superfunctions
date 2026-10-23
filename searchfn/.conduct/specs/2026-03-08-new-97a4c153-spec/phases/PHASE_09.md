# PHASE_09

## Phase goal
Build and publish comprehensive SearchFn docs using Fumadocs and shared theme primitives.

## In scope / Out of scope
In scope:
- New `searchfn/docs` app scaffold and config.
- Full documentation content coverage for all rewritten functionality.
- Docs coverage checks.

Out of scope:
- Runtime adapter implementation changes.

## Deliverables
- `searchfn/docs/package.json` (new)
- `searchfn/docs/source.config.ts` (new)
- `searchfn/docs/app/layout.tsx` (new)
- `searchfn/docs/app/layout.config.tsx` (new)
- `searchfn/docs/app/docs/layout.tsx` (new)
- `searchfn/docs/app/docs/[[...slug]]/page.tsx` (new)
- `searchfn/docs/app/global.css` (new)
- `searchfn/docs/content/docs/meta.json` (new)
- `searchfn/docs/content/docs/architecture.mdx` (new)
- `searchfn/docs/content/docs/reference/client.mdx` (new)
- `searchfn/docs/content/docs/reference/server.mdx` (new)
- `searchfn/docs/content/docs/reference/adapters/*.mdx` (new)
- `searchfn/docs/content/docs/integrations/datafn.mdx` (new)
- `searchfn/docs/content/docs/operations/*.mdx` (new)
- `scripts/docs-coverage-check.mjs` (new)

## Requirements covered
- DOC-001
- DOC-003

## Implementation tasks
1. Scaffold SearchFn docs app mirroring DataFn docs stack (Fumadocs + Next).
2. Wire docs app to shared theme package.
3. Author complete content set: architecture, API, adapters, server/client usage, DataFn integration, ops, troubleshooting.
4. Add docs coverage check script that verifies required sections.
5. Ensure docs examples compile or are test-validated.

## Verification steps
1. `npm --prefix searchfn/docs run build`
- Expected: build succeeds.
2. `node scripts/docs-coverage-check.mjs searchfn/docs`
- Expected: all required sections present.
3. `rg -n "PostgresAdapter|MeilisearchAdapter|OpenSearch|Elasticsearch|redaction|retries|timeouts" searchfn/docs/content/docs`
- Expected: topic coverage exists.

## Stop condition
SearchFn docs site is complete, builds successfully, and passes content coverage checks.
