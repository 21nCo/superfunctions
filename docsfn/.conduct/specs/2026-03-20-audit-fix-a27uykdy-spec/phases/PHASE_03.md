# PHASE_03

- Phase goal: Build a trusted compilation pipeline for React and Svelte consumers that preserves required Fumadocs-authored content semantics without allowing unsafe raw HTML execution.

## In scope

- Markdown, MDX, and mdsvex compilation contracts.
- Fumadocs compatibility transforms for existing repo content patterns.
- Heading extraction, anchor generation, TOC derivation, and component mapping.
- Sanitization and raw HTML blocking rules.

## Out of scope

- Search indexing output.
- OpenAPI parsing.
- Framework route wiring.

## Deliverables

- Modify `docsfn/core/src/markdown.ts`.
- Modify `docsfn/core/src/markdown.test.ts`.
- Create `docsfn/core/src/compile/react.ts`.
- Create `docsfn/core/src/compile/svelte.ts`.
- Create `docsfn/core/src/compat/fumadocs.ts`.
- Create `docsfn/core/src/sanitize.ts`.
- Create `docsfn/core/src/compile.test.ts`.
- Modify `docsfn/react/src/DocsContent.tsx`.
- Modify `docsfn/svelte/src/DocsContent.svelte`.

## Requirements covered

- `MDX-001`
- `MDX-002`
- `PAGE-001`
- `SEC-001`
- `MIG-001`

## Implementation tasks

1. Split markdown responsibilities into source parsing, compatibility transforms, compilation, and sanitization so later framework packages consume a stable compiled-content contract.
2. Implement the `fumadocs-v15` compatibility preset that rewrites supported Fumadocs page patterns into canonical docsfn component usage without requiring broad source rewrites.
3. Add explicit support for the current repo’s `Tabs` or `Tab` pattern, Mermaid blocks, heading slugging, callouts, and imported MDX components that must survive migration.
4. Generate canonical heading and TOC records during compilation so page chrome can remain framework-agnostic.
5. Block raw `<script>` and other unsafe HTML from rendering by default and emit structured diagnostics when blocked content is detected.
6. Update React and Svelte content renderers to consume compiled artifacts instead of rendering raw markdown strings directly.
7. Add positive and negative tests that cover tabs, Mermaid, nested headings, code fences, raw scripts, malformed MDX, and unsupported component imports.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/markdown.test.ts src/compile.test.ts`
   Expected outcome: canonical MDX and mdsvex fixture outputs pass and unsafe HTML is rejected with diagnostics.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/react run build`
   Expected outcome: the React renderer builds against the compiled-content contract without raw HTML passthrough.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/svelte run build`
   Expected outcome: the Svelte renderer builds and emits matching compiled-content support and types.
4. Manual check: render the fixture containing tabs and Mermaid in both framework renderers.
   Expected outcome: tabs are interactive, Mermaid is transformed into the expected safe render surface, and no raw script executes.

## Stop condition

- Report the supported compatibility transforms that now let existing repo MDX migrate unchanged.
- Report the sanitization rule set and the blocked element categories.
- Report whether React and Svelte renderers now share the same canonical compiled-content inputs.
