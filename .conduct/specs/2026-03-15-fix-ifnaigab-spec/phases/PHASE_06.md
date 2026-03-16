# Phase goal

Implement Python Integrations and Tooling categories so the full shared-package surface is covered with the same quality bar.

## In scope / Out of scope

- **In scope**:
  - Python overview + all Python package pages
  - Tooling overview + `cli` and `docs-theme`
- **Out of scope**:
  - root ecosystem page
  - removal of old nav buckets

## Deliverables

- `docs/content/docs/python/meta.json`
- `docs/content/docs/python/index.mdx`
- `docs/content/docs/python/python-core.mdx`
- `docs/content/docs/python/python-fastapi.mdx`
- `docs/content/docs/python/python-flask.mdx`
- `docs/content/docs/python/python-sqlalchemy.mdx`
- `docs/content/docs/tooling/meta.json`
- `docs/content/docs/tooling/index.mdx`
- `docs/content/docs/tooling/cli.mdx`
- `docs/content/docs/tooling/docs-theme.mdx`

## Requirements covered

- DOCS-002
- DOCS-004
- DOCS-005
- DOCS-006
- DOCS-007

## Implementation tasks

1. Create the Python overview page explaining how Python integrations map to shared concepts.
2. Rewrite each Python page with Python-native installation and usage examples.
3. Create the Tooling overview page and rewrite `cli` and `docs-theme` pages for external consumers.
4. Ensure cross-links between TypeScript and Python content are intentional and beginner-friendly.

## Verification steps

1. Run `npm -w docs run check:content`.
Expected: Python and tooling pages pass the shared page contract and language-specific checks.
2. Run `npm -w docs run check:links`.
Expected: Python/tooling pages link cleanly to related categories and packages.

## Stop condition

Report that all remaining shared packages are now covered by the new category model and content standard.
