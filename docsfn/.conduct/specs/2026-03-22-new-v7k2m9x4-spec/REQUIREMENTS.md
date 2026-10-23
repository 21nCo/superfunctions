# REQUIREMENTS: DocsFn Documentation Site

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| SITE-001 | P0 | SvelteKit project scaffold at docsfn/docs/ |
| SITE-002 | P0 | Dev server on port 6004 |
| SITE-003 | P0 | docsfn config file with native format |
| SITE-004 | P0 | No fumadocs dependencies |
| NAV-001 | P0 | Top navigation bar with Docs, API Reference, Blog, GitHub |
| NAV-002 | P0 | Docs sidebar with full navigation tree |
| NAV-003 | P0 | API Reference sidebar with per-package sections |
| NAV-004 | P0 | Breadcrumb navigation on all doc/api pages |
| NAV-005 | P0 | Previous/next pagination on all doc/api pages |
| NAV-006 | P1 | Table of contents (right sidebar) on all doc/api pages |
| LAYOUT-001 | P0 | Root layout loads manifest and search artifact |
| LAYOUT-002 | P0 | Three-column layout: sidebar + content + TOC |
| LAYOUT-003 | P0 | Responsive layout for mobile viewports |
| LAYOUT-004 | P1 | Landing page with hero section and quick links |
| CONTENT-001 | P0 | Getting Started guide (installation, quick start, project structure) |
| CONTENT-002 | P0 | Core Concepts: Configuration (docsfn.config.ts schema, all options) |
| CONTENT-003 | P0 | Core Concepts: Content Format (markdown, frontmatter, meta.json) |
| CONTENT-004 | P0 | Core Concepts: Sidebars (auto-build, meta.json ordering, custom sidebars, collapsible groups, hidden pages) |
| CONTENT-005 | P0 | Core Concepts: Navigation (topNav, breadcrumbs, pagination, active states) |
| CONTENT-006 | P0 | Core Concepts: Search (enabling, scopes, body indexing modes, artifact serving) |
| CONTENT-007 | P0 | Core Concepts: SEO (title, description, canonical URLs, basePath, edit links, page metadata) |
| CONTENT-008 | P0 | Core Concepts: Theming (CSS custom properties, dark mode, fonts, colors) |
| CONTENT-009 | P1 | Core Concepts: Blog (setup, frontmatter fields, drafts, tags, archives, RSS) |
| CONTENT-010 | P1 | Core Concepts: Versioning (path-prefix, path-segment modes, version switcher) |
| CONTENT-011 | P1 | Core Concepts: OpenAPI (spec loading, operation routes, schema catalog) |
| CONTENT-012 | P1 | Core Concepts: Security (HTML sanitization, auth modes, sensitive redaction) |
| CONTENT-013 | P1 | Core Concepts: Analytics (event types, DNT, watchfn provider) |
| CONTENT-014 | P1 | Core Concepts: RSS (feed generation, configuration) |
| CONTENT-015 | P0 | Core Concepts: CLI (validate, build, dev commands, output artifacts) |
| CONTENT-016 | P0 | Core Concepts: Content Provider (FsContentProvider, custom providers) |
| CONTENT-017 | P1 | Core Concepts: Markdown Extensions (callouts, mermaid, tabs, code blocks) |
| CONTENT-018 | P1 | Core Concepts: Diagnostics (error codes, severity levels, troubleshooting) |
| CONTENT-019 | P0 | Guides: SvelteKit Integration (full walkthrough) |
| CONTENT-020 | P1 | Guides: Next.js Integration (full walkthrough) |
| CONTENT-021 | P1 | Guides: Customizing Components (overriding defaults) |
| API-001 | P0 | API Reference: @docsfn/core (config, manifest, search, types, navigation, routing, blog, markdown, security, analytics, rss, openapi, diagnostics, theme, helpers) |
| API-002 | P0 | API Reference: @docsfn/sveltekit (route resolution, surface, static params, load creators, search response) |
| API-003 | P0 | API Reference: @docsfn/svelte (DocsLayout, DocsContent, DocsSidebar, DocsToc, DocsSearch, TopBar, Pagination, Breadcrumbs, VersionSwitcher, EmbeddedPage, SidebarGroup) |
| API-004 | P0 | API Reference: @docsfn/provider-fs (FsContentProvider, collection dirs, glob patterns, meta.json) |
| API-005 | P0 | API Reference: @docsfn/cli (validate, build, dev commands, options, exit codes) |
| API-006 | P1 | API Reference: @docsfn/next (generateStaticParams, resolveDocsRouteData, resolveDocsPageSurface, generatePageMetadata, createSearchArtifactResponse) |
| API-007 | P1 | API Reference: @docsfn/react (all React component equivalents) |
| SEARCH-001 | P0 | Search enabled with scopes: docs, api, blog |
| SEARCH-002 | P0 | Search artifact served at /search.json endpoint |
| SEARCH-003 | P0 | DocsSearch component wired with Cmd/Ctrl+K shortcut |
| SEARCH-004 | P0 | Search results display kind, title, summary, path |
| BLOG-001 | P1 | Blog listing page at /blog |
| BLOG-002 | P1 | Individual blog post pages at /blog/[slug] |
| BLOG-003 | P1 | Initial blog post: "Introducing docsfn" |
| BLOG-004 | P2 | RSS feed at /blog/rss.xml |
| THEME-001 | P0 | Visual consistency with superfunctions docs sites (colors, typography, spacing) |
| THEME-002 | P0 | Tailwind CSS 4 for styling |
| THEME-003 | P1 | Dark mode via prefers-color-scheme |
| BUILD-001 | P0 | docsfn validate passes with 0 errors |
| BUILD-002 | P0 | docsfn build produces manifest.json, search.json, diagnostics.json with 0 errors |
| BUILD-003 | P0 | SvelteKit build succeeds (vite build) |

