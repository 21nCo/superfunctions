# Full Audit: docsfn Production Readiness

## Metadata

- Timestamp: `2026-03-25T11:22:18Z`
- Agent name: `audit`
- Model: `GPT-5 Codex`
- Launcher: `Codex Desktop`
- Workspace/project path: `docsfn`
- Comparison target paths: `docsfn/docs`, `docsfn/test-fixtures/repo/datafn-docs`, `docsfn/test-fixtures/repo/searchfn-docs`
- OS + shell: `Darwin arm64`, `/bin/zsh`
- Repo metadata: git repo rooted at `.`; branch `HEAD` (detached); commit `ca86e25e6faf11da93e390c18dad8ae5f22b6f69`; dirty worktree `yes (8 entries)`
- Intent/notes paths audited:
  - User request in thread: production-readiness audit for replacing Fumadocs with docsfn across repo docs
  - `docsfn/README.md`
  - `docsfn/next/README.md`
  - `docsfn/sveltekit/README.md`
  - `docsfn/examples/README.md`
  - `docsfn/test-fixtures/README.md`
- Spec bundle paths audited:
  - `docsfn/.conduct/specs/2026-03-20-audit-fix-a27uykdy-spec`
  - `docsfn/.conduct/specs/2026-03-22-new-v7k2m9x4-spec`
- Codebase scope audited:
  - Core/runtime: `docsfn/core`, `docsfn/provider-fs`, `docsfn/cli`
  - Framework/UI: `docsfn/react`, `docsfn/svelte`, `docsfn/next`, `docsfn/sveltekit`
  - Dogfood/example apps: `docsfn/docs`, `docsfn/examples/*`
  - Migration fixtures: `docsfn/test-fixtures/repo/datafn-docs`, `docsfn/test-fixtures/repo/searchfn-docs`
  - Historical context only: prior `.conduct` reports and phase outputs
- Verification caveat:
  - `node docsfn/scripts/release-gate.mjs` failed immediately in this environment because package build tooling is not bootstrapped (`tsup: command not found` while building `@docsfn/core`). Build/validate/vite results that require installed toolchain are marked `UNVERIFIED` rather than assumed.

## Audit Scope

This audit measured `docsfn` against the user’s actual replacement bar, not just against package existence:

1. `docsfn/docs` must be a real dogfood site.
2. Both React/Next and Svelte/SvelteKit must be usable migration paths.
3. Canonical repo docs like `datafn/docs` and `searchfn/docs` must be migratable without broad content rewrites.
4. The release process must catch parity regressions before other packages in this monorepo adopt docsfn.

The standard here was “ready to replace Fumadocs for sibling docs apps in this repo,” not “a promising prototype.”

## Inputs Audited (Intent + Spec Bundles)

### Intent / notes

- User request in thread:
  - “Perform a thorough production readiness audit for docsfn”
  - “both react and svelte should be usable”
  - “we are currently using docsfn for docsfn/docs”
  - “we should be in a position to replace fumadocs with docsfn for other docs in this repo like for datafn, searchfn etc”
- Package/readme intent:
  - `docsfn/README.md`
  - `docsfn/next/README.md`
  - `docsfn/sveltekit/README.md`
  - `docsfn/examples/README.md`
  - `docsfn/test-fixtures/README.md`

### Spec bundles

- `docsfn/.conduct/specs/2026-03-20-audit-fix-a27uykdy-spec`
  - `INTENT_AUDIT.md`
  - `PLAN.md`
  - `REQUIREMENTS.md`
  - `SPEC.md`
  - `TEST_VECTORS.md`
  - `phases/PHASE_00.md` through `phases/PHASE_10.md`
- `docsfn/.conduct/specs/2026-03-22-new-v7k2m9x4-spec`
  - `INTENT_AUDIT.md`
  - `PLAN.md`
  - `REQUIREMENTS.md`
  - `SPEC.md`
  - `TEST_VECTORS.md`
  - `phases/PHASE_00.md` through `phases/PHASE_11.md`

### Historical context only

- Existing docsfn audit/spec reports in `.conduct`
- `docsfn/AUDIT.md`

Historical materials informed trend analysis only; they were not treated as authoritative requirements.

## High-Level Findings

**Overall verdict: FAIL for the stated replacement bar.**

`docsfn` is materially stronger than the 2026-03-20 baseline: config validation, filesystem provider coverage, deterministic manifest/search/OpenAPI pipelines, route/version logic, blog/RSS, security/auth boundaries, and the `docsfn/docs` SvelteKit scaffold are all in much better shape. But it is still **not ready for repo-wide Fumadocs replacement** because the remaining failures hit the exact user bar: usable React/Svelte rendering parity and trustworthy release proof.

