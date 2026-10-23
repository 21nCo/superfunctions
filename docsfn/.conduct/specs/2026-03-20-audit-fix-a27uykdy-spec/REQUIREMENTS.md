# Requirement Table Of Contents

- `CFG-001`
- `DET-001`
- `CMS-001`
- `FS-001`
- `MIG-001`
- `ROUTE-001`
- `ROUTE-002`
- `NAV-001`
- `NAV-002`
- `MDX-001`
- `MDX-002`
- `PAGE-001`
- `SEARCH-001`
- `SEARCH-002`
- `API-001`
- `API-002`
- `BLOG-001`
- `EMBED-001`
- `NEXT-001`
- `SVELTE-001`
- `SEC-001`
- `OBS-001`
- `CLI-001`
- `PKG-001`
- `TEST-001`

## Requirement

- ID: `CFG-001`
- Priority: `P0`
- Statement: `docsfn` MUST load and validate a canonical `DocsConfig` schema and MUST fail closed on invalid config.
- Rationale: Production readiness requires predictable site behavior and no silent fallback to wrong directories or defaults.
- Acceptance criteria:
  - `docsfn` loads config from an explicit path or from `docsfn.config.ts|mjs|js` in the provided root.
  - Config validation covers site, content, compatibility, versions, navigation, search, auth, and analytics settings.
  - Invalid config exits `validate` and `build` with `DOCS_CONFIG_INVALID`.
  - A missing config file MAY use documented defaults only when no config file exists.
- Test vectors: `TV-CFG-001`
- Notes: Config parsing MUST preserve user-specified path strings exactly after normalization.

## Requirement

- ID: `DET-001`
- Priority: `P0`
- Statement: `docsfn` MUST emit byte-identical deterministic artifacts for identical normalized inputs.
- Rationale: Stable manifests and search artifacts are required for cache correctness, code review clarity, and regression testing.
- Acceptance criteria:
  - `manifest.json`, `search.json`, and `compat-report.json` do not embed timestamps, random IDs, or absolute build-machine paths.
  - Re-running `docsfn build` twice on unchanged inputs produces identical hashes for deterministic artifacts.
  - Filesystem iteration order does not affect route order, sidebar order, or search doc IDs.
- Test vectors: `TV-DET-001`
- Notes: Human-readable CLI stdout MAY include durations; deterministic artifacts MUST NOT.

## Requirement

- ID: `CMS-001`
- Priority: `P1`
- Statement: `docsfn` MUST define a provider contract that supports filesystem and remote/CMS-backed sources without changing core APIs.
- Rationale: Existing planning docs require a stable provider abstraction, and production readiness depends on not hard-coding filesystem-only assumptions into core.
- Acceptance criteria:
  - Core provider contract includes `listEntries`, `loadEntry`, optional `loadAsset`, and optional `watch`.
  - Provider entries carry stable IDs plus optional `etag`, `sha256`, and `updatedAt`.
  - Remote provider failures surface `DOCS_PROVIDER_ERROR` or `DOCS_REMOTE_FETCH_FAILED` diagnostics.
- Test vectors: `TV-CMS-001`
- Notes: An actual third-party CMS implementation is not required by this requirement; the contract and contract-proof fixture are required.

## Requirement

- ID: `FS-001`
- Priority: `P0`
- Statement: `@docsfn/provider-fs` MUST support the canonical content directories and control files required by the current repo docs and the published docsfn model.
- Rationale: The current repo docs use `content/docs`, while the draft docsfn plan also requires `pages`, `blog`, `api`, and assets.
- Acceptance criteria:
  - The filesystem provider supports configurable roots for `content/docs` or `docs`, `pages`, `blog`, `api`, and `public` or `assets`.
  - `meta.json` files are loaded as control files and are not emitted as pages.
  - Asset metadata is available for resolved image/download links.
  - Invalid/missing configured directories produce diagnostics rather than implicit silent omission.
