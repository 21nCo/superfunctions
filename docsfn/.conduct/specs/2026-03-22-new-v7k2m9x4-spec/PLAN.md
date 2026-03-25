# PLAN: DocsFn Documentation Site

## Architecture Sketch

```
docsfn/docs/
├── package.json                    # Project metadata, dependencies, scripts
├── svelte.config.js                # SvelteKit config with docsfn package aliases
├── vite.config.ts                  # Vite + SvelteKit plugin + Tailwind
├── docsfn.config.ts                # DocsFn site configuration (native format)
├── tailwind.config.ts              # Tailwind CSS 4 config with theme tokens
├── tsconfig.json                   # TypeScript configuration
│
├── src/
│   ├── app.html                    # SvelteKit HTML shell
│   ├── app.css                     # Global styles + Tailwind imports + theme tokens
│   ├── routes/
│   │   ├── +layout.server.ts       # Root layout: loads manifest + search artifact
│   │   ├── +layout.svelte          # Root layout: TopBar + DocsSearch + slot
│   │   ├── +page.svelte            # Landing page (hero + quick links)
│   │   ├── docs/
│   │   │   └── [...slug]/
│   │   │       ├── +page.ts        # Resolves route data + surface for docs pages
│   │   │       └── +page.svelte    # Renders docs page (sidebar + content + TOC)
│   │   ├── blog/
│   │   │   ├── +page.svelte        # Blog listing
│   │   │   ├── +page.ts            # Blog listing data
│   │   │   └── [slug]/
│   │   │       ├── +page.ts        # Blog post data
│   │   │       └── +page.svelte    # Blog post page
│   │   ├── search.json/
│   │   │   └── +server.ts          # Search artifact JSON endpoint
│   │   └── blog/rss.xml/
│   │       └── +server.ts          # RSS feed endpoint
│   └── lib/
│       └── theme.ts                # Theme tokens + helpers (optional)
│
├── content/
│   ├── docs/
│   │   ├── meta.json               # Root docs navigation
│   │   ├── index.md                # Docs landing
│   │   ├── getting-started/        # Getting started section
│   │   ├── core-concepts/          # Core concepts section (config, content, sidebars, etc.)
│   │   └── guides/                 # Integration guides
│   ├── api/
│   │   ├── meta.json               # Root API navigation
│   │   ├── index.md                # API reference landing
│   │   ├── core/                   # @docsfn/core reference
│   │   ├── sveltekit/              # @docsfn/sveltekit reference
│   │   ├── svelte/                 # @docsfn/svelte reference
│   │   ├── provider-fs/            # @docsfn/provider-fs reference
│   │   ├── cli/                    # @docsfn/cli reference
│   │   ├── next/                   # @docsfn/next reference
│   │   └── react/                  # @docsfn/react reference
│   └── blog/
│       └── introducing-docsfn.md   # Initial blog post
│
└── static/                         # Static assets
```

### Module Responsibilities

| Module | Responsibility |
|---|---|
| `docsfn.config.ts` | Declares site metadata, navigation, sidebars, search settings |
| `+layout.server.ts` | Loads config, builds manifest + search artifact, provides to all routes |
| `+layout.svelte` | Renders TopBar, DocsSearch, provides layout shell |
| `docs/[...slug]/+page.ts` | Resolves docs/api route data and page surface |
| `docs/[...slug]/+page.svelte` | Renders sidebar + DocsContent + TOC + breadcrumbs + pagination |
| `blog/+page.svelte` | Renders blog listing |
| `blog/[slug]/+page.svelte` | Renders blog post |
| `search.json/+server.ts` | Serves search artifact as JSON |
| `blog/rss.xml/+server.ts` | Generates RSS feed |
| `content/docs/**` | All documentation markdown |
| `content/api/**` | All API reference markdown |
| `content/blog/**` | All blog posts |

---

## Dependency Graph

```
Phase 0: Project Scaffold
    ↓
Phase 1: Root Layout + Route Shell (depends on scaffold)
    ↓
Phase 2: Core Content — Getting Started + Config + Content Format (depends on routes)
    ↓
Phase 3: Core Content — Sidebars, Navigation, Search, SEO, Theming, CLI, Provider (depends on Phase 2)
    ↓
Phase 4: Core Content — Blog, Versioning, OpenAPI, Security, Analytics, RSS, Markdown Extensions, Diagnostics (depends on Phase 3)
    ↓
Phase 5: Guides — SvelteKit, Next.js, Customizing Components (depends on Phase 2)
    ↓
Phase 6: API Reference — core, sveltekit, svelte, provider-fs, cli (depends on scaffold)
    ↓
Phase 7: API Reference — next, react (depends on Phase 6)
    ↓
Phase 8: Blog Section — listing, post pages, initial post, RSS (depends on Phase 1)
    ↓
Phase 9: Search Wiring — endpoint, component, keyboard shortcut (depends on Phase 1)
    ↓
Phase 10: Theme + Landing Page — visual polish, dark mode, landing hero (depends on all content)
    ↓
Phase 11: Build Verification — validate, build, SvelteKit build, final QA (depends on all phases)
```

**Parallelizable**: Phases 2-5 (docs content) and Phases 6-7 (API reference) can proceed in parallel once Phase 1 is complete. Phase 8 (blog) and Phase 9 (search) can also proceed in parallel with content phases.

---

## Phases Overview

| Phase | Goal | Delivered Capability | Verification |
|---|---|---|---|
| 0 | Project scaffold | SvelteKit project at docsfn/docs/ with dependencies and config | `npm install` succeeds; `npx docsfn validate` exits 0 with minimal content |
| 1 | Route shell + layout | Root layout loads manifest; docs/blog routes render placeholder content | Dev server starts on 6004; pages render without errors |
| 2 | Getting Started + Config + Content Format docs | Core onboarding content | Pages render at correct URLs; content is complete per acceptance criteria |
| 3 | Sidebars, Navigation, Search, SEO, Theming, CLI, Provider docs | Full "Core Concepts" section | All core concept pages render; sidebar shows full navigation tree |
| 4 | Blog, Versioning, OpenAPI, Security, Analytics, RSS, Markdown Extensions, Diagnostics docs | Complete "Core Concepts" section | All remaining concept pages render |
| 5 | SvelteKit guide, Next.js guide, Customizing Components guide | Guides section | Guide pages render with step-by-step content |
| 6 | API Reference: core, sveltekit, svelte, provider-fs, cli | P0 API reference content | API sidebar populated; all P0 package pages render |
| 7 | API Reference: next, react | Complete API reference | All 7 packages documented |
| 8 | Blog: listing, posts, RSS | Functional blog section | Blog listing shows posts; RSS feed valid |
| 9 | Search: endpoint, component wiring | Working search | Cmd/Ctrl+K opens search; results navigate correctly |
| 10 | Theme polish + landing page | Visual consistency, landing page | Visual parity with other docs sites; landing page renders |
| 11 | Build verification + final QA | Production-ready site | docsfn validate/build pass; SvelteKit build passes; all test vectors pass |

---

## Definition of Done (Global)

No phase is complete unless:
1. All deliverables listed in the phase are created.
2. All verification steps in the phase pass.
3. The dev server starts without errors.
4. No regressions to previously completed phases.