---

## Requirement Details

---

### SITE-001: SvelteKit Project Scaffold

- **Priority**: P0
- **Statement**: The docs site MUST be a SvelteKit 2 application located at `docsfn/docs/` with standard project structure.
- **Rationale**: Dogfooding docsfn's SvelteKit integration; consistent with monorepo layout pattern.
- **Acceptance Criteria**:
  - `docsfn/docs/package.json` exists with `@sveltejs/kit ^2.0.0` and `svelte ^5.0.0` dependencies
  - `docsfn/docs/svelte.config.js` configures adapter-auto and docsfn package aliases
  - `docsfn/docs/vite.config.ts` configures SvelteKit + Vite
  - `docsfn/docs/src/app.html` is the SvelteKit shell
  - Project name is `@docsfn/docs`
- **Test Vectors**: TV-SITE-001
- **Notes**: Aliases MUST point to source (`../../core/src/index.ts` etc.) for monorepo dev, matching the example app pattern.

---

### SITE-002: Dev Server Port

- **Priority**: P0
- **Statement**: The dev server MUST listen on port 6004.
- **Rationale**: Follows the monorepo port convention (datafn=6001, searchfn=6002, hostfn=6003).
- **Acceptance Criteria**:
  - `package.json` `dev` script includes `--port 6004`
  - `package.json` `preview` script includes `--port 6004`
- **Test Vectors**: TV-SITE-002
- **Notes**: None.

---

### SITE-003: DocsFn Config

- **Priority**: P0
- **Statement**: The site MUST have a `docsfn.config.ts` (or `.js`/`.mjs`) at `docsfn/docs/` with native format (`compat.preset: "none"`).
- **Rationale**: Dogfooding native content format; no fumadocs compat needed.
- **Acceptance Criteria**:
  - Config file exists and is loadable by `loadDocsConfig()`
  - `schemaVersion` is `1`
  - `compat.preset` is `"none"`
  - `site.title` is `"docsfn"`
  - `search.enabled` is `true`
  - `navigation.sidebars` defines `docs` and `api` sidebars
  - `navigation.topNav` defines at least Docs, API Reference, Blog, GitHub links
- **Test Vectors**: TV-SITE-003
- **Notes**: Config structure defined in SPEC.md "Public API" section.

---

### SITE-004: No Fumadocs Dependencies

- **Priority**: P0
- **Statement**: The docs site MUST NOT depend on any `fumadocs-*` npm package.
- **Rationale**: This site proves docsfn can stand alone without fumadocs.
- **Acceptance Criteria**:
  - `package.json` contains no dependency matching `fumadocs-*`
  - No source file imports from `fumadocs-*`
- **Test Vectors**: TV-SITE-004
- **Notes**: The `@superfunctions/docs-theme` package depends on fumadocs-ui — it MUST NOT be imported either. Visual consistency is achieved via CSS tokens.

---

### NAV-001: Top Navigation

- **Priority**: P0
- **Statement**: The site MUST render a `TopBar` component with navigation items: Docs, API Reference, Blog, GitHub (external).
- **Rationale**: Consistent navigation across all superfunctions docs sites.
- **Acceptance Criteria**:
  - TopBar is visible on all pages
  - "Docs" links to `/docs`
  - "API Reference" links to `/docs/api` (or equivalent)
  - "Blog" links to `/blog`
  - "GitHub" links to the external GitHub URL and opens in new tab
  - Search trigger button is present in TopBar
- **Test Vectors**: TV-NAV-001
- **Notes**: None.

