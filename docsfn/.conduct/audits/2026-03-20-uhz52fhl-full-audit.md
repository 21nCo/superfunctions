# Full Audit: docsfn Production Readiness

## Metadata

- Timestamp: `2026-03-20T11:35:12Z`
- Agent name: `audit`
- Model: `GPT-5 Codex`
- Launcher: `Codex`
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/docsfn`
- Comparison target paths: `/Users/serro/Documents/dev/n/superfunctions/datafn/docs`, `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs`
- OS + shell: `Darwin Mac 25.3.0 arm64`, `/bin/zsh`
- Repo metadata: git repo rooted at `/Users/serro/Documents/dev/n/superfunctions`; branch `next`; commit `6f9a47d6c5f8ac166932e0156efb910bf5e32652`; dirty worktree `yes`
- Intent/notes paths audited:
  - User request in thread: production-readiness audit for replacing Fumadocs with `docsfn + svelte`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/next/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/sveltekit/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs`
- Spec bundle paths audited:
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/spec.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/implementation.md`
  - No `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, or `INTENT_AUDIT.md` were present under `docsfn/.conduct`
- Codebase scope audited:
  - Included: `docsfn/core`, `docsfn/provider-fs`, `docsfn/cli`, `docsfn/react`, `docsfn/svelte`, `docsfn/next`, `docsfn/sveltekit`
  - Referenced for migration-target compatibility: `datafn/docs`, `searchfn/docs`, `packages/docs-theme`
  - Excluded from pass/fail: `dist`, `node_modules`, `.turbo`, historical `docsfn/AUDIT.md`
- Commands executed during audit:
  - `rg --files`, `rg -n`, `sed -n`, `nl -ba`, `find`, `ls -la`
  - `git status --short`, `git branch --show-current`, `git rev-parse HEAD`
  - `npm test -- --run` in `docsfn/core` and `docsfn/provider-fs`
  - `npm run build` in `docsfn/core`, `docsfn/provider-fs`, `docsfn/react`, `docsfn/svelte`, `docsfn/next`, `docsfn/sveltekit`, `docsfn/cli`
  - `node --input-type=module` reproduction scripts for manifest generation, routing, MDX rendering, search, versioning, YAML OpenAPI parsing, and HTML/script rendering
  - `uname -a`, `echo $SHELL`, `date -u`

## Audit Scope

This was a full read-only audit of `docsfn` against two authorities:

1. The user’s stated intent: `docsfn` must be production-ready enough to replace Fumadocs for the existing docs apps in this repo, specifically the current `datafn/docs`, `searchfn/docs`, and similar sites, with a Svelte/SvelteKit migration path.
2. The `docsfn` spec bundle in `docsfn/.conduct/`.

The audit standard was not “does some code exist,” but “can this replace the current Fumadocs-based sites without major regressions in routing, navigation, content rendering, search, versioning, packaging, and safety.”

## Inputs Audited (Intent + Spec Bundles)

### Intent / notes

- Thread request: “perform a thorough audit of docsfn for production readiness in all aspects”
- Replacement target clarification: “we should be able to replace fumadocs with our docsfn + svelte for our existing docs in this repo (`datafn/docs`, `searchfn/docs` etc)”
- Self-claims and usage docs:
  - `docsfn/README.md`
  - `docsfn/next/README.md`
  - `docsfn/sveltekit/README.md`
- Real migration targets:
  - `datafn/docs/source.config.ts`
  - `datafn/docs/content/docs/**`
  - `datafn/docs/app/docs/**`
  - `searchfn/docs/source.config.ts`
  - `searchfn/docs/content/docs/**`
  - `searchfn/docs/app/docs/**`

### Spec bundles

- `docsfn/.conduct/spec.md`
- `docsfn/.conduct/implementation.md`

### Historical context only

- `docsfn/AUDIT.md`

Per the audit rules, `docsfn/AUDIT.md` was not used to decide compliance.

## High-Level Findings

**Overall verdict: FAIL. `docsfn` is not production-ready to replace the current Fumadocs-based docs sites in this repo.**

1. **Current repo docs cannot be migrated without major behavior loss.**
   `docsfn` ignores `meta.json` navigation ordering/grouping, maps `index.mdx` to `/index` instead of `/docs`, and does not support the MDX component patterns already used in `datafn/docs` and `searchfn/docs`. This alone blocks replacement readiness.

