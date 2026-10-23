# Phase goal

Remove outdated docs surfaces, finalize the new navigation, and make the full local verification suite pass.

## In scope / Out of scope

- **In scope**:
  - removing or retiring old root docs groupings
  - final nav cleanup
  - final verification suite
  - content polish for consistency and broken links
- **Out of scope**:
  - new package APIs
  - docs framework replacement

## Deliverables

- Updated `docs/content/docs/meta.json`
- Removal or retirement of:
  - `docs/content/docs/shared/*`
  - `docs/content/docs/shared-packages/*`
  - `docs/content/docs/migration/*`
  - `docs/content/docs/migrations/*`
  - `docs/content/docs/operations/*`
- Finalized docs script wiring and README comments if needed

## Requirements covered

- DOCS-002
- DOCS-008
- QA-001
- QA-002

## Implementation tasks

1. Remove old user-facing nav buckets and routes from the finished page tree.
2. Update internal links so they only target the new category-based docs routes.
3. Ensure all validation scripts use the catalog-driven structure.
4. Run the full local docs verification suite and fix any remaining failures.

## Verification steps

1. Run `npm -w docs run build`.
Expected: build succeeds.
2. Run `npm -w docs run check:catalog`.
Expected: all categories and package mappings pass.
3. Run `npm -w docs run check:content`.
Expected: no missing sections, thin pages, placeholder hits, or invalid examples.
4. Run `npm -w docs run check:snippets`.
Expected: no invalid imports.
5. Run `npm -w docs run check:links`.
Expected: no broken internal docs links.
6. Run `npm -w docs run dev` and manually inspect the sidebar.
Expected: the finished nav shows `Start Here`, category groups, and no migration/deprecation surfaces.

## Stop condition

Report the final route tree, the removed legacy buckets, and the passing verification commands before declaring the docs refresh complete.
