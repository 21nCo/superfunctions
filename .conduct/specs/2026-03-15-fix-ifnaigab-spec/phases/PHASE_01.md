# Phase goal

Rebrand the root site as `Superfunctions` and rebuild the Start Here section so the docs site has a clear public-facing entry point.

## In scope / Out of scope

- **In scope**:
  - site title and layout label
  - root page
  - getting-started page
  - choosing-packages page
  - ecosystem page
  - top-level `meta.json` ordering
- **Out of scope**:
  - full package-page rewrites
  - category-specific deep dives

## Deliverables

- `docs/app/layout.config.tsx`
- `docs/content/docs/meta.json`
- `docs/content/docs/index.mdx`
- `docs/content/docs/getting-started.mdx`
- `docs/content/docs/choosing-packages.mdx`
- `docs/content/docs/ecosystem.mdx`

## Requirements covered

- DOCS-001
- DOCS-003

## Implementation tasks

1. Rename the site identity from `Superfunctions Shared` to `Superfunctions`.
2. Rewrite the root docs page with mission, audience, ecosystem framing, and category entry links.
3. Replace the current getting-started page with an external-first onboarding flow.
4. Add a package-chooser page that helps readers choose categories by need.
5. Add a comprehensive ecosystem page driven by the ecosystem catalog.
6. Update top-level metadata to surface the new Start Here section first.

## Verification steps

1. Run `npm -w docs run build`.
Expected: build succeeds with the new pages.
2. Run `npm -w docs run check:catalog`.
Expected: top-level sections and page presence pass.
3. Run `npm -w docs run dev`, open `/docs`, and manually verify the sidebar begins with `Start Here`.

## Stop condition

Report the new home page title, the Start Here routes, and the ecosystem page coverage before moving into category content.