2. **Search is not functional.**
   `buildSearchIndex()` is a stub returning an empty snapshot in `docsfn/core/src/search.ts:4-8`, `docsfn/core/src/search.test.ts` skips all search tests, and `@docsfn/react` does not build because `DocsSearch.tsx` contains HTML-escaped source.

3. **Versioned docs are broken end-to-end.**
   When version is inferred from the filesystem path, `buildManifest()` duplicates the version in the route path (`/v2/v2/intro`), while the Next helper looks up `/v2/intro`, so generated params do not resolve.

4. **The renderers are unsafe for any non-fully-trusted content source.**
   Both React and Svelte renderers allow raw `<script>` output. That is incompatible with the spec’s pluggable-provider/CMS ambitions and below a production bar even for internal docs infrastructure.

5. **Packaging and release quality are below production grade.**
   `@docsfn/react` fails `npm run build`, `@docsfn/svelte` emits no `.d.ts` despite declaring one, `docsfn/core` is named `docsfn` instead of `@docsfn/core`, and `@docsfn/react` excludes React 19 even though the repo’s docs apps use Next 15 + React 19.

6. **The README and adapter docs materially overstate readiness.**
   `docsfn/README.md` claims production readiness, working search, complete adapters, and deployability, but the code and spec bundle still show large unfinished milestone areas. The adapter READMEs also contain example code that does not match the actual component APIs.

Validated command outcomes:

- `docsfn/core`: `26` tests passed, `7` search tests skipped.
- `docsfn/provider-fs`: `12` tests passed.
- `npm run build` succeeded for `core`, `provider-fs`, `next`, `sveltekit`, and `cli`.
- `npm run build` failed for `react`.
- `npm run build` succeeded for `svelte`, but produced JS bundles only and no declared `dist/index.d.ts`.

## Intent Inventory

1. `docsfn` must be production-ready enough to replace the current Fumadocs-based docs sites in this repo.
2. The replacement target explicitly includes the real docs trees under `datafn/docs`, `searchfn/docs`, and similar sibling apps.
3. Existing `content/docs` trees must be ingestible with only reasonable migration wiring, not wholesale content rewrites.
4. The docs landing page must work at the docs root (`/docs`), not at `/docs/index`.
5. Nested documentation routes must continue to work.
6. Navigation grouping and ordering must preserve the current site structure, including `meta.json`-driven page order.
7. Existing MDX features used in the repo, including imported JSX components such as `Tabs` / `Tab`, must continue to render correctly.
8. Mermaid diagrams must continue to render.
9. Core docs-site chrome must remain available with reasonable wiring: sidebar, TOC, breadcrumbs, pagination, and top-level docs layout.
10. Search must work in production for docs content.
11. API reference / OpenAPI content must work, including YAML-backed specs used in normal docs tooling.
12. Versioned docs must work correctly.
13. The Svelte / SvelteKit path must be viable for migration, not just nominally present.
14. Packaging, installability, and release metadata must be production-safe for both monorepo and published-package use.
15. Security and validation boundaries must be acceptable for a pluggable docs system, especially if CMS providers are added later.
16. Current docs metadata expectations such as canonical/OG handling and edit/copy affordances should remain achievable without substantial custom reimplementation.

## Intent → Spec Coverage Matrix

