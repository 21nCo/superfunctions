# PHASE_08

- Phase goal: Add complete blog and embedded-surface support on top of the shared manifest, rendering, and routing contracts.

## In scope

- Blog post normalization, tags, feeds, and archive surfaces.
- Embedded page contracts without full docs chrome.
- Shared page-surface behavior for docs, blog, and embedded routes.

## Out of scope

- New content authoring interfaces.
- Multi-locale blog behavior.
- Analytics aggregation beyond the shared event contract.

## Deliverables

- Create `docsfn/core/src/blog.ts`.
- Create `docsfn/core/src/blog.test.ts`.
- Modify `docsfn/core/src/rss.ts`.
- Modify `docsfn/core/src/manifest.ts`.
- Modify `docsfn/react/src/BlogList.tsx`.
- Create `docsfn/react/src/EmbeddedPage.tsx`.
- Modify `docsfn/svelte/src/index.ts`.
- Create `docsfn/svelte/src/EmbeddedPage.svelte`.
- Modify `docsfn/next/src/index.ts`.
- Modify `docsfn/sveltekit/src/index.ts`.

## Requirements covered

- `BLOG-001`
- `EMBED-001`
- `PAGE-001`
- `SEARCH-001`

## Implementation tasks

1. Normalize blog entries into canonical blog records with publish dates, authors, tags, summaries, draft handling, and deterministic archive ordering.
2. Extend RSS generation to operate from canonical blog records and to fail closed on invalid publish metadata.
3. Add embedded page surfaces that render canonical compiled content without docs chrome while preserving heading IDs, component mappings, and sanitization guarantees.
4. Integrate blog and embedded routes into the manifest so search, navigation, and framework adapters can consume them without custom side channels.
5. Add React and Svelte embedded page components and a minimal shared contract for host applications that want to embed docs content.
6. Add tests that cover tag pages, RSS output, draft exclusion, embedded rendering, and mixed docs-plus-blog search scope behavior.
7. Update framework adapters so example sites can expose a blog route and at least one embedded route from the canonical fixtures.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/blog.test.ts src/rss.test.ts src/manifest.test.ts`
   Expected outcome: blog normalization and RSS tests pass with deterministic output.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/examples/next-docs-site run build`
   Expected outcome: the example site builds with blog and embedded routes enabled.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/examples/sveltekit-docs-site run build`
   Expected outcome: the SvelteKit example site builds with the same blog and embedded routes.
4. Manual check: open one blog post route and one embedded page route in each example site.
   Expected outcome: blog pages include canonical metadata and embedded pages render content without docs chrome while remaining sanitized.

## Stop condition

- Report the canonical blog record fields and RSS output location.
- Report the embedded-surface API exposed to host applications.
- Report whether search now spans docs, API, and blog routes correctly.
