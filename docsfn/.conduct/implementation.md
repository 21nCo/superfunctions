# docsfn Implementation Plan (AI agent-ready)

**Status**: Draft  
**Last updated**: 2026-01-18  

This plan implements the `docsfn/.conduct/spec.md` v1 direction:
- **Headless core** (framework-agnostic)
- **Content provider adapter interface** (filesystem + CMS + future `cmsfn`)
- **Cross-framework UI** (React-like + Svelte first) built on `@uifn/*`
- Supports:
  - (A) standalone docs site
  - (B) embedded single markdown page + TOC
  - (C) embedded docs surface (sidebar + TOC + topbar + search)
  - (D) blog

---

## Repository + package layout (target)

Proposed structure (aligned with `datafn`/`uifn` patterns):

```
superfunctions/
  docsfn/
    .conduct/
      spec.md
      implementation.md
    core/                       # package: @docsfn/core
    provider-fs/                # package: @docsfn/provider-fs
    cli/                        # package: @docsfn/cli (optional, but recommended)
    react/                      # package: @docsfn/react
    svelte/                     # package: @docsfn/svelte
    next/                       # package: @docsfn/next
    sveltekit/                  # package: @docsfn/sveltekit
    examples/
      next-docs-site/
      sveltekit-docs-site/
      embedded-page/
      embedded-docs-surface/
```

Notes:
- The current repo has `docsfn/package.json` at `docsfn/`. During implementation, either:
  - evolve it into a workspace root with child packages (recommended), or
  - keep single-package temporarily and add subpackages later.
- When implementation starts, add the new packages to the root `superfunctions/package.json` workspaces list.

---

## Milestones

### Milestone 0 — Package scaffolding + conventions

Deliverable: buildable skeletons for core/providers/adapters.

- [ ] Create package skeletons:
  - [ ] `docsfn/core/` (`@docsfn/core`)
  - [ ] `docsfn/provider-fs/` (`@docsfn/provider-fs`)
  - [ ] `docsfn/react/` (`@docsfn/react`)
  - [ ] `docsfn/svelte/` (`@docsfn/svelte`)
  - [ ] `docsfn/next/` (`@docsfn/next`) and/or `docsfn/sveltekit/` (`@docsfn/sveltekit`) (can be delayed until Milestone 6)
  - [ ] `docsfn/cli/` (`@docsfn/cli`) (optional; can start as internal scripts)
- [ ] Standard package files:
  - `package.json` (ESM-first)
  - `tsconfig.json`
  - `tsup.config.ts`
  - `vitest.config.ts` where needed
  - `src/index.ts` exporting the public surface only
- [ ] Establish consistent naming:
  - “docsfn” (directory) vs “Docsfn” (docs) vs `@docsfn/*` (packages)

---

### Milestone 1 — Core domain model + config schema

Deliverable: stable types/interfaces enabling all 4 usage modes.

**Core types (minimum):**
- [ ] Content records:
  - `DocPage`, `MarkdownPage`, `BlogPost`, `ApiReference`, `Asset`
  - `DocHeading` (TOC nodes), `DocBreadcrumb`, `DocPagination`
- [ ] Navigation:
  - `Sidebar` + `SidebarItem` (link/group/separator)
  - `TopNav` + items (link/dropdown)
- [ ] Versioning:
  - `DocsVersion`, `VersionStrategy` (prefix vs segment)
- [ ] Manifest:
  - `DocsManifest` containing:
    - `site` metadata
    - content indexes (pages/posts/api)
    - sidebars + topnav
    - route map metadata
    - search index metadata/snapshot path

**Config:**
- [ ] Define `docsfn.config.ts` shape (serializable, framework-agnostic).
- [ ] Validate config at runtime (Zod recommended).

**Design constraints:**
- [ ] Deterministic outputs for the same inputs (stable ordering + stable IDs).
- [ ] Core has no dependency on React/Svelte or DOM.

---

### Milestone 2 — Content provider interface + filesystem provider (required)

Deliverable: provider adapter contract + `provider-fs` implementation.

**Provider interface (core):**
- [ ] Define `DocsContentProvider` with capabilities:
  - list content entries by collection/kind
  - load entry content (body + frontmatter + timestamps/etag)
  - load assets (optional)
  - watch/invalidate (optional)