| Intent ID | Intent | Spec mapping | Spec coverage | Implementation status | Notes |
| --- | --- | --- | --- | --- | --- |
| I1 | Replace current Fumadocs docs sites end-to-end | `SP4`, `SP21`, `SP30`, `IMP9`, `IMP-A2` | Covered | FAIL | No complete standalone site kit or migration-compatible renderer exists. |
| I2 | Include real repo docs targets (`datafn/docs`, `searchfn/docs`) | `SP3`, `SP18` | Partially covered | FAIL | Files can be listed if manually pointed at `content/docs`, but current site conventions are not preserved. |
| I3 | Ingest current `content/docs` trees with reasonable migration effort | `SP18`, `SP21` | Partially covered | FAIL | CLI defaults to `docs/`; no support for `meta.json`, MDX imports, or current routing semantics. |
| I4 | Serve docs root at `/docs` | none explicit | **SPEC MISSING** | FAIL | `index.mdx` becomes `/index`; `getPageData(undefined, manifest)` throws. |
| I5 | Preserve nested docs routes | `SP4`, `SP21` | Covered | PARTIAL | Non-root, unversioned nested pages can resolve, but root and versioned routes do not. |
| I6 | Preserve nav grouping and `meta.json` order | `SP4`, `SP18` | **SPEC MISSING** for `meta.json` compatibility | FAIL | Auto sidebar sorts alphabetically and ignores `meta.json` entirely. |
| I7 | Preserve MDX component rendering (`Tabs`, imported JSX) | `SP19`, `SP20` | Covered at a high level only | FAIL | Current docs use imported MDX components; `docsfn` renderers do not execute them. |
| I8 | Preserve Mermaid rendering | `SP19`, `SP20` | Partially covered | FAIL | Current docs use Mermaid remark/MDX plugins; `docsfn` reduces these to code blocks. |
| I9 | Preserve core docs chrome (sidebar, TOC, breadcrumbs, pagination, layout) | `SP4`, `SP20`, `IMP4`, `IMP8` | Covered | PARTIAL | Components exist, but data quality and route integration are insufficient for migration. |
| I10 | Search must work | `SP9`, `SP26`, `IMP6` | Covered | FAIL | Search index generation is stubbed. |
| I11 | OpenAPI / API reference must work | `SP8`, `SP25`, `IMP7` | Covered | PARTIAL | Basic JSON-only passthrough exists; YAML and derived pages are missing. |
| I12 | Versioned docs must work | `SP13`, `SP30`, `IMP4` | Covered | FAIL | Versioned routing is currently broken. |
| I13 | Svelte / SvelteKit migration path must be viable | `SP2`, `SP21`, `IMP8`, `IMP9` | Covered | FAIL | SvelteKit helper docs are invalid; Svelte renderer is plain-markdown only and unsafe. |
| I14 | Packaging / release quality must be production-safe | `SP14`, `SP28`, `IMP0` | Covered | FAIL | Build, peer, naming, and typing issues remain. |
| I15 | Security / validation boundaries must be acceptable | `SP17`, `SP27`, `IMP12` | Covered | FAIL | Raw HTML/script rendering, silent config fallback, and no validation hardening. |
| I16 | Metadata / edit-link / copy affordances should remain achievable | `SP21`, `SP27` | Partially covered | PARTIAL | Current docs use richer metadata and page actions than `docsfn` adapters provide out of the box. |

Intent coverage summary:

- Fully/meaningfully covered by spec: `10 / 16`
- Partially specified or missing in spec: `6 / 16`
- Main spec gaps relative to migration intent: root-index semantics, `meta.json` compatibility, MDX-component compatibility details, and parity for current docs-site metadata/actions

## Requirement Coverage Summary

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED |
| --- | ---: | ---: | ---: | ---: |
| `docsfn/.conduct/spec.md` | 0 | 13 | 17 | 0 |
| `docsfn/.conduct/implementation.md` | 0 | 7 | 10 | 0 |

## Requirement-by-Requirement Results

