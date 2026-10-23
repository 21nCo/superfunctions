# PHASE 10: Theme Polish + Landing Page

## Phase Goal

Ensure visual consistency with other superfunctions docs sites, refine the landing page, and implement dark mode.

## In Scope

- CSS theme tokens matching superfunctions visual identity
- Landing page refinement (hero, quick links, styling)
- Dark mode via prefers-color-scheme
- Footer with "Built at 21n.co"
- Typography and spacing consistency
- Layout max-width (1600px)

## Out of Scope

- Content changes (completed in prior phases)
- Explicit dark mode toggle (deferred)

## Deliverables

| File | Description |
|---|---|
| `src/app.css` | Refined global styles with theme tokens |
| `src/routes/+page.svelte` | Polished landing page |
| `src/routes/+layout.svelte` | Footer added if not already present |

## Requirements Covered

- THEME-001, THEME-003, LAYOUT-004

## Implementation Tasks

1. Review and refine `src/app.css`:
   - Verify primary color palette matches other SF docs sites
   - Verify font stack (system fonts or matching convention)
   - Verify layout max-width is 1600px
   - Add dark mode variables in `@media (prefers-color-scheme: dark)` block:
     - Background, foreground, muted, accent, border colors
     - Code block backgrounds
     - Sidebar backgrounds
   - Ensure smooth transitions between light/dark

2. Polish landing page (`src/routes/+page.svelte`):
   - Hero section: "docsfn" title, tagline ("The documentation toolchain for superfunctions")
   - Brief feature highlights (3-4 bullet points or cards)
   - Quick link cards with clear visual hierarchy:
     - Getting Started → /docs/getting-started
     - Core Concepts → /docs/core-concepts
     - API Reference → /docs/api
     - Blog → /blog
   - Clean, minimal design consistent with brand

3. Ensure footer is present on all pages:
   - "Built at 21n.co" text
   - Consistent with other docs sites

4. Visual QA:
   - Compare side-by-side with datafn/searchfn docs
   - Check color consistency
   - Check typography consistency
   - Check spacing/padding consistency
   - Test dark mode appearance

5. Responsive QA:
   - Test 375px, 768px, 1024px, 1440px viewports
   - Verify sidebar collapse on mobile
   - Verify TOC hidden on small screens
   - Verify content readability at all sizes

## Verification Steps

1. Load site → colors match superfunctions brand
2. Footer visible on all pages → "Built at 21n.co"
3. Set OS to dark mode → site adapts with dark background/light text
4. Landing page → hero, tagline, and quick links render beautifully
5. Mobile viewport → sidebar hidden, content full-width, TopBar accessible
6. Layout max-width → content does not exceed 1600px on wide screens

## Stop Condition

Report: visual consistency achieved, dark mode working, landing page polished, responsive layout verified. Ready for final build verification (Phase 11).