**Filesystem provider (provider-fs):**
- [ ] Support canonical directories:
  - `docs/` (docs pages)
  - `pages/` (single pages)
  - `blog/` (blog posts)
  - `api/` (OpenAPI files/refs)
  - `public/` or `assets/` (assets)
- [ ] Frontmatter parsing:
  - common fields: `title`, `description`, `sidebar`, `order`, `tags`, `draft`
  - blog fields: `date`, `author`, `excerpt`
  - version fields: `version` or `versions`
- [ ] Ordering rules:
  - explicit `order` first
  - then filename/folder ordering (stable)
- [ ] Multiple sidebars:
  - by folder conventions (ex: `docs/guides/**`, `docs/api/**`) and/or per-page frontmatter

---

### Milestone 3 — Markdown analysis pipeline (TOC + excerpts + anchors)

Deliverable: markdown parsing for metadata extraction (not rendering).

- [ ] Parse markdown into AST (remark/mdast).
- [ ] Extract:
  - headings with stable anchors (slug algorithm must be stable + documented)
  - excerpt/summary (blog)
  - outbound links (for link checking)
- [ ] Normalize:
  - code fences metadata (lang, filename, highlight ranges)
  - admonitions/callouts markers (if used)

Output of this milestone is structured metadata stored into the manifest; rendering is handled by adapters.

---

### Milestone 4 — Navigation engine (sidebars, breadcrumbs, pagination, versions)

Deliverable: derive docs chrome data for any route.

- [ ] Sidebar generation:
  - auto mode (from content tree)
  - config override mode (explicit sidebar definition)
- [ ] Breadcrumb computation:
  - from sidebar tree + current page path
- [ ] Pagination:
  - prev/next based on sidebar linearization
  - allow per-page overrides (frontmatter)
- [ ] Versioning support:
  - route strategy
  - per-version sidebars and per-version API references
  - version switcher data

---

### Milestone 5 — Manifest builder + cache keys

Deliverable: `buildManifest()` that powers static and runtime modes.

- [ ] Implement `buildManifest({ provider, config })`:
  - loads all required content
  - computes derived nav/TOC/pagination/versioning
  - produces a single `DocsManifest` JSON object
- [ ] Implement cache keys:
  - per-entry etag/timestamp
  - overall manifest hash (for incremental rebuilds)

Optional:
- [ ] A “runtime manifest” mode that builds lazily and caches (for CMS-driven live docs).

---

### Milestone 6 — Search (searchfn-first)

Deliverable: generate and consume a `searchfn` index snapshot.

- [ ] Index builder:
  - index docs pages + blog posts + API reference pages (configurable)
  - fields: title, headings, description, tags, body text (optional)
- [ ] Snapshot export for static sites.
- [ ] Runtime loader:
  - load snapshot
  - execute search queries
  - return ranked results with URL + snippets/highlights

Adapter deliverables:
- [ ] React search UI:
  - dialog/command palette UX using `@uifn/react` (Dialog, Combobox, ScrollArea)
- [ ] Svelte search UI:
  - dialog/combobox using `@uifn/svelte`

---

### Milestone 7 — API docs ingestion (OpenAPI)

Deliverable: OpenAPI → `ApiReference` model + reference page generation.

- [ ] OpenAPI sources:
  - local files (filesystem provider)
  - remote URLs with caching (provider or helper)
  - optional per-version mapping
- [ ] Normalize to:
  - tags/groups
  - operations (method/path/summary/description)
  - params/request bodies/responses
  - schemas/components
- [ ] Generate virtual “pages” in the manifest:
  - API overview
  - tag pages
  - endpoint pages
  - schema pages (optional)

UI deliverables:
- [ ] Minimal reference renderer in React and Svelte.
- [ ] “Try it” explicitly deferred until v1.1+ unless required earlier.

---

### Milestone 8 — UI kits (Docs chrome) using UIFN

Deliverable: composable UI components to satisfy cases B and C, and enable A.

React (`@docsfn/react`):
- [ ] `DocsLayout`, `DocsSidebar`, `DocsToc`, `DocsPagination`, `DocsTopBar`
- [ ] Mobile sidebar drawer (Dialog/Sheet pattern via UIFN primitives)
- [ ] `DocsSurface` (embedded wrapper) configurable to hide/show chrome

Svelte (`@docsfn/svelte`):
- [ ] same component set as React with matching props and behavior