1. **The core compile pipeline recognizes Tabs/Mermaid/custom-component syntax, but the shipped React and Svelte renderers still degrade real fixture content into raw text/source.**
   - React `DocsContent` renders mermaid blocks as raw `<pre><code>`, tab panels as `<pre>{activeTab.content}</pre>`, and unknown custom components as raw bodies in `docsfn/react/src/DocsContent.tsx:61-117`.
   - Svelte `DocsContent` does the same in `docsfn/svelte/src/DocsContent.svelte:60-93`.
   - Canonical fixtures actively use these constructs: `docsfn/test-fixtures/repo/datafn-docs/content/docs/documentation/server/routes.mdx:8-85` and `docsfn/test-fixtures/repo/searchfn-docs/content/docs/architecture.mdx:48-79`.
   - Result: migration parity is still incomplete for the exact docs trees the user wants to replace.

2. **The reference example sites do not actually prove framework rendering readiness.**
   - The Next example renders page bodies as raw `<pre>` in `docsfn/examples/next-docs-site/app/docs/[[...slug]]/page.tsx:195-214`.
   - The SvelteKit example does the same in `docsfn/examples/sveltekit-docs-site/src/routes/docs/[...slug]/+page.svelte:64-85` and `docsfn/examples/sveltekit-docs-site/src/routes/embedded/[...slug]/+page.svelte:7-24`.
   - That means example builds can pass without exercising `@docsfn/react` or `@docsfn/svelte` on real migrated content.

3. **The release gate and migration parity script are still blind to renderer regressions.**
   - `docsfn/scripts/migration-check.mjs:99-118` only counts presence of `meta.json`, Tabs syntax, and mermaid fences in source files.
   - `docsfn/scripts/migration-check.mjs:190-222` checks routes, sidebar labels, diagnostics, and syntax presence, but never rendered HTML/component behavior.
   - `docsfn/scripts/release-gate.mjs:141-237` builds packages/examples and runs migration parity, but does not add DOM or screenshot assertions for Tabs/Mermaid/custom components.

4. **The official Svelte integration path is not a clean public-package story yet.**
   - The guide tells users to alias internal source `.svelte` files from `node_modules/@docsfn/svelte/src` in `docsfn/docs/content/docs/guides/sveltekit.md:76-102`.
   - The same guide imports `DocsContent` from `@docsfn/svelte/DocsContent.svelte` in `docsfn/docs/content/docs/guides/sveltekit.md:336-345`.
   - But `docsfn/svelte/package.json:10-19` only exports `"."`, `"./theme.css"`, and `"./theme-base.css"`.
   - The customizing guide repeats the same unexported Svelte subpath pattern in `docsfn/docs/content/docs/guides/customizing-components.md:20-30` and `:60-68`.

5. **The dogfood docs site’s `api` search scope depends on explicit route overrides for markdown API pages.**
   - The site config enables scopes `["docs", "api", "blog"]` in `docsfn/docs/docsfn.config.ts:40-44`.
   - By default, search indexes `manifest.pages` as `scope: "docs"` and only `manifest.apis` as `scope: "api"` in `docsfn/core/src/search.ts:147-190`.
   - The docs site stores one real OpenAPI spec under `content/api`, but 33 package API reference pages under `content/docs/api`:
     - `content/api files: 1`
     - `content/docs/api files: 33`
   - Those markdown pages can be classified into the `api` scope via `search.routeScopeOverrides` such as `/docs/api` and `/docs/api/**`; without that explicit config, most API reference content is searchable only as docs.

6. **The docs site and the specs are closer, but there are still important documentation/spec mismatches.**
   - Bundle 2 `SPEC.md` still defines API reference route shape as `/api/[...slug]`, while requirements/tests/implementation use `/docs/api` (`SPEC.md:82`, `TEST_VECTORS.md:88,118,287`).
   - The same `SPEC.md` says “OpenAPI-generated API reference” is deferred and that API reference is hand-written markdown (`SPEC.md:277`), but the docs site ships `content/api/search-qa-stub.openapi.yaml` and route code supports real `kind === "api"` entries.

## Intent Inventory