- Test vectors: `TV-FS-001`
- Notes: Directory presence MAY be optional per collection if config disables that collection.

## Requirement

- ID: `MIG-001`
- Priority: `P0`
- Statement: `docsfn` MUST provide a `fumadocs-v15` compatibility preset that migrates the current repo docs fixtures without broad manual content rewrites.
- Rationale: The user’s production-readiness bar is explicit replacement of the existing Fumadocs docs sites.
- Acceptance criteria:
  - The compatibility preset handles the syntax and metadata constructs currently used in `datafn/docs` and `searchfn/docs`.
  - The preset recognizes `meta.json`, `Tabs` / `Tab`, Mermaid fences, and the fixture frontmatter fields listed in `SPEC.md`.
  - Unsupported syntax fails the build with `DOCS_COMPAT_UNSUPPORTED` and a precise file-level diagnostic.
  - Fixture migration does not require editing the source MDX documents beyond site-wiring/config changes.
- Test vectors: `TV-MIG-001`
- Notes: The supported compatibility surface MUST be documented and fixture-tested.

## Requirement

- ID: `ROUTE-001`
- Priority: `P0`
- Statement: `docsfn` MUST generate canonical docs routes, including correct root-index and nested-index behavior under the configured base path.
- Rationale: Current docs live at `/docs`, not `/docs/index`, and broken root routing was a direct audit blocker.
- Acceptance criteria:
  - Root `index.mdx` resolves to the collection root route.
  - Nested `foo/index.mdx` resolves to `/foo`.
  - Resolvers accept absent route params for root pages.
  - Route conflicts fail with `DOCS_ROUTE_CONFLICT`.
- Test vectors: `TV-ROUTE-001`
- Notes: Slugs MUST be normalized before route construction.

## Requirement

- ID: `ROUTE-002`
- Priority: `P0`
- Statement: `docsfn` MUST support deterministic versioning strategies and MUST keep generation-time and runtime route resolution in sync.
- Rationale: The audited implementation produced versioned params that could not be looked up at runtime.
- Acceptance criteria:
  - Supported version modes are `none`, `path-prefix`, and `path-segment`.
  - Version inference from filesystem structure MUST NOT duplicate version segments in emitted paths.
  - Static params helpers, runtime resolvers, sidebar links, and canonical paths agree for versioned content.
  - Invalid version lookups fail with `DOCS_VERSION_INVALID` or `DOCS_ROUTE_NOT_FOUND`.
- Test vectors: `TV-ROUTE-002`
- Notes: Exactly one configured version MAY be marked default.

## Requirement

- ID: `NAV-001`
- Priority: `P0`
- Statement: `docsfn` MUST honor `meta.json` ordering and grouping semantics for directory-local navigation.
- Rationale: The current repo docs use `meta.json` as the source of truth for top-level and nested page order.
- Acceptance criteria:
  - `meta.json.pages` order controls sibling order.
  - `meta.json.title` controls group label when present.
  - `meta.json.root` is respected for root-group flattening behavior.
  - Entries not listed in `meta.json.pages` are appended after explicit entries in stable normalized order.
  - Invalid `meta.json` produces `DOCS_META_INVALID`.
- Test vectors: `TV-NAV-001`
- Notes: `meta.json` semantics MUST be documented as part of the compatibility preset and canonical navigation rules.

## Requirement

- ID: `NAV-002`
- Priority: `P0`
- Statement: `docsfn` MUST expose multiple sidebars, top navigation, breadcrumbs, and pagination from canonical navigation data rather than path heuristics.
- Rationale: Production docs require stable chrome data that matches the effective page tree, not ad hoc path capitalization.
- Acceptance criteria:
  - Multiple sidebars can be defined from config and/or content assignment.
  - Breadcrumbs resolve from the active sidebar tree and route.
  - Pagination follows effective sidebar order with explicit override support.
  - Top navigation is represented in the manifest and site-kit helpers.