Shared:
- [ ] Theme tokens + CSS variables conventions
- [ ] Accessibility requirements:
  - keyboard navigation
  - skip-to-content
  - correct heading levels and aria labeling

---

### Milestone 9 — Framework site kits (standalone docs site)

Deliverable: “minimal wiring” docs site for Next.js and SvelteKit (case A).

Next.js (`@docsfn/next`) recommended target:
- [ ] App Router integration:
  - dynamic route `[...slug]`
  - static params generation from manifest
  - metadata generation (title/description/canonical)
- [ ] Build-time manifest generation in `next build`
- [ ] Static export compatibility where possible (document limitations)

SvelteKit (`@docsfn/sveltekit`) recommended target:
- [ ] `+page.server.ts`/`+page.ts` loaders reading the manifest
- [ ] prerender support using manifest routes

Examples:
- [ ] `docsfn/examples/next-docs-site/`
- [ ] `docsfn/examples/sveltekit-docs-site/`

---

### Milestone 10 — Blog mode

Deliverable: blog listing + post pages + tags + RSS (case D).

- [ ] Blog post model + listing queries over manifest
- [ ] Tag pages + pagination
- [ ] RSS generation in site kits
- [ ] Styling guidelines for prose/code blocks consistent with docs

---

### Milestone 11 — CMS support (interface now, adapters later)

Deliverable: CMS adapter pattern and at least one reference provider.

- [ ] Finalize `DocsContentProvider` contract to support remote CMS:
  - pagination
  - drafts/preview mode
  - webhooks or polling for invalidation
- [ ] Implement at least one provider (optional) OR defer implementations but keep interface stable.
- [ ] Define `@docsfn/provider-cmsfn` contract for future `cmsfn`:
  - docsfn should depend on a small, stable API surface from `cmsfn` (to be defined when `cmsfn` exists).

---

### Milestone 12 — Superfunctions integrations (watchfn/authfn/cachefn)

Deliverable: optional integrations that don’t pollute core.

- [ ] `watchfn` analytics adapter:
  - pageview events
  - search events
  - outbound link click events
  - opt-in + DNT support
- [ ] `authfn` gating hooks for protected docs:
  - standalone site kit integration
  - embedded integration (host app decides)
- [ ] `cachefn` optional cache wrapper for runtime CMS mode

---

## Testing strategy

- **Unit tests (`@docsfn/core`)**:
  - manifest determinism (stable IDs/order)
  - TOC extraction + anchor generation
  - sidebar/pagination resolution
  - version routing strategy
- **Provider tests (`@docsfn/provider-fs`)**:
  - frontmatter parsing
  - ordering rules
  - file tree → sidebar generation inputs
- **Integration tests**:
  - build manifest end-to-end from fixture content trees
  - search index build + query behavior
  - OpenAPI ingestion fixtures
- **Adapter tests**:
  - render snapshots for docs chrome components
  - keyboard navigation and aria attributes where possible
- **E2E (optional)**:
  - Playwright against example Next/SvelteKit sites (nav/search/api/blog)

---

## Acceptance criteria (v1)

### Core
- A `DocsManifest` can be produced from filesystem content with:
  - multiple sidebars
  - TOC per page
  - breadcrumbs and prev/next pagination
  - optional versions
- The manifest is deterministic for identical inputs.

### Mode coverage
- (B) Embedded markdown page can render with TOC in both React and Svelte.
- (C) Embedded docs surface renders sidebar + TOC + topbar + search.
- (D) Blog posts list and render with tags + pagination.
- (A) Standalone docs site example works end-to-end (build + run) for:
  - Next.js and/or SvelteKit (at least one must be complete in v1).

### Integrations
- Search works via `searchfn` snapshot in static mode.
- OpenAPI reference pages render from ingested specs.
- `watchfn` analytics can be enabled without code changes to core.

---

## Open questions (to resolve during implementation)

- Rendering strategy per adapter:
  - Do we standardize on MDX for React and mdsvex for Svelte, or provide two paths (MDX + “plain markdown renderer”)?
- API docs UI depth:
  - minimal reference pages in v1 vs embedding an explorer component.
- Versioning URL strategy defaults:
  - `/v1/docs/...` vs `/docs/v1/...` vs domain-based.
- Search indexing scope:
  - include full body by default or headings only (size/perf trade-off).

