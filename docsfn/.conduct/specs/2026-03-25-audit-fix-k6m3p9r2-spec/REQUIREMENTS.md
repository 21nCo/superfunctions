# Requirement Table Of Contents

- `CFG-001`
- `ROUTE-001`
- `CONTENT-001`
- `REACT-001`
- `SVELTE-001`
- `API-001`
- `SEARCH-001`
- `BLOG-001`
- `EMBED-001`
- `SEC-001`
- `PKG-001`
- `SITE-001`
- `CACHE-001`
- `DOCS-001`
- `EXAMPLE-001`
- `TEST-001`
- `GATE-001`
- `BUILD-001`

## Requirement

- ID: `CFG-001`
- Priority: `P0`
- Statement: `docsfn` MUST preserve the audited config, routing, navigation, versioning, and deterministic artifact behavior while validating any new search-scope configuration fail-closed.
- Rationale: Production readiness cannot regress already-passing fundamentals while fixing renderer and release findings.
- Acceptance criteria:
  - Existing root, nested, versioned, and `meta.json` navigation semantics remain unchanged for canonical fixtures unless this spec explicitly changes them.
  - `search.routeScopeOverrides` is validated during `validate` and `build`.
  - Invalid override patterns, invalid scope values, or ambiguous effective matches fail with `DOCS_SEARCH_SCOPE_INVALID`.
  - Deterministic artifacts remain byte-stable for unchanged normalized inputs.
- Test vectors: `TV-CFG-001`
- Notes: This requirement carries forward the previously passing baseline; it is not optional because the user asked for production readiness, not a narrow patch set.

## Requirement

- ID: `ROUTE-001`
- Priority: `P0`
- Statement: `docsfn` MUST preserve canonical root, nested, and versioned route semantics for docs, blog, embedded, and API surfaces while preventing new route collisions introduced by API model alignment.
- Rationale: The renderer fixes are only useful if the route model stays stable for existing docs trees.
- Acceptance criteria:
  - `/docs`, nested docs pages, blog routes, embedded routes, and existing versioned routes continue to resolve on canonical fixtures.
  - Hand-written API reference pages and OpenAPI-generated API routes do not collide.
  - Route collisions fail with `DOCS_ROUTE_CONFLICT`.
  - Search-scope overrides do not change route resolution.
- Test vectors: `TV-ROUTE-001`
- Notes: Search scope is classification metadata only.

## Requirement

- ID: `CONTENT-001`
- Priority: `P0`
- Statement: `docsfn` MUST compile supported markdown/MDX compatibility constructs into a structured render model that preserves nested tab/component content and explicit mermaid blocks, and MUST fail closed on unsupported or unresolved constructs.
- Rationale: The audit found that syntax recognition exists, but renderer-facing structure is too lossy to achieve parity.
- Acceptance criteria:
  - `CompiledTabsBlock.tabs[*].nodes` carries compiled child nodes.
  - `CompiledComponentBlock.children` carries compiled child nodes and normalized props.
  - Mermaid fences compile to explicit mermaid blocks with stable ids.
  - Unsupported Fumadocs constructs fail with `DOCS_COMPAT_UNSUPPORTED`.
  - Unresolved native/custom component tags fail with `DOCS_COMPONENT_UNRESOLVED`.
  - Shipped reference renderers are forbidden from raw-source fallback for supported constructs.
- Test vectors: `TV-CONTENT-001`
- Notes: This requirement supersedes any raw-string-only tab/component body behavior.

## Requirement

- ID: `REACT-001`
- Priority: `P0`
- Statement: `@docsfn/react` and `@docsfn/next` MUST render canonical fixture pages with functional Tabs, Mermaid, custom component mapping, API surfaces, blog routes, and embedded pages, without raw-source fallback.
- Rationale: The user explicitly requires React to be usable for real migrations.
- Acceptance criteria:
  - A canonical Tabs-heavy fixture page renders a working tablist and tabpanel with rendered child content.
  - A canonical Mermaid fixture page renders a mermaid container through a defined renderer contract.
  - Custom component blocks render through the provided component registry and receive compiled children semantics.
  - Blog and embedded pages render through `DocsContent` or equivalent shipped components rather than raw `<pre>` source dumps.
  - Missing component mappings fail with `DOCS_COMPONENT_UNRESOLVED`.