### Spec Bundle: `docsfn/.conduct/spec.md`

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| SP1 | Headless core models docs/nav/search/api as data | PARTIAL | `DocPage`, `BlogPost`, `ApiReference`, `Sidebar`, and `DocsManifest` exist, but `MarkdownPage`, `Asset`, `TopNav`, and first-class breadcrumb/pagination/version-strategy models are absent in `docsfn/core/src/types.ts:1-90`. |
| SP2 | Cross-framework UI via React and Svelte using `@uifn/*` | PARTIAL | React/Svelte component sets exist and use `@uifn/*`, but `@docsfn/react` fails to build and `@docsfn/svelte` does not emit declared typings. |
| SP3 | Pluggable provider interface with filesystem first | PARTIAL | `DocsContentProvider.list()` and `FsContentProvider` exist, but there is no `load()`, `watch()`, timestamps, etags, or CMS-ready contract. |
| SP4 | Standalone docs site supports multi-sidebars, topbar, search, API docs, versions, theming, pagination | FAIL | Only a single `default` sidebar is built; no top-nav model; search is stubbed; versioning is broken; theming is isolated and not site-kit ready. |
| SP5 | Embedded markdown page mode | PARTIAL | Minimal content components exist, but no dedicated `MarkdownPage` abstraction or compatibility with current MDX content. |
| SP6 | Embedded docs surface mode | FAIL | No `DocsSurface` API or equivalent host-app embedding abstraction was found. |
| SP7 | Blog mode | PARTIAL | `BlogList` and `generateRSSFeed()` exist, but there are no tag pages, post page helpers, or pagination primitives wired into adapters. |
| SP8 | OpenAPI is a first-class content type | PARTIAL | `ApiReference` exists and a minimal renderer exists, but ingestion is shallow and YAML parsing fails. |
| SP9 | Search defaults to `searchfn` | FAIL | `buildSearchIndex()` is hard-disabled in `docsfn/core/src/search.ts:4-8`. |
| SP10 | Optional `watchfn` / `authfn` / `cachefn` integration hooks | FAIL | No implementation or API surface for these integrations was found. |
| SP11 | Content types include `DocPage`, `MarkdownPage`, `BlogPost`, `ApiReference`, `Asset` | PARTIAL | `Asset` is in `ContentKind`, but assets are not loaded or stored, and `MarkdownPage` is not modeled. |
| SP12 | Navigation types include `Sidebar`, `TopNav`, `TOC`, `Pagination` | PARTIAL | `Sidebar` and TOC data exist; helper-based pagination exists; `TopNav` is not part of core data model. |
| SP13 | Versioning affects routes, sidebars, API refs, search partitions | FAIL | Route generation is broken for versioned docs; search partitioning is absent; no version strategy is defined. |
| SP14 | Package layout includes core, cli, react, svelte, next, sveltekit, provider-fs, examples | PARTIAL | Packages exist; examples do not. |
| SP15 | Pipeline is source -> normalize -> index -> manifest | PARTIAL | Loading and manifest building exist, but normalization is shallow and index generation is stubbed. |
| SP16 | Build-time and runtime modes share the same models | FAIL | No runtime/CMS mode implementation was found. |
| SP17 | Provider contract exposes list/load/watch and stable ids/timestamps/etags | FAIL | Provider contract only exposes `list()` in `docsfn/core/src/types.ts:89-90`. |
| SP18 | Filesystem provider supports docs/pages/blog/api/assets, frontmatter, ordering, multiple sidebars | FAIL | Supports docs/blog/api only; no `pages/`, no assets, no ordering rules, no `meta.json`, no multiple sidebars. |
| SP19 | Adapters use idiomatic MDX/mdsvex rendering; core does not own markdown compilation | FAIL | Adapters directly render raw strings via `markdown-to-jsx` and `marked` in `docsfn/react/src/DocsContent.tsx:8-11` and `docsfn/svelte/src/DocsContent.svelte:7-8`. |
| SP20 | Required UI building blocks exist (sidebar/toc/pagination/topbar/search/layout/api) | PARTIAL | Most components exist, but working search, mobile-nav behavior, and accessibility depth are incomplete. |
| SP21 | Standalone site kit requires minimal wiring | FAIL | README examples are not valid against the actual APIs and there are no runnable example sites. |
| SP22 | Minimal embedded markdown APIs such as `renderMarkdownPage()` / `<MarkdownPage>` | FAIL | No such API exists. |
| SP23 | Embedded docs surface composability | FAIL | No composable `DocsSurface` primitive or equivalent contract exists. |
| SP24 | Blog mode includes posts, tags, authors, listing pages, RSS, pagination | PARTIAL | Tags/authors/RSS data exist partially; pages and pagination do not. |
| SP25 | OpenAPI ingestion supports local/remote/CMS inputs and derived overview/tag/endpoint/schema pages | FAIL | Only local file passthrough exists; YAML breaks; remote/CMS inputs and derived pages are absent. |
| SP26 | Search includes build-time index, runtime cache, client UI, shortcut, highlights, scoped search | FAIL | Only a partially written UI exists; backend is stubbed; no highlights or scoped search. |
| SP27 | Config includes basePath/canonical/theme/versions/sidebars/topnav/provider/api/search/analytics/auth | FAIL | CLI only loads `docsfn.config.js` and fails open to a tiny default config in `docsfn/cli/src/index.ts:11-29`. |
| SP28 | Compatibility constraints: ESM, Node, determinism, SSR/SSG, client navigation | FAIL | ESM exists, but determinism, root routing, versioning, and active-state parity are not reliable enough for production. |
| SP29 | v0 roadmap: core models + fs provider + TOC + sidebar + React/Svelte minimal renderers | PARTIAL | These pieces exist at a foundation level, but heading extraction is regex-only and React package build integrity is broken. |
| SP30 | v1 roadmap: standalone site kits + search + multi-sidebars + blog + OpenAPI reference pages | FAIL | The v1 production bar is not met. |