---

### NAV-002: Docs Sidebar

- **Priority**: P0
- **Statement**: The site MUST render a `DocsSidebar` component on `/docs/[...slug]` pages with a full navigation tree built from the content directory structure and `meta.json` files.
- **Rationale**: Primary navigation for documentation content.
- **Acceptance Criteria**:
  - Sidebar renders all docs pages grouped by directory
  - Page ordering follows `meta.json` `pages` arrays
  - Active page is visually highlighted
  - Groups are collapsible
  - Clicking a sidebar link navigates to the correct page
- **Test Vectors**: TV-NAV-002
- **Notes**: Auto-built by `buildSidebarFromPages()` via manifest.

---

### NAV-003: API Reference Sidebar

- **Priority**: P0
- **Statement**: The site MUST render a separate sidebar for API Reference pages, organized by package.
- **Rationale**: API reference content has a different structure than conceptual docs.
- **Acceptance Criteria**:
  - API sidebar is distinct from docs sidebar
  - Packages are listed as top-level groups: core, sveltekit, svelte, provider-fs, cli, next, react
  - Each package group contains its API reference pages
- **Test Vectors**: TV-NAV-003
- **Notes**: Achieved via the `api` sidebar definition in the docsfn config.

---

### NAV-004: Breadcrumbs

- **Priority**: P0
- **Statement**: Every docs and API reference page MUST display breadcrumb navigation.
- **Rationale**: Orientation and quick upward navigation.
- **Acceptance Criteria**:
  - `Breadcrumbs` component renders on all doc/api pages
  - Breadcrumb trail reflects the page's position in the sidebar hierarchy
  - All items except the last are clickable links
- **Test Vectors**: TV-NAV-004
- **Notes**: Computed by `resolveDocsPageSurface()`.

---

### NAV-005: Pagination

- **Priority**: P0
- **Statement**: Every docs and API reference page MUST display previous/next page links.
- **Rationale**: Sequential reading flow.
- **Acceptance Criteria**:
  - `Pagination` component renders at the bottom of each doc/api page
  - Previous and next pages are derived from the sidebar order
  - First page has no "previous"; last page has no "next"
  - Keyboard shortcuts Alt+ArrowLeft/Right work
- **Test Vectors**: TV-NAV-005
- **Notes**: Computed by `resolveDocsPageSurface()`.

---

### NAV-006: Table of Contents

- **Priority**: P1
- **Statement**: Every docs and API reference page SHOULD display a table of contents in the right sidebar.
- **Rationale**: Quick navigation within long pages.
- **Acceptance Criteria**:
  - `DocsToc` component renders on the right side
  - TOC items are extracted from page headings (h2+)
  - Active heading is highlighted via IntersectionObserver
  - Clicking a TOC item smooth-scrolls to the heading
- **Test Vectors**: TV-NAV-006
- **Notes**: Hidden on mobile.

---

### LAYOUT-001: Root Layout Data Loading

- **Priority**: P0
- **Statement**: The root SvelteKit layout MUST load the docsfn manifest and search artifact at server startup and pass them to all routes.
- **Rationale**: Manifest and search data are needed by all pages.
- **Acceptance Criteria**:
  - `+layout.server.ts` loads config via `loadDocsConfig()`
  - Creates `FsContentProvider` with the content root
  - Calls `buildManifest()` and `buildSearchIndex()`
  - Returns manifest, searchArtifact, siteTitle, canonicalUrl, compatPreset
  - Uses singleton promise pattern for caching
- **Test Vectors**: TV-LAYOUT-001
- **Notes**: Mirrors the example app pattern.

---

### LAYOUT-002: Three-Column Layout

- **Priority**: P0
- **Statement**: Doc and API pages MUST use a three-column layout: left sidebar, center content, right TOC.
- **Rationale**: Standard documentation layout; matches existing superfunctions sites.
- **Acceptance Criteria**:
  - Left column: sidebar navigation (collapsible on mobile)
  - Center column: main content area with breadcrumbs, content, pagination
  - Right column: table of contents (hidden on smaller screens)
- **Test Vectors**: TV-LAYOUT-002
- **Notes**: Uses `DocsLayout` or custom composition of sidebar + content + TOC components.

---

### LAYOUT-003: Responsive Layout

- **Priority**: P0
- **Statement**: The layout MUST be responsive and usable on mobile viewports (320px+).
- **Rationale**: Documentation must be accessible on all devices.
- **Acceptance Criteria**:
  - Sidebar collapses to a hamburger menu on mobile
  - TOC is hidden on screens < 1024px
  - Content area takes full width on mobile
  - TopBar remains accessible on all viewports