- Test vectors: `TV-REACT-001`
- Notes: This applies to package tests and example proof routes.

## Requirement

- ID: `SVELTE-001`
- Priority: `P0`
- Statement: `@docsfn/svelte` and `@docsfn/sveltekit` MUST render the same canonical fixture semantics as React and MUST expose browser-safe public imports that match all published guidance.
- Rationale: The audit found Svelte usability blocked by both renderer behavior and public import contract problems.
- Acceptance criteria:
  - Canonical Tabs, Mermaid, custom components, blog, and embedded surfaces render functionally in Svelte.
  - `@docsfn/svelte` root and documented subpaths are safe to import from SvelteKit/Vite without source-alias hacks.
  - Package exports include every component subpath used in official guides, or the guides are updated to only use supported exports.
  - No official guide or example depends on `node_modules/@docsfn/svelte/src/*`.
  - Missing component mappings fail with `DOCS_COMPONENT_UNRESOLVED`.
- Test vectors: `TV-SVELTE-001`
- Notes: This requirement is satisfied only when code, package exports, and docs align.

## Requirement

- ID: `API-001`
- Priority: `P0`
- Statement: `docsfn` MUST support a consistent API reference model where hand-written API-markdown pages and OpenAPI-generated routes can coexist without route ambiguity and both participate in first-class API navigation and search semantics.
- Rationale: The audit found the dogfood site’s API model internally inconsistent and only nominally searchable as `api`.
- Acceptance criteria:
  - Hand-written package API pages can be classified into `api` search scope without mandatory content relocation.
  - OpenAPI-generated routes remain routable and searchable as `api`.
  - The chosen model is documented consistently across config, guides, and dogfood site content.
  - Route collisions between hand-written and generated API surfaces fail with `DOCS_ROUTE_CONFLICT`.
- Test vectors: `TV-API-001`
- Notes: This spec chooses route/classification alignment through `search.routeScopeOverrides` for the dogfood site.

## Requirement

- ID: `SEARCH-001`
- Priority: `P0`
- Statement: `docsfn` MUST build and serve a deterministic search artifact whose `docs`, `api`, and `blog` scopes are truthful, configurable, keyboard-accessible, and identical in meaning across docs site, examples, and guides.
- Rationale: Search is a public promise in config examples and docs, and the audit found the `api` scope misleading on the dogfood site.
- Acceptance criteria:
  - Search documents for `/docs/api/**` pages can resolve to `api` scope when configured.
  - Search UI supports `Cmd/Ctrl+K`, scope filtering, deterministic result ordering, title/summary/path display, and keyboard selection.
  - `search.json` responses are cacheable and deterministic.
  - Invalid search scope configuration fails with `DOCS_SEARCH_SCOPE_INVALID`.
- Test vectors: `TV-SEARCH-001`
- Notes: This requirement is not satisfied by merely enabling an `api` scope in config. Implementation for this spec MUST target the current `@searchfn/*` adapter/client architecture; legacy bare `searchfn` exports are not the normative production contract.

## Requirement

- ID: `BLOG-001`
- Priority: `P1`
- Statement: `docsfn` MUST keep blog and RSS behavior production-ready while the renderer and example proof paths are rebuilt.
- Rationale: Production readiness includes not regressing already-passing blog capability while refactoring renderers and examples.
- Acceptance criteria:
  - Blog listings, blog posts, and RSS continue to resolve and render through shipped components.
  - Blog proof routes exist in both example apps.
  - Draft filtering and deterministic ordering remain intact.
  - Regression tests cover at least one non-draft post route and the RSS endpoint.
- Test vectors: `TV-BLOG-001`
- Notes: This is primarily a regression-preservation requirement.

## Requirement