### Implementation Bundle: `docsfn/.conduct/implementation.md`

| ID | Requirement | Status | Evidence / notes |
| --- | --- | --- | --- |
| IMP0 | Package scaffolding and naming conventions | PARTIAL | Package folders exist, but `docsfn/core/package.json:2` is named `docsfn` instead of `@docsfn/core`, and examples are missing. |
| IMP1 | Core domain model + config schema | FAIL | Several planned types are absent and config validation was not implemented. |
| IMP2 | Provider interface + filesystem provider | FAIL | Interface is too narrow and the FS provider does not implement required directories, ordering, or watch/invalidation behavior. |
| IMP3 | Markdown analysis pipeline | FAIL | `extractHeadings()` is a regex pass in `docsfn/core/src/markdown.ts:3-22`; no AST pipeline, excerpts, or link analysis exists. |
| IMP4 | Navigation engine | PARTIAL | Auto sidebar, breadcrumbs, and pagination helpers exist, but explicit sidebar config, `meta.json`, overrides, and stable versioning are missing/broken. |
| IMP5 | Manifest builder + cache keys | PARTIAL | `buildManifest()` exists, but there are no etag/timestamp/hash cache keys. |
| IMP6 | Search milestone | FAIL | Search index generation is disabled; React search source is malformed; search tests are skipped. |
| IMP7 | API docs ingestion milestone | PARTIAL | Minimal JSON OpenAPI passthrough and a renderer exist, but YAML, normalization, and virtual pages do not. |
| IMP8 | UI kits + accessibility | PARTIAL | Component surface exists, but mobile drawer, skip link, stronger keyboard support, and safety hardening are missing. |
| IMP9 | Framework site kits | FAIL | Route helpers exist, but root routing, versioned routing, and README examples do not form a usable end-to-end site kit. |
| IMP10 | Blog mode | PARTIAL | Some primitives exist, but no full blog route/page system exists. |
| IMP11 | CMS support | FAIL | No CMS provider or stable remote-provider contract exists. |
| IMP12 | `watchfn` / `authfn` / `cachefn` integrations | FAIL | No implementation found. |
| IMP-T1 | Testing strategy | PARTIAL | Unit/provider coverage exists, but search tests are skipped and adapter/integration/e2e coverage is missing. |
| IMP-A1 | Acceptance: deterministic core with multiple sidebars, breadcrumbs, pagination, versions | FAIL | Determinism is compromised, multiple sidebars are absent, and versioned routing is broken. |
| IMP-A2 | Acceptance: modes A-D covered and at least one complete site kit | FAIL | No complete standalone site kit exists and embedded/blog modes are only partial. |
| IMP-A3 | Acceptance: search works, OpenAPI pages render, watchfn can be enabled | FAIL | Search does not work; OpenAPI support is partial; watchfn is absent. |

## Spec Conflicts / Spec Gaps

### Spec conflicts

1. **README vs spec bundle conflict**
   - `docsfn/README.md:3-15` says the core is production ready, search is working, adapters are working, and deployment is recommended.
   - `docsfn/.conduct/spec.md` and `docsfn/.conduct/implementation.md` still describe large unfinished v1 areas.
   - The code matches the spec/plan’s incompleteness, not the README’s “ship it” claim.

2. **Adapter README vs actual API conflict**
   - `docsfn/README.md:31-37`, `docsfn/next/README.md:45-56`, and `docsfn/sveltekit/README.md:30-39` show `<DocsContent page={page} />`.
   - Actual component APIs expect `content: string` in `docsfn/react/src/DocsContent.tsx:4-12` and `docsfn/svelte/src/DocsContent.svelte:1-8`.
   - The published usage docs are therefore not executable as written.

### Spec gaps relative to user intent

