# docsfn examples

Reference example sites used by the release gate.

## Included apps

- `next-docs-site` - Next 15 + React 18/19
- `sveltekit-docs-site` - SvelteKit 2 + Svelte 4/5

Both examples load canonical fixtures through `DOCSFN_FIXTURE_ROOT`.

## Build matrix (from repo root)

```bash
# Next example against both canonical fixtures
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/searchfn-docs npm --prefix docsfn/examples/next-docs-site run build
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/datafn-docs npm --prefix docsfn/examples/next-docs-site run build

# SvelteKit example against both canonical fixtures
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/searchfn-docs npm --prefix docsfn/examples/sveltekit-docs-site run build
DOCSFN_FIXTURE_ROOT=../../test-fixtures/repo/datafn-docs npm --prefix docsfn/examples/sveltekit-docs-site run build
```

## Local migration smoke check

Use the release scripts to run package builds, tests, fixture builds, example builds, and parity checks in one flow:

```bash
node /Users/serro/Documents/dev/n/superfunctions/docsfn/scripts/release-gate.mjs
node /Users/serro/Documents/dev/n/superfunctions/docsfn/scripts/migration-check.mjs
```
