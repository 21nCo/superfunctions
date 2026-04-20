# Phase goal

Rewrite BrowseFn docs, examples, quickstarts, and testing guidance so they accurately describe the supported surface and remain machine-portable.

## In scope / Out of scope

- **In scope**:
  - root BrowseFn README
  - TypeScript README
  - Python README
  - quickstart and implementation notes
  - testing guide
  - TypeScript examples
- **Out of scope**:
  - dashboard or CLI docs
  - unrelated function docs outside `browsefn/`

## Deliverables

- `browsefn/README.md`
- `browsefn/typescript/README.md`
- `browsefn/python/README.md`
- `browsefn/.conduct/QUICKSTART.md`
- `browsefn/.conduct/IMPLEMENTATION.md`
- `browsefn/python/TESTING.md`
- `browsefn/typescript/examples/basic-web-scraping.ts`
- `browsefn/typescript/examples/geocoding.ts`
- `browsefn/typescript/examples/image-search.ts`
- `browsefn/typescript/examples/with-puppeteer.ts`

## Requirements covered

- DOC-001
- PKG-001
- API-001

## Implementation tasks

1. Replace stale package names, paths, and readiness claims with canonical values.
2. Remove machine-specific absolute paths from committed docs.
3. Update examples to use real imports, real provider IDs, and the canonical APIs.
4. Remove or clearly mark unspecified dashboard/CLI claims.
5. Add one repo-root verification snippet for TypeScript and Python.

## Verification steps

1. Run `rg -n "/Users/|ts-sdk|coming soon|fully implemented|dashboard|CLI" browsefn/README.md browsefn/typescript/README.md browsefn/python/README.md browsefn/.conduct/QUICKSTART.md browsefn/.conduct/IMPLEMENTATION.md browsefn/python/TESTING.md`.
Expected: no stale matches remain except deliberate lowercase `cli` inside code/package names unrelated to BrowseFn.
2. Run `npm --prefix browsefn/typescript run build`.
Expected: examples and docs references are aligned with the package build.

## Stop condition

Report the final install/import snippets for TypeScript and Python and confirm the docs portability scan is clean.