1. **No explicit migration contract for Fumadocs `meta.json` navigation**
   - The user’s readiness bar is replacement of real repo docs.
   - The spec mentions multiple sidebars and ordering, but never defines compatibility with the actual `meta.json` files driving those sites.

2. **No explicit contract for MDX component compatibility**
   - The spec says “markdown/MDX/mdsvex,” but it does not define whether imported JSX components from existing docs content must execute unchanged.
   - That omission is material for this repo because current docs use `Tabs`, `Tab`, and Mermaid-enabled MDX.

3. **No explicit root-index routing semantics**
   - The migration target assumes `/docs` root pages.
   - The spec talks about routing generally but does not define how `index.mdx` should map.

4. **No explicit parity requirement for current docs-site affordances**
   - The current Fumadocs apps provide edit links, copy/view actions, canonical metadata, and Open Graph metadata.
   - The spec partly covers metadata and top-level chrome, but not the current repo’s full docs UX contract.

## Cross-Cutting Audits

### Security / authz / validation boundaries

- **Unsafe HTML/script rendering**
  - React renderer: `docsfn/react/src/DocsContent.tsx:8-11`
  - Svelte renderer: `docsfn/svelte/src/DocsContent.svelte:7-8`
  - Reproduction: rendering `<script>alert(1)</script>` through both renderers emitted a literal `<script>` tag.
  - Impact: this is not safe for any future CMS-backed or otherwise non-fully-trusted content source.

- **No auth gating or opt-in analytics hooks**
  - No `authfn`, `watchfn`, or `cachefn` integration surfaces were found.

- **Config validation fails open**
  - `docsfn/cli/src/index.ts:11-29` catches all config import failures and silently falls back to defaults.
  - Impact: misconfiguration can produce a “successful” build against the wrong directories or site settings.

### Determinism invariants

- **Manifest output is not fully deterministic**
  - `docsfn/core/src/manifest.ts:72-83` defaults missing blog dates to `new Date().toISOString()`, so identical content can produce different manifest outputs over time.

- **Ordering rules required by the plan are not implemented**
  - `docsfn/provider-fs/src/index.ts:26-90` reads files and returns entries without any explicit `order` handling.
  - `docsfn/core/src/sidebar.ts:7-45` sorts alphabetically by slug and ignores existing `meta.json`.

- **Actual replacement targets demonstrate order drift**
  - `datafn/docs/content/docs/meta.json:1-4` expects `["index", "documentation", "dfql", "cli", "reference"]`.
  - `docsfn` generated top-level order as `["Cli", "Dfql", "Documentation", "DataFn", "Reference"]`.
  - `searchfn/docs/content/docs/meta.json:1-10` expects `index` before `getting-started`, `architecture`, `reference`, etc.
  - `docsfn` generated `["Architecture", "Getting Started", "SearchFn", "Integrations", "Operations", "Reference"]`.

- **Versioning determinism is broken**
  - `docsfn/core/src/manifest.ts:37-46` keeps the version directory in `slug` and then prefixes it again.
  - Reproduction: `v2/intro.md` with versions configured produced `path: "/v2/v2/intro"`.

### Limits / caps

- **Whole-tree loading only**
  - `FsContentProvider` bulk-loads all docs/blog/api files into memory before manifesting.
  - No chunking, streaming, or caps were found.

- **Search size/perf controls are absent**
  - The disabled search implementation comments in `docsfn/core/src/search.ts:24-33` already note that storing full bodies “might be large,” but no implemented cap or strategy exists.

- **No scoped search or result window controls**
  - The spec calls for scoped search and ranked snippets/highlights; none were found.

### Error handling + canonical envelopes

- **Search failures are returned as empty success artifacts**
  - `docsfn/core/src/search.ts:4-8` logs a warning and returns `{ docs: {}, index: {} }`.
  - Impact: build pipelines can publish a broken search experience without failing.

- **YAML OpenAPI parsing fails silently**
  - `docsfn/core/src/manifest.ts:97-103` swallows non-JSON parse failures.
  - Reproduction: a YAML OpenAPI input produced `spec: {}`.

- **Route helper failure modes are inconsistent**
  - Next helper returns `null` and also crashes on `undefined` slug in `docsfn/next/src/route-helpers.ts:48-55`.
  - SvelteKit helper throws 404s in `docsfn/sveltekit/src/route-helpers.ts:53-63`.
  - There is no canonical docsfn error contract.

