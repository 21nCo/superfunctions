# PHASE 06: API Reference — core, sveltekit, svelte, provider-fs, cli

## Phase Goal

Write the P0 API reference documentation for the 5 primary docsfn packages.

## In Scope

- content/api/core/ (with sub-pages per module)
- content/api/sveltekit/
- content/api/svelte/
- content/api/provider-fs/
- content/api/cli/
- API sidebar navigation via meta.json files

## Out of Scope

- @docsfn/next and @docsfn/react API reference (Phase 7)
- Conceptual documentation (Phases 2-5)

## Deliverables

| File | Description |
|---|---|
| `content/api/index.md` | API Reference overview listing all packages |
| `content/api/meta.json` | Root API navigation |
| `content/api/core/index.md` | @docsfn/core overview |
| `content/api/core/config.md` | Config functions: loadDocsConfig, validateConfig |
| `content/api/core/manifest.md` | Manifest: buildManifest, DocsManifest type |
| `content/api/core/search.md` | Search: buildSearchIndex, DocsSearchArtifact, DocsSearchDocument |
| `content/api/core/types.md` | Core types: DocPage, BlogPost, ApiReference, DocsConfig, etc. |
| `content/api/core/navigation.md` | Navigation: buildSidebarFromPages, generateBreadcrumbs, etc. |
| `content/api/core/routing.md` | Routing: route building, version context |
| `content/api/core/blog.md` | Blog: buildCanonicalBlogRecords, BlogManifestSurface |
| `content/api/core/markdown.md` | Markdown: CompiledContentBlock types, compilation |
| `content/api/core/security.md` | Security: sanitization, auth helpers |
| `content/api/core/analytics.md` | Analytics: event types, helpers |
| `content/api/core/rss.md` | RSS: buildRssFeed |
| `content/api/core/openapi.md` | OpenAPI: CanonicalOpenApiReference |
| `content/api/core/diagnostics.md` | Diagnostics: DocsError, DocsDiagnostic, error codes |
| `content/api/core/theme.md` | Theme: ThemeConfig, presets |
| `content/api/core/helpers.md` | Helper functions |
| `content/api/core/meta.json` | Core sub-navigation |
| `content/api/sveltekit/index.md` | @docsfn/sveltekit full API |
| `content/api/sveltekit/meta.json` | SvelteKit navigation |
| `content/api/svelte/index.md` | @docsfn/svelte overview |
| `content/api/svelte/components.md` | All 11 Svelte components with props |
| `content/api/svelte/meta.json` | Svelte navigation |
| `content/api/provider-fs/index.md` | @docsfn/provider-fs full API |
| `content/api/provider-fs/meta.json` | Provider-fs navigation |
| `content/api/cli/index.md` | @docsfn/cli command reference |
| `content/api/cli/meta.json` | CLI navigation |

## Requirements Covered

- API-001, API-002, API-003, API-004, API-005

## Implementation Tasks

1. Create `content/api/index.md`:
   - Title: "API Reference"
   - Table listing all 7 packages with descriptions and links

2. Create `content/api/meta.json`:
   ```json
   { "title": "API Reference", "pages": ["index", "core", "sveltekit", "svelte", "provider-fs", "cli", "next", "react"] }
   ```

