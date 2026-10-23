## Docsfn Specification (v1)

**Last updated**: 2026-01-18  
**Status**: Draft (implementation-targeted)  
**Owner**: Platform (Superfunctions)

### Why this spec changed
The earlier draft described `docsfn` as a full docs site generator. This spec re-scopes `docsfn` into a **headless, cross-framework documentation toolkit** that:
- can still power a “full docs site” when paired with a framework adapter (Next.js/SvelteKit first),
- but also works as a small, embedded “docs surface” inside product UIs,
- and integrates cleanly with Superfunctions primitives (especially `uifn`, `searchfn`, `watchfn`, future `cmsfn`).

---

## Goals

- **Headless core**: A framework-agnostic core that models documentation content, navigation, TOC, pagination, versions, and API reference as data.
- **Cross-framework UI**: React-like and Svelte adapters first; Vue later. UI components must be built using `@uifn/*` primitives wherever interactivity is needed (dialogs, combobox, accordion, scroll areas, etc).
- **Pluggable content sources (CMS + FS)**:
  - a stable **content provider interface** with an adapter pattern,
  - first-class **filesystem provider**,
  - CMS providers (existing SaaS + future `cmsfn`) without changing core APIs.
- **Works for 4 primary product shapes**:
  1. **Standalone docs site**: multi-sidebars, top bar, search, API docs, version switcher, theming, pagination.
  2. **Embedded markdown page**: render a single page + TOC (minimal chrome).
  3. **Embedded “docs surface”**: sidebar + TOC + top bar + search (docs site bells/whistles) but inside product.
  4. **Blog**: posts, tags, authors, listing pages, RSS, pagination.
- **API docs**: OpenAPI ingestion as a first-class content type; optionally TypeDoc later. Must support either “generated pages” or an embedded API explorer UI.
- **Search**: default to `searchfn` (client-side, snapshot-based) for both standalone and embedded modes.
- **Superfunctions integration**:
  - `searchfn` for doc search,
  - `watchfn` for analytics events (pageview/search/clicks),
  - `authfn` for gating private docs (optional),
  - `cachefn` for runtime caching (optional),
  - `cmsfn` as a future content source provider.

## Non-goals (v1)

- Not a new general-purpose SSG competing with Docusaurus/Hugo. `docsfn` should **integrate with** app frameworks (Next/SvelteKit) rather than replace them.
- Not a WYSIWYG editor. Authoring can be filesystem Git-backed, or external CMS.
- Not a full i18n system in v1 (leave hooks for later).
- Not a full design system. `docsfn` provides docs-oriented components + tokens; styling is themeable.

---

## Conceptual model

`docsfn` treats docs as a structured dataset.

### Content types

- **DocPage**: markdown/MDX/mdsvex content rendered as a docs page.
- **MarkdownPage**: a doc page rendered without full docs chrome (embedded mode).
- **BlogPost**: markdown content with blog metadata (date, tags, author).
- **ApiReference**: an OpenAPI spec transformed into a model used to render reference pages or an explorer.
- **Asset**: images, downloads; may come from filesystem or CMS.

### Navigation types

- **Sidebar**: a named navigation tree (supports multiple sidebars per site/product).
- **TopNav**: top bar links and dropdowns.
- **TOC**: per-page extracted headings (configurable depth, anchors).
- **Pagination**: prev/next based on nav order and/or explicit overrides.

### Versioning

Docs may have versions (ex: `v1`, `v2`, `latest`). Versioning affects:
- routing (prefix or segment),
- sidebars (per-version nav),
- API references (per-version OpenAPI),
- search index partitioning.

---

## Architecture (high-level)

### Packages (proposed)

Follow the `uifn`/`datafn` pattern: framework-agnostic core + framework adapters.

