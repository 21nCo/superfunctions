# TEST VECTORS

## `TV-CFG-001`

- Description: Valid and invalid search-scope override config must validate deterministically without regressing route/navigation baseline.
- Input:
  ```json
  {
    "schemaVersion": 1,
    "site": { "title": "Docs", "basePath": "/docs" },
    "compat": { "preset": "fumadocs-v15" },
    "content": { "root": ".", "docsDir": "content/docs", "pagesDir": "pages", "blogDir": "blog", "apiDir": "api", "assetsDir": "public", "metaFileName": "meta.json" },
    "search": {
      "enabled": true,
      "scopes": ["docs", "api", "blog"],
      "routeScopeOverrides": [
        { "pattern": "/docs/api/**", "scope": "api" }
      ]
    }
  }
  ```
- Expected output:
  - config loads successfully
  - canonical fixture routes remain unchanged
  - deterministic artifacts remain byte-identical on repeated build
- Negative variant(s):
  - `routeScopeOverrides: [{ "pattern": "/docs/api/**", "scope": "invalid" }]`
  - Expected error: `DOCS_SEARCH_SCOPE_INVALID`

## `TV-ROUTE-001`

- Description: Existing route semantics must remain stable while API-markdown and OpenAPI routes do not collide.
- Input:
  - canonical fixture roots
  - docs page `/docs`
  - nested docs page `/docs/reference/client`
  - API-markdown page `/docs/api/core`
  - OpenAPI route `/docs/api/search-qa-stub.openapi`
- Expected output:
  - all routes resolve
  - no route path changes caused by scope overrides
  - no collisions between API-markdown and OpenAPI routes
- Negative variant(s):
  - a hand-written API page and generated OpenAPI route claiming the same path
  - Expected error: `DOCS_ROUTE_CONFLICT`

## `TV-CONTENT-001`

- Description: Compatibility content compiles to renderable nested block structure and unresolved constructs fail closed.
- Input:
  - `docsfn/test-fixtures/repo/datafn-docs/content/docs/documentation/server/routes.mdx`
  - compat preset `fumadocs-v15`
- Expected output:
  - compiled artifact `renderModelVersion === 2`
  - contains a `tabs` block with per-tab `nodes`
  - contains no raw `<Tabs>` or `<Tab>` source fallback blocks
  - any Mermaid fence compiles to `type: "mermaid"` with stable `id`
- Negative variant(s):
  - input contains unsupported compatibility construct `<Accordion />`
  - Expected error: `DOCS_COMPAT_UNSUPPORTED`
  - input contains unresolved native custom component `<DemoCard />` with no registry support
  - Expected error: `DOCS_COMPONENT_UNRESOLVED`

## `TV-REACT-001`

- Description: React rendering path must render functional tabs/mermaid/custom components for canonical fixtures.
- Input:
  - render compiled `routes.mdx` artifact through `@docsfn/react` `DocsContent`
- Expected output:
  - DOM includes `role="tablist"` and `role="tabpanel"`
  - active panel contains rendered child content, not raw source text
  - Mermaid block renders through the mermaid renderer container
  - DOM does not include literal `<Tabs` source or raw block body wrapper for supported constructs
- Negative variant(s):
  - render a compiled unresolved component block without mapping
  - Expected error: `DOCS_COMPONENT_UNRESOLVED`

## `TV-SVELTE-001`

- Description: Svelte rendering path and public import surface must be usable without source aliases.
- Input:
  - import `DocsContent` from `@docsfn/svelte/DocsContent.svelte`
  - render compiled `routes.mdx` artifact through Svelte `DocsContent`
- Expected output:
  - package import resolves through the exports map
  - tabs, Mermaid, and mapped custom components render functionally
  - DOM does not contain raw source fallback for supported constructs
- Negative variant(s):
  - guide/example imports a non-exported path or `node_modules/@docsfn/svelte/src/*`
  - Expected error: `DOCS_PUBLIC_API_INVALID`

## `TV-API-001`

- Description: Hand-written API pages and OpenAPI-generated routes must coexist and both index as `api`.
- Input:
  - dogfood config with `routeScopeOverrides: [{ "pattern": "/docs/api/**", "scope": "api" }]`
  - hand-written page `/docs/api/core`
  - OpenAPI route `/docs/api/search-qa-stub.openapi`
- Expected output:
  - search artifact contains both documents with `scope: "api"`
  - sidebar and route resolution remain stable
- Negative variant(s):
  - conflicting route or ambiguous API model mapping
  - Expected error: `DOCS_ROUTE_CONFLICT` or `DOCS_SEARCH_SCOPE_INVALID`

## `TV-SEARCH-001`

- Description: Search artifact and UI must reflect truthful docs/api/blog scope semantics.
- Input:
  - build search artifact for dogfood site with docs, api, blog enabled
  - query `core` with scope `api`
- Expected output:
  - results include hand-written API page `/docs/api/core`
  - results exclude unrelated docs-only pages when `scope=api`
  - equal-score ordering is deterministic
  - search endpoint responds with cacheable JSON
- Negative variant(s):
  - invalid override config or ambiguous match
  - Expected error: `DOCS_SEARCH_SCOPE_INVALID`

## `TV-BLOG-001`

