# Phase goal

Define the canonical docs taxonomy, catalogs, and stronger local quality checks before rewriting content.

## In scope / Out of scope

- **In scope**:
  - category taxonomy
  - package and ecosystem catalogs
  - content-quality validation script scaffolding
  - docs package script wiring for new checks
- **Out of scope**:
  - full rewrite of all package pages
  - final sidebar polish

## Deliverables

- `docs/lib/package-catalog.ts`
- `docs/lib/ecosystem-catalog.ts`
- `docs/scripts/check-docs-catalog.mjs`
- `docs/scripts/check-docs-content.mjs`
- `docs/package.json`

## Requirements covered

- DOCS-002
- DOCS-003
- DOCS-009
- QA-001
- QA-002

## Implementation tasks

1. Create a canonical package catalog covering every shared package page and its target category/order.
2. Create a canonical ecosystem catalog covering every top-level function listed in `AGENTS.md`.
3. Add a catalog-validation script that checks for duplicates, missing entries, and wrong category assignment.
4. Add a content-quality script that supports required headings, minimum prose thresholds, banned placeholder phrases, and example validation.
5. Wire `check:catalog` and `check:content` into `docs/package.json`.

## Verification steps

1. Run `npm -w docs run check:catalog`.
Expected: script exits `0` and reports no duplicate or missing catalog entries.
2. Run `npm -w docs run check:content`.
Expected: script runs and reports current failures accurately if content is not yet rewritten; phase success requires the script itself to be correct and documented even if later phases clear all findings.

## Stop condition

Report the new catalog files, the new script names, and the initial validation output shape before starting content rewrites.