- ID: `EMBED-001`
- Priority: `P1`
- Statement: `docsfn` MUST keep embedded page and embedded docs-surface modes working with the new compiled-content model and renderer contracts.
- Rationale: Embedded modes are part of the product shape and are easily broken by content-model refactors.
- Acceptance criteria:
  - Embedded page mode renders compiled content, not raw source bodies.
  - Embedded docs-surface mode continues to expose sidebar/search/top-nav-capable surfaces.
  - Embedded proof routes exist in both example apps.
  - Embedded routes are included in release-gate parity checks.
- Test vectors: `TV-EMBED-001`
- Notes: Embedded behavior MAY share compiled caches with normal page routes.

## Requirement

- ID: `SEC-001`
- Priority: `P0`
- Statement: `docsfn` MUST keep unsafe HTML, auth boundaries, and redaction fail-closed across compile, build, search, docs contract checks, examples, and release-gate output.
- Rationale: The renderer and docs corrections cannot weaken the existing safety posture.
- Acceptance criteria:
  - Unsafe HTML remains blocked by default.
  - `public`, `private`, and `mixed` auth behaviors continue to emit canonical auth errors.
  - Search, diagnostics, docs contract checks, and release summaries do not log secrets or protected content bodies.
  - Mermaid source is handled as inert data.
  - Unresolved components do not leak raw bodies as a fallback path.
- Test vectors: `TV-SEC-001`
- Notes: This requirement preserves and extends the audited fail-closed model.

## Requirement

- ID: `PKG-001`
- Priority: `P0`
- Statement: `@docsfn/*` packages MUST be buildable, typed, peer-range-correct, and internally consistent with every import path used by official guides and examples.
- Rationale: A production-ready docs toolchain cannot depend on undocumented internal package layout.
- Acceptance criteria:
  - `main`, `module`, `types`, and `exports` fields point to built artifacts that exist after a documented bootstrap.
  - React peer ranges cover React `18` and `19`; Next peer range covers Next `15`; Svelte peer range covers Svelte `4` and `5`; SvelteKit peer range covers SvelteKit `2`.
  - Documented imports compile against the package exports map.
  - Package guides and example apps do not rely on internal source directories.
- Test vectors: `TV-PKG-001`
- Notes: This requirement explicitly includes `@docsfn/svelte` subpath exports used by public guides. For search integration, docsfn package/runtime contracts MUST align with current `@searchfn/*` workspace exports rather than undocumented legacy package surfaces.

## Requirement

- ID: `SITE-001`
- Priority: `P0`
- Statement: `docsfn/docs` MUST be a truthful dogfood site that uses shipped docsfn components/helpers, aligns its API reference model and search scope semantics, and exposes no machine-specific or internal-only assumptions.
- Rationale: The user explicitly said `docsfn/docs` is the dogfood bar for broader replacement.
- Acceptance criteria:
  - Docs pages render via shipped docsfn Svelte components, not bespoke raw-source rendering.
  - The docs site uses a documented, consistent API content/search model.
  - The dogfood site’s guides match the actual supported public imports.
  - The docs site does not compile immutable page content on every request.
  - All public commands shown by the site are repo-relative or standard CLI invocations.
- Test vectors: `TV-SITE-001`
- Notes: This requirement includes fixing README path hygiene and guide/API-model drift where relevant to the dogfood story.

## Requirement

- ID: `CACHE-001`
- Priority: `P1`
- Statement: Dogfood and example site loaders MUST build and reuse deterministic compiled-content caches keyed by manifest entry id, framework, and compat preset, and MUST NOT recompile immutable page/post bodies on each request.
- Rationale: The audit identified per-request Svelte compilation as a production-readiness risk.
- Acceptance criteria:
  - A cache helper or equivalent loader strategy compiles known pages/posts once per source snapshot.
  - Cache keys are deterministic.
  - Dogfood and example loaders use the cache for docs/blog/embedded page content.
  - Cache misses or invalidation bugs fail with diagnostics rather than silently falling back to per-request compile loops.
- Test vectors: `TV-CACHE-001`
- Notes: This is a runtime efficiency and proof-truthfulness requirement, not a general distributed cache feature.

