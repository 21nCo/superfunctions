# TEST VECTORS: DocsFn Documentation Site

---

## TV-SITE-001: SvelteKit Project Scaffold

**Description**: Verify the project scaffold is correct.

**Input**: Inspect `docsfn/docs/` directory.

**Expected Output**:
```
docsfn/docs/
├── package.json          # name: "@docsfn/docs", deps include @sveltejs/kit ^2.0.0, svelte ^5.0.0
├── svelte.config.js      # adapter-auto, aliases to docsfn source packages
├── vite.config.ts        # sveltekit plugin
├── docsfn.config.ts      # native docsfn config
├── src/
│   ├── app.html          # SvelteKit shell
│   └── routes/           # SvelteKit routes
├── content/
│   ├── docs/             # documentation markdown
│   ├── blog/             # blog posts
│   └── api/              # API reference markdown
└── static/               # static assets
```

**Negative Variant**: `package.json` missing `@sveltejs/kit` → SvelteKit build fails.

---

## TV-SITE-002: Dev Server Port

**Description**: Verify dev server runs on port 6004.

**Input**: `npm run dev` in `docsfn/docs/`

**Expected Output**: Server starts and logs `Local: http://localhost:6004/`

**Negative Variant**: Port 6004 already in use → Vite reports port conflict error.

---

## TV-SITE-003: DocsFn Config

**Description**: Verify the config file is valid and loadable.

**Input**: `npx docsfn validate --root docsfn/docs`

**Expected Output**:
- Exit code 0
- Config loaded with:
  - `schemaVersion: 1`
  - `site.title: "docsfn"`
  - `compat.preset: "none"`
  - `search.enabled: true`
  - `navigation.sidebars` has `docs` and `api` keys
  - `navigation.topNav` has 4+ items

**Negative Variant**: Missing `site.title` → DOCS_CONFIG_INVALID error, exit code 1.

---

## TV-SITE-004: No Fumadocs Dependencies

**Description**: Verify no fumadocs packages are used.

**Input**:
```bash
grep -r "fumadocs" docsfn/docs/package.json
grep -r "from ['\"]fumadocs" docsfn/docs/src/
```

**Expected Output**: Both commands return no matches (exit code 1).

**Negative Variant**: `fumadocs-core` found in package.json → requirement violation.

---

## TV-NAV-001: Top Navigation

**Description**: Verify TopBar renders with all required items.

**Input**: Load any page in browser; inspect TopBar.

**Expected Output**:
- "Docs" link → navigates to `/docs`
- "API Reference" link → navigates to `/docs/api` (or first API page)
- "Blog" link → navigates to `/blog`
- "GitHub" link → opens `https://github.com/21nCo/super-functions/tree/dev/docsfn` in new tab
- Search trigger button is visible

**Negative Variant**: Missing topNav config → TopBar renders with no items.

---

## TV-NAV-002: Docs Sidebar

**Description**: Verify sidebar renders correct navigation tree.

**Input**: Navigate to `/docs/getting-started`.

**Expected Output**:
- Left sidebar is visible
- Contains grouped sections matching content/docs/ directory structure
- "Getting Started" section is present and active
- Clicking a different page navigates correctly
- Groups are collapsible (click group header toggles children)

**Negative Variant**: No content/docs/ directory → empty sidebar.

---

## TV-NAV-003: API Reference Sidebar

**Description**: Verify API sidebar is distinct from docs sidebar.

**Input**: Navigate to an API reference page (e.g., `/docs/api/core`).

**Expected Output**:
- Left sidebar shows API reference navigation (not docs navigation)
- Package groups visible: core, sveltekit, svelte, provider-fs, cli, next, react
- Each group contains sub-pages for that package's API

**Negative Variant**: No `api` sidebar defined → falls back to docs sidebar.

---

## TV-NAV-004: Breadcrumbs

**Description**: Verify breadcrumbs on nested doc pages.

**Input**: Navigate to `/docs/core-concepts/sidebars`.

**Expected Output**:
- Breadcrumb trail: `Docs > Core Concepts > Sidebars`
- "Docs" and "Core Concepts" are clickable links
- "Sidebars" is plain text (current page)

**Negative Variant**: Root page `/docs` → breadcrumb shows only "Docs" (no trail).

---

## TV-NAV-005: Pagination

**Description**: Verify prev/next navigation at page bottom.

**Input**: Navigate to a docs page that is not first or last in sidebar order.

**Expected Output**:
- "Previous" link shows previous page title and navigates correctly
- "Next" link shows next page title and navigates correctly
- Alt+ArrowLeft navigates to previous page
- Alt+ArrowRight navigates to next page

**Negative Variant**: First page in sidebar → no "Previous" link shown. Last page → no "Next" link.

---

