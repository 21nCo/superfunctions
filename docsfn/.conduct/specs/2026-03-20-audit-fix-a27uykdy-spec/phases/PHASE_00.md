# PHASE_00

- Phase goal: Establish the production contract, package metadata baseline, and canonical fixture inventory that every later phase depends on.

## In scope

- Canonical config loading and validation contracts.
- Structured diagnostics and fail-closed error codes.
- Package naming, exports, peer ranges, and release metadata corrections.
- Canonical migration fixtures for `datafn/docs` and `searchfn/docs`.

## Out of scope

- Routing semantics and navigation derivation.
- MDX or mdsvex compilation behavior.
- Search, OpenAPI, or framework-specific site rendering.

## Deliverables

- Modify `docsfn/core/package.json`.
- Modify `docsfn/react/package.json`.
- Modify `docsfn/svelte/package.json`.
- Modify `docsfn/next/package.json`.
- Modify `docsfn/sveltekit/package.json`.
- Modify `docsfn/cli/package.json`.
- Create `docsfn/core/src/config.ts`.
- Create `docsfn/core/src/diagnostics.ts`.
- Modify `docsfn/core/src/types.ts`.
- Modify `docsfn/core/src/index.ts`.
- Create `docsfn/core/src/config.test.ts`.
- Create `docsfn/test-fixtures/README.md`.
- Create `docsfn/test-fixtures/repo/datafn-docs/`.
- Create `docsfn/test-fixtures/repo/searchfn-docs/`.

## Requirements covered

- `CFG-001`
- `DET-001`
- `MIG-001`
- `PKG-001`

## Implementation tasks

1. Rename the published core package from `docsfn` to `@docsfn/core` and align all internal dependency references to the scoped package name.
2. Expand peer dependency ranges so React packages accept React `18` and `19`, and keep Next `15` and SvelteKit `2` support explicit.
3. Add a canonical `loadDocsConfig()` flow that searches explicit paths first, then `docsfn.config.ts|mjs|js`, and returns typed config plus deterministic defaults only when no config file exists.
4. Introduce a diagnostics module that defines `DOCS_CONFIG_INVALID`, `DOCS_PROVIDER_INVALID`, `DOCS_ROUTE_INVALID`, `DOCS_COMPILE_FAILED`, `DOCS_SEARCH_FAILED`, and related structured envelopes shared by CLI and site kits.
5. Add config validation tests that cover valid config, invalid shape, unsupported compat preset, invalid version config, and missing config fallback behavior.
6. Materialize canonical fixtures by snapshotting or linking the current `datafn/docs` and `searchfn/docs` trees into `docsfn/test-fixtures/repo/` with a short inventory document that explains update policy.
7. Document the package contract and fixture contract in the root fixture README so later phases can verify against a stable corpus instead of live repo drift.

## Verification steps

1. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run build`
   Expected outcome: the core package builds with the new config and diagnostics modules exported.
2. Run: `npm --prefix /Users/serro/Documents/dev/n/superfunctions/docsfn/core run test -- --run src/config.test.ts`
   Expected outcome: positive config loads pass and invalid configs fail with `DOCS_CONFIG_INVALID`.
3. Run: `npm pack --dry-run /Users/serro/Documents/dev/n/superfunctions/docsfn/core`
   Expected outcome: the tarball metadata shows package name `@docsfn/core` and includes types output.
4. Manual check: inspect `docsfn/test-fixtures/repo/datafn-docs` and `docsfn/test-fixtures/repo/searchfn-docs`.
   Expected outcome: both fixtures contain the current canonical docs content and the fixture README states how they are refreshed.

## Stop condition

- Report the final package names and peer ranges for all publishable packages.
- Report the config and diagnostics error codes that are now canonical.
- Report the fixture inventory paths that all later verification steps must use.
