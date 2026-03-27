# PHASE_03

- Phase goal: Restore Svelte and SvelteKit parity and make the Svelte public import surface honest.

## In scope

- Svelte `DocsContent`
- Svelte package exports
- SvelteKit proof-route integration

## Out of scope

- docs guide wording changes
- release-gate finalization

## Deliverables

- Modify `docsfn/svelte/src/DocsContent.svelte`
- Create `docsfn/svelte/src/DocsContent.test.ts`
- Modify `docsfn/svelte/package.json`
- Modify `docsfn/svelte/src/index.ts`
- Modify `docsfn/sveltekit` helpers only as needed for proof routes/import safety

## Requirements covered

- `SVELTE-001`
- `PKG-001`
- `TEST-001`

## Implementation tasks

1. Implement recursive tab/component rendering and Mermaid rendering contract in Svelte.
2. Export every documented component subpath or remove unsupported documentation references.
3. Make root and subpath imports browser-safe.
4. Add Svelte component tests for tabs, mermaid, custom components, blog, embedded, and no raw-source fallback.
5. Add import-resolution tests that prove public subpaths are valid.

## Verification steps

1. Run: `npm --prefix docsfn/svelte run build`
   Expected outcome: build emits artifacts matching `package.json`.
2. Run: `npm exec -- vitest run docsfn/svelte/src/DocsContent.test.ts`
   Expected outcome: Svelte parity tests pass.
3. Run the SvelteKit proof-route tests/build against both canonical fixtures.
   Expected outcome: proof routes render shipped components without source aliases.

## Stop condition

- Report the final supported public import paths for `@docsfn/svelte`.
