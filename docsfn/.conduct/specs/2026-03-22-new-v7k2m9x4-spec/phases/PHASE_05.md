# PHASE 05: Guides — SvelteKit, Next.js, Customizing Components

## Phase Goal

Write the integration guides for SvelteKit and Next.js, and a guide for customizing components.

## In Scope

- content/docs/guides/sveltekit.md
- content/docs/guides/nextjs.md
- content/docs/guides/customizing-components.md
- Guides meta.json and directory

## Out of Scope

- API reference (Phase 6, 7)
- Blog content (Phase 8)

## Deliverables

| File | Description |
|---|---|
| `content/docs/guides/index.md` | Guides section overview |
| `content/docs/guides/sveltekit.md` | Complete SvelteKit integration walkthrough |
| `content/docs/guides/nextjs.md` | Complete Next.js App Router integration walkthrough |
| `content/docs/guides/customizing-components.md` | Component customization guide |
| `content/docs/guides/meta.json` | Navigation: index, sveltekit, nextjs, customizing-components |

## Requirements Covered

- CONTENT-019, CONTENT-020, CONTENT-021

## Implementation Tasks

1. Create `content/docs/guides/index.md`:
   - Title: "Guides"
   - Overview with links to each guide

2. Create `content/docs/guides/sveltekit.md`:
   - Title: "SvelteKit Integration"
   - Prerequisites: SvelteKit 2, Svelte 5, Node 18+
   - Step 1: Create SvelteKit project
   - Step 2: Install packages (@docsfn/core, @docsfn/sveltekit, @docsfn/svelte, @docsfn/provider-fs)
   - Step 3: Configure svelte.config.js with aliases
   - Step 4: Create docsfn.config.ts
   - Step 5: Create root layout (+layout.server.ts) — load manifest and search
   - Step 6: Create root layout component (+layout.svelte) — TopBar + slot
   - Step 7: Create docs route (+page.ts + +page.svelte) — three-column layout
   - Step 8: Add content (first page + meta.json)
   - Step 9: Wire search (endpoint + DocsSearch component)
   - Step 10: Add blog routes
   - Step 11: Prerendering / static generation
   - Complete code for each route file
   - All @docsfn/svelte components used with examples

3. Create `content/docs/guides/nextjs.md`:
   - Title: "Next.js Integration"
   - Prerequisites: Next.js 15, React 19, Node 18+
   - Step 1: Create Next.js project (App Router)
   - Step 2: Install packages (@docsfn/core, @docsfn/next, @docsfn/react, @docsfn/provider-fs)
   - Step 3: Create docsfn.config.ts
   - Step 4: Create root layout
   - Step 5: Create docs pages ([...slug]/page.tsx) — generateStaticParams, resolveDocsRouteData, resolveDocsPageSurface
   - Step 6: Wire search
   - Step 7: Add blog routes
   - Complete code for each file
   - All @docsfn/next helpers used with examples
   - All @docsfn/react components used with examples

4. Create `content/docs/guides/customizing-components.md`:
   - Title: "Customizing Components"
   - Passing custom components to DocsContent (components prop)
   - Overriding sidebar rendering: custom SidebarGroup, custom item rendering
   - Custom TopBar composition: using TopBar props (logo, items, searchTrigger)
   - Custom breadcrumb separator
   - Custom pagination layout
   - Adding custom CSS: targeting docsfn component class names
   - Creating wrapper components

5. Create `content/docs/guides/meta.json`:
   ```json
   { "title": "Guides", "pages": ["index", "sveltekit", "nextjs", "customizing-components"] }
   ```

## Verification Steps

1. All 4 guide pages render at their URLs
2. Sidebar shows Guides section with correct sub-pages
3. SvelteKit guide contains complete route file code examples
4. Next.js guide contains complete page file code examples
5. Component customization guide covers all listed topics

## Stop Condition

Report: all 3 guides and index created, all render correctly, code examples are complete and accurate. Ready for API Reference (Phase 6).