- Description: Blog listing, post rendering, and RSS remain valid in proof paths.
- Input:
  - dogfood `/blog`
  - dogfood `/blog/introducing-docsfn`
  - dogfood `/blog/rss.xml`
- Expected output:
  - listing excludes drafts
  - blog post renders through shipped content components
  - RSS is deterministic and includes the published post
- Negative variant(s):
  - request draft or missing slug
  - Expected output: 404

## `TV-EMBED-001`

- Description: Embedded routes must use compiled content and remain part of the proof surface.
- Input:
  - example embedded route for canonical fixture page
- Expected output:
  - embedded page renders compiled content, not raw source dump
  - embedded proof route participates in release-gate checks
- Negative variant(s):
  - embedded loader bypasses compiled cache and falls back to raw source render
  - Expected error: `DOCS_RENDER_FALLBACK_FORBIDDEN`

## `TV-SEC-001`

- Description: Safety boundaries remain fail-closed after renderer changes.
- Input:
  - markdown with `<script>alert(1)</script>`
  - private route in `mixed` or `private` auth mode
- Expected output:
  - unsafe HTML is blocked
  - private route requires auth
  - diagnostics/search/release outputs contain no secret-bearing raw body
- Negative variant(s):
  - unresolved component attempts to render raw body fallback
  - Expected error: `DOCS_COMPONENT_UNRESOLVED` or `DOCS_RENDER_FALLBACK_FORBIDDEN`

## `TV-PKG-001`

- Description: Package exports must match documentation and supported imports.
- Input:
  - build package matrix
  - import every documented Svelte component subpath
- Expected output:
  - all documented imports resolve against built artifacts
  - peer ranges match documented framework versions
- Negative variant(s):
  - docs reference an import path absent from `exports`
  - Expected error: `DOCS_PUBLIC_API_INVALID`

## `TV-SITE-001`

- Description: `docsfn/docs` must dogfood shipped packages and stable API/search semantics.
- Input:
  - load docs site source once and request two page loads for the same route
  - search `/docs/api/core` through api scope
- Expected output:
  - compiled artifact reused rather than rebuilt on the second request
  - API page appears in `api` scope search results
  - docs route renders shipped components
- Negative variant(s):
  - second request recompiles unchanged content or api scope misses package API pages
  - Expected error: `DOCS_RELEASE_GATE_FAILED`

## `TV-CACHE-001`

- Description: Compiled content cache keys and invalidation must be deterministic.
- Input:
  - build compiled content map twice for the same manifest/framework/preset
- Expected output:
  - identical key set
  - identical compiled artifact hashes for unchanged entries
- Negative variant(s):
  - cache key omits compat preset or framework and mixes artifacts
  - Expected error: `DOCS_RELEASE_GATE_FAILED`

## `TV-DOCS-001`

- Description: Public docs must only use supported imports and machine-independent commands.
- Input:
  - run docs contract check over `docsfn/README.md`, adapter READMEs, and docs site guides
- Expected output:
  - no `node_modules/.../src` paths
  - no unsupported subpath imports
  - no machine-specific absolute paths
  - one consistent `/docs/api` route/content model
- Negative variant(s):
  - docs contain `/Users/.../docsfn/scripts/release-gate.mjs` or `@docsfn/svelte/src/*`
  - Expected error: `DOCS_PUBLIC_API_INVALID`

## `TV-EXAMPLE-001`

- Description: Example apps must prove real framework rendering on canonical fixtures.
- Input:
  - Next and SvelteKit example builds against both canonical fixtures
  - proof routes for docs/api/blog/embedded surfaces
- Expected output:
  - proof routes render shipped components, not raw `<pre>` source bodies
  - both frameworks expose the same proof-route inventory
- Negative variant(s):
  - proof route renders raw page body or omits a required surface
  - Expected error: `DOCS_RELEASE_GATE_FAILED`

## `TV-TEST-001`

- Description: Required test coverage must exist and execute.
- Input:
  - run component and example parity test suites
- Expected output:
  - executed tests cover tabs, mermaid, custom components, API, blog, embedded, search, and keyboard interaction
- Negative variant(s):
  - a required parity suite is missing or skipped
  - Expected error: `DOCS_RELEASE_GATE_FAILED`

## `TV-GATE-001`

- Description: Release gate must preflight environment, run the full matrix, and emit deterministic summary output.
- Input:
  - run `node docsfn/scripts/release-gate.mjs` after documented bootstrap
- Expected output:
  - summary artifact conforms to `DocsReleaseGateSummary`
  - all checks and fixture proof routes are listed deterministically
- Negative variant(s):
  - required binary missing before package builds start
  - Expected error: `DOCS_RELEASE_ENV_INVALID`
  - renderer parity failure in a proof route
  - Expected error: `DOCS_RELEASE_GATE_FAILED`

## `TV-BUILD-001`

- Description: Clean-checkout bootstrap and documented commands must be sufficient.
- Input:
  - clean repo checkout
  - documented install/bootstrap command
  - documented validate/build/example/release-gate commands
- Expected output:
  - commands succeed without editing paths
  - all required binaries are present after bootstrap
- Negative variant(s):
  - missing toolchain after following documented bootstrap
  - Expected error: `DOCS_RELEASE_ENV_INVALID`