- Test vectors: `TV-NAV-002`
- Notes: Host apps MAY choose which sidebar to render, but the underlying data model MUST be complete.

## Requirement

- ID: `MDX-001`
- Priority: `P0`
- Statement: `docsfn` MUST compile React and Svelte content through trusted MDX-compatible pipelines and MUST transform supported compatibility syntax instead of rendering it as plain text.
- Rationale: The audited implementation downgraded MDX imports/components and Mermaid to broken output.
- Acceptance criteria:
  - React/Next site kits compile through MDX with documented component mapping.
  - Svelte/SvelteKit site kits compile through mdsvex-compatible or equivalent Svelte-safe transforms.
  - Supported compatibility constructs render as functional docs UI, not literal source text.
  - Unsupported syntax fails the build with `DOCS_MDX_COMPILE_FAILED` or `DOCS_COMPAT_UNSUPPORTED`.
- Test vectors: `TV-MDX-001`
- Notes: `markdown-to-jsx` and `marked` raw-string rendering are insufficient for this requirement unless wrapped in a trusted compilation stage that satisfies the acceptance criteria.

## Requirement

- ID: `MDX-002`
- Priority: `P0`
- Statement: `docsfn` MUST derive headings, anchors, and TOC data from the compiled syntax tree with stable duplicate and Unicode handling.
- Rationale: Regex-based heading extraction is not accurate enough for production navigation and anchor linking.
- Acceptance criteria:
  - Headings inside code fences are ignored.
  - Duplicate headings receive stable suffixed anchors.
  - Unicode headings receive deterministic non-empty anchors.
  - Rendered heading IDs and manifest TOC anchors match exactly.
- Test vectors: `TV-MDX-002`
- Notes: The slug algorithm MUST be documented and versioned.

## Requirement

- ID: `PAGE-001`
- Priority: `P0`
- Statement: `docsfn` MUST expose page chrome metadata and extension slots sufficient to preserve the current repo docs metadata and affordance model.
- Rationale: Current docs rely on canonical metadata, edit links, custom page actions, and page-body chrome composition.
- Acceptance criteria:
  - Resolved page data includes canonical path, title, description, Open Graph metadata inputs, edit-link metadata, TOC, breadcrumbs, and pagination.
  - Site kits provide extension slots for custom page actions.
  - Edit-link data can be derived from configurable git metadata without hard-coding repo paths into core.
- Test vectors: `TV-PAGE-001`
- Notes: Host apps MAY omit slots from rendering, but the site-kit contract MUST expose them.

## Requirement

- ID: `SEARCH-001`
- Priority: `P0`
- Statement: `docsfn` MUST build a deterministic `searchfn`-backed search artifact for all enabled scopes.
- Rationale: Search was explicitly disabled in the audited implementation and is mandatory for production docs.
- Acceptance criteria:
  - Search indexing covers enabled docs/api/blog scopes.
  - Build failures stop the build with `DOCS_SEARCH_BUILD_FAILED`.
  - Search doc IDs, titles, paths, and summaries are deterministic.
  - Body indexing behavior is configurable and enforced.
- Test vectors: `TV-SEARCH-001`
- Notes: Empty snapshots emitted on failure are forbidden.

## Requirement

- ID: `SEARCH-002`
- Priority: `P0`
- Statement: `docsfn` MUST provide adapter-level search UI behavior with scope filters, keyboard shortcuts, and deterministic result presentation.
- Rationale: Production-readiness requires both a valid search artifact and a usable client experience.
- Acceptance criteria:
  - Search UI supports opening with `Cmd/Ctrl+K`.
  - Search results support docs/api/blog scope filtering.
  - Equal-score result ordering is deterministic.
  - The UI shows title, summary, and route, and supports keyboard selection.
- Test vectors: `TV-SEARCH-002`
- Notes: Host apps MAY restyle the UI, but the reference behavior MUST exist.

## Requirement

