# PHASE 11: Build Verification + Final QA

## Phase Goal

Verify that all builds pass, all test vectors are satisfied, and the site is production-ready.

## In Scope

- docsfn validate (0 errors)
- docsfn build (all artifacts, 0 errors)
- SvelteKit build (vite build succeeds)
- Full test vector sweep
- No fumadocs dependencies check
- Link integrity check
- Search coverage check

## Out of Scope

- Deployment (out of spec scope)
- CI/CD setup

## Deliverables

No new files. This phase is verification-only.

## Requirements Covered

- BUILD-001, BUILD-002, BUILD-003, SITE-004 (re-verification)

## Implementation Tasks

1. Run `docsfn validate`:
   ```bash
   cd docsfn/docs && npx docsfn validate --root .
   ```
   - MUST exit 0
   - MUST have 0 error-severity diagnostics
   - Warnings are acceptable

2. Run `docsfn build`:
   ```bash
   cd docsfn/docs && npx docsfn build --root . --out-dir .docsfn
   ```
   - MUST exit 0
   - MUST produce: .docsfn/manifest.json, .docsfn/search.json, .docsfn/diagnostics.json
   - diagnostics.json MUST contain 0 error entries
   - Note search artifact byte size

3. Run SvelteKit build:
   ```bash
   cd docsfn/docs && npm run build
   ```
   - MUST exit 0
   - No TypeScript errors
   - No build-breaking warnings

4. Verify no fumadocs dependencies:
   ```bash
   grep -c "fumadocs" docsfn/docs/package.json  # must be 0
   grep -r "from ['\"]fumadocs" docsfn/docs/src/  # must find nothing
   ```

5. Start dev server and verify key pages:
   - `/` → landing page renders
   - `/docs` → docs index renders
   - `/docs/getting-started` → getting started renders
   - `/docs/core-concepts/configuration` → config reference renders
   - `/docs/core-concepts/sidebars` → sidebar docs render
   - `/docs/api` → API reference index renders
   - `/docs/api/core` → core API renders
   - `/docs/api/svelte/components` → component docs render
   - `/blog` → blog listing renders
   - `/blog/introducing-docsfn` → blog post renders

6. Verify search end-to-end:
   - `curl http://localhost:6004/search.json | jq '.documents | length'` → > 30 documents
   - Cmd/Ctrl+K → search dialog opens
   - Search "sidebar" → docs results appear
   - Search "DocsContent" → api results appear
   - Search "introducing" → blog results appear

7. Verify navigation end-to-end:
   - TopBar links all work
   - Sidebar navigation works on docs and API pages
   - Breadcrumbs show correct trail
   - Pagination prev/next works
   - TOC appears on pages with headings

8. Check for broken internal links:
   - Manually verify links between docs pages
   - Verify API cross-references

9. Verify responsive layout:
   - Desktop (1440px): three-column layout
   - Tablet (768px): sidebar + content (no TOC)
   - Mobile (375px): content only, sidebar via hamburger

## Verification Steps

1. `npx docsfn validate --root .` → exit 0, 0 errors
2. `npx docsfn build --root . --out-dir .docsfn` → exit 0, all artifacts produced, 0 errors
3. `npm run build` → exit 0
4. No fumadocs references found
5. All 10 key pages render without errors
6. Search returns results from all 3 scopes
7. Navigation (TopBar, sidebar, breadcrumbs, pagination, TOC) all functional
8. No broken internal links
9. Responsive layout correct at all breakpoints

## Stop Condition

Report: all builds pass (validate, docsfn build, SvelteKit build), no fumadocs dependencies, all pages render, search functional, navigation complete, responsive layout verified. Site is production-ready.