## TV-NAV-006: Table of Contents

**Description**: Verify TOC renders from page headings.

**Input**: Navigate to a docs page with multiple h2/h3 headings.

**Expected Output**:
- Right sidebar shows TOC with heading text
- Headings are indented by level (h3 indented more than h2)
- Clicking a TOC item scrolls to the heading
- Active heading is highlighted as you scroll

**Negative Variant**: Page with no headings → TOC is empty or hidden.

---

## TV-LAYOUT-001: Root Layout Data Loading

**Description**: Verify manifest and search artifact load correctly.

**Input**: Start dev server; navigate to any page.

**Expected Output**:
- Page renders without errors
- Sidebar navigation is populated (manifest loaded)
- Search dialog opens and works (search artifact loaded)
- Server logs show no errors during manifest/search build

**Negative Variant**: Invalid config → server error during layout load; error page displayed.

---

## TV-LAYOUT-002: Three-Column Layout

**Description**: Verify the three-column layout on doc pages.

**Input**: Navigate to a docs page on a desktop viewport (1280px+).

**Expected Output**:
- Left column: sidebar (~250px wide)
- Center column: main content (flex-grow)
- Right column: TOC (~200px wide)
- All three columns visible simultaneously

**Negative Variant**: N/A (layout is structural).

---

## TV-LAYOUT-003: Responsive Layout

**Description**: Verify mobile layout.

**Input**: Navigate to a docs page on a 375px wide viewport.

**Expected Output**:
- Sidebar is hidden (accessible via hamburger menu)
- TOC is hidden
- Content area spans full width
- TopBar is visible and functional
- Search is accessible

**Negative Variant**: N/A (layout is structural).

---

## TV-LAYOUT-004: Landing Page

**Description**: Verify the landing page content.

**Input**: Navigate to `/`.

**Expected Output**:
- Page displays "docsfn" title and description
- Quick links to Getting Started, Core Concepts, API Reference, Blog are present
- Links navigate correctly

**Negative Variant**: N/A.

---

## TV-CONTENT-001: Getting Started Content

**Description**: Verify Getting Started section exists and is complete.

**Input**: Navigate to `/docs/getting-started`.

**Expected Output**:
- Page renders with title "Getting Started"
- Contains sections: Installation, Quick Start, Project Structure
- Code examples present for package installation and config setup
- Both SvelteKit and Next.js paths mentioned

**Negative Variant**: Missing `content/docs/getting-started/index.md` → 404.

---

## TV-CONTENT-002: Configuration Content

**Description**: Verify configuration reference is exhaustive.

**Input**: Navigate to `/docs/core-concepts/configuration`.

**Expected Output**:
- All config sections documented: site, compat, versions, content, navigation, search, auth, analytics
- Each field has type, default, description
- Config filename conventions listed

**Negative Variant**: Missing a config field → user cannot configure that feature.

---

## TV-CONTENT-003 through TV-CONTENT-021

**Description**: Each content requirement (CONTENT-003 through CONTENT-021) has a corresponding page that exists, renders, and contains the content described in its acceptance criteria.

**Generic Input**: Navigate to the relevant URL path.

**Generic Expected Output**: Page renders with title, all acceptance-criteria content items present, code examples render correctly.

**Generic Negative Variant**: Missing markdown file → 404 page.

---

## TV-API-001: @docsfn/core API Reference

**Description**: Verify core API reference content.

**Input**: Navigate to `/docs/api/core`.

**Expected Output**:
- Index page with links to sub-sections (config, manifest, search, etc.)
- Each sub-section lists exported functions and types
- Function entries include: signature, parameters, return type, description

**Negative Variant**: Missing `content/api/core/index.md` → 404.

---

## TV-API-002 through TV-API-007

**Description**: Each package API reference section exists and documents all public exports.

**Generic Input**: Navigate to `/docs/api/{package-name}`.

**Generic Expected Output**: Package overview page with sub-pages for major exports; all public APIs documented.

**Generic Negative Variant**: Missing content directory → 404.

---

## TV-SEARCH-001: Search Enabled

**Description**: Verify search works across all scopes.

**Input**: Open search dialog (Cmd/Ctrl+K); type "config".

**Expected Output**:
- Search results appear from docs scope (configuration page)
- Results may also appear from api scope (config module)
- Scope filter allows filtering to "docs", "api", or "blog"

**Negative Variant**: `search.enabled: false` in config → DocsSearch component does not render.

---

## TV-SEARCH-002: Search Artifact Endpoint

**Description**: Verify the search JSON endpoint.

**Input**: `curl http://localhost:6004/search.json`