- ID: `API-001`
- Priority: `P0`
- Statement: `docsfn` MUST ingest and normalize OpenAPI sources from JSON, YAML, local files, and remote URLs.
- Rationale: The draft docsfn intent and production bar both require first-class API reference support, and YAML silent failure was an audited blocker.
- Acceptance criteria:
  - YAML and JSON inputs both parse into normalized OpenAPI models.
  - Remote fetch failures surface `DOCS_REMOTE_FETCH_FAILED`.
  - Parse failures surface `DOCS_OPENAPI_PARSE_FAILED`.
  - Normalization outputs tags, operations, parameters, request bodies, responses, and schemas.
- Test vectors: `TV-API-001`
- Notes: Remote fetches MUST be cacheable and configurable.

## Requirement

- ID: `API-002`
- Priority: `P0`
- Statement: `docsfn` MUST generate routeable API reference pages and render them from normalized OpenAPI data.
- Rationale: A stored spec alone is not sufficient to replace current docs-site behavior.
- Acceptance criteria:
  - API overview, tag-group, operation, and schema routes are derivable from normalized input.
  - The reference renderer shows summary, description, parameters, request bodies, responses, and schemas.
  - Broken or missing API routes fail with `DOCS_ROUTE_NOT_FOUND`.
- Test vectors: `TV-API-002`
- Notes: “Try it” UI is not required by this requirement.

## Requirement

- ID: `BLOG-001`
- Priority: `P1`
- Statement: `docsfn` MUST support blog posts, tag indexes, pagination, drafts, and RSS generation.
- Rationale: Blog mode is part of the authoritative docsfn product shape and must not be left implicit.
- Acceptance criteria:
  - Blog posts include title, date, tags, author, excerpt, and draft metadata.
  - Drafts are excluded from production builds unless preview mode is enabled.
  - Tag index pages and RSS feed output are derivable from canonical blog records.
  - Blog pagination is deterministic.
- Test vectors: `TV-BLOG-001`
- Notes: The current repo fixtures do not use blog mode, so dedicated fixtures are required.

## Requirement

- ID: `EMBED-001`
- Priority: `P1`
- Statement: `docsfn` MUST provide both embedded markdown-page mode and embedded docs-surface mode as public APIs.
- Rationale: The authoritative product definition includes both lightweight and chrome-rich embedded usage.
- Acceptance criteria:
  - Embedded page mode renders a single compiled page with optional TOC.
  - Embedded docs-surface mode renders sidebar, top-nav slot, TOC, and search trigger inside an existing host layout.
  - Embedded modes use the same manifest data as standalone site kits.
- Test vectors: `TV-EMBED-001`
- Notes: Embedded modes MUST NOT force a site-root HTML shell.

## Requirement

- ID: `NEXT-001`
- Priority: `P0`
- Statement: `@docsfn/next` MUST provide a production-ready Next.js App Router site kit compatible with Next `15` and React `18`/`19`.
- Rationale: Next is one of the primary site-kit targets and the current repo docs already run on Next.
- Acceptance criteria:
  - Static params, route resolution, and metadata helpers resolve root and nested docs correctly.
  - The site kit supports React `19`.
  - The site kit consumes canonical manifest/search artifacts without bespoke route rewriting.
  - A runnable Next example site exists.
- Test vectors: `TV-NEXT-001`
- Notes: Site kit APIs MAY be additive, but invalid README examples are forbidden.

## Requirement

- ID: `SVELTE-001`
- Priority: `P0`
- Statement: `@docsfn/sveltekit` and `@docsfn/svelte` MUST provide a production-ready SvelteKit `2` and Svelte `4`/`5` site kit path that satisfies the repo migration goal.
- Rationale: The user explicitly asked for readiness to replace Fumadocs with `docsfn + svelte`.
- Acceptance criteria:
  - SvelteKit load/static-path helpers resolve root and nested docs correctly.
  - Svelte components consume compiled content instead of raw unsafe HTML strings.
  - The Svelte package emits valid declaration files matching its package metadata.
  - A runnable SvelteKit example site exists.
