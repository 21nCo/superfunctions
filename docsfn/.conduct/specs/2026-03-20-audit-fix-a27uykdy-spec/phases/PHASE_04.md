# PHASE_04

- Phase goal: Restore deterministic search artifact generation and runtime search behavior across docs, API, and blog content.

## In scope

- Search artifact build pipeline.
- Search document normalization and scope handling.
- Runtime helpers consumed by React and Svelte search UIs.
- Artifact size warnings and deterministic output guarantees.

## Out of scope

- UI polish beyond enough to validate query behavior.
- Search analytics aggregation.
- Full framework site-kit integration.

## Deliverables

- Modify `docsfn/core/src/search.ts`.
- Modify `docsfn/core/src/search.test.ts`.
- Create `docsfn/core/src/search-runtime.ts`.
- Create `docsfn/core/src/search-runtime.test.ts`.
- Modify `docsfn/react/src/DocsSearch.tsx`.
- Modify `docsfn/svelte/src/DocsSearch.svelte`.
- Modify `docsfn/cli/src/index.ts`.

## Requirements covered

- `SEARCH-001`
- `SEARCH-002`
- `DET-001`
- `OBS-001`

## Implementation tasks

1. Replace the stubbed `buildSearchIndex()` implementation with deterministic artifact generation keyed by manifest page IDs and configured search scopes.
2. Normalize search inputs so titles, summaries, headings, route metadata, and body tokens are indexed consistently across docs, API, and blog collections.
3. Enforce deterministic serialization order and emit a warning diagnostic when the artifact exceeds the configured maximum byte threshold.
4. Add a runtime helper layer that loads the artifact lazily and exposes stable query helpers to React and Svelte UIs.
5. Update the React and Svelte search components to consume the runtime helper instead of assuming ad hoc index state.
6. Add CLI build output that writes the search artifact alongside the manifest and fails the build with `DOCS_SEARCH_FAILED` on fatal indexing errors.
7. Add query golden tests and negative tests for empty scopes, duplicate IDs, oversized output, and malformed artifact input.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/search.test.ts src/search-runtime.test.ts`
   Expected outcome: search artifact and runtime query tests pass with deterministic snapshots.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/cli run build -- build --root /Users/serro/Documents/dev/n/superfunctions/docsfn/test-fixtures/repo/datafn-docs --out-dir /tmp/docsfn-search-check`
   Expected outcome: `manifest.json` and `search.json` are written and the search artifact is non-empty.
3. Manual check: inspect `/tmp/docsfn-search-check/search.json`.
   Expected outcome: results include docs routes and headings from the canonical fixture and preserve deterministic order between repeated runs.

## Stop condition

- Report the artifact path and byte size from a canonical build.
- Report the supported search scopes and the indexed fields for each record.
- Report any warning-severity diagnostics emitted during search generation.
