# PHASE 03: Core Content — Sidebars, Navigation, Search, SEO, Theming, CLI, Provider

## Phase Goal

Write the P0 core concept documentation pages covering sidebars, navigation, search, SEO, theming, CLI, and content providers.

## In Scope

- content/docs/core-concepts/sidebars.md
- content/docs/core-concepts/navigation.md
- content/docs/core-concepts/search.md
- content/docs/core-concepts/seo.md
- content/docs/core-concepts/theming.md
- content/docs/core-concepts/cli.md
- content/docs/core-concepts/content-providers.md
- Updated meta.json

## Out of Scope

- P1 concept pages (Phase 4)
- API reference (Phase 6, 7)

## Deliverables

| File | Description |
|---|---|
| `content/docs/core-concepts/sidebars.md` | Comprehensive sidebar documentation |
| `content/docs/core-concepts/navigation.md` | TopNav, breadcrumbs, pagination, active states |
| `content/docs/core-concepts/search.md` | Search setup, scopes, body indexing, artifact serving |
| `content/docs/core-concepts/seo.md` | SEO config, canonical URLs, metadata |
| `content/docs/core-concepts/theming.md` | CSS custom properties, Tailwind, colors, fonts, dark mode |
| `content/docs/core-concepts/cli.md` | CLI commands: validate, build, dev |
| `content/docs/core-concepts/content-providers.md` | FsContentProvider, custom providers |
| `content/docs/core-concepts/meta.json` | Updated with all new pages |

## Requirements Covered

- CONTENT-004, CONTENT-005, CONTENT-006, CONTENT-007, CONTENT-008, CONTENT-015, CONTENT-016

## Implementation Tasks

1. Create `content/docs/core-concepts/sidebars.md`:
   - Title: "Sidebars"
   - Auto-build behavior from directory structure
   - meta.json ordering: pages array, string shorthand vs {key, label, icon, hidden} objects
   - Custom sidebar definitions in config: include globs, title, root flag
   - Multiple sidebars: defining separate sidebars (e.g., docs vs api)
   - Switching between sidebars based on route
   - Collapsible groups: default state, nesting levels
   - Hidden pages: hidden: true in meta.json
   - Sidebar item types: link, group, separator
   - Sidebar resolution: how a route maps to its sidebar
   - Examples with meta.json snippets and resulting sidebar screenshots/descriptions

2. Create `content/docs/core-concepts/navigation.md`:
   - Title: "Navigation"
   - topNav configuration: items array with label, href, external, children (dropdowns)
   - Breadcrumb generation: rules for trail construction from sidebar hierarchy
   - Pagination: prev/next derivation from sidebar order
   - Frontmatter overrides for prev/next
   - Active page detection in sidebar
   - Keyboard shortcuts: Alt+Arrow for pagination

3. Create `content/docs/core-concepts/search.md`:
   - Title: "Search"
   - Enabling search: config.search.enabled
   - Search scopes: docs, api, blog
   - Body indexing modes: full (indexes entire body), summary (first 220 chars), disabled
   - Trade-offs: artifact size vs search quality
   - maxArtifactBytes configuration
   - Serving the search artifact in SvelteKit (createSearchArtifactResponse)
   - DocsSearch component usage: placement, keyboard shortcut (Cmd/Ctrl+K)
   - Scope filtering in search dialog
   - How searchfn scoring works (brief)

4. Create `content/docs/core-concepts/seo.md`:
   - Title: "SEO"
   - site.title and site.description: where they appear
   - site.canonicalUrl: how canonical paths are computed
   - site.basePath: URL prefix behavior
   - Per-page title/description from frontmatter
   - Edit link pattern: template variables ({path})
   - Generating meta tags in SvelteKit (using resolveDocsPageSurface)
   - Open Graph / social sharing considerations

5. Create `content/docs/core-concepts/theming.md`:
   - Title: "Theming"
   - CSS custom properties (--docsfn-*): full list from theme.ts
   - Theme config structure: colors (primary, secondary, background, foreground, muted, accent, destructive, border), fonts (sans, mono), spacing (container, section), darkMode
   - Default presets: defaultLightTheme, defaultDarkTheme
   - Overriding theme values in CSS
   - Tailwind integration: extending tailwind config with docsfn tokens
   - Dark mode: prefers-color-scheme, class-based, or disabled

6. Create `content/docs/core-concepts/cli.md`:
   - Title: "CLI"
   - Installation: npx docsfn or global install
   - `docsfn validate [root]`: validates config and content; options (--root, --config); exit codes (0=ok, 1=errors); output format
   - `docsfn build [root]`: builds artifacts; options (--root, --config, --out, --out-dir default .docsfn); output files (manifest.json, search.json, diagnostics.json, compat-report.json); reports artifact sizes
   - `docsfn dev [root]`: watch mode; options same as build; file watching behavior; rebuild triggers; output directory exclusion
   - Pipeline overview: config load → manifest build → search build → diagnostics

7. Create `content/docs/core-concepts/content-providers.md`:
   - Title: "Content Providers"
   - DocsContentProvider interface: listEntries, loadEntry, loadAsset, watch
   - FsContentProvider: constructor options ({root}), collection directory mapping (docs→content/docs, pages→pages, blog→blog, api→api, assets→public)
   - Supported file types: .md, .mdx, .json, .yaml, .yml
   - How entries are discovered (glob patterns)
   - Watch mode integration
   - Building a custom provider: interface contract, example skeleton

8. Update `content/docs/core-concepts/meta.json`:
   ```json
   {
     "title": "Core Concepts",
     "pages": ["index", "configuration", "content-format", "sidebars", "navigation", "search", "seo", "theming", "cli", "content-providers"]
   }
   ```

## Verification Steps

1. All 7 new pages render at their respective URLs
2. Sidebar shows all core concept pages in correct order
3. Each page contains all content described in acceptance criteria
4. Code examples render with syntax highlighting
5. No broken links between pages

## Stop Condition

Report: all 7 P0 core concept pages created, sidebar navigation updated, all pages render correctly. Ready for P1 concepts in Phase 4.