**Expected Output**:
```json
{
  "schemaVersion": 1,
  "engine": "searchfn",
  "fields": ["title", "summary", "headings", "tags", "body"],
  "scopes": ["docs", "api", "blog"],
  "documents": [...],
  "snapshot": {...},
  "bytes": <number>
}
```
- `Content-Type: application/json`
- HTTP 200

**Negative Variant**: Invalid search config → DOCS_SEARCH_BUILD_FAILED diagnostic.

---

## TV-SEARCH-003: Search Keyboard Shortcut

**Description**: Verify Cmd/Ctrl+K opens search.

**Input**: Press Cmd+K (macOS) or Ctrl+K (other) on any page.

**Expected Output**:
- Search dialog opens
- Input is focused
- Typing shows results
- Escape closes dialog

**Negative Variant**: N/A.

---

## TV-SEARCH-004: Search Result Display

**Description**: Verify search result items.

**Input**: Search for a known term.

**Expected Output**: Each result shows:
- Kind indicator (page/api/post)
- Title text
- Summary/excerpt
- Navigation path
- Clicking navigates to the page

**Negative Variant**: No results for term → "No results found" message.

---

## TV-BLOG-001: Blog Listing

**Description**: Verify blog listing page.

**Input**: Navigate to `/blog`.

**Expected Output**:
- Page displays blog post list
- At least one post ("Introducing docsfn")
- Posts show title, date, excerpt
- Reverse chronological order

**Negative Variant**: No blog posts → empty listing with message.

---

## TV-BLOG-002: Blog Post Page

**Description**: Verify individual blog post rendering.

**Input**: Navigate to `/blog/introducing-docsfn`.

**Expected Output**:
- Title: "Introducing docsfn"
- Date displayed
- Author displayed
- Body content rendered as markdown

**Negative Variant**: Navigate to `/blog/nonexistent` → 404.

---

## TV-BLOG-003: Introductory Post

**Description**: Verify the initial blog post exists with valid frontmatter.

**Input**: Read `docsfn/docs/content/blog/introducing-docsfn.md`.

**Expected Output**:
```yaml
---
title: Introducing docsfn
date: 2026-03-22
author: 21n
tags: [release, announcement]
---
```
- Body text introduces docsfn

**Negative Variant**: Missing date → blog processing error.

---

## TV-BLOG-004: RSS Feed

**Description**: Verify RSS feed.

**Input**: `curl http://localhost:6004/blog/rss.xml`

**Expected Output**:
- Valid RSS 2.0 XML
- Contains `<channel>` with `<title>` and `<link>`
- Contains `<item>` for each non-draft post
- HTTP 200, Content-Type includes `xml`

**Negative Variant**: No blog posts → RSS feed with empty channel.

---

## TV-THEME-001: Visual Consistency

**Description**: Verify visual parity with other docs sites.

**Input**: Compare docsfn docs site visually with datafn docs site.

**Expected Output**:
- Similar color scheme
- Similar typography
- Similar layout proportions
- Footer includes "Built at 21n.co"

**Negative Variant**: N/A (visual check).

---

## TV-THEME-002: Tailwind CSS

**Description**: Verify Tailwind is configured.

**Input**: Check `package.json` for tailwindcss; inspect rendered page styles.

**Expected Output**:
- `tailwindcss` v4 in dependencies
- Utility classes are applied and functional in rendered pages

**Negative Variant**: Missing tailwindcss → unstyled pages.

---

## TV-THEME-003: Dark Mode

**Description**: Verify dark mode via system preference.

**Input**: Set OS to dark mode; load the site.

**Expected Output**:
- Background switches to dark color
- Text switches to light color
- All components adapt to dark scheme

**Negative Variant**: No prefers-color-scheme styles → no dark mode.

---

## TV-BUILD-001: Validate Passes

**Description**: Verify docsfn validate exits clean.

**Input**: `npx docsfn validate --root docsfn/docs`

**Expected Output**:
- Exit code 0
- Output indicates no errors

**Negative Variant**: Broken meta.json → DOCS_META_INVALID error, exit code 1.

---

## TV-BUILD-002: Build Succeeds

**Description**: Verify docsfn build produces artifacts.

**Input**: `npx docsfn build --root docsfn/docs --out-dir .docsfn`

**Expected Output**:
- Exit code 0
- Files created: `.docsfn/manifest.json`, `.docsfn/search.json`, `.docsfn/diagnostics.json`
- diagnostics.json: no entries with `"severity": "error"`

**Negative Variant**: Content error → exit code 1, diagnostics.json contains error entries.

---

## TV-BUILD-003: SvelteKit Build

**Description**: Verify the SvelteKit production build.

**Input**: `cd docsfn/docs && npm run build`

**Expected Output**:
- Exit code 0
- Build output in `.svelte-kit/output/` or `build/`
- No TypeScript compilation errors

**Negative Variant**: Type error in route file → build fails with TSC error.