```
docsfn/
  .conduct/
    spec.md
    implementation.md
  core/                 (package: @docsfn/core)
  cli/                  (package: @docsfn/cli)  [optional but recommended]
  react/                (package: @docsfn/react)
  svelte/               (package: @docsfn/svelte)
  next/                 (package: @docsfn/next) [react-like adapter]
  sveltekit/            (package: @docsfn/sveltekit)
  providers/
    fs/                 (package: @docsfn/provider-fs)
    cmsfn/              (package: @docsfn/provider-cmsfn) [future]
  examples/
    next-docs-site/
    sveltekit-docs-site/
    embedded-page/
    embedded-docs-surface/
```

Notes:
- If we keep a single-package `docsfn` for now, `@docsfn/*` can be introduced when implementation begins.
- Providers can also live as plugins inside `@docsfn/core` initially, but should be split when stable.

### Core pipeline: “source → normalize → index → manifest”

1. **Load** raw content from a provider (filesystem or CMS).
2. **Normalize** into canonical content records (doc pages, blog posts, api references).
3. **Compute** derived structures (TOC, sidebars, pagination, breadcrumbs, routes).
4. **Index** (search index via `searchfn` snapshot, or JSON fallback).
5. **Emit** a **manifest** artifact used by runtime adapters.

### Runtime modes

- **Build-time mode**: produce a static manifest (and optional pre-render artifacts).
- **Runtime mode**: serve content dynamically from CMS (server-side), with caching.

Both modes should share the same core interfaces and return the same normalized models.

---

## Content source abstraction (CMS + filesystem)

### `DocsContentProvider` interface (conceptual)

A provider must be able to:
- list entries (docs pages, blog posts, assets, openapi specs),
- load a single entry,
- optionally watch for updates (dev mode),
- expose stable identifiers and timestamps/etags for caching.

Provider responsibilities:
- **Authentication** to the backing system (CMS tokens, etc).
- **Fetching** and rate-limits/backoff (if remote).
- **Mapping** CMS fields to `docsfn` canonical frontmatter.

Core responsibilities:
- validate and normalize provider output,
- compute nav/TOC/search,
- provide framework-agnostic rendering metadata.

### Provider types

- **Filesystem provider (v1 required)**:
  - Git-backed content in `docs/`, `pages/`, `blog/`, `api/`.
  - Supports frontmatter and directory-based ordering.
- **External CMS providers (v1 interface, optional implementations)**:
  - Contentful / Sanity / Notion / etc via separate packages.
- **`cmsfn` provider (future)**:
  - `cmsfn` becomes a superfunctions-unified CMS API. `docsfn` should only depend on a small interface so `cmsfn` can slot in later.

---

## Rendering + framework adapters

`docsfn` does not attempt to “own” markdown compilation. Instead:
- core extracts metadata and builds structures,
- adapters render markdown using the idiomatic toolchain:
  - React-like: MDX (`@mdx-js/mdx`) or remark/rehype to React
  - Svelte: mdsvex or remark/rehype to Svelte

### Adapter responsibilities

- routing integration (Next.js/SvelteKit),
- page loading (static params + load functions),
- render docs UI (layout, sidebar, toc, pagination),
- styling/theming hooks (tokens, CSS variables),
- interactive widgets using `@uifn/*`.

---

## UI components (built on UIFN)

### Required building blocks

- **SidebarNav**: nested items, collapsible groups, active state, mobile drawer.
- **TOC**: sticky on large screens, inline on small screens.
- **Pagination**: prev/next + section context.
- **TopBar**: logo, top links, version selector, search trigger.
- **Search UI**: command palette / dialog (keyboard shortcut) + result list.
- **DocsLayout**: composed layout with slots for content + chrome.
- **ApiReference UI**: either:
  - `docsfn`-native reference renderer (v1), or
  - wrapper around a stable explorer component (v1.1+), but must remain cross-framework-friendly.

### UIFN primitives likely used

- `Dialog` / `Popover` / `DropdownMenu` (search, version menu)
- `Combobox` (search suggestions)
- `Accordion` / `Collapsible` (sidebar sections)
- `ScrollArea` (sidebar + search results)
- `Tabs` (code groups, API tabs)

