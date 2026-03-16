# PHASE 18

## Phase goal
Publish complete root shared-package docs content, migration guides, and docs quality checks.

## In scope / Out of scope

- **In scope:** full package coverage pages, architecture docs, migration docs, snippet/link/coverage checks.
- **Out of scope:** non-shared-function product docs beyond migration references.

## Deliverables

- Shared package docs pages for all `packages/*` and `packages/python-*`.
- Architecture pages (OAuth flow, webhooks, envelope/errors, queue/rate-limit, HTTP/DB integration).
- Migration guides for authfn/plugfn/recfn/cifn reuse transitions.
- Docs CI checks (coverage, snippet compile, links).

## Requirements covered

- OAUTH-014
- DOCS-002
- DOCS-003
- DOCS-004
- DOCS-005
- DOCS-006
- OPS-002
- OPS-003

## Implementation tasks

1. Author package pages with beginner + advanced external-consumer examples.
2. Add architecture and migration guides with mapping tables and rollback guidance.
3. Add docs coverage script comparing package list to docs pages.
4. Add snippet compile checks and link checker scripts.
5. Add release notes/changelog/deprecation docs links.

## Verification steps

1. Run:
```bash
npm -w docs run build
npm -w docs run check:coverage
npm -w docs run check:snippets
npm -w docs run check:links
```
Expected: all docs checks pass and coverage is complete.

2. Run:
```bash
npm run gate:audit-fix-o4u9k2m7
```
Expected: release gate passes all package/doc checks.

## Stop condition
Root docs are complete, validated, and release-gate clean for this spec.