- **Search tests are not currently enforced**
  - `docsfn/core/src/search.test.ts:6-8` marks the entire search suite as skipped.

### Compatibility / versioning / migrations

- **React package is not compatible with the repo’s React 19 docs apps**
  - `docsfn/react/package.json:8-11` restricts peers to `^18`.
  - The current repo docs use Next 15 + React 19 in `datafn/docs/package.json` and `searchfn/docs/package.json`.

- **Core package naming does not match spec or sibling dependencies**
  - `docsfn/core/package.json:2` is `docsfn`, not `@docsfn/core`.
  - Sibling packages depend on `@docsfn/core`.
  - This is a release/publish risk even if the local workspace symlink currently masks it.

- **`@docsfn/react` does not build**
  - `docsfn/react/src/DocsSearch.tsx:26-160` contains `=&gt;` HTML entities in source.
  - `docsfn/react/tsconfig.json:6` omits `"DOM"` from `lib`, causing declaration-build failures around `window`, `document`, and `IntersectionObserver`.

- **`@docsfn/svelte` declares types but ships none**
  - `docsfn/svelte/package.json:5-6` declares `dist/index.d.ts`.
  - Running `npm run build` produced only JS/CJS bundles in `docsfn/svelte/dist/`.

- **Current docs content is not migration-compatible**
  - `datafn/docs/content/docs/documentation/server/routes.mdx:8-85` uses imported `Tabs` / `Tab`.
  - `searchfn/docs/content/docs/index.mdx:12-50` uses Mermaid fences.
  - `datafn/docs/source.config.ts:1-11` and `searchfn/docs/source.config.ts:1-11` explicitly configure Mermaid via `remarkMdxMermaid`.
  - Reproduction with `markdown-to-jsx`/`marked` showed imported MDX components rendered as literal text/tags and Mermaid as plain code blocks.

## Recommendations

1. **Fix migration blockers before anything else.**
   Implement proper root-index semantics, `meta.json`/ordering support, and a real MDX/mdsvex rendering pipeline that can handle the current repo’s `Tabs`, `Tab`, and Mermaid usage. Without this, `docsfn` cannot replace Fumadocs for `datafn/docs` or `searchfn/docs`.

2. **Restore search end-to-end.**
   Replace the search stub with a real `searchfn` snapshot builder, unskip search tests, and ensure at least one working adapter search UI ships and builds cleanly.

3. **Repair versioning as a first-class invariant.**
   Define one versioning strategy, normalize slugs before prefixing, and add fixture tests for filesystem-versioned content so `generateVersionedStaticParams()` and `getVersionedPageData()` agree.

4. **Harden package/release integrity.**
   Rename `docsfn/core` to `@docsfn/core`, fix `@docsfn/react` source and DOM typings, emit `@docsfn/svelte` declarations, widen React compatibility where intended, and stop publishing README examples that do not compile.

5. **Harden safety and failure behavior.**
   Sanitize or explicitly disallow raw HTML/script content, validate config with Zod, and fail builds on broken search/config/OpenAPI ingestion instead of silently emitting degraded artifacts.

6. **Prove readiness with real fixtures and one real site kit.**
   Add integration tests that run `docsfn` against `datafn/docs` and `searchfn/docs` fixtures, then ship one working SvelteKit example site that exercises navigation, search, MDX rendering, metadata, and versioning.

Ranked top risks:

1. **Content incompatibility risk**
   Why it matters: it blocks the core user goal of replacing current docs sites.
   References: intent `I1-I8`, `SP4`, `SP18`, `SP19`, `SP21`.

2. **Search and discoverability risk**
   Why it matters: docs without working search are not production-ready for large sites.
   References: intent `I10`, `SP9`, `SP26`, `IMP6`.

3. **Versioning correctness risk**
   Why it matters: broken version routing causes incorrect links, null lookups, and unusable versioned docs.
   References: intent `I12`, `SP13`, `IMP4`.

4. **Security risk**
   Why it matters: raw HTML/script rendering is not acceptable for a pluggable docs platform.
   References: intent `I15`, `SP17`, `SP27`.