1. `docsfn` must be production-ready enough to replace Fumadocs-based docs sites elsewhere in this repo.
2. That replacement target explicitly includes docs trees like `datafn/docs` and `searchfn/docs`.
3. `docsfn/docs` must be a real dogfood deployment of docsfn rather than a separate stack.
4. Both React/Next and Svelte/SvelteKit must be viable paths, not nominal adapters.
5. Migration should mostly require site wiring/config, not broad content rewrites.
6. Root docs routes must resolve canonically at `/docs`.
7. Nested docs routes must resolve deterministically.
8. Versioned docs must keep build-time and runtime lookup in sync.
9. `meta.json` ordering/grouping/root/hidden semantics must survive migration.
10. Fumadocs-style `Tabs` / `Tab` blocks must remain usable.
11. Mermaid fences must remain usable.
12. Custom MDX/component blocks must remain usable.
13. Docs chrome must remain available: top nav, sidebars, breadcrumbs, pagination, TOC, edit metadata.
14. Search must work across docs, api, and blog with usable keyboard UI.
15. API reference and OpenAPI routes must work.
16. Blog and RSS features must work.
17. Embedded page/surface modes must exist as public APIs.
18. Unsafe HTML, auth boundaries, and redaction must fail closed.
19. Artifacts and navigation/search ordering must be deterministic.
20. Packages must be publishable and examples/release checks must prove framework readiness.
21. `docsfn/docs` should be SvelteKit-native, independent of Fumadocs runtime dependencies, and visually aligned with other repo docs sites.
22. Release gating must include real fixture verification that catches renderer regressions before wider adoption.

## Intent → Spec Coverage Matrix

| Intent | Summary | Bundle 1 refs | Bundle 2 refs | Spec coverage | Implementation status |
| --- | --- | --- | --- | --- | --- |
| I1 | Repo-wide Fumadocs replacement readiness | `MIG-001`, `MDX-001`, `SVELTE-001`, `NEXT-001`, `TEST-001` | `SITE-*`, `CONTENT-019`, `CONTENT-020`, `BUILD-*` | Covered | FAIL |
| I2 | Includes `datafn/docs` and `searchfn/docs` | `MIG-001`, `TEST-001` | n/a | Covered | PARTIAL |
| I3 | `docsfn/docs` is real dogfood | `SVELTE-001`, `PKG-001` | `SITE-*`, `LAYOUT-*`, `SEARCH-*` | Covered | PARTIAL |
| I4 | Both framework paths usable | `NEXT-001`, `SVELTE-001`, `MDX-001` | `CONTENT-019`, `CONTENT-020`, `API-003`, `API-007` | Covered | FAIL |
| I5 | Migration mostly wiring/config only | `MIG-001`, `FS-001`, `NAV-001` | `CONTENT-003`, `CONTENT-004` | Covered | PARTIAL |
| I6 | Root `/docs` route | `ROUTE-001` | `NAV-001`, `LAYOUT-001` | Covered | PASS |
| I7 | Nested routes | `ROUTE-001` | `NAV-002`, `NAV-004`, `NAV-005` | Covered | PASS |
| I8 | Version sync | `ROUTE-002` | `CONTENT-010` | Covered | PASS |
| I9 | `meta.json` semantics | `FS-001`, `NAV-001` | `CONTENT-003`, `CONTENT-004` | Covered | PASS |
| I10 | Tabs parity | `MIG-001`, `MDX-001` | `CONTENT-017` | Covered | FAIL |
| I11 | Mermaid parity | `MIG-001`, `MDX-001` | `CONTENT-017` | Covered | FAIL |
| I12 | Custom component parity | `MDX-001` | `CONTENT-017`, `CONTENT-021` | Covered | FAIL |
| I13 | Docs chrome + metadata | `NAV-002`, `PAGE-001` | `NAV-*`, `LAYOUT-*`, `CONTENT-005`, `CONTENT-007` | Covered | PASS |
| I14 | Search artifact + UX + scopes | `SEARCH-001`, `SEARCH-002` | `SEARCH-*`, `CONTENT-006` | Covered | PARTIAL |
| I15 | OpenAPI + API reference | `API-001`, `API-002` | `CONTENT-011`, `API-*` | Covered with conflict | PARTIAL |
| I16 | Blog + RSS | `BLOG-001` | `BLOG-*`, `CONTENT-009`, `CONTENT-014` | Covered | PASS |
| I17 | Embedded modes | `EMBED-001` | n/a | Covered | PASS |
| I18 | Security/auth/redaction | `SEC-001`, `OBS-001` | `CONTENT-012`, `CONTENT-013` | Covered | PASS |
| I19 | Determinism | `DET-001` | `BUILD-*` | Covered | PASS |
| I20 | Publishable packages/examples | `PKG-001`, `TEST-001` | `CONTENT-019`, `CONTENT-020`, `API-*` | Covered | PARTIAL |
| I21 | SvelteKit-native, no Fumadocs runtime, shared visual language | `SVELTE-001`, `PKG-001` | `SITE-001`, `SITE-004`, `THEME-*` | Covered | PARTIAL |
| I22 | Release gate catches real regressions | `TEST-001` | `BUILD-*` | Covered with gap | FAIL |

Intent coverage summary:

- Fully specified in spec bundles: `22 / 22`
- Intents with a material implementation miss: `10 / 22`
- Main misses relative to user bar:
  - real rendered Tabs/Mermaid/custom-component parity
  - trustworthy framework example proof
  - clean public Svelte integration guidance
  - truthful `api` search scope behavior on the dogfood site

