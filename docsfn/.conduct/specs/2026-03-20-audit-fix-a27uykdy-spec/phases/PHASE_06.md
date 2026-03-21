# PHASE_06

- Phase goal: Ship a production-capable React component layer and Next.js site kit that can host the canonical docsfn manifest and replace the current Fumadocs-backed Next docs sites.

## In scope

- React chrome components and page surface contracts.
- Next.js App Router helpers for docs routes, metadata, and static params.
- A runnable Next example site wired to the canonical repo fixtures.

## Out of scope

- SvelteKit site-kit work.
- Blog or embedded-only flows beyond what the shared React layer needs.
- Analytics beyond wiring the shared contracts through.

## Deliverables

- Modify `docsfn/react/src/DocsLayout.tsx`.
- Modify `docsfn/react/src/DocsSidebar.tsx`.
- Modify `docsfn/react/src/DocsToc.tsx`.
- Modify `docsfn/react/src/Breadcrumbs.tsx`.
- Modify `docsfn/react/src/Pagination.tsx`.
- Modify `docsfn/react/src/TopBar.tsx`.
- Modify `docsfn/react/src/VersionSwitcher.tsx`.
- Modify `docsfn/react/src/ThemeProvider.tsx`.
- Modify `docsfn/react/src/index.ts`.
- Modify `docsfn/next/src/index.ts`.
- Modify `docsfn/next/src/route-helpers.ts`.
- Create `docsfn/examples/next-docs-site/package.json`.
- Create `docsfn/examples/next-docs-site/source.config.ts`.
- Create `docsfn/examples/next-docs-site/app/docs/layout.tsx`.
- Create `docsfn/examples/next-docs-site/app/docs/[[...slug]]/page.tsx`.
- Create `docsfn/examples/next-docs-site/app/api/search/route.ts`.

## Requirements covered

- `PAGE-001`
- `NEXT-001`
- `SEARCH-002`
- `ROUTE-001`
- `NAV-001`
- `PKG-001`

## Implementation tasks

1. Refactor the React chrome components so they all consume the same manifest-derived page surface and do not reconstruct navigation independently.
2. Fix any type or build failures in `@docsfn/react`, including React `19` compatibility and typed exports for all public components.
3. Implement Next route helpers for static params generation, page lookup by slug, metadata generation, not-found behavior, and search artifact serving.
4. Wire the canonical manifest and compiled-content pipeline into a runnable Next example site that targets the canonical repo fixtures under the expected `/docs` base path.
5. Ensure the example site proves parity for root docs index routing, breadcrumbs, version switching, pagination, TOC, search loading, and API page rendering.
6. Add component or integration tests for the shared React surface where behavior is not already locked by fixture snapshots.
7. Update package exports and README snippets as needed so the Next site kit is publishable and self-describing.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/react run build`
   Expected outcome: `@docsfn/react` builds cleanly and emits valid types.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/next run build`
   Expected outcome: `@docsfn/next` builds cleanly against the updated core and React contracts.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/examples/next-docs-site run build`
   Expected outcome: the example Next site builds successfully and precomputes docs routes from the canonical fixture.
4. Manual check: start the example site and open `/docs`.
   Expected outcome: the root docs page resolves without `/index`, navigation matches `meta.json`, and search loads the generated artifact.

## Stop condition

- Report whether the Next example site can replace the current repo’s Fumadocs route structure without content rewrites.
- Report any remaining React component mismatches between docs, API, and versioned routes.
- Report the exact example-site command sequence that now passes locally.
