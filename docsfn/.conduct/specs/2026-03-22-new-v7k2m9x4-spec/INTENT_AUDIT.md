# INTENT AUDIT: DocsFn Documentation Site

## Intent Inventory

Extracted from the user's request and clarifying answers:

| # | Intent Item |
|---|---|
| 1 | Create a docs site for docsfn |
| 2 | Located at docsfn/docs/ (matching datafn/docs, searchfn/docs pattern) |
| 3 | Similar to existing datafn/searchfn/hostfn docs sites |
| 4 | Use docsfn instead of fumadocs (dogfooding) |
| 5 | Use SvelteKit + @docsfn/sveltekit (not Next.js) |
| 6 | Dev server on port 6004 |
| 7 | Getting started section |
| 8 | Overview section |
| 9 | Core concepts with comprehensive coverage (super comprehensive and thorough) |
| 10 | Core concepts: sidebar customization |
| 11 | Core concepts: SEO |
| 12 | Default sidebar for core concepts |
| 13 | API reference sidebar with each package |
| 14 | No migration guide from fumadocs |
| 15 | Use shared theme (visual consistency with other SF docs) |
| 16 | Use docsfn's native content format (not fumadocs compat) |
| 17 | Search enabled and wired up |
| 18 | Blog section included |

---

## Coverage Matrix

### Intent 1: Create a docs site for docsfn

- **SPEC.md**: Overview section
- **Requirements**: SITE-001 (scaffold), BUILD-001/002/003 (builds pass)
- **Test Vectors**: TV-SITE-001, TV-BUILD-001, TV-BUILD-002, TV-BUILD-003
- **Phases**: Phase 0 (scaffold), Phase 11 (verification)

### Intent 2: Located at docsfn/docs/

- **SPEC.md**: Overview ("located at `docsfn/docs/`")
- **Requirements**: SITE-001 ("located at `docsfn/docs/`")
- **Test Vectors**: TV-SITE-001 (directory structure check)
- **Phases**: Phase 0

### Intent 3: Similar to existing docs sites

- **SPEC.md**: Overview, Goals #3
- **Requirements**: THEME-001 (visual consistency), LAYOUT-002 (three-column), NAV-001/002/003/004/005/006 (navigation patterns)
- **Test Vectors**: TV-THEME-001, TV-LAYOUT-002
- **Phases**: Phase 1 (layout), Phase 10 (theme polish)

### Intent 4: Use docsfn instead of fumadocs

- **SPEC.md**: Invariants #1 ("No fumadocs dependency")
- **Requirements**: SITE-004 (no fumadocs-* packages)
- **Test Vectors**: TV-SITE-004
- **Phases**: Phase 0 (no fumadocs in package.json), Phase 11 (re-verification)

### Intent 5: SvelteKit + @docsfn/sveltekit

- **SPEC.md**: Overview ("SvelteKit 2 + @docsfn/sveltekit + @docsfn/svelte")
- **Requirements**: SITE-001 (SvelteKit 2), LAYOUT-001 (SvelteKit layout data loading)
- **Test Vectors**: TV-SITE-001, TV-LAYOUT-001
- **Phases**: Phase 0 (scaffold with SvelteKit), Phase 1 (SvelteKit routes)

### Intent 6: Port 6004

- **SPEC.md**: Invariants #5
- **Requirements**: SITE-002 (port 6004)
- **Test Vectors**: TV-SITE-002
- **Phases**: Phase 0 (package.json scripts)

### Intent 7: Getting started section

- **SPEC.md**: Overview (bullet point)
- **Requirements**: CONTENT-001 (installation, quick start, project structure)
- **Test Vectors**: TV-CONTENT-001
- **Phases**: Phase 2

### Intent 8: Overview section

- **SPEC.md**: Overview (docs index)
- **Requirements**: CONTENT-001 (getting started overview), LAYOUT-004 (landing page)
- **Test Vectors**: TV-CONTENT-001, TV-LAYOUT-004
- **Phases**: Phase 1 (landing page), Phase 2 (docs overview content)

### Intent 9: Core concepts — super comprehensive and thorough

- **SPEC.md**: Overview (comprehensive list of core concept topics)
- **Requirements**: CONTENT-002 through CONTENT-018 (17 core concept requirements)
- **Test Vectors**: TV-CONTENT-002 through TV-CONTENT-021
- **Phases**: Phase 2 (config, content format), Phase 3 (sidebars, nav, search, SEO, theming, CLI, providers), Phase 4 (blog, versioning, OpenAPI, security, analytics, RSS, markdown, diagnostics)
- **Coverage detail**:
  - Configuration: CONTENT-002
  - Content format: CONTENT-003
  - Sidebars: CONTENT-004
  - Navigation: CONTENT-005
  - Search: CONTENT-006
  - SEO: CONTENT-007
  - Theming: CONTENT-008
  - Blog: CONTENT-009
  - Versioning: CONTENT-010
  - OpenAPI: CONTENT-011
  - Security: CONTENT-012
  - Analytics: CONTENT-013
  - RSS: CONTENT-014
  - CLI: CONTENT-015
  - Content Providers: CONTENT-016
  - Markdown Extensions: CONTENT-017
  - Diagnostics: CONTENT-018