## Requirement Coverage Summary

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED |
| --- | ---: | ---: | ---: | ---: |
| `2026-03-20-audit-fix-a27uykdy-spec` | 19 | 3 | 3 | 0 |
| `2026-03-22-new-v7k2m9x4-spec` | 49 | 3 | 1 | 3 |

## Requirement-by-Requirement Results

### Spec Bundle: `2026-03-20-audit-fix-a27uykdy-spec`

| ID | Status | Evidence / notes |
| --- | --- | --- |
| `CFG-001` | PASS | `loadDocsConfig` loads explicit/default `docsfn.config.ts|mjs|js`, validates the schema, and fails closed with `DOCS_CONFIG_INVALID` in `docsfn/core/src/config.test.ts:28-178`. |
| `DET-001` | PASS | Deterministic manifest/search/OpenAPI and provider ordering are covered in `docsfn/core/src/manifest.test.ts:222-240`, `docsfn/core/src/search.test.ts:98-113`, `docsfn/core/src/openapi.test.ts:131-172`, and `docsfn/provider-fs/src/index.test.ts:158-174`. |
| `CMS-001` | PASS | The provider contract includes `listEntries`, `loadEntry`, optional `loadAsset`, and optional `watch`, with `DOCS_PROVIDER_ERROR` / `DOCS_REMOTE_FETCH_FAILED` helpers in `docsfn/core/src/provider.ts:28-233`. |
| `FS-001` | PASS | `FsContentProvider` covers docs/pages/blog/api/assets, keeps `meta.json` as control data, and errors on missing configured directories in `docsfn/provider-fs/src/index.test.ts:38-174`. |
| `MIG-001` | PARTIAL | Canonical fixtures, compat transforms, and unsupported syntax diagnostics exist, but real Tabs/Mermaid/custom-component rendering still degrades in the shipped React/Svelte renderers. |
| `ROUTE-001` | PASS | Root and nested index routes are verified in `docsfn/core/src/manifest.test.ts:186-220` and `docsfn/core/src/routing.test.ts:39-74`, with SvelteKit parity in `docsfn/sveltekit/src/route-helpers.test.ts:45-68`. |
| `ROUTE-002` | PASS | Versioned route/static-param behavior and invalid version failures are covered in `docsfn/core/src/routing.test.ts:94-166`. |
| `NAV-001` | PASS | `meta.json` sibling ordering, `root`, and `hidden` handling are covered in `docsfn/core/src/navigation.test.ts:68-216`. |
| `NAV-002` | PASS | Multiple sidebars, breadcrumbs, pagination, and top-nav data are exercised in `docsfn/core/src/navigation.test.ts:218-260` and used in `docsfn/docs/src/routes/docs/[...slug]/+page.server.ts:48-111`. |
| `MDX-001` | FAIL | Compile-time normalization works, but rendered behavior does not meet the requirement: React and Svelte `DocsContent` still render mermaid/tabs/custom blocks as raw code/text in `docsfn/react/src/DocsContent.tsx:61-117` and `docsfn/svelte/src/DocsContent.svelte:60-93`. |
| `MDX-002` | PASS | Heading extraction ignores fenced code, stabilizes duplicates, and produces Unicode slugs in `docsfn/core/src/markdown.test.ts:4-43`. |
| `PAGE-001` | PASS | Canonical path/URL, TOC, breadcrumbs, pagination, top nav, and edit-link data are exposed through page surfaces and docs site config in `docsfn/docs/docsfn.config.ts:5-44` and `docsfn/docs/src/routes/docs/[...slug]/+page.server.ts:48-111`. |
| `SEARCH-001` | PASS | `buildSearchIndex` deterministically emits docs/api/blog search artifacts with configurable body indexing and max artifact diagnostics in `docsfn/core/src/search.test.ts:73-178`. |
| `SEARCH-002` | PASS | Both React and Svelte `DocsSearch` implement `Cmd/Ctrl+K`, scope filters, keyboard result selection, and deterministic result rendering in `docsfn/react/src/DocsSearch.tsx:50-277` and `docsfn/svelte/src/DocsSearch.svelte:14-230`. |
| `API-001` | PASS | JSON + YAML OpenAPI ingestion, parse failures, and deterministic normalization are covered in `docsfn/core/src/openapi.test.ts:104-172` and `:189-255`. |
| `API-002` | PASS | Generated overview/tag/operation routes and missing-route failures are covered in `docsfn/core/src/openapi.test.ts:174-188` and `:258-267`; renderer ordering tests exist in React/Svelte API renderer tests. |
| `BLOG-001` | PASS | Blog normalization, drafts, tags, archives, pagination, and RSS are covered in `docsfn/core/src/blog.test.ts:29-135` and `docsfn/core/src/rss.test.ts:59-124`. |
| `EMBED-001` | PASS | Embedded page/surface metadata is asserted in `docsfn/core/src/manifest.test.ts:560-568`, and example embedded routes exist for both frameworks. |
| `NEXT-001` | PARTIAL | Route helpers are solid and a Next example exists, but the example still renders raw page bodies in `<pre>` instead of proving the real `@docsfn/react` rendering path on migrated fixtures. |
| `SVELTE-001` | FAIL | SvelteKit helper parity is good, but the Svelte renderer still fails real compatibility constructs and the official guide depends on internal/unexported component paths. |
| `SEC-001` | PASS | Unsafe HTML blocking, auth-required/auth-forbidden behavior, mixed-mode fail-closed defaults, and redaction are covered in `docsfn/core/src/security.test.ts:23-159`. |
| `OBS-001` | PASS | Analytics sanitization and DNT-aware hooks are present in core tests and the search components use canonical analytics event names. |
| `CLI-001` | PASS | `docsfn/cli/src/index.ts:381-460` implements `validate`, `build`, and `dev`, writes canonical artifacts, and the release gate is wired to run CLI validate/build on canonical fixtures. |
| `PKG-001` | PARTIAL | Package matrix checks peer ranges and artifact fields in `docsfn/scripts/release-gate.mjs:84-139`, but Svelte public exports do not match the published guide and local artifact builds could not be reproduced here. |
| `TEST-001` | FAIL | Release-gating exists, but example sites and migration parity checks still do not verify rendered compatibility semantics, and framework UI test coverage is extremely thin (`docsfn/react` + `docsfn/svelte` only test API renderers). |

