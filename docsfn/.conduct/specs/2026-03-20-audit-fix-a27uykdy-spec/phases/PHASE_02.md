# PHASE_02

- Phase goal: Fix route derivation, versioning, `meta.json` semantics, and navigation generation so the canonical repo docs fixtures resolve to the same information architecture expected today.

## In scope

- Root index behavior and base path behavior.
- Version prefix semantics and canonical version lookup.
- `meta.json` ordering, grouping, labels, hidden entries, and root metadata.
- Breadcrumbs, pagination, sidebar sections, and previous or next page derivation.

## Out of scope

- Rendering of page bodies.
- Search indexing internals.
- Framework-specific route adapters.

## Deliverables

- Create `docsfn/core/src/normalize.ts`.
- Create `docsfn/core/src/routing.ts`.
- Create `docsfn/core/src/navigation.ts`.
- Modify `docsfn/core/src/manifest.ts`.
- Modify `docsfn/core/src/sidebar.ts`.
- Modify `docsfn/core/src/helpers.ts`.
- Modify `docsfn/core/src/manifest.test.ts`.
- Modify `docsfn/core/src/sidebar.test.ts`.
- Create `docsfn/core/src/routing.test.ts`.
- Create `docsfn/core/src/navigation.test.ts`.

## Requirements covered

- `MIG-001`
- `ROUTE-001`
- `ROUTE-002`
- `NAV-001`
- `NAV-002`
- `DET-001`

## Implementation tasks

1. Normalize source entries into canonical page records that distinguish root index pages from child pages and preserve original source-relative intent.
2. Fix root index semantics so `content/docs/index.mdx` maps to the base docs route instead of `/index`.
3. Implement versioned route derivation that prevents duplicated prefixes such as `/v2/v2/intro` and guarantees a single canonical route per versioned page.
4. Parse `meta.json` ordering and group configuration into deterministic navigation inputs, including support for labels, icons, hidden nodes, and explicit child ordering.
5. Derive breadcrumbs and pagination from the same normalized manifest graph so all chrome consumers receive a single source of truth.
6. Add manifest golden snapshots for the `datafn/docs` and `searchfn/docs` fixtures and pin expected route and navigation outputs in test fixtures.
7. Add negative tests for duplicate routes, missing default version, orphaned `meta.json` entries, and references to nonexistent pages.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/manifest.test.ts src/sidebar.test.ts src/routing.test.ts src/navigation.test.ts`
   Expected outcome: all canonical route and navigation snapshots pass.
2. Run: `node /Users/serro/Documents/dev/n/superfunctions/docsfn/cli/dist/index.js validate --root /Users/serro/Documents/dev/n/superfunctions/docsfn/test-fixtures/repo/searchfn-docs`
   Expected outcome: validation succeeds with no error-severity diagnostics and the base docs index resolves to `/docs`.
3. Manual check: inspect the manifest for the versioned fixture.
   Expected outcome: no page path contains duplicated version segments and `meta.json` ordering is preserved exactly.

## Stop condition

- Report the canonical routes produced for the root docs index and at least one versioned page.
- Report whether the `datafn/docs` and `searchfn/docs` navigation shape now matches fixture expectations.
- Report any unresolved route ambiguity before compilation work begins.
