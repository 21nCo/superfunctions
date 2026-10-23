# Phase goal

Implement the HTTP & Framework Adapters category with real adapter-selection guidance and complete package pages.

## In scope / Out of scope

- **In scope**:
  - HTTP category overview
  - `http`
  - `http-express`
  - `http-fastify`
  - `http-hono`
  - `http-next`
  - `http-sveltekit`
- **Out of scope**:
  - auth/oauth rewrites
  - data/storage pages

## Deliverables

- `docs/content/docs/http/meta.json`
- `docs/content/docs/http/index.mdx`
- `docs/content/docs/http/http.mdx`
- `docs/content/docs/http/http-express.mdx`
- `docs/content/docs/http/http-fastify.mdx`
- `docs/content/docs/http/http-hono.mdx`
- `docs/content/docs/http/http-next.mdx`
- `docs/content/docs/http/http-sveltekit.mdx`

## Requirements covered

- DOCS-002
- DOCS-004
- DOCS-005
- DOCS-006
- DOCS-007

## Implementation tasks

1. Create the HTTP overview page with a core-package-versus-adapter explanation.
2. Add an adapter chooser matrix explaining when to use each framework integration.
3. Rewrite the core `http` page for external library authors and app developers.
4. Rewrite each adapter page with real usage examples and related-package links.

## Verification steps

1. Run `npm -w docs run check:content`.
Expected: all HTTP pages meet heading, depth, and chooser requirements.
2. Run `npm -w docs run check:snippets`.
Expected: all HTTP examples use valid imports and no monorepo-relative paths.
3. Run `npm -w docs run build`.
Expected: new HTTP routes render correctly.

## Stop condition

Report the HTTP category route tree and confirm that adapter selection guidance is present and testable.
