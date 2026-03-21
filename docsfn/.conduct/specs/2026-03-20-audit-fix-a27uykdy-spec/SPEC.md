# Metadata

- Timestamp: `2026-03-20T12:57:57Z`
- Agent name: `spec`
- Model: `GPT-5 Codex`
- Launcher: `Codex`
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/docsfn`
- OS + shell: `Darwin Mac 25.3.0 arm64`, `/bin/zsh`
- Repo metadata:
  - Repository root: `/Users/serro/Documents/dev/n/superfunctions`
  - Branch: `next`
  - Commit: `6f9a47d6c5f8ac166932e0156efb910bf5e32652`
  - Dirty worktree: `yes`
- Spec folder name: `2026-03-20-audit-fix-a27uykdy-spec`
- Spec folder full path: `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/specs/2026-03-20-audit-fix-a27uykdy-spec`
- Spec type: `audit-fix`
- Spec ID: `a27uykdy`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/audits/2026-03-20-uhz52fhl-full-audit.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/spec.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/implementation.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/next/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/docsfn/sveltekit/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/docs-theme/src/layout.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/docs-theme/src/config.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/source.config.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/meta.json`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/content/docs/documentation/server/routes.mdx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/docs/layout.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/docs/app/docs/[[...slug]]/page.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs/source.config.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs/content/docs/meta.json`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs/content/docs/index.mdx`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs/app/docs/layout.tsx`
  - `/Users/serro/Documents/dev/n/superfunctions/searchfn/docs/app/docs/[[...slug]]/page.tsx`
- Audit reference:
  - Audit file: `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/audits/2026-03-20-uhz52fhl-full-audit.md`
  - This spec supersedes the root-level draft planning docs at `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/spec.md` and `/Users/serro/Documents/dev/n/superfunctions/docsfn/.conduct/implementation.md` for production-readiness work.

# Overview

## Context

- Project name: `docsfn`
- One-sentence goal: Make `docsfn` production-ready to replace the repository’s current Fumadocs-based docs sites, especially `datafn/docs` and `searchfn/docs`, while preserving existing content semantics and supporting first-class Next.js and SvelteKit site kits.
- Target users:
  - Superfunctions package maintainers and docs authors
  - Platform engineers building and operating docs sites
  - Consumers embedding docs surfaces inside product UIs
- Target environments:
  - Build/runtime: Node.js `>=18.18`
  - Frameworks: Next.js `15.x` with React `18` and `19`; SvelteKit `2.x` with Svelte `4` and `5`
  - Deployment: static hosting, SSR, and SSG
  - Browsers: modern evergreen browsers
  - Connectivity: online docs hosting; offline-capable client-side search snapshot consumption
- Languages/packages required:
  - TypeScript, ESM-first packages
  - `@docsfn/*`, `@uifn/*`, `searchfn`, `watchfn`, `authfn`, `cachefn`
  - MDX/remark/rehype on React-like adapters; mdsvex/remark/rehype on Svelte adapters
- Existing systems it MUST integrate with:
  - Current repo docs trees under `datafn/docs` and `searchfn/docs`
  - Current repo docs theme helpers under `packages/docs-theme`
  - Existing Fumadocs-authored content conventions: `meta.json`, MDX imports, Mermaid remark plugin behavior, page metadata expectations
- Data model summary:
  - Source entries: docs pages, blog posts, OpenAPI sources, assets, meta files
  - Canonical records: `DocPage`, `MarkdownPage`, `BlogPost`, `ApiReference`, `Asset`
  - Derived records: `Sidebar`, `TopNav`, `DocHeading`, `Breadcrumb`, `Pagination`, `VersionSet`, `DocsManifest`, `DocsSearchArtifact`, `DocsDiagnostic`
- Security model:
  - Public docs by default
  - Optional private-doc gating through `authfn`
  - Content sources MUST be treated as untrusted structured input until compiled and sanitized by a trusted pipeline
  - Analytics MUST be opt-in and MUST NOT leak secrets or PII
- Performance constraints:
  - MUST support the current repo fixtures without regressions
  - SHOULD support at least `1,000` docs pages, `100` blog posts, and `20` OpenAPI specs in a single site build on Apple Silicon developer hardware without process failure
  - SHOULD keep the default uncompressed search artifact under `8 MiB`; if exceeded, the build MUST emit a warning with the contributing scope
- Non-goals / out of scope:
  - A general-purpose SSG that replaces Next.js or SvelteKit
  - A WYSIWYG authoring product
  - Built-in full i18n/localization orchestration
  - A brand-new design system unrelated to `@uifn/*` and the current repo docs styling model
- Hard constraints:
  - No nested monorepo structure
  - Deterministic manifest, navigation, and search artifacts for identical inputs
  - No silent degradation for broken config, routing, MDX compilation, or search build failures
  - Existing repo docs content MUST NOT require broad manual rewrites to migrate

## Assumptions

1. “Production-ready” means both build integrity and migration parity for the current Superfunctions docs sites.
2. The existing repo docs content under `datafn/docs` and `searchfn/docs` is the minimum compatibility fixture set; future packages MAY add more fixtures, but these two MUST pass before release.
3. Small site-wiring changes and compatibility preset activation are allowed during migration; broad source-document rewrites are not.

# Glossary

- **Artifact**: A deterministic file emitted by `docsfn build`, such as `manifest.json` or `search.json`.
- **Base path**: The route prefix for a docs site, defaulting to `/docs`.
- **Collection**: A logical content group such as `docs`, `blog`, `api`, or `pages`.
- **Compatibility preset**: A named transform bundle that normalizes external content conventions into canonical `docsfn` semantics.
- **Diagnostic**: A structured, machine-readable error/warning/info record emitted by validation, build, or runtime helpers.
- **Docs page**: A canonical documentation page rendered with full docs chrome.
- **Embedded page**: A canonical page rendered without full site chrome.
- **Manifest**: The canonical JSON artifact representing normalized content and derived navigation/runtime metadata.
- **Meta file**: A directory-local control file such as `meta.json` that defines ordering, group metadata, or root behavior.
- **Page chrome**: UI metadata and slots for sidebar, TOC, breadcrumbs, pagination, edit link, page actions, and site metadata.
- **Site kit**: A framework adapter package that wires loading, routing, rendering metadata, and chrome defaults into a host framework.
- **Source entry**: A raw input record from a provider before normalization.
- **Trusted compilation pipeline**: The build path that converts MDX/Markdown/mdsvex into renderable output while enforcing allowed syntax and sanitation rules.
- **Version set**: The configured versions for a docs site and the route strategy used to expose them.

# Goals / Non-goals

## Goals

1. `docsfn` MUST replace the current Fumadocs-based docs sites in this repository without loss of required content semantics, navigation shape, or framework behavior.
2. `docsfn` MUST provide deterministic, validated, framework-agnostic core artifacts that support standalone site kits, embedded docs surfaces, blog content, and API reference content.
3. `docsfn` MUST support first-class Next.js and SvelteKit site kits with parity around routing, metadata, search, and page chrome.
4. `docsfn` MUST integrate cleanly with `@uifn/*`, `searchfn`, `watchfn`, `authfn`, and `cachefn`.

## Non-goals

1. `docsfn` is NOT required to replace the host framework router, bundler, or deployment model.
2. `docsfn` is NOT required to ship a rich-text editor or authoring UI.
3. `docsfn` is NOT required to define a complete multilingual content system in this spec.
4. `docsfn` is NOT required to implement third-party SaaS CMS providers beyond a stable remote-provider contract and at least one contract-proof integration path.

# Public API

## Core package: `@docsfn/core`

```ts
export type DocsFramework = "next" | "sveltekit" | "embedded";
export type DocsCollection = "docs" | "pages" | "blog" | "api" | "assets";
export type DocsVersionMode = "none" | "path-prefix" | "path-segment";
export type DocsCompatPreset = "none" | "fumadocs-v15";

export interface DocsSiteConfig {
  title: string;
  description?: string;
  basePath?: `/${string}`;
  canonicalUrl?: string;
  defaultLocale?: string;
  theme?: DocsThemeConfig;
  editLink?: DocsEditLinkConfig;
  pageActions?: DocsPageActionConfig[];
}

export interface DocsVersionConfig {
  slug: string;
  label: string;
  default?: boolean;
}

export interface DocsConfig {
  schemaVersion: 1;
  site: DocsSiteConfig;
  compat?: {
    preset: DocsCompatPreset;
    allowRawHtml?: false;
  };
  versions?: {
    mode: DocsVersionMode;
    versions: DocsVersionConfig[];
  };
  content: {
    root: string;
    docsDir?: string;
    pagesDir?: string;
    blogDir?: string;
    apiDir?: string;
    assetsDir?: string;
    metaFileName?: string;
  };
  navigation?: {
    topNav?: DocsTopNavItem[];
    sidebars?: Record<string, DocsSidebarDefinition>;
  };
  search?: {
    enabled: boolean;
    scopes: Array<"docs" | "api" | "blog">;
    bodyIndexing?: "full" | "summary" | "disabled";
    maxArtifactBytes?: number;
  };
  auth?: {
    enabled: boolean;
    mode: "public" | "private" | "mixed";
  };
  analytics?: {
    enabled: boolean;
    provider: "watchfn";
    respectDnt: boolean;
  };
}

export interface DocsSourceEntry {
  id: string;
  collection: DocsCollection;
  relativePath: string;
  absolutePath?: string;
  frontmatter: Record<string, unknown>;
  body?: string;
  bytes?: number;
  sha256?: string;
  etag?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}

export interface DocsContentProvider {
  readonly providerId: string;
  listEntries(input: {
    config: DocsConfig;
    collections: DocsCollection[];
  }): Promise<DocsSourceEntry[]>;
  loadEntry(input: {
    config: DocsConfig;
    entry: DocsSourceEntry;
  }): Promise<DocsSourceEntry>;
  loadAsset?(
    input: { config: DocsConfig; relativePath: string },
  ): Promise<{ relativePath: string; absolutePath: string; bytes: number; sha256?: string }>;
  watch?(
    input: { config: DocsConfig; onChange: (paths: string[]) => Promise<void> | void },
  ): Promise<{ close(): Promise<void> }>;
}

export interface DocsDiagnostic {
  code: DocsErrorCode;
  severity: "error" | "warning" | "info";
  message: string;
  location?: {
    sourceId?: string;
    absolutePath?: string;
    line?: number;
    column?: number;
  };
  details?: Record<string, unknown>;
  suggestion?: string;
}

export type DocsErrorCode =
  | "DOCS_CONFIG_INVALID"
  | "DOCS_CONFIG_UNSUPPORTED"
  | "DOCS_PROVIDER_ERROR"
  | "DOCS_ENTRY_INVALID"
  | "DOCS_META_INVALID"
  | "DOCS_ROUTE_CONFLICT"
  | "DOCS_ROUTE_NOT_FOUND"
  | "DOCS_VERSION_INVALID"
  | "DOCS_COMPAT_UNSUPPORTED"
  | "DOCS_MDX_COMPILE_FAILED"
  | "DOCS_HTML_UNSAFE"
  | "DOCS_SEARCH_BUILD_FAILED"
  | "DOCS_OPENAPI_PARSE_FAILED"
  | "DOCS_REMOTE_FETCH_FAILED"
  | "DOCS_AUTH_REQUIRED"
  | "DOCS_AUTH_FORBIDDEN"
  | "DOCS_ARTIFACT_INVALID";

export class DocsError extends Error {
  code: DocsErrorCode;
  diagnostics: DocsDiagnostic[];
}

export interface DocsBuildArtifacts {
  manifest: DocsManifest;
  search?: DocsSearchArtifact;
  diagnostics: DocsDiagnostic[];
  compatReport: DocsCompatReport;
}

export async function loadDocsConfig(input: {
  cwd: string;
  configPath?: string;
}): Promise<DocsConfig>;

export async function validateDocsConfig(input: {
  config: DocsConfig;
  provider: DocsContentProvider;
}): Promise<{ ok: true; diagnostics: DocsDiagnostic[] }>;

export async function buildManifest(input: {
  config: DocsConfig;
  provider: DocsContentProvider;
}): Promise<DocsManifest>;

export async function buildSearchArtifact(input: {
  config: DocsConfig;
  manifest: DocsManifest;
}): Promise<DocsSearchArtifact>;

export async function buildDocsArtifacts(input: {
  config: DocsConfig;
  provider: DocsContentProvider;
}): Promise<DocsBuildArtifacts>;

export function resolveDocsRoute(input: {
  manifest: DocsManifest;
  pathname: string;
}): DocsResolvedRoute | null;

export function getSidebarTree(input: {
  manifest: DocsManifest;
  sidebarId: string;
  version?: string;
}): DocsSidebarTree;
```

## Filesystem provider package: `@docsfn/provider-fs`

```ts
export interface FsContentProviderOptions {
  root: string;
}

export class FsContentProvider implements DocsContentProvider {
  constructor(options: FsContentProviderOptions);
}
```

## CLI package: `@docsfn/cli`

```txt
docsfn validate [root] [--config <path>] [--json]
docsfn build [root] [--config <path>] [--out <dir>]
docsfn dev [root] [--config <path>] [--out <dir>]
```

CLI behavior:

- `validate` MUST parse config, load sources, and exit nonzero on any error-severity diagnostic.
- `build` MUST emit `manifest.json`, `search.json` when search is enabled, `diagnostics.json`, and `compat-report.json`.
- `dev` MUST perform an initial validated build and then rebuild on provider watch events.

## Next.js site kit package: `@docsfn/next`

```ts
export interface NextDocsRouteHelpers {
  generateStaticParams(): Array<{ slug?: string[]; version?: string }>;
  resolvePage(params: { slug?: string[]; version?: string }): DocsResolvedPage;
  generateMetadata(params: { slug?: string[]; version?: string }): Metadata;
}

export function createNextDocsRouteHelpers(input: {
  manifest: DocsManifest;
  sidebarId?: string;
}): NextDocsRouteHelpers;
```

## SvelteKit site kit package: `@docsfn/sveltekit`

```ts
export interface SvelteKitDocsLoadData {
  manifest: DocsManifest;
  page?: DocsResolvedPage;
  post?: DocsResolvedPost;
  api?: DocsResolvedApiPage;
}

export function createSvelteKitPageLoad(input: {
  manifest: DocsManifest;
  sidebarId?: string;
}): ({ params }: { params: Record<string, string> }) => Promise<SvelteKitDocsLoadData>;

export function getSvelteKitStaticPaths(input: {
  manifest: DocsManifest;
}): Array<{ params: Record<string, string> }>;
```

## React and Svelte component contracts

The site kits MAY ship higher-level wrappers, but the following component contracts MUST exist and remain framework-parity-aligned:

```ts
interface DocsLayoutProps {
  sidebar: DocsSidebarTree;
  topNav?: DocsTopNavModel;
  toc?: DocHeading[];
  breadcrumbs?: DocsBreadcrumbItem[];
  pagination?: DocsPagination;
  pageActionsSlot?: unknown;
  children: unknown;
}

interface DocsContentProps {
  compiled: DocsCompiledContent;
  components?: Record<string, unknown>;
}

interface DocsSearchProps {
  artifact: DocsSearchArtifact;
  scopeLabels?: Record<string, string>;
}
```

# Data Formats / Protocol

## Canonical manifest artifact

```ts
export interface DocsManifest {
  schemaVersion: 1;
  stableHash: string;
  site: DocsSiteConfig;
  compat: {
    preset: DocsCompatPreset;
    rawHtmlAllowed: false;
  };
  versions?: {
    mode: DocsVersionMode;
    defaultVersion?: string;
    versions: DocsVersionConfig[];
  };
  collections: {
    pages: Record<string, DocPage>;
    markdownPages: Record<string, MarkdownPage>;
    posts: Record<string, BlogPost>;
    apis: Record<string, ApiReference>;
    assets: Record<string, Asset>;
  };
  routes: Record<string, DocsResolvedRoute>;
  sidebars: Record<string, DocsSidebarTree>;
  topNav?: DocsTopNavModel;
}
```

Manifest rules:

1. `manifest.json` MUST be deterministic for identical normalized inputs.
2. `manifest.json` MUST NOT contain wall-clock timestamps, random IDs, or machine-local absolute paths.
3. `stableHash` MUST change when any user-visible routed content or navigation data changes.

## Canonical search artifact

```ts
export interface DocsSearchArtifact {
  schemaVersion: 1;
  stableHash: string;
  scopes: Array<"docs" | "api" | "blog">;
  engine: "searchfn";
  snapshot: Record<string, unknown>;
  documents: Array<{
    id: string;
    scope: "docs" | "api" | "blog";
    path: string;
    title: string;
    summary?: string;
    version?: string;
  }>;
}
```

Search rules:

1. The artifact MUST be sufficient for offline client-side query execution.
2. Unsupported or failed search builds MUST fail the build with `DOCS_SEARCH_BUILD_FAILED`; they MUST NOT silently emit an empty snapshot.

## Canonical diagnostics artifact

```ts
export interface DocsDiagnosticsArtifact {
  schemaVersion: 1;
  ok: boolean;
  diagnostics: DocsDiagnostic[];
}
```

## Canonical compatibility report

```ts
export interface DocsCompatReport {
  schemaVersion: 1;
  preset: DocsCompatPreset;
  transformedFiles: Array<{
    sourceId: string;
    transforms: string[];
  }>;
  unsupportedSyntax: DocsDiagnostic[];
}
```

## Canonical analytics event envelope

```ts
export interface DocsAnalyticsEvent {
  name: "docs.pageview" | "docs.search" | "docs.search_result_click" | "docs.external_click";
  timestamp: string;
  route: string;
  version?: string;
  sidebarId?: string;
  searchScope?: "docs" | "api" | "blog";
  resultCount?: number;
  targetUrl?: string;
}
```

# Semantics

## Configuration loading and validation

1. `docsfn` MUST load config from an explicit path when provided, else from `docsfn.config.ts`, `docsfn.config.mjs`, or `docsfn.config.js` at the site root.
2. Invalid config MUST fail validation with `DOCS_CONFIG_INVALID`; `docsfn` MUST NOT silently fall back to a default config when a config file exists but is invalid.
3. Missing config MAY use documented defaults only when no config file is present.

## Source discovery and normalization

1. The filesystem provider MUST support:
   - `content/docs` and `docs` as docs collections
   - `pages` for standalone markdown pages
   - `blog` for posts
   - `api` for OpenAPI specs
   - `public` or `assets` for asset passthrough
2. Directory-local `meta.json` files MUST be loaded as control files and MUST NOT be exposed as docs pages.
3. Each normalized record MUST have a stable ID derived from collection + relative path after canonical path normalization.
4. Collection-relative `index.mdx` and `index.md` files MUST map to the parent route, not `.../index`.

## Compatibility preset semantics

1. The `fumadocs-v15` preset MUST support the constructs currently used in repo docs fixtures:
   - `meta.json` with `title`, `description`, `root`, and `pages`
   - MDX imports from `fumadocs-ui/components/tabs`
   - `Tabs` / `Tab` blocks
   - Mermaid code fences transformed via a trusted plugin path
   - current frontmatter keys used in fixtures, including `title`, `description`, `full`, `toc`, `tags`, `date`, `author`, `audience`, and `applies_to`
2. Supported compatibility transforms MUST happen during build normalization or compilation.
3. Unsupported syntax encountered under an enabled compatibility preset MUST fail the build with `DOCS_COMPAT_UNSUPPORTED`; `docsfn` MUST NOT render misleading fallback output for that syntax.

## Routing

1. Every route MUST be derived from:
   - `site.basePath`
   - collection semantics
   - version strategy
   - canonical slug normalization
2. Route conflicts MUST fail the build with `DOCS_ROUTE_CONFLICT`.
3. Page resolution MUST support root pages where route params are absent.
4. Versioned routes MUST resolve identically from:
   - build-generated static params
   - runtime route lookup helpers
   - sidebar links

## Navigation

1. `meta.json.pages` ordering MUST take precedence over alphabetical ordering for siblings within the same directory.
2. Entries omitted from `meta.json.pages` MUST be appended after explicit entries in stable normalized order.
3. Multiple sidebars MUST be supported via config or directory/frontmatter assignment.
4. Breadcrumbs MUST derive from the effective sidebar tree and resolved route, not from naive path-segment capitalization alone.
5. Pagination MUST follow effective sidebar order and MUST allow explicit previous/next overrides in frontmatter or config.

## MDX / markdown compilation

1. React/Next content MUST compile through a trusted MDX pipeline.
2. Svelte/SvelteKit content MUST compile through a trusted mdsvex-compatible or equivalent Svelte compilation pipeline.
3. Raw HTML MUST be sanitized or rejected according to the security rules; default behavior MUST be rejection.
4. TOC extraction MUST use the same AST-derived heading model that rendering uses.
5. Duplicate headings MUST receive stable suffixed anchors.
6. Heading anchors for Unicode text MUST be deterministic and non-empty.

## Page chrome and metadata

1. Each resolved page MUST expose:
   - title
   - description
   - canonical path
   - Open Graph metadata inputs
   - edit-link metadata when configured
   - page actions slot metadata
   - TOC
   - breadcrumbs
   - pagination
2. Site kits MUST provide extension slots so host apps can inject custom actions such as copy-markdown buttons or AI links without forking core layout components.

## Search

1. Search build MUST index all enabled scopes and emit a `searchfn`-powered snapshot.
2. Search runtime MUST support:
   - docs/api/blog scope filtering
   - keyboard shortcut open/close behavior
   - deterministic ordering for equal scores
   - title/summary/path display
   - snippet/highlight data when enabled
3. Search artifact generation MUST use canonical summarized text for pages that opt out of full-body indexing.

## OpenAPI

1. OpenAPI sources MAY be JSON, YAML, local files, or remote URLs.
2. YAML parsing MUST be first-class and MUST NOT silently degrade to an empty spec.
3. Normalization MUST produce stable operation IDs, tag groups, schema groups, and routeable reference pages.
4. The API reference renderer MUST present summary, description, parameters, request bodies, responses, and schemas from normalized data.

## Blog

1. Blog posts MUST support date, tags, author, excerpt, and draft metadata.
2. Draft posts MUST be excluded from production artifacts unless explicitly enabled in preview mode.
3. Tag index pages and RSS feed generation MUST be derived from canonical post records.

## Embedded modes

1. Embedded markdown page mode MUST render a single compiled page with optional TOC and no forced site chrome.
2. Embedded docs surface mode MUST render sidebar, TOC, search trigger, and top-nav slots inside an existing host app layout.

## Site kits

1. Next.js site kit MUST support App Router static params, page resolution, metadata generation, and React `18`/`19`.
2. SvelteKit site kit MUST support load functions, prerender/static path generation, and Svelte `4`/`5`.
3. Both site kits MUST work with the same manifest semantics and produce equivalent route resolution.

# Invariants

1. `docsfn` MUST be deterministic for identical normalized inputs.
2. Deterministic outputs include:
   - `manifest.json`
   - `search.json`
   - `compat-report.json`
3. The following MUST NOT affect deterministic outputs:
   - build timestamp
   - machine absolute paths
   - filesystem iteration order
   - process ID
   - random IDs
4. The following MAY vary outside deterministic artifacts:
   - CLI duration logging
   - watch-mode rebuild timestamps on stdout
5. Route IDs, heading anchors, sidebar order, and search document IDs MUST remain stable unless source content or config changes.
6. Build and validation are idempotent: repeated execution on identical inputs MUST produce byte-identical deterministic artifacts.

# Security

1. Default content trust model:
   - frontmatter and raw body input are untrusted
   - compatibility transforms and compilation operate in a trusted build environment
   - emitted compiled content is trusted only after sanitation/allowlist enforcement
2. Raw `<script>` and equivalent executable HTML MUST be rejected by default with `DOCS_HTML_UNSAFE`.
3. Dangerous remote OpenAPI fetch failures MUST fail closed with `DOCS_REMOTE_FETCH_FAILED`.
4. Optional auth gates MUST operate at route resolution boundaries and MUST support public, private, and mixed docs modes.
5. Search artifacts and analytics events MUST NOT include:
   - secrets
   - auth tokens
   - private headers
   - raw request bodies
   - PII beyond route/search metadata explicitly defined in this spec

# Limits / Caps

1. `meta.json.pages` nesting depth MUST support at least `8` levels.
2. Heading extraction MUST support heading levels `1` through `6`.
3. Single-source file size above `1 MiB` SHOULD emit a warning diagnostic; above `5 MiB` MUST require explicit opt-in or fail with `DOCS_ENTRY_INVALID`.
4. Search artifact size above configured `maxArtifactBytes` MUST fail with `DOCS_SEARCH_BUILD_FAILED`.
5. OpenAPI sources larger than `10 MiB` MUST require explicit config opt-in.

# Observability

1. CLI build and validate commands MUST emit human-readable summaries and machine-readable diagnostics.
2. When analytics is enabled, `docsfn` MUST emit only the canonical `DocsAnalyticsEvent` shapes defined in this spec.
3. When `navigator.doNotTrack === "1"` or equivalent browser signal is present, client analytics MUST NOT emit events.
4. `docsfn` MUST log compatibility transforms and unsupported syntax findings into `compat-report.json`.
5. `docsfn` MUST NOT log secrets, tokens, cookies, or full raw content bodies by default.

# Compatibility / Versioning Strategy

1. Package compatibility:
   - `@docsfn/react` MUST support React `18` and `19`
   - `@docsfn/next` MUST support Next `15`
   - `@docsfn/svelte` MUST support Svelte `4` and `5`
   - `@docsfn/sveltekit` MUST support SvelteKit `2`
2. Package names MUST be internally consistent and publishable:
   - core package name MUST be `@docsfn/core`
   - all sibling packages MUST depend on the published core package name
3. Config versioning:
   - config schema version MUST be explicit (`schemaVersion: 1`)
   - backward-incompatible config changes MUST increment `schemaVersion`
4. Manifest and search artifact schema versions MUST be explicit and semver-governed.
5. Compatibility preset versions MUST be named and documented; changing preset semantics in a breaking way MUST be treated as a breaking change.

# Undefined / Explicitly User-deferred Only

- Explicitly user-deferred items: none.
- Any behavior not specified in this document is undefined and is not required for implementation.