---

## Standalone docs site (case A)

`docsfn` must support assembling a full docs site with:
- multiple sidebars (`guides`, `api`, `sdk`, etc),
- top bar navigation,
- version switcher,
- search (searchfn-based),
- API docs routes (OpenAPI),
- theming (tokens + light/dark),
- pagination + breadcrumbs.

Implementation guidance:
- Provide a “site kit” for Next.js and SvelteKit that requires minimal wiring:
  - import config,
  - mount routes,
  - choose provider (filesystem/CMS),
  - run build step or runtime mode.

---

## Embedded markdown page (case B)

Expose a minimal surface to render a single page:
- `renderMarkdownPage({ source, slug })` (headless)
- framework components:
  - `<MarkdownPage slug="..." toc />`
  - minimal styles, optional heading anchors and TOC.

---

## Embedded docs surface (case C)

Expose “docs chrome” as composable components that can be embedded:
- `<DocsSurface sidebar="product" />` around product routes
- shared header/topbar slot, optional product navigation integration
- search modal that can index both product docs + broader site docs (configurable).

---

## Blog (case D)

Support blog-specific concerns:
- blog post frontmatter (title, date, tags, author, draft, excerpt),
- list pages with pagination,
- tag pages,
- RSS feed generation in standalone site kits,
- consistent typography/code highlighting.

---

## API docs (OpenAPI) support

### OpenAPI ingestion

- Inputs:
  - local file(s) in repo
  - remote URL(s) (with caching)
  - CMS-managed spec blobs (via provider)
- Output:
  - a normalized `ApiReference` model in the manifest
  - derived pages: overview, tag groups, endpoint pages, schemas

### “Try it” support (phased)

- v1: render reference + examples (curl + fetch), schemas, params.
- v1.1+: optional “try it” with explicit enablement and safe defaults.

---

## Search (searchfn-first)

### Requirements

- build-time index generation for static sites
- runtime index generation/caching for CMS-driven mode
- client UI in adapters (dialog + results)
- keyboard shortcut, highlight matches, scoped search (docs vs api vs blog)

### `searchfn` integration

Recommended approach:
- build a `searchfn` index from:
  - titles, descriptions, headings, body text (optional), tags
- export/import snapshots so the client can search offline in static mode.

---

## Analytics (watchfn) + auth (authfn) integration (optional)

- `watchfn`:
  - pageview events (route + version + sidebar)
  - search events (query + result count)
  - outbound click events (docs CTA clicks)
  - opt-in only; must support DNT.
- `authfn`:
  - optional gate around docs routes for private docs
  - should work in standalone and embedded contexts.

---

## Configuration

### `docsfn.config.ts` (conceptual)

Config should be serializable and framework-agnostic. It should define:
- site metadata (title, basePath, canonical URL)
- theme tokens (colors, typography, radii)
- versions + default version behavior
- sidebars/topnav definitions (or “auto from content tree” mode)
- provider setup (filesystem paths, CMS connection config)
- api sources (OpenAPI refs + routing)
- search config (indexing options)
- analytics/auth toggles

---

## Compatibility + constraints

- **ESM-first** TypeScript packages.
- Core must be:
  - framework-agnostic,
  - runnable in Node (build/runtime server),
  - deterministic for the same inputs (manifest stability).
- Adapters must support:
  - SSR + SSG where applicable (Next/SvelteKit),
  - client navigation without breaking active states.

---

## Roadmap (phased)

- **v0**: Core models + filesystem provider + TOC extraction + sidebar generation + React + Svelte minimal renderers (embedded mode B).
- **v1**: Standalone site kits (Next + SvelteKit) + searchfn index + multi-sidebars + blog + OpenAPI reference pages (cases A–D).
- **v1.1+**: CMS providers, “try it” API explorer mode, i18n, TypeDoc ingestion, richer theming and widgets.