- **Test Vectors**: TV-LAYOUT-003
- **Notes**: None.

---

### LAYOUT-004: Landing Page

- **Priority**: P1
- **Statement**: The site SHOULD have a landing page at `/` with a hero section, tagline, and quick links to key sections.
- **Rationale**: First impression and quick orientation for new visitors.
- **Acceptance Criteria**:
  - `/` renders a page distinct from the docs layout
  - Hero includes the docsfn name and a one-line description
  - Quick links to: Getting Started, Core Concepts, API Reference, Blog
  - Links are functional
- **Test Vectors**: TV-LAYOUT-004
- **Notes**: Simple and clean; does not need to be elaborate.

---

### CONTENT-001: Getting Started

- **Priority**: P0
- **Statement**: The docs MUST include a "Getting Started" section covering installation, quick start, and project structure.
- **Rationale**: Essential onboarding content for new users.
- **Acceptance Criteria**:
  - `content/docs/getting-started/index.md` exists
  - Covers: installing docsfn packages, creating a minimal config, adding first content, running dev server
  - Covers: project directory structure explanation
  - Code examples are copy-pasteable and correct
- **Test Vectors**: TV-CONTENT-001
- **Notes**: Should cover both SvelteKit and Next.js setup paths.

---

### CONTENT-002: Configuration

- **Priority**: P0
- **Statement**: The docs MUST include a comprehensive configuration reference covering every field in `DocsConfig`.
- **Rationale**: Configuration is the primary interface for docsfn users.
- **Acceptance Criteria**:
  - Documents every top-level config section: site, compat, versions, content, navigation, search, auth, analytics
  - Each field has: type, default value, description, example
  - Config file naming conventions documented (docsfn.config.ts/mjs/js)
  - Schema version explained
- **Test Vectors**: TV-CONTENT-002
- **Notes**: Must be exhaustive — this is the most-referenced page.

---

### CONTENT-003: Content Format

- **Priority**: P0
- **Statement**: The docs MUST explain the native content format: markdown syntax, frontmatter fields, and meta.json structure.
- **Rationale**: Users need to know how to write content.
- **Acceptance Criteria**:
  - Markdown features documented: headings, code blocks, callouts, mermaid, tabs
  - Frontmatter fields documented: title, description, draft, tags, date, author, version
  - meta.json structure documented: title, pages array, root flag, key/label/icon/hidden
  - File naming conventions: .md extension, index.md for section roots
  - Directory structure → URL mapping rules explained
- **Test Vectors**: TV-CONTENT-003
- **Notes**: None.

---

### CONTENT-004: Sidebars

- **Priority**: P0
- **Statement**: The docs MUST comprehensively document sidebar configuration, auto-generation, customization, and meta.json ordering.
- **Rationale**: Sidebar is the primary navigation; users need full control over it.
- **Acceptance Criteria**:
  - Auto-build behavior explained (from directory structure)
  - meta.json ordering: pages array, string vs object entries
  - Custom sidebar definitions: include globs, title, root flag
  - Multiple sidebars: defining and switching between them
  - Collapsible groups: default state, nesting
  - Hidden pages: `hidden: true` in meta.json
  - Link types: link, group, separator
  - Sidebar resolution: how route → sidebar mapping works
- **Test Vectors**: TV-CONTENT-004
- **Notes**: Include visual examples or diagrams where helpful.

---

### CONTENT-005: Navigation

- **Priority**: P0
- **Statement**: The docs MUST document topNav configuration, breadcrumbs, pagination, and active state behavior.
- **Rationale**: Navigation customization is a common need.
- **Acceptance Criteria**:
  - topNav: items structure (label, href, external, children/dropdowns)
  - Breadcrumb generation rules
  - Pagination: prev/next derivation from sidebar, frontmatter overrides
  - Active page detection in sidebar
- **Test Vectors**: TV-CONTENT-005
- **Notes**: None.

---

### CONTENT-006: Search

- **Priority**: P0
- **Statement**: The docs MUST document search setup, scopes, body indexing modes, and artifact serving.
- **Rationale**: Search is a key feature that requires configuration.
- **Acceptance Criteria**:
  - Enabling/disabling search
  - Search scopes: docs, api, blog
  - Body indexing modes: full, summary, disabled (with trade-offs)
  - Max artifact bytes configuration
  - How to serve the search artifact in SvelteKit
  - DocsSearch component usage and keyboard shortcuts
- **Test Vectors**: TV-CONTENT-006
- **Notes**: None.

---

### CONTENT-007: SEO