### Intent 10: Sidebar customization

- **SPEC.md**: "Semantics > Sidebar Resolution"
- **Requirements**: CONTENT-004 (comprehensive sidebar docs)
- **Test Vectors**: TV-CONTENT-004
- **Phases**: Phase 3

### Intent 11: SEO

- **SPEC.md**: "Data Formats" section, config shape
- **Requirements**: CONTENT-007 (SEO docs)
- **Test Vectors**: TV-CONTENT-007
- **Phases**: Phase 3

### Intent 12: Default sidebar for core concepts

- **SPEC.md**: "Public API > Site Routes" and config navigation.sidebars
- **Requirements**: NAV-002 (docs sidebar)
- **Test Vectors**: TV-NAV-002
- **Phases**: Phase 1 (sidebar rendering), Phase 2-4 (content populates sidebar)

### Intent 13: API reference sidebar with each package

- **SPEC.md**: Config navigation.sidebars.api, "Semantics > Sidebar Resolution"
- **Requirements**: NAV-003 (API sidebar distinct from docs), API-001 through API-007 (per-package reference)
- **Test Vectors**: TV-NAV-003, TV-API-001 through TV-API-007
- **Phases**: Phase 6 (P0 packages), Phase 7 (P1 packages)

### Intent 14: No migration guide from fumadocs

- **SPEC.md**: Non-goals #2 ("Building a Fumadocs compatibility layer")
- **Requirements**: Not included (explicitly excluded per user request)
- **Notes**: Confirmed absent from REQUIREMENTS.md

### Intent 15: Shared theme

- **SPEC.md**: Glossary "shared theme", Goals #3
- **Requirements**: THEME-001 (visual consistency), THEME-002 (Tailwind), THEME-003 (dark mode)
- **Test Vectors**: TV-THEME-001, TV-THEME-002, TV-THEME-003
- **Phases**: Phase 0 (CSS setup), Phase 10 (polish)
- **Notes**: Since @superfunctions/docs-theme is React/fumadocs-specific, visual consistency is via CSS tokens — documented in SPEC.md Glossary and SITE-004 notes.

### Intent 16: Native content format

- **SPEC.md**: Config `compat.preset: "none"`, Invariants #1
- **Requirements**: SITE-003 (compat.preset "none"), CONTENT-003 (content format docs)
- **Test Vectors**: TV-SITE-003, TV-CONTENT-003
- **Phases**: Phase 0 (config), Phase 2 (content format docs)

### Intent 17: Search enabled

- **SPEC.md**: "Semantics > Search", config search section
- **Requirements**: SEARCH-001, SEARCH-002, SEARCH-003, SEARCH-004, CONTENT-006
- **Test Vectors**: TV-SEARCH-001, TV-SEARCH-002, TV-SEARCH-003, TV-SEARCH-004, TV-CONTENT-006
- **Phases**: Phase 0 (config), Phase 1 (endpoint), Phase 9 (wiring + verification)

### Intent 18: Blog section

- **SPEC.md**: "Semantics > Blog", config navigation.topNav Blog link
- **Requirements**: BLOG-001, BLOG-002, BLOG-003, BLOG-004, CONTENT-009
- **Test Vectors**: TV-BLOG-001, TV-BLOG-002, TV-BLOG-003, TV-BLOG-004, TV-CONTENT-009
- **Phases**: Phase 1 (routes), Phase 4 (blog concept docs), Phase 8 (blog content)

---

## Audit Result

**No missing intent items.**

All 18 intent items from the user's request and clarifying answers are fully covered in SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, PLAN.md, and the phase files. Intent item #14 (no migration guide) is confirmed as explicitly excluded per user request and documented in Non-goals.

### Additional coverage beyond stated intent

The spec also includes:
- Integration guides (SvelteKit, Next.js, Customizing Components) — CONTENT-019, 020, 021
- Comprehensive API reference for all 7 packages — API-001 through API-007
- Build verification phase — BUILD-001, 002, 003
- Responsive layout — LAYOUT-003

These additions are necessary for a complete, production-quality documentation site and do not conflict with any stated intent or non-goal.