3. Create `content/api/core/` directory with index.md and sub-pages:
   - `index.md`: Package overview, installation, exports summary
   - `config.md`: loadDocsConfig(options) — params, return type; validateConfig(); DEFAULT_CONFIG_FILENAMES
   - `manifest.md`: buildManifest(provider, config) — full signature; DocsManifest type with all fields
   - `search.md`: buildSearchIndex(manifest, options) — params, return type; DocsSearchArtifact, DocsSearchDocument, DocsSearchScope types
   - `types.md`: All core types: DocPage, BlogPost, ApiReference, DocsSourceEntry, DocHeading, SidebarItem, Sidebar, DocsTopNavItem, DocsConfig (summary linking to config.md), DocsCompatPreset, DocsErrorCode enum
   - `navigation.md`: buildSidebarFromPages(), resolveBreadcrumbsFromSidebar(), resolvePaginationFromSidebar(), resolveSidebarForRoute(), flattenSidebarLinks(), generateBreadcrumbs(), getPaginationFromSidebarWithTitles(), getTopNavigation()
   - `routing.md`: Route building rules, normalizeSlug(), version context resolution
   - `blog.md`: buildCanonicalBlogRecords(), BlogManifestSurface, BlogArchivePage, BlogTagIndex
   - `markdown.md`: CompiledContentBlock union types (heading, paragraph, code, mermaid, tabs, callout, component), CompiledContentArtifact
   - `security.md`: Sanitization functions, auth check helpers, sensitive detection
   - `analytics.md`: DocsAnalyticsEventName, DocsAnalyticsEvent type
   - `rss.md`: RSS generation function
   - `openapi.md`: CanonicalOpenApiReference, operation/schema types
   - `diagnostics.md`: DocsError class, DocsDiagnostic type, all error codes
   - `theme.md`: ThemeConfig, defaultLightTheme, defaultDarkTheme, CSS property generation
   - `helpers.md`: Utility functions
   - `meta.json`: Navigation for all sub-pages

4. Create `content/api/sveltekit/index.md`:
   - All exports documented:
   - Types: DocsRouteEntry (page|api|post variants), SvelteDocsPageSurface
   - Route resolution: resolveDocsRouteData(), resolveDocsRouteDataOrThrow()
   - Type-safe getters: getPageData, getApiData, getPostData + throwing variants
   - Versioned getters: getVersionedPageData, getVersionedPageDataOrThrow
   - Static params: generateStaticParams(), generateVersionedStaticParams()
   - Surface: resolveDocsPageSurface()
   - Load creators: createPageLoad(), createVersionedPageLoad(), createPostLoad(), createApiLoad()
   - Search: createSearchArtifactResponse()
   - Each function: signature, params, return type, example usage

5. Create `content/api/svelte/` with index.md and components.md:
   - `index.md`: Package overview, installation, component list
   - `components.md`: Each of the 11 components:
     - DocsLayout: props (surface, sidebar, headings, activePath), slots
     - DocsContent: props (compiled/source, content, sourcePath, compatPreset, allowUnsafeHtml, components), behavior
     - DocsSidebar: props (surface, sidebar, activePath, defaultCollapsedGroups)
     - SidebarGroup: props (item, activePath, defaultCollapsed, depth)
     - DocsToc: props (headings), IntersectionObserver behavior
     - DocsSearch: props (searchArtifact, loadSearchArtifact, placeholder, initialScope, scopes, analytics), keyboard shortcuts
     - TopBar: props (surface, logo, items, searchTrigger, versionSelector, mobileMenuTrigger)
     - Pagination: props (surface, prevPage, nextPage, sectionContext), keyboard shortcuts
     - Breadcrumbs: props (surface, items, separator)
     - VersionSwitcher: props (surface, versions, currentVersion, onVersionChange)
     - EmbeddedPage: props (title, description, content, headings, compiled, compatPreset, components, showToc, tocLabel)

6. Create `content/api/provider-fs/index.md`:
   - FsContentProvider class: constructor({root})
   - Methods: listEntries(input), loadEntry(input), loadAsset(input), watch()
   - Collection directory mapping table
   - Supported file types
   - DocsContentProvider interface definition

7. Create `content/api/cli/index.md`:
   - Each command: usage syntax, options table, exit codes, output files
   - `docsfn validate [root]` — options: --root, --config
   - `docsfn build [root]` — options: --root, --config, --out, --out-dir
   - `docsfn dev [root]` — options: --root, --config, --out, --out-dir
   - Pipeline internals overview

## Verification Steps

1. All API reference pages render at `/docs/api/*` URLs
2. API sidebar shows all packages with correct sub-pages
3. @docsfn/core has 15 sub-pages all rendering correctly
4. @docsfn/sveltekit documents all exported functions
5. @docsfn/svelte documents all 11 components with props
6. @docsfn/provider-fs documents the full class API
7. @docsfn/cli documents all 3 commands

## Stop Condition

Report: all P0 API reference content created (5 packages), API sidebar fully populated, all pages render correctly. Ready for P1 packages in Phase 7.
