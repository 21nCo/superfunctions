# PHASE_06

- Phase goal: Convert both example apps into true proof apps for docs, API, blog, and embedded surfaces.

## In scope

- Next example proof routes
- SvelteKit example proof routes
- shared proof-route inventory

## Out of scope

- release-gate final orchestration
- docs wording changes

## Deliverables

- Modify `docsfn/examples/next-docs-site/app/docs/[[...slug]]/page.tsx`
- Modify `docsfn/examples/next-docs-site/app/blog/[slug]/page.tsx`
- Modify `docsfn/examples/next-docs-site/app/embedded/[[...slug]]/page.tsx`
- Modify `docsfn/examples/sveltekit-docs-site/src/routes/docs/[...slug]/+page.svelte`
- Modify `docsfn/examples/sveltekit-docs-site/src/routes/blog/[slug]/+page.svelte`
- Modify `docsfn/examples/sveltekit-docs-site/src/routes/embedded/[...slug]/+page.svelte`
- Add proof-route tests or e2e specs

## Requirements covered

- `EXAMPLE-001`
- `BLOG-001`
- `EMBED-001`
- `TEST-001`

## Implementation tasks

1. Replace raw `<pre>` source rendering in proof routes with shipped docsfn components.
2. Ensure proof routes exist for docs/api/blog/embedded surfaces in both frameworks.
3. Ensure example search behavior exercises the same adapter-based search runtime path as docsfn core and dogfood.
4. Add tests that assert absence of raw-source fallback.
5. Keep route names stable so release gate can target them.

## Verification steps

1. Build/run Next example against both canonical fixtures.
   Expected outcome: proof routes render shipped components for all required surfaces and do not diverge from the canonical search runtime path.
2. Build/run SvelteKit example against both canonical fixtures.
   Expected outcome: same proof-route inventory and same required surfaces.

## Stop condition

- Report the final proof-route inventory shared by both frameworks.