- **Priority**: P0
- **Statement**: The docs MUST document SEO-related configuration: title, description, canonical URLs, basePath, edit links, and page metadata.
- **Rationale**: SEO is critical for documentation discoverability.
- **Acceptance Criteria**:
  - site.title and site.description usage
  - site.canonicalUrl and how canonical paths are computed
  - site.basePath behavior
  - Edit link pattern and template variables
  - Per-page title/description from frontmatter
  - How to generate meta tags in SvelteKit
- **Test Vectors**: TV-CONTENT-007
- **Notes**: None.

---

### CONTENT-008: Theming

- **Priority**: P0
- **Statement**: The docs MUST document theming via CSS custom properties, Tailwind configuration, and color/font customization.
- **Rationale**: Users need to customize the visual appearance.
- **Acceptance Criteria**:
  - CSS custom properties (`--docsfn-*`) documented
  - Theme config structure (colors, fonts, spacing, darkMode)
  - Default light/dark theme presets
  - How to override theme values
  - Tailwind integration guidance
- **Test Vectors**: TV-CONTENT-008
- **Notes**: None.

---

### CONTENT-009: Blog

- **Priority**: P1
- **Statement**: The docs SHOULD document blog setup, frontmatter fields, drafts, tags, archives, and RSS.
- **Rationale**: Blog is an included feature that needs documentation.
- **Acceptance Criteria**:
  - Blog directory setup (content/blog/)
  - Required frontmatter: title, date
  - Optional frontmatter: author, tags, excerpt, summary, draft
  - Draft filtering behavior
  - Tag normalization and tag index pages
  - Archive pagination
  - RSS feed configuration
- **Test Vectors**: TV-CONTENT-009
- **Notes**: None.

---

### CONTENT-010: Versioning

- **Priority**: P1
- **Statement**: The docs SHOULD document versioned documentation support.
- **Rationale**: Important feature for production docs sites.
- **Acceptance Criteria**:
  - Versioning modes: none, path-prefix, path-segment
  - Version definition: slug, label, default
  - URL generation for versioned pages
  - VersionSwitcher component usage
  - Version detection from frontmatter or path
- **Test Vectors**: TV-CONTENT-010
- **Notes**: None.

---

### CONTENT-011: OpenAPI

- **Priority**: P1
- **Statement**: The docs SHOULD document OpenAPI reference generation.
- **Rationale**: API docs from OpenAPI specs is a key feature.
- **Acceptance Criteria**:
  - Supported spec formats (JSON, YAML)
  - Auto-generated routes: overview, tag groups, operations, schemas
  - How to add an OpenAPI spec to the api collection
  - Route structure documentation
- **Test Vectors**: TV-CONTENT-011
- **Notes**: None.

---

### CONTENT-012: Security

