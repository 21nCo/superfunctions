# Phase goal

Implement the Middleware & Runtime category and replace generic runtime package placeholders with practical composition docs.

## In scope / Out of scope

- **In scope**:
  - Middleware & Runtime overview
  - `middleware`
  - `webhooks`
  - `queue`
  - `envelope`
  - `errors`
  - `metrics`
  - `config`
- **Out of scope**:
  - storage providers
  - Python integrations

## Deliverables

- `docs/content/docs/middleware-runtime/meta.json`
- `docs/content/docs/middleware-runtime/index.mdx`
- `docs/content/docs/middleware-runtime/middleware.mdx`
- `docs/content/docs/middleware-runtime/webhooks.mdx`
- `docs/content/docs/middleware-runtime/queue.mdx`
- `docs/content/docs/middleware-runtime/envelope.mdx`
- `docs/content/docs/middleware-runtime/errors.mdx`
- `docs/content/docs/middleware-runtime/metrics.mdx`
- `docs/content/docs/middleware-runtime/config.mdx`

## Requirements covered

- DOCS-002
- DOCS-004
- DOCS-005
- DOCS-006
- DOCS-007

## Implementation tasks

1. Create an overview page that explains how these runtime primitives compose in real services.
2. Rewrite each runtime package page with real-world examples and related-package links.
3. Include guidance for common compositions such as `http + middleware + errors + envelope`.
4. Validate that examples remain external-reader friendly.

## Verification steps

1. Run `npm -w docs run check:content`.
Expected: middleware/runtime pages meet the package-page contract.
2. Run `npm -w docs run check:links`.
Expected: all cross-links between runtime pages and adjacent categories resolve.

## Stop condition

Report that runtime packages now read like practical external docs rather than internal scaffolding.