### Spec Bundle: `2026-03-22-new-v7k2m9x4-spec`

| ID | Status | Evidence / notes |
| --- | --- | --- |
| `SITE-001` | PASS | `docsfn/docs/package.json`, `docsfn/docs/svelte.config.js`, `docsfn/docs/vite.config.ts`, and `docsfn/docs/src/app.html` satisfy the scaffold requirement. |
| `SITE-002` | PASS | `docsfn/docs/package.json:6-10` sets dev/preview port `6004`. |
| `SITE-003` | PASS | `docsfn/docs/docsfn.config.ts:3-47` provides schemaVersion `1`, `compat.preset: "none"`, search enabled, sidebars, and top nav. |
| `SITE-004` | PASS | `docsfn/docs/package.json:11-28` contains no `fumadocs-*` dependency, and no docs site source imports `fumadocs-*`. |
| `NAV-001` | PASS | Top-nav items are configured in `docsfn/docs/docsfn.config.ts:24-39` and rendered through `TopBar` in `docsfn/docs/src/routes/+layout.svelte:23-27`. |
| `NAV-002` | PASS | Docs sidebar data comes from the manifest and `DocsLayout` / `DocsSidebar` in `docsfn/docs/src/routes/docs/[...slug]/+page.svelte:23-35` and `docsfn/svelte/src/DocsLayout.svelte:80-99`. |
| `NAV-003` | PASS | Separate `api` sidebar config exists in `docsfn/docs/docsfn.config.ts:35-38` and drives `/docs/api/*` package sections. |
| `NAV-004` | PASS | `Breadcrumbs` render on docs routes in `docsfn/docs/src/routes/docs/[...slug]/+page.svelte:23-35`. |
| `NAV-005` | PASS | `Pagination` renders on docs routes and the component supports prev/next + Alt+Arrow shortcuts. |
| `NAV-006` | PASS | `DocsToc` is used in layout and implements IntersectionObserver-based active heading behavior in `docsfn/svelte/src/DocsToc.svelte:14-68`. |
| `LAYOUT-001` | PASS | `loadDocsSiteSource()` uses a singleton promise, builds manifest + search artifact, and is surfaced via `+layout.server.ts` in `docsfn/docs/src/lib/server/docs-site-source.ts:23-57` and `docsfn/docs/src/routes/+layout.server.ts:1-7`. |
| `LAYOUT-002` | PASS | `DocsLayout` provides the three-column sidebar/content/TOC shell in `docsfn/svelte/src/DocsLayout.svelte:52-100` and theme CSS `docsfn/svelte/src/theme.css:61-100`. |
| `LAYOUT-003` | PASS | Responsive behavior is implemented by the mobile menu in `DocsLayout` and CSS breakpoints in `docsfn/svelte/src/theme.css:94-110`. |
| `LAYOUT-004` | PASS | The landing page exists at `docsfn/docs/src/routes/+page.svelte:46-79` with hero and quick links. |
| `CONTENT-001` | PASS | `docsfn/docs/content/docs/getting-started/index.md`, `installation.md`, `quick-start.md`, and `project-structure.md` cover onboarding. |
| `CONTENT-002` | PASS | `docsfn/docs/content/docs/core-concepts/configuration.md` documents the config schema and fields. |
| `CONTENT-003` | PASS | `docsfn/docs/content/docs/core-concepts/content-format.md` documents markdown/frontmatter/meta.json conventions. |
| `CONTENT-004` | PASS | `docsfn/docs/content/docs/core-concepts/sidebars.md` covers auto-build, meta ordering, multiple sidebars, hidden pages, and link/group behavior. |
| `CONTENT-005` | PASS | `docsfn/docs/content/docs/core-concepts/navigation.md` covers top nav, breadcrumbs, pagination, and active states. |
| `CONTENT-006` | PASS | `docsfn/docs/content/docs/core-concepts/search.md` covers enablement, scopes, body indexing, serving, and keyboard UI. |
| `CONTENT-007` | PASS | `docsfn/docs/content/docs/core-concepts/seo.md` covers site metadata, canonical URLs, basePath, and edit links. |
| `CONTENT-008` | PASS | `docsfn/docs/content/docs/core-concepts/theming.md` documents CSS variables, theme config, and overrides. |
| `CONTENT-009` | PASS | `docsfn/docs/content/docs/core-concepts/blog.md` covers blog setup, drafts, tags, archives, and RSS. |
| `CONTENT-010` | PASS | `docsfn/docs/content/docs/core-concepts/versioning.md` documents modes, definitions, URL shape, and version switcher usage. |
| `CONTENT-011` | PARTIAL | `docsfn/docs/content/docs/core-concepts/openapi.md` documents generated OpenAPI routes, but the dogfood site’s main package API reference is still mostly hand-written docs under `content/docs/api`, with only one real spec in `content/api`. |
| `CONTENT-012` | PASS | `docsfn/docs/content/docs/core-concepts/security.md` documents sanitization, auth modes, and redaction. |
| `CONTENT-013` | PASS | `docsfn/docs/content/docs/core-concepts/analytics.md` documents event types, DNT, and provider behavior. |
| `CONTENT-014` | PASS | `docsfn/docs/content/docs/core-concepts/rss.md` documents RSS feed generation/configuration. |
| `CONTENT-015` | PASS | `docsfn/docs/content/docs/core-concepts/cli.md` documents validate/build/dev and emitted artifacts. |
| `CONTENT-016` | PASS | `docsfn/docs/content/docs/core-concepts/content-providers.md` covers the provider contract and `FsContentProvider`. |
| `CONTENT-017` | PASS | `docsfn/docs/content/docs/core-concepts/markdown-extensions.md` documents callouts, mermaid, tabs, code blocks, and components, though runtime parity is weaker than the page implies. |
| `CONTENT-018` | PASS | `docsfn/docs/content/docs/core-concepts/diagnostics.md` documents error codes and diagnostics handling. |
| `CONTENT-019` | PARTIAL | The SvelteKit guide is extensive, but it instructs internal source aliases and unexported package subpaths (`node_modules/@docsfn/svelte/src/*`, `@docsfn/svelte/DocsContent.svelte`), so it is not a clean published-package path yet. |
| `CONTENT-020` | PASS | `docsfn/docs/content/docs/guides/nextjs.md` provides a full App Router walkthrough using public `@docsfn/next` and `@docsfn/react` APIs. |
| `CONTENT-021` | PARTIAL | The customization guide exists, but its Svelte examples also import unexported subpaths like `@docsfn/svelte/DocsContent.svelte` and `@docsfn/svelte/Breadcrumbs.svelte`. |
| `API-001` | PASS | `docsfn/docs/content/docs/api/core/*` covers config, manifest, search, navigation, routing, blog, markdown, security, analytics, RSS, OpenAPI, diagnostics, theme, and helpers. |
| `API-002` | PASS | `docsfn/docs/content/docs/api/sveltekit/index.md` documents the `@docsfn/sveltekit` surface. |
| `API-003` | PASS | `docsfn/docs/content/docs/api/svelte/index.md` and `components.md` document the Svelte component library. |
| `API-004` | PASS | `docsfn/docs/content/docs/api/provider-fs/index.md` documents `@docsfn/provider-fs`. |
| `API-005` | PASS | `docsfn/docs/content/docs/api/cli/index.md` documents `@docsfn/cli`. |
| `API-006` | PASS | `docsfn/docs/content/docs/api/next/index.md` documents `@docsfn/next`. |
| `API-007` | PASS | `docsfn/docs/content/docs/api/react/index.md` and `components.md` document `@docsfn/react`. |
| `SEARCH-001` | FAIL | Config enables an `api` scope, but most API reference pages live under `content/docs/api` and are indexed as docs, while only `manifest.apis` from `content/api` are indexed as api. The site therefore does not truly make all three scopes equivalently searchable. |
| `SEARCH-002` | PASS | `docsfn/docs/src/routes/search.json/+server.ts:1-8` serves the artifact via `createSearchArtifactResponse`, which returns JSON with cache headers in `docsfn/sveltekit/src/route-helpers.ts:751-795`. |
| `SEARCH-003` | PASS | Search is wired in `docsfn/docs/src/lib/components/DocsSiteSearch.svelte:13-17` and mounted in `docsfn/docs/src/routes/+layout.svelte:23-27`; `DocsSearch` implements `Cmd/Ctrl+K` and keyboard navigation. |
| `SEARCH-004` | PASS | `DocsSearch` renders kind, title, summary, and path in both Svelte and React implementations. |
| `BLOG-001` | PASS | `/blog` exists and lists non-draft posts sorted newest-first in `docsfn/docs/src/routes/blog/+page.ts:3-10` and `+page.svelte:15-38`. |
| `BLOG-002` | PASS | `/blog/[slug]` exists and returns 404 for missing/draft posts in `docsfn/docs/src/routes/blog/[slug]/+page.server.ts:6-23`. |
| `BLOG-003` | PASS | `docsfn/docs/content/blog/introducing-docsfn.md:1-34` satisfies the initial post requirement. |
| `BLOG-004` | PASS | `/blog/rss.xml` is implemented in `docsfn/docs/src/routes/blog/rss.xml/+server.ts:1-25`. |
| `THEME-001` | PASS | The docs site uses the Twenty One Native font, shared max-width, and footer treatment in `docsfn/docs/src/app.css:1-38` and `docsfn/docs/src/routes/+layout.svelte:31-33`. |
| `THEME-002` | PASS | Tailwind CSS 4 is present in `docsfn/docs/package.json:18-27` and imported in `docsfn/docs/src/app.css:1-3`. |
| `THEME-003` | PASS | Dark mode is implemented via `prefers-color-scheme` in `docsfn/svelte/src/theme.css:35-52` and used in the landing page styles. |
| `BUILD-001` | UNVERIFIED | Could not rerun `docsfn validate` here because the package toolchain is not installed; release-gate stopped at `tsup: command not found`. |
| `BUILD-002` | UNVERIFIED | Could not rerun `docsfn build` here because the package toolchain is not installed; release-gate stopped at `tsup: command not found`. |
| `BUILD-003` | UNVERIFIED | Could not rerun `vite build` for `docsfn/docs` here because the package toolchain is not installed. |

