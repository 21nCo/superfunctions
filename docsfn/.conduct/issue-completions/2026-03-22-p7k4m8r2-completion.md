# Completion Report: docsfn/docs library-level code consolidation

## Metadata

- **Issue ID**: `2026-03-22-q9x3k7m2-issue`
- **Completion ID**: `2026-03-22-p7k4m8r2-completion`
- **Timestamp**: 2026-03-22T20:30:00Z
- **Agent**: Claude Sonnet 4.6
- **Model**: claude-sonnet-4-6

## Summary

All four fixes required by the issue were implemented. The docs site no longer duplicates library-level types, renderers, or layout. The root cause (`@docsfn/core` having no browser-safe sub-entry) was fixed, enabling library components to be imported without triggering Vite's `__vite-browser-external` error.

## Fixes Applied

### Fix 1 — `@docsfn/core/browser` sub-entry (ROOT FIX)

**Files changed:**
- Created `docsfn/core/src/browser.ts` — exports only browser-safe modules: types, diagnostics, sanitize, markdown compiler, `compileSvelteContent`, `compileReactContent`, `assertCompiledContentTrusted`, theme utilities. Explicitly excludes `config.ts`, `provider.ts`, `manifest.ts`, `normalize.ts`, `routing.ts`, `rss.ts`, `blog.ts`, `openapi.ts`.
- Updated `docsfn/core/package.json` — added `"./browser"` exports entry pointing to `dist/browser.{js,cjs,d.ts}`.
- Updated `docsfn/core/tsup.config.ts` — added `browser: "src/browser.ts"` entry point.

**Verification:** `@docsfn/core` built successfully. `dist/browser.js` is only 1.51 KB ESM (compared to 79.58 KB for `dist/index.js`), confirming it contains only browser-safe code.

### Fix 2 — `DocsContent.svelte` and other svelte components import from `@docsfn/core/browser`

**Files changed:**
- `docsfn/svelte/src/DocsContent.svelte` — changed import from `@docsfn/core` to `@docsfn/core/browser`
- `docsfn/svelte/src/DocsLayout.svelte` — changed import from `@docsfn/core` to `@docsfn/core/browser`
- `docsfn/svelte/src/DocsSidebar.svelte`, `DocsToc.svelte`, `SidebarGroup.svelte`, `VersionSwitcher.svelte`, `TopBar.svelte`, `ApiReferenceRenderer.svelte`, `EmbeddedPage.svelte`, `public-types.ts` — all updated to import from `@docsfn/core/browser`

This ensures that importing any svelte component from `@docsfn/svelte` no longer pulls in `node:path`, `node:url`, `node:fs/promises` on the client bundle.

**Verification:** `@docsfn/svelte` built successfully.

### Fix 3 — Delete duplicates and wire up library components

**Files deleted:**
- `docsfn/docs/src/lib/compiled-docs-types.ts` — duplicate type mirror of `CompiledContentArtifact`
- `docsfn/docs/src/lib/components/PresentCompiledDocs.svelte` — duplicate content renderer

**Files updated:**
- `docsfn/docs/src/routes/docs/[...slug]/+page.svelte` — replaced `PresentCompiledDocs` import and usage with `DocsContent` from `@site/docs-content` alias
- `docsfn/docs/src/routes/blog/[slug]/+page.svelte` — same replacement

**Aliases added:**
- `docsfn/docs/vite.config.ts` — added `"@site/docs-content"` → `svelte/src/DocsContent.svelte` and `"@site/docs-layout"` → `svelte/src/DocsLayout.svelte`, plus `"@docsfn/core/browser"` → `core/src/browser.ts`
- `docsfn/docs/svelte.config.js` — added `"@docsfn/core/browser"` alias (critical: SvelteKit aliases take precedence over Vite aliases for imports within svelte source files)

### Fix 4 — Use `DocsLayout` from `@docsfn/svelte` in docs page

**Files changed:**
- `docsfn/svelte/src/DocsLayout.svelte` — added mobile sidebar toggle (Menu button + backdrop overlay with `sidebarOpen` reactive state), added scoped `<style>` block with mobile-first CSS matching what the docs page previously had inline (hidden toolbar on desktop, fixed positioned sidebar on mobile with slide-in transition, backdrop overlay at z-index 30, sidebar at z-index 40).
- `docsfn/docs/src/routes/docs/[...slug]/+page.svelte` — replaced ~100 lines of layout HTML + CSS with `<DocsLayout>` wrapper. The page went from 178 lines to 43 lines.

## Verification

| Check | Result |
|-------|--------|
| `@docsfn/core` build | Pass — all 5 entries built (index, search-runtime, search, analytics, browser) |
| `@docsfn/svelte` build | Pass |
| `docsfn/docs` build | Pass — 302 modules transformed, no errors |
| `@docsfn/core` tests | Pass — 97 tests across 15 test files |
| No `compiled-docs-types.ts` | Confirmed deleted |
| No `PresentCompiledDocs.svelte` | Confirmed deleted |

## Notes

- The `assertCompiledContentTrusted` function in `security.ts` uses `process.env` — this is browser-compatible in Vite/SvelteKit builds (Vite provides `process.env` via define). Including it in the browser entry is safe.
- The `svelte.config.js` alias for `@docsfn/core/browser` was required in addition to the `vite.config.ts` alias. SvelteKit processes its `kit.alias` entries before Vite resolves imports from svelte source files — without the SvelteKit alias, the `@docsfn/core` alias (`→ src/index.ts`) would fire first and Vite would try to load `src/index.ts/browser` (ENOTDIR error).
- `DocsLayout.svelte` now uses Svelte 4 `on:click` event syntax (compatible with both Svelte 4 and 5 in legacy mode). The docs `+page.svelte` uses Svelte 5 `onclick` syntax — this difference is expected since the library targets `^4.0.0 || ^5.0.0`.
- The pre-existing rollup circular dependency warnings in the `@docsfn/core` build (about `provider.ts` ↔ `types.ts`) are unchanged and pre-date this fix.
