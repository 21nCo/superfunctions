# Phase goal

Replace the current auth/oauth placeholder docs with a full Authentication & OAuth category.

## In scope / Out of scope

- **In scope**:
  - Authentication & OAuth category overview
  - `auth`
  - `oauth-core`
  - `oauth-http`
  - `oauth-providers`
  - `oauth-storage`
  - `oauth-flow`
  - `oauth-testing`
- **Out of scope**:
  - HTTP adapters
  - storage providers outside OAuth storage

## Deliverables

- `docs/content/docs/authentication/meta.json`
- `docs/content/docs/authentication/index.mdx`
- `docs/content/docs/authentication/auth.mdx`
- `docs/content/docs/authentication/oauth-core.mdx`
- `docs/content/docs/authentication/oauth-http.mdx`
- `docs/content/docs/authentication/oauth-providers.mdx`
- `docs/content/docs/authentication/oauth-storage.mdx`
- `docs/content/docs/authentication/oauth-flow.mdx`
- `docs/content/docs/authentication/oauth-testing.mdx`

## Requirements covered

- DOCS-002
- DOCS-004
- DOCS-005
- DOCS-006
- DOCS-007

## Implementation tasks

1. Create the category overview page with package map and chooser guidance.
2. Explain the difference between generic auth abstraction and OAuth-specific layers.
3. Rewrite each package page with the required headings, real examples, and related-package links.
4. Add a low-level versus high-level chooser for the OAuth stack.
5. Ensure examples are valid for external library authors and app developers.

## Verification steps

1. Run `npm -w docs run check:content`.
Expected: all authentication pages pass required sections, prose depth, and placeholder checks.
2. Run `npm -w docs run check:snippets`.
Expected: auth/oauth examples only use valid package imports.
3. Run `npm -w docs run check:links`.
Expected: no broken links inside the authentication section.

## Stop condition

Report that the Authentication & OAuth category is complete and that the chooser guidance explains the full package layering clearly.