## Spec Conflicts / Spec Gaps

### Spec conflicts

1. **Bundle 2 route shape conflict**
   - `SPEC.md:82` defines API reference route shape as `/api/[...slug]`.
   - Bundle 2 requirements, test vectors, config, and implementation use `/docs/api` instead (`REQUIREMENTS.md:138`, `TEST_VECTORS.md:88,118,287`, `docsfn/docs/docsfn.config.ts:25-38`).

2. **Bundle 2 OpenAPI ownership conflict**
   - `SPEC.md:277` says OpenAPI-generated API reference is deferred and that API reference is hand-written markdown.
   - The same bundle also requires OpenAPI documentation (`CONTENT-011`), the dogfood site ships `docsfn/docs/content/api/search-qa-stub.openapi.yaml`, and route code handles `routeEntry.kind === "api"` in `docsfn/docs/src/routes/docs/[...slug]/+page.server.ts:48-100`.

3. **Bundle 2 API directory guidance conflict**
   - The SvelteKit guide uses `apiDir: "content/docs/api"` in `docsfn/docs/content/docs/guides/sveltekit.md:122-139`.
   - The actual docs site config uses `content/api` in `docsfn/docs/docsfn.config.ts:15-23`.
   - The dogfood site then stores the public package API reference under `content/docs/api`, creating mixed semantics.