- Test vectors: `TV-SVELTE-001`
- Notes: SvelteKit is the primary migration target for this spec, but parity with Next semantics is still required.

## Requirement

- ID: `SEC-001`
- Priority: `P0`
- Statement: `docsfn` MUST reject unsafe executable HTML by default and MUST enforce explicit auth boundaries for private docs modes.
- Rationale: A pluggable docs platform cannot safely treat raw source as trusted executable HTML.
- Acceptance criteria:
  - Raw `<script>` content fails with `DOCS_HTML_UNSAFE` unless an explicitly documented and disabled-by-default allowlist mode is configured.
  - Auth modes support `public`, `private`, and `mixed`.
  - Private routes fail with `DOCS_AUTH_REQUIRED` or `DOCS_AUTH_FORBIDDEN` instead of leaking content.
  - Search and diagnostics do not include secrets or raw protected content bodies by default.
- Test vectors: `TV-SEC-001`
- Notes: This requirement applies to all providers and site kits.

## Requirement

- ID: `OBS-001`
- Priority: `P1`
- Statement: `docsfn` MUST provide optional `watchfn`-compatible analytics hooks and MUST respect Do Not Track signals.
- Rationale: The authoritative plan includes analytics, but privacy controls are mandatory for production readiness.
- Acceptance criteria:
  - Analytics emits only the canonical event names defined in `SPEC.md`.
  - Client analytics are suppressed when DNT is enabled.
  - Analytics are opt-in and disabled by default.
  - Analytics payloads exclude secrets, cookies, tokens, and raw content bodies.
- Test vectors: `TV-OBS-001`
- Notes: Analytics transport implementation MAY be thin if it adheres to the event envelope.

## Requirement

- ID: `CLI-001`
- Priority: `P0`
- Statement: `@docsfn/cli` MUST provide validated build/dev/validate workflows and MUST emit canonical artifacts and diagnostics.
- Rationale: A production-ready docs toolchain requires a reliable CLI entrypoint and machine-readable failures.
- Acceptance criteria:
  - `validate` exits nonzero on any error diagnostic.
  - `build` emits `manifest.json`, `search.json` when enabled, `diagnostics.json`, and `compat-report.json`.
  - `dev` performs an initial validated build and rebuilds on provider watch events.
  - Invalid config or build failures do not silently fall back to defaults.
- Test vectors: `TV-CLI-001`
- Notes: CLI stdout format MAY evolve; emitted artifact contract MUST remain stable.

## Requirement

- ID: `PKG-001`
- Priority: `P0`
- Statement: `docsfn` packages MUST be publishable, internally consistent, correctly typed, and accompanied by runnable examples.
- Rationale: Package naming/build/type mismatches were direct audit failures and block downstream adoption.
- Acceptance criteria:
  - Core package is published as `@docsfn/core`.
  - All package metadata matches emitted build outputs.
  - React/Svelte/Next/SvelteKit packages build successfully and emit the declared type files.
  - Peer dependency ranges cover the supported framework versions in this spec.
  - Next and SvelteKit example sites are runnable and fixture-backed.
- Test vectors: `TV-PKG-001`
- Notes: Example sites are part of the release gate, not optional documentation.

## Requirement

- ID: `TEST-001`
- Priority: `P0`
- Statement: `docsfn` MUST ship a release-gating test matrix that includes real repo fixture coverage and end-to-end site-kit verification.
- Rationale: Production readiness cannot be asserted from unit tests alone.
- Acceptance criteria:
  - Core, provider, adapter, integration, and example E2E test layers exist.
  - Real fixture coverage includes the current `datafn/docs` and `searchfn/docs` content trees or canonical snapshots of them.
  - Search, versioning, compatibility, and OpenAPI routes are covered by tests.
  - A release is blocked when any fixture or example site fails.
- Test vectors: `TV-TEST-001`
- Notes: Snapshot tests MAY be used, but critical route/search behavior requires executable assertions.
