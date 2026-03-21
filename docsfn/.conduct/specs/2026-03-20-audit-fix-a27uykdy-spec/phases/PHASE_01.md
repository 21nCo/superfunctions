# PHASE_01

- Phase goal: Implement the remote-ready provider contract and make the filesystem provider produce deterministic canonical source entries across all supported collections.

## In scope

- Framework-agnostic provider interfaces and source-entry envelopes.
- Filesystem provider discovery, frontmatter loading, asset scanning, and watch metadata.
- Collection coverage for docs, pages, blog, api, and assets.

## Out of scope

- Route derivation and navigation ordering.
- Markdown compilation and UI rendering.
- Search indexing and OpenAPI normalization.

## Deliverables

- Create `docsfn/core/src/provider.ts`.
- Modify `docsfn/core/src/types.ts`.
- Modify `docsfn/core/src/test-utils.ts`.
- Modify `docsfn/core/src/index.ts`.
- Modify `docsfn/provider-fs/src/index.ts`.
- Modify `docsfn/provider-fs/src/index.test.ts`.
- Create `docsfn/provider-fs/src/watch.ts`.
- Create `docsfn/provider-fs/src/watch.test.ts`.
- Create `docsfn/provider-fs/src/provider-fixtures.test.ts`.

## Requirements covered

- `CMS-001`
- `FS-001`
- `DET-001`
- `TEST-001`

## Implementation tasks

1. Define `DocsContentProvider` and provider result semantics in `docsfn/core/src/provider.ts`, including deterministic ordering, byte counts, hashes, and source metadata requirements.
2. Make the provider contract explicitly support remote-ready fields such as `etag`, `updatedAt`, and optional `absolutePath`, while keeping filesystem providers fully functional without remote dependencies.
3. Refactor `@docsfn/provider-fs` to emit canonical entries for all configured collections and to treat `meta.json` as a control entry instead of a page entry.
4. Ensure provider enumeration is stable across platforms by normalizing path separators, sort order, and Unicode slug input before later routing phases consume the entries.
5. Add watch support metadata that records which files and directories drive rebuild invalidation without yet implementing a full dev server.
6. Add unit tests over the canonical repo fixtures plus synthetic multi-collection fixtures to prove correct detection of docs, blog, api, page, and asset entries.
7. Add negative tests that cover duplicate IDs, missing frontmatter defaults, unsupported file extensions, and unreadable provider roots.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/provider-fs run build`
   Expected outcome: the provider package builds with the new provider and watch modules.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/provider-fs run test`
   Expected outcome: provider discovery tests pass across canonical fixtures and synthetic fixtures.
3. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/provider.test.ts`
   Expected outcome: provider contract invariants pass and deterministic ordering is asserted.
4. Manual check: inspect the provider output for one `datafn/docs` fixture run.
   Expected outcome: `meta.json` is represented as control metadata only and docs entries retain stable relative paths and hashes.

## Stop condition

- Report the canonical `DocsSourceEntry` fields that are now guaranteed by all providers.
- Report the collections covered by `@docsfn/provider-fs`.
- Report any remaining provider limitations that would block routing or compilation work.