### Spec gaps

1. **No rendered compatibility acceptance for React/Svelte**
   - Bundle 1 requires functional Tabs/Mermaid/custom-component rendering, but neither spec bundle requires DOM assertions on the example apps for those constructs.

2. **Example-site proof is specified too shallowly**
   - Bundle 1 `TEST-001` and release-gate expect example site builds, but not that the examples actually use `DocsContent` / framework renderers for migrated fixture pages.

3. **Search scope requirements do not pin the site’s content model tightly enough**
   - Bundle 2 requires docs/api/blog scopes, but does not enforce that content intended as “API reference” must live in the `api` collection rather than a docs subtree.

## Cross-Cutting Audits

### Security / auth / redaction

- Strong overall.
- Source-level and compiled-content HTML safety checks fail closed by default.
- Auth modes `public`, `private`, and `mixed` are implemented with explicit `DOCS_AUTH_REQUIRED` / `DOCS_AUTH_FORBIDDEN` behavior.
- Search and analytics pipelines redact sensitive values.
- Caveat: renderer parity failures are not security failures by themselves, but they increase the chance of teams bypassing the official rendering path with ad hoc HTML handling.

### Determinism / reproducibility

- Strong at the code/model level.
- Provider ordering, manifest routes, search artifact ordering, OpenAPI normalization, blog records, and RSS output all have deterministic coverage.
- Caveat: full end-to-end artifact reproducibility through CLI/build scripts was not re-executed in this environment because the toolchain was not installed.