## Requirement

- ID: `DOCS-001`
- Priority: `P0`
- Statement: Public READMEs, guides, API reference docs, and release instructions MUST describe only supported public APIs, consistent route/content semantics, and machine-independent commands.
- Rationale: The audit found the public docs materially overstated or contradicted the actual product contract.
- Acceptance criteria:
  - No public docs use `node_modules/.../src` imports.
  - No public docs import unexported package subpaths.
  - No public docs contain user-machine-specific absolute file paths.
  - Public docs describe one consistent API reference route/content model and one consistent search-scope story.
  - Docs correctness is checked by an automated contract test or script.
- Test vectors: `TV-DOCS-001`
- Notes: This requirement covers `docsfn/README.md`, adapter READMEs, and docs site content.

## Requirement

- ID: `EXAMPLE-001`
- Priority: `P0`
- Statement: The Next and SvelteKit example apps MUST dogfood the shipped framework layers on canonical fixtures and MUST include deterministic proof routes for docs, API, blog, and embedded surfaces.
- Rationale: Example apps are part of the public proof and must demonstrate real adoption semantics.
- Acceptance criteria:
  - Both example apps render fixture docs pages through `DocsContent` or equivalent shipped components.
  - Both example apps render at least one API route, one blog post route, and one embedded route through shipped components.
  - Both example apps expose the same named proof routes for release-gate checks.
  - Neither example app renders raw source bodies in the proof paths.
- Test vectors: `TV-EXAMPLE-001`
- Notes: A build-only smoke test is insufficient.

## Requirement

- ID: `TEST-001`
- Priority: `P0`
- Statement: `docsfn` MUST ship executable tests that prove renderer parity and critical UX behavior at both component level and example-site level.
- Rationale: The audit found that the current proof surface is too shallow to catch the exact regressions that remain.
- Acceptance criteria:
  - React and Svelte component tests cover Tabs, Mermaid, custom components, API rendering, search interaction, blog rendering, and embedded rendering.
  - Example-site tests cover at least one proof route per required surface in both frameworks.
  - Tests explicitly fail if raw-source fallback appears for supported constructs.
  - Keyboard search interaction and pagination shortcuts are covered where relevant.
- Test vectors: `TV-TEST-001`
- Notes: Snapshot tests MAY exist, but executable assertions are mandatory.

## Requirement

- ID: `GATE-001`
- Priority: `P0`
- Statement: The release gate MUST preflight the bootstrap environment, run the full production matrix, emit a deterministic summary artifact, and fail on any renderer, docs-contract, build, or example-proof regression.
- Rationale: Production readiness claims are only credible if the gate proves them end-to-end.
- Acceptance criteria:
  - The gate checks for required local bootstrap artifacts/binaries before running package builds.
  - The gate runs package builds, required tests, example-site proof checks, fixture parity checks, and docs-contract validation.
  - The gate emits a deterministic `DocsReleaseGateSummary`.
  - Any failed check exits non-zero with `DOCS_RELEASE_GATE_FAILED` or `DOCS_RELEASE_ENV_INVALID`.
- Test vectors: `TV-GATE-001`
- Notes: The gate MUST be runnable from repo root after documented bootstrap steps.

## Requirement

- ID: `BUILD-001`
- Priority: `P0`
- Statement: The documented bootstrap, validate, build, example-build, and release-gate commands MUST succeed from a clean repo checkout without machine-specific assumptions.
- Rationale: The audit environment could not verify production readiness because the current toolchain contract is not explicit enough.
- Acceptance criteria:
  - Docs and READMEs specify canonical repo-relative bootstrap and verification commands.
  - A clean checkout after documented install/bootstrap provides all binaries required by package builds and the release gate.
  - `validate`, `build`, example builds, and the release gate run successfully without editing hardcoded local paths.
  - Missing bootstrap prerequisites fail with `DOCS_RELEASE_ENV_INVALID` and actionable guidance.
- Test vectors: `TV-BUILD-001`
- Notes: This requirement addresses both local and CI reproducibility.
