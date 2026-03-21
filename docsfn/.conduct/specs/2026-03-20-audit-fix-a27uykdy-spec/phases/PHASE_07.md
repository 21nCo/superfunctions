# PHASE_07

- Phase goal: Ship a production-capable Svelte component layer and SvelteKit site kit with parity to the canonical core contracts and the Next site kit.

## In scope

- Safe Svelte chrome components and content rendering.
- SvelteKit route helpers for load and prerender flows.
- A runnable SvelteKit example site wired to the canonical fixtures.
- Type declaration correctness for `@docsfn/svelte`.

## Out of scope

- React or Next-specific refactors beyond shared core fixes discovered during parity testing.
- Blog-specific flows not needed for the shared chrome model.
- Custom design-system work beyond current `@uifn/svelte` integration needs.

## Deliverables

- Modify `docsfn/svelte/package.json`.
- Modify `docsfn/svelte/tsup.config.ts`.
- Modify `docsfn/svelte/src/index.ts`.
- Modify `docsfn/svelte/src/DocsLayout.svelte`.
- Modify `docsfn/svelte/src/DocsSidebar.svelte`.
- Modify `docsfn/svelte/src/DocsToc.svelte`.
- Modify `docsfn/svelte/src/Breadcrumbs.svelte`.
- Modify `docsfn/svelte/src/Pagination.svelte`.
- Modify `docsfn/svelte/src/TopBar.svelte`.
- Modify `docsfn/svelte/src/VersionSwitcher.svelte`.
- Modify `docsfn/sveltekit/src/index.ts`.
- Modify `docsfn/sveltekit/src/route-helpers.ts`.
- Create `docsfn/examples/sveltekit-docs-site/package.json`.
- Create `docsfn/examples/sveltekit-docs-site/svelte.config.js`.
- Create `docsfn/examples/sveltekit-docs-site/src/routes/docs/[...slug]/+page.svelte`.
- Create `docsfn/examples/sveltekit-docs-site/src/routes/docs/[...slug]/+page.ts`.
- Create `docsfn/examples/sveltekit-docs-site/src/routes/+layout.ts`.

## Requirements covered

- `SVELTE-001`
- `PAGE-001`
- `SEARCH-002`
- `ROUTE-001`
- `NAV-001`
- `PKG-001`

## Implementation tasks

1. Fix `@docsfn/svelte` packaging so it emits the declared `.d.ts` output and the published entrypoints match the actual build artifacts.
2. Refactor Svelte chrome components to consume the same manifest-derived page surface used by React and to avoid unsafe raw HTML rendering.
3. Implement SvelteKit route helpers for slug lookup, route data loading, prerender entry generation, and static search artifact access.
4. Wire the canonical manifest and compiled-content pipeline into a runnable SvelteKit example site under `/docs`.
5. Add parity checks that compare Next and SvelteKit route lookup results for the canonical fixtures so framework adapters cannot drift semantically.
6. Add component or integration tests for Svelte surfaces where the shared core tests do not already prove behavior.
7. Update publish metadata and README snippets so `@docsfn/svelte` and `@docsfn/sveltekit` are releasable.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/svelte run build`
   Expected outcome: the Svelte package builds and writes `dist/index.d.ts` plus the compiled JS artifacts.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/sveltekit run build`
   Expected outcome: the SvelteKit adapter builds against the updated core and Svelte contracts.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/examples/sveltekit-docs-site run build`
   Expected outcome: the example SvelteKit site builds and prerenders the canonical docs routes.
4. Manual check: open the SvelteKit example `/docs` route.
   Expected outcome: the root docs route, navigation order, breadcrumbs, version switching, and search behavior match the Next example semantics.

## Stop condition

- Report whether SvelteKit route behavior is semantically identical to the Next site kit for the canonical fixtures.
- Report the final published artifacts emitted by `@docsfn/svelte`.
- Report any remaining framework-specific parity gaps before blog and embedded mode work begins.
