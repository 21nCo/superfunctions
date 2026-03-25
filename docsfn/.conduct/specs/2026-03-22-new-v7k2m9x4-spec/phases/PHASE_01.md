# PHASE 01: Route Shell + Layout

## Phase Goal

Create the SvelteKit route files and root layout that loads the docsfn manifest and search artifact, providing the foundational page structure for all routes.

## In Scope

- Root layout server load (manifest + search)
- Root layout Svelte component (TopBar + slot)
- Docs dynamic route ([...slug]) with page.ts and page.svelte
- Blog listing route
- Blog post route ([slug])
- Search JSON endpoint
- RSS XML endpoint (placeholder)
- Landing page

## Out of Scope

- Full content (Phases 2-8)
- Search component wiring (Phase 9)
- Visual polish (Phase 10)

## Deliverables

| File | Description |
|---|---|
| `src/routes/+layout.server.ts` | Loads config via loadDocsConfig, creates FsContentProvider, builds manifest + search artifact, returns DocsSiteSource |
| `src/routes/+layout.svelte` | Renders TopBar with nav items, provides slot for child routes |
| `src/routes/+page.svelte` | Landing page with hero, tagline, quick links |
| `src/routes/docs/[...slug]/+page.ts` | Uses resolveDocsRouteDataOrThrow + resolveDocsPageSurface to build page data |
| `src/routes/docs/[...slug]/+page.svelte` | Three-column layout: DocsSidebar + DocsContent + DocsToc, with Breadcrumbs + Pagination |
| `src/routes/blog/+page.ts` | Loads blog post list from manifest |
| `src/routes/blog/+page.svelte` | Blog listing page |
| `src/routes/blog/[slug]/+page.ts` | Resolves blog post from manifest |
| `src/routes/blog/[slug]/+page.svelte` | Blog post page |
| `src/routes/search.json/+server.ts` | Returns search artifact JSON via createSearchArtifactResponse |
| `src/routes/blog/rss.xml/+server.ts` | Placeholder RSS endpoint |

## Requirements Covered

- LAYOUT-001, LAYOUT-002, LAYOUT-003, LAYOUT-004, NAV-001, NAV-002, NAV-003, NAV-004, NAV-005, NAV-006

## Implementation Tasks

1. Create `src/routes/+layout.server.ts`:
   - Import loadDocsConfig, buildManifest, buildSearchIndex from @docsfn/core
   - Import FsContentProvider from @docsfn/provider-fs
   - Load config with cwd pointing to docsfn/docs content root
   - Build manifest and search artifact
   - Cache with singleton promise pattern
   - Export load function returning: manifest, searchArtifact, siteTitle, canonicalUrl, compatPreset
2. Create `src/routes/+layout.svelte`:
   - Import TopBar from @docsfn/svelte
   - Render TopBar with topNav items from layout data
   - Include search trigger in TopBar
   - Render `<slot />` for child content
   - Add footer with "Built at 21n.co"
3. Create `src/routes/+page.svelte`:
   - Hero section with "docsfn" title and description
   - Quick link cards: Getting Started, Core Concepts, API Reference, Blog
   - Clean layout without sidebar
4. Create `src/routes/docs/[...slug]/+page.ts`:
   - Get params.slug from URL
   - Call resolveDocsRouteDataOrThrow with slug and manifest
   - Call resolveDocsPageSurface with route entry, manifest, config
   - Return: routeEntry, surface, sidebar links, search metadata
5. Create `src/routes/docs/[...slug]/+page.svelte`:
   - Three-column layout using @docsfn/svelte components
   - Left: DocsSidebar with correct sidebar (docs or api based on route)
   - Center: Breadcrumbs + DocsContent + Pagination
   - Right: DocsToc
   - Mobile: sidebar behind hamburger, TOC hidden
6. Create `src/routes/blog/+page.ts`:
   - Extract posts from manifest, filter drafts, sort by date desc
7. Create `src/routes/blog/+page.svelte`:
   - List posts with title, date, excerpt
   - Link each post to /blog/[slug]
8. Create `src/routes/blog/[slug]/+page.ts`:
   - Find post by slug in manifest.posts
   - Throw error if not found
9. Create `src/routes/blog/[slug]/+page.svelte`:
   - Render post: title, date, author, tags, body content
10. Create `src/routes/search.json/+server.ts`:
    - Import createSearchArtifactResponse from @docsfn/sveltekit
    - GET handler returns the artifact JSON
11. Create `src/routes/blog/rss.xml/+server.ts`:
    - Import buildRssFeed from @docsfn/core (or manual RSS generation)
    - GET handler returns RSS XML with correct Content-Type

## Verification Steps

1. `cd docsfn/docs && npm run dev` → server starts on port 6004
2. Navigate to `http://localhost:6004/` → landing page renders with hero and links
3. Navigate to `http://localhost:6004/docs` → docs page renders with sidebar and content
4. Navigate to `http://localhost:6004/blog` → blog listing renders (empty or with placeholder)
5. `curl http://localhost:6004/search.json` → returns JSON with schemaVersion: 1
6. TopBar shows Docs, API Reference, Blog, GitHub links
7. No console errors in browser or server

## Stop Condition

Report: all routes render without errors, TopBar navigation works, three-column layout visible on desktop, sidebar collapses on mobile. Ready for content in Phases 2+.