- **Priority**: P1
- **Statement**: The docs SHOULD document security features.
- **Rationale**: Users running private docs need to understand auth and sanitization.
- **Acceptance Criteria**:
  - HTML sanitization: blocked tags, blocked patterns
  - Auth modes: public, private, mixed
  - Route-level access control (frontmatter.private, /private/* pattern)
  - Sensitive data redaction in diagnostics/analytics
  - DOCSFN_HTML_UNSAFE_ALLOWLIST env var
- **Test Vectors**: TV-CONTENT-012
- **Notes**: None.

---

### CONTENT-013: Analytics

- **Priority**: P1
- **Statement**: The docs SHOULD document analytics configuration.
- **Rationale**: Feature documentation completeness.
- **Acceptance Criteria**:
  - Event types: pageview, search, search_result_click, external_click
  - DNT respect
  - Provider configuration (watchfn)
  - URL sanitization behavior
- **Test Vectors**: TV-CONTENT-013
- **Notes**: None.

---

### CONTENT-014: RSS

- **Priority**: P1
- **Statement**: The docs SHOULD document RSS feed generation.
- **Rationale**: Feature documentation completeness.
- **Acceptance Criteria**:
  - RSS 2.0 format
  - Auto-generation from blog posts
  - Feed URL configuration
  - Atom link support
- **Test Vectors**: TV-CONTENT-014
- **Notes**: None.

---

### CONTENT-015: CLI

- **Priority**: P0
- **Statement**: The docs MUST document the docsfn CLI commands.
- **Rationale**: CLI is the primary build tool.
- **Acceptance Criteria**:
  - `docsfn validate`: purpose, options (--root, --config), exit codes
  - `docsfn build`: purpose, options (--root, --config, --out, --out-dir), output files
  - `docsfn dev`: purpose, options, watch behavior, rebuild triggers
  - Output artifacts: manifest.json, search.json, diagnostics.json, compat-report.json
- **Test Vectors**: TV-CONTENT-015
- **Notes**: None.

---

### CONTENT-016: Content Provider

- **Priority**: P0
- **Statement**: The docs MUST document the content provider interface and FsContentProvider.
- **Rationale**: Users may need custom providers; need to understand the FS provider.
- **Acceptance Criteria**:
  - DocsContentProvider interface: listEntries, loadEntry, loadAsset, watch
  - FsContentProvider: constructor options, collection directories, glob patterns
  - Collection types: docs, pages, blog, api, assets
  - How to create a custom provider
- **Test Vectors**: TV-CONTENT-016
- **Notes**: None.

---

### CONTENT-017: Markdown Extensions

- **Priority**: P1
- **Statement**: The docs SHOULD document markdown extensions supported by docsfn.
- **Rationale**: Users need to know what's available beyond standard markdown.
- **Acceptance Criteria**:
  - Callouts: `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, `> [!INFO]`, `> [!CAUTION]`
  - Mermaid diagrams: fenced code blocks with `mermaid` language
  - Tabs: `<Tabs><Tab>` syntax
  - Code blocks: language highlighting, line numbers
  - Component blocks: `<ComponentName>` syntax
- **Test Vectors**: TV-CONTENT-017
- **Notes**: None.

---

### CONTENT-018: Diagnostics

- **Priority**: P1
- **Statement**: The docs SHOULD document the diagnostics system and all error codes.
- **Rationale**: Troubleshooting aid for users.
- **Acceptance Criteria**:
  - All 17 error codes documented with descriptions
  - Severity levels: error, warning, info
  - How to read diagnostics.json
  - Common error scenarios and resolutions
- **Test Vectors**: TV-CONTENT-018
- **Notes**: None.

---

### CONTENT-019: SvelteKit Integration Guide

- **Priority**: P0
- **Statement**: The docs MUST include a complete SvelteKit integration guide.
- **Rationale**: SvelteKit is one of the two primary frameworks; this site itself is the proof.
- **Acceptance Criteria**:
  - Step-by-step: new SvelteKit project → install packages → config → layout → routes → components
  - Route file templates: +layout.server.ts, +page.ts, +page.svelte for docs, blog, embedded
  - Component usage examples for all @docsfn/svelte components
  - Search wiring
  - Static generation / prerendering guidance
- **Test Vectors**: TV-CONTENT-019
- **Notes**: This is the most important guide since the site itself uses SvelteKit.

---

### CONTENT-020: Next.js Integration Guide

- **Priority**: P1
- **Statement**: The docs SHOULD include a Next.js App Router integration guide.
- **Rationale**: Next.js is the other primary framework supported.
- **Acceptance Criteria**:
  - Step-by-step: new Next.js project → install packages → config → layout → pages → components
  - @docsfn/next API usage: generateStaticParams, resolveDocsRouteData, resolveDocsPageSurface, generatePageMetadata
  - @docsfn/react component usage
  - Search wiring
- **Test Vectors**: TV-CONTENT-020
- **Notes**: None.

---

### CONTENT-021: Customizing Components

- **Priority**: P1
- **Statement**: The docs SHOULD include guidance on overriding/customizing default components.
- **Rationale**: Users will want to extend the default UI.
- **Acceptance Criteria**:
  - How to pass custom components to DocsContent
  - Overriding sidebar, breadcrumb, pagination rendering
  - Custom TopBar composition
  - Adding custom CSS to components
- **Test Vectors**: TV-CONTENT-021
- **Notes**: None.

---

### API-001: @docsfn/core API Reference

- **Priority**: P0
- **Statement**: The API Reference MUST document all public exports from `@docsfn/core`.
- **Rationale**: Core is the foundation package.
- **Acceptance Criteria**:
  - Every exported function: signature, parameters, return type, description
  - Every exported type/interface: all fields with types and descriptions
  - Organized by module: config, manifest, search, navigation, routing, blog, markdown, security, analytics, rss, openapi, diagnostics, theme, helpers
  - Error codes and their meanings
- **Test Vectors**: TV-API-001
- **Notes**: This is the largest API reference section.

---

### API-002: @docsfn/sveltekit API Reference

- **Priority**: P0
- **Statement**: The API Reference MUST document all public exports from `@docsfn/sveltekit`.
- **Rationale**: Primary framework integration for this site.
- **Acceptance Criteria**:
  - Route resolution functions: resolveDocsRouteData, resolveDocsRouteDataOrThrow
  - Type-safe getters: getPageData, getApiData, getPostData (+ throwing variants)
  - Static params: generateStaticParams, generateVersionedStaticParams
  - Surface resolution: resolveDocsPageSurface
  - Load creators: createPageLoad, createVersionedPageLoad, createPostLoad, createApiLoad
  - Search: createSearchArtifactResponse
  - All types: DocsRouteEntry, SvelteDocsPageSurface
- **Test Vectors**: TV-API-002
- **Notes**: None.

---

### API-003: @docsfn/svelte API Reference

- **Priority**: P0
- **Statement**: The API Reference MUST document all Svelte components from `@docsfn/svelte`.
- **Rationale**: Component library is the UI layer.
- **Acceptance Criteria**:
  - Each component: description, props (name, type, required, default), slots, events
  - Components: DocsLayout, DocsContent, DocsSidebar, SidebarGroup, DocsToc, DocsSearch, TopBar, Pagination, Breadcrumbs, VersionSwitcher, EmbeddedPage
  - Usage examples for each component
- **Test Vectors**: TV-API-003
- **Notes**: None.

---

### API-004: @docsfn/provider-fs API Reference

- **Priority**: P0
- **Statement**: The API Reference MUST document `@docsfn/provider-fs`.
- **Rationale**: Default content provider.
- **Acceptance Criteria**:
  - FsContentProvider class: constructor options, methods
  - Collection directory mapping
  - Supported file types (.md, .mdx, .json, .yaml, .yml)
  - Watch mode integration
- **Test Vectors**: TV-API-004
- **Notes**: None.

---

### API-005: @docsfn/cli API Reference

- **Priority**: P0
- **Statement**: The API Reference MUST document `@docsfn/cli`.
- **Rationale**: Build toolchain documentation.
- **Acceptance Criteria**:
  - Each command: usage, options, exit codes
  - Output file descriptions
  - Pipeline overview
- **Test Vectors**: TV-API-005
- **Notes**: May overlap with CONTENT-015; API-005 is the terse reference, CONTENT-015 is the guide.

---

### API-006: @docsfn/next API Reference

- **Priority**: P1
- **Statement**: The API Reference SHOULD document `@docsfn/next`.
- **Rationale**: Completeness for the Next.js framework integration.
- **Acceptance Criteria**:
  - All exported functions with signatures and descriptions
  - generateStaticParams, resolveDocsRouteData, resolveDocsPageSurface, generatePageMetadata, createSearchArtifactResponse
- **Test Vectors**: TV-API-006
- **Notes**: None.

---

### API-007: @docsfn/react API Reference

- **Priority**: P1
- **Statement**: The API Reference SHOULD document `@docsfn/react`.
- **Rationale**: Completeness for the React component library.
- **Acceptance Criteria**:
  - Each component: description, props, usage examples
  - DocsLayout, DocsSidebar, Breadcrumbs, DocsContent, DocsToc, Pagination, DocsSearch, ApiReferenceRenderer, BlogList, VersionSwitcher, ThemeProvider, TopBar, EmbeddedPage
- **Test Vectors**: TV-API-007
- **Notes**: None.

---

### SEARCH-001: Search Enabled

- **Priority**: P0
- **Statement**: Search MUST be enabled with scopes: docs, api, blog.
- **Rationale**: User requirement.
- **Acceptance Criteria**:
  - `search.enabled: true` in config
  - `search.scopes: ["docs", "api", "blog"]` in config
  - All three scopes are searchable
- **Test Vectors**: TV-SEARCH-001
- **Notes**: None.

---

### SEARCH-002: Search Artifact Endpoint

- **Priority**: P0
- **Statement**: The site MUST serve the search artifact as JSON.
- **Rationale**: Client-side search requires loading the artifact.
- **Acceptance Criteria**:
  - A SvelteKit endpoint (e.g., `/search.json/+server.ts`) returns the artifact
  - Response has `Content-Type: application/json`
  - Response includes cache headers
- **Test Vectors**: TV-SEARCH-002
- **Notes**: Uses `createSearchArtifactResponse()` from @docsfn/sveltekit.

---

### SEARCH-003: Search Component

- **Priority**: P0
- **Statement**: The site MUST include the `DocsSearch` component with Cmd/Ctrl+K keyboard shortcut.
- **Rationale**: Standard search UX.
- **Acceptance Criteria**:
  - DocsSearch component is rendered in the layout
  - Cmd/Ctrl+K opens the search dialog
  - Arrow keys navigate results, Enter selects
  - Escape closes the dialog
- **Test Vectors**: TV-SEARCH-003
- **Notes**: None.

---

### SEARCH-004: Search Results

- **Priority**: P0
- **Statement**: Search results MUST display the result kind, title, summary, and path.
- **Rationale**: Users need to identify and select relevant results.
- **Acceptance Criteria**:
  - Each result shows: kind emoji/icon, title, summary text, navigation path
  - Results are grouped/filterable by scope
  - Clicking a result navigates to the page
- **Test Vectors**: TV-SEARCH-004
- **Notes**: None.

---

### BLOG-001: Blog Listing

- **Priority**: P1
- **Statement**: The site SHOULD have a blog listing page at `/blog`.
- **Rationale**: User requirement.
- **Acceptance Criteria**:
  - `/blog` route exists and renders blog post list
  - Posts shown in reverse chronological order
  - Each post shows: title, date, excerpt/summary
  - Draft posts are excluded
- **Test Vectors**: TV-BLOG-001
- **Notes**: None.

---

### BLOG-002: Blog Post Pages

- **Priority**: P1
- **Statement**: Individual blog posts SHOULD be accessible at `/blog/[slug]`.
- **Rationale**: Standard blog routing.
- **Acceptance Criteria**:
  - `/blog/[slug]` renders the post content
  - Post displays: title, date, author, tags, body
  - Non-existent slugs return 404
- **Test Vectors**: TV-BLOG-002
- **Notes**: None.

---

### BLOG-003: Introductory Blog Post

- **Priority**: P1
- **Statement**: The site SHOULD include an initial blog post: "Introducing docsfn".
- **Rationale**: The blog section needs at least one post to be functional.
- **Acceptance Criteria**:
  - `content/blog/introducing-docsfn.md` exists
  - Valid frontmatter with title, date, author, tags
  - Body introduces docsfn's purpose and key features
- **Test Vectors**: TV-BLOG-003
- **Notes**: None.

---

### BLOG-004: RSS Feed

- **Priority**: P2
- **Statement**: The site MAY serve an RSS feed at `/blog/rss.xml`.
- **Rationale**: Nice-to-have for blog subscribers.
- **Acceptance Criteria**:
  - RSS 2.0 compliant XML
  - Contains all non-draft blog posts
  - Each item has title, link, pubDate, description
- **Test Vectors**: TV-BLOG-004
- **Notes**: None.

---

### THEME-001: Visual Consistency

- **Priority**: P0
- **Statement**: The site MUST be visually consistent with other superfunctions docs sites (datafn, searchfn, hostfn) in terms of colors, typography, and spacing.
- **Rationale**: Brand coherence across the monorepo.
- **Acceptance Criteria**:
  - Uses the same primary color palette
  - Same font families (or system fonts matching the convention)
  - Similar layout proportions (max-width ~1600px)
  - Footer with "Built at 21n.co"
- **Test Vectors**: TV-THEME-001
- **Notes**: Since `@superfunctions/docs-theme` is React/fumadocs-specific, consistency is achieved via CSS custom properties and Tailwind config.

---

### THEME-002: Tailwind CSS

- **Priority**: P0
- **Statement**: The site MUST use Tailwind CSS 4 for styling.
- **Rationale**: Consistent with the monorepo's frontend stack.
- **Acceptance Criteria**:
  - `tailwindcss` v4 is in dependencies
  - Tailwind is configured and functional
  - Styles compile without errors
- **Test Vectors**: TV-THEME-002
- **Notes**: None.

---

### THEME-003: Dark Mode

- **Priority**: P1
- **Statement**: The site SHOULD support dark mode via `prefers-color-scheme` CSS media query.
- **Rationale**: Standard accessibility feature.
- **Acceptance Criteria**:
  - Light and dark color schemes defined
  - OS preference is respected automatically
  - No explicit toggle (deferred)
- **Test Vectors**: TV-THEME-003
- **Notes**: None.

---

### BUILD-001: Validate Passes

- **Priority**: P0
- **Statement**: `docsfn validate` MUST exit with code 0 and 0 error diagnostics for the docs content.
- **Rationale**: Content correctness gate.
- **Acceptance Criteria**:
  - Running `npx docsfn validate --root docsfn/docs` exits 0
  - diagnostics output contains no entries with severity "error"
- **Test Vectors**: TV-BUILD-001
- **Notes**: None.

---

### BUILD-002: Build Succeeds

- **Priority**: P0
- **Statement**: `docsfn build` MUST produce all output artifacts with 0 errors.
- **Rationale**: Build correctness gate.
- **Acceptance Criteria**:
  - Running `npx docsfn build --root docsfn/docs` exits 0
  - Outputs: manifest.json, search.json, diagnostics.json
  - diagnostics.json contains no entries with severity "error"
- **Test Vectors**: TV-BUILD-002
- **Notes**: None.

---

### BUILD-003: SvelteKit Build

- **Priority**: P0
- **Statement**: `vite build` MUST succeed for the SvelteKit project.
- **Rationale**: The site must be deployable.
- **Acceptance Criteria**:
  - Running `npm run build` in `docsfn/docs/` exits 0
  - No TypeScript errors
  - No build warnings that indicate broken functionality
- **Test Vectors**: TV-BUILD-003
- **Notes**: None.