5. **Release / adoption risk**
   Why it matters: broken package builds, wrong package names, and missing types stop downstream adoption even before runtime testing.
   References: intent `I13-I14`, `SP14`, `SP28`, `IMP0`.

Recommended fix order:

1. Fix `I1-I8` via `SP4`, `SP18`, `SP19`, `SP21`: root routes, `meta.json`, MDX component compatibility, Mermaid, site-kit examples.
2. Fix `I10` via `SP9`, `SP26`, `IMP6`: real search index generation and working UI.
3. Fix `I12` via `SP13`, `IMP4`: version routing and version-aware lookups.
4. Fix `I13-I14` via `SP14`, `SP28`, `IMP0`: package naming, build integrity, typings, and peer ranges.
5. Fix `I15` via `SP17`, `SP27`: sanitization, config validation, and fail-closed error handling.
6. Fix `I16` via `SP21`, `SP27`: metadata/edit/copy affordance parity and documented migration path.

## Appendix: Commands Run + Environment Details

Environment:

- Project root audited: `/Users/serro/Documents/dev/n/superfunctions/docsfn`
- Repo root: `/Users/serro/Documents/dev/n/superfunctions`
- Branch: `next`
- Commit: `6f9a47d6c5f8ac166932e0156efb910bf5e32652`
- Shell: `/bin/zsh`
- OS: `Darwin Mac 25.3.0 Darwin Kernel Version 25.3.0 ... arm64`

Command summary:

- Discovery and file inventory:
  - `rg --files docsfn datafn/docs searchfn/docs`
  - `rg --files docsfn -g 'README.md' -g 'AUDIT.md' -g 'SPEC.md' -g 'REQUIREMENTS.md' ...`
  - `find docsfn -maxdepth 2 -type d | sort`
  - `sed -n` / `nl -ba` across docsfn source, spec, implementation plan, and target docs apps

- Repo metadata:
  - `git status --short`
  - `git branch --show-current`
  - `git rev-parse HEAD`
  - `uname -a`
  - `echo $SHELL`
  - `date -u`

- Tests and builds:
  - `npm test -- --run` in `docsfn/core`
    - Result: `26` passed, `7` skipped (`search.test.ts`)
  - `npm test -- --run` in `docsfn/provider-fs`
    - Result: `12` passed
  - `npm run build` in `docsfn/core`
    - Result: success
  - `npm run build` in `docsfn/provider-fs`
    - Result: success
  - `npm run build` in `docsfn/react`
    - Result: failure due to malformed `DocsSearch.tsx` source and missing DOM typings for declarations
  - `npm run build` in `docsfn/svelte`
    - Result: JS bundle success, no declared typings emitted
  - `npm run build` in `docsfn/next`
    - Result: success
  - `npm run build` in `docsfn/sveltekit`
    - Result: success
  - `npm run build` in `docsfn/cli`
    - Result: success

- Runtime reproductions:
  - Built manifests for `datafn/docs` and `searchfn/docs` with `FsContentProvider({ docsDir: 'content/docs' })`
    - Result: root pages mapped to `/index`; generated top-level sidebar order drifted from `meta.json`
  - Compared real `meta.json` order against generated sidebar order
    - Result: mismatch for both `datafn/docs` and `searchfn/docs`
  - Exercised `getPageData(undefined, manifest)` with a real manifest
    - Result: throws because `slug.join` is called on `undefined`
  - Reproduced versioned doc generation with `v2/intro.md`
    - Result: manifest path `/v2/v2/intro`; generated params `['intro']`; lookup returns `null`
  - Rendered imported MDX component content through `markdown-to-jsx` and `marked`
    - Result: import lines are emitted as text; custom tags are not executed; Mermaid fences render as code blocks
  - Rendered `<script>alert(1)</script>` through both renderers
    - Result: literal `<script>` output from both
  - Reproduced YAML OpenAPI ingestion
    - Result: API record created with `spec: {}`
  - Ran `buildSearchIndex()` against a real manifest
    - Result: warning plus `{ docs: {}, index: {} }`

Final audit conclusion:

- `docsfn` is a partial foundation, not a production-ready Fumadocs replacement for the current repo docs.
- The highest-confidence path forward is to treat this as a v0 foundation audit, then implement a real SvelteKit migration target backed by fixture tests using `datafn/docs` and `searchfn/docs`.