### Limits / diagnostics / failure behavior

- Good overall.
- Config validation, route conflicts, version errors, provider errors, search build failures, unsafe HTML, and OpenAPI parse failures use stable diagnostic codes.
- Search artifact size caps are enforced via `maxArtifactBytes`.
- Caveat: there is less visible proof for broader resource caps outside search artifact size.

### Compatibility / migration realism

- This is the weakest production-readiness area.
- The compile pipeline recognizes the right syntax and fixture content is present.
- The gap is not syntax detection; it is actual React/Svelte rendering semantics and release tests that would catch regressions there.

### Performance / ops

- The docs site caches manifest + search artifact at process scope.
- However it recompiles Svelte page content per request load in `docsfn/docs/src/routes/docs/[...slug]/+page.server.ts:94-100` rather than caching compiled page artifacts, which is a readiness risk for heavier docs sites.

## Recommendations

1. **Fix `DocsContent` renderer parity before any wider rollout.**
   - Tabs must recursively render markdown/content blocks, not raw strings.
   - Mermaid must route through a real client/SSR rendering strategy, not raw `<pre>`.
   - Custom component blocks must have a safe, documented rendering contract in both frameworks.

2. **Convert both example apps into true framework-dogfood apps.**
   - The Next example should render migrated fixture pages with `@docsfn/react`.
   - The SvelteKit example should render migrated fixture pages with `@docsfn/svelte`.
   - Remove raw-body `<pre>` rendering from the proof paths.

3. **Strengthen release gating with rendered fixture assertions.**
   - Add DOM or snapshot assertions for canonical fixture pages that contain Tabs, Mermaid, and custom components.
   - Require those assertions for both example apps.
   - Expand framework UI coverage beyond only API reference renderers.

4. **Resolve the Svelte public integration story.**
   - Either export supported component subpaths from `@docsfn/svelte`, or update the guides to use only supported public imports.
   - Stop documenting `node_modules/@docsfn/svelte/src/*` aliasing as the recommended path.

5. **Make the docs site’s API story internally consistent.**
   - Decide whether package API reference belongs to `content/api` or `content/docs/api`.
   - Align search scope behavior, sidebar config, OpenAPI docs, and spec language to that choice.

6. **Re-run the full release gate in a bootstrapped environment before calling docsfn production-ready.**
   - The current environment prevented direct confirmation of `validate`, `build`, and `vite build`.
   - That rerun should happen only after the renderer/example/gate fixes above, otherwise green builds will still overstate readiness.

## Appendix: Commands Run + Environment Details

### Environment details

- `pwd` → `.`
- `git rev-parse HEAD` → `ca86e25e6faf11da93e390c18dad8ae5f22b6f69`
- `git rev-parse --abbrev-ref HEAD` → `HEAD`
- `git status --porcelain | wc -l` → `8`
- `date -u +%Y-%m-%dT%H:%M:%SZ` → `2026-03-25T11:22:18Z`

### Representative commands run

- Inventory / structure:
  - `rg --files docsfn`
  - `find docsfn -maxdepth 3 -type d | sort`
  - `find docsfn/docs/content -type f | sort`
  - `find docsfn/docs/src/routes -type f | sort`
  - `find docsfn/examples -type f | sort`
- Spec / intent reads:
  - `sed -n` and `nl -ba` across both spec bundles, docs/readmes, fixtures, and implementation files
- Code / test discovery:
  - `rg -n "describe\\(|it\\(" docsfn/react docsfn/svelte docsfn/next docsfn/sveltekit -g '*test*'`
  - `rg -n "fumadocs" docsfn/docs docsfn/examples docsfn/README.md docsfn/next docsfn/sveltekit`
  - `rg -n "createSearchArtifactResponse" docsfn/sveltekit/src docsfn/next/src docsfn/core/src`
- Verification attempts:
  - `node docsfn/scripts/release-gate.mjs`
  - `find docsfn/docs/content/api -type f | wc -l`
  - `find docsfn/docs/content/docs/api -type f | wc -l`

### Verification failure captured

`node docsfn/scripts/release-gate.mjs` failed immediately with:

```text
[release-gate] build @docsfn/core
> @docsfn/core@0.0.1 build
> tsup
sh: tsup: command not found
```

That blocked direct local confirmation of bundle-2 `BUILD-001`, `BUILD-002`, and `BUILD-003`.
