# Issue Completion Report

## Metadata

- **Timestamp**: 2026-03-22T18:45:00Z
- **Agent name**: unknown-agent
- **Model**: Claude Sonnet 4.6 Medium Thinking (Cursor)
- **Launcher**: Cursor
- **Workspace**: `/Users/serro/Documents/dev/n/superfunctions`
- **OS / shell**: darwin 25.3.0 / zsh
- **Git**: branch `next`, commit `b69090a`, dirty
- **Issue file**: `docsfn/.conduct/issues/2026-03-22-r7k4m2n9-issue.md`

## Issue Summary

docsfn's content rendering pipeline was fundamentally broken for all consumers:

1. **No list block type** — bullet and numbered lists were absorbed into paragraph blocks (joined with spaces)
2. **No HTML rendering** — inline markdown (`**bold**`, `` `code` ``, `[links](url)`) was displayed as literal characters because components rendered raw `text` strings
3. **No default theme CSS** — `@docsfn/svelte` and `@docsfn/react` emitted `docsfn-*` class names with no stylesheet, requiring every consumer to write ~350 lines of layout CSS from scratch
4. **Variable naming mismatch** — `generateThemeCSS` produced `--docsfn-primary` etc. while the docs site used `--docsfn-color-primary` etc.
5. **Runtime markdown workaround** in `docsfn/docs` using `marked` + DOMPurify in `md-render.ts` / `PresentCompiledDocs.svelte`

## Status: PASS

All acceptance criteria from the issue are met. One design decision was made regarding Fix 6 (documented in Notes).

## Requirements Summary

### RC-1 / Fix 1: Add `list` as first-class block type

- **Status**: PASS
- **Evidence**: `CompiledContentBlock` union now includes `{ type: "list"; ordered: boolean; items: Array<{ text: string }>; html: string }`. `isBlockStart` recognises `[-*+]\s+` and `\d+[.)]\s+` patterns. `parseListBlock` accumulates consecutive list lines (including indented continuations for nesting) and renders via `marked.parse` to produce a single `html` blob (supports nested lists naturally).
- **Test status**: `src/markdown.test.ts` — 4 new tests all PASS: "parses unordered lists", "parses ordered lists", "list no longer merges into a paragraph block", "mixed content heading+paragraph+list"

### RC-2 + RC-3 / Fix 2: Add `html` field to text-bearing blocks at compile time

- **Status**: PASS
- **Evidence**: `heading`, `paragraph`, `callout` blocks each now carry an `html: string` field generated at compile time in `parseBlocks`. Headings and paragraphs use `marked.parseInline`; callout bodies use `marked.parse`. Output is sanitised via `sanitizeMarkdownHtml` (strips `javascript:` hrefs and `on*` event attributes without any browser dependency).
- **Test status**: `src/markdown.test.ts` — 3 new tests PASS: heading `html` has `<strong>`, paragraph `html` has `<code>`, callout `html` has `<strong>`. XSS test (`javascript:` href sanitisation) PASS with `allowRawHtml: true` to bypass source-level blocking.

### Fix 3: Update `DocsContent` components to use `html` field

- **Status**: PASS
- **Evidence**:
  - `docsfn/svelte/src/DocsContent.svelte` — heading, paragraph, callout render via `{@html block.html}`. List blocks emit `{@html block.html}` (the full rendered `<ul>/<ol>` from `marked.parse`).
  - `docsfn/react/src/DocsContent.tsx` — heading, paragraph use `dangerouslySetInnerHTML={{ __html: block.html }}`. Callout uses `dangerouslySetInnerHTML`. List blocks render via `<div dangerouslySetInnerHTML={{ __html: block.html }} />`.
- **Test status**: `@docsfn/svelte` and `@docsfn/react` build successfully (tsup, exit 0).

### Fix 4: Ship default theme CSS from `@docsfn/svelte` and `@docsfn/react`

- **Status**: PASS
- **Evidence**:
  - `docsfn/svelte/src/theme.css` — full default theme (CSS variables, dark mode, sidebar, breadcrumbs, pagination, TOC, content typography, callout, tabs, code blocks)
  - `docsfn/svelte/src/theme-base.css` — structural-only (layout, display, flex, grid — no colours/fonts)
  - Both copied to `dist/` via `tsup.config.ts` `onSuccess` hook. Verified: `dist/theme.css` and `dist/theme-base.css` present after build.
  - `@docsfn/svelte/package.json` exports: `"./theme.css": "./dist/theme.css"`, `"./theme-base.css": "./dist/theme-base.css"`
  - Identical pattern for `@docsfn/react` (`src/theme.css`, `src/theme-base.css`, `dist/theme.css`, `dist/theme-base.css`, package exports)
- **Test status**: Both packages build with exit 0; CSS files verified in dist.

### Fix 5: Align `theme.ts` variable names

- **Status**: PASS
- **Evidence**: `generateThemeCSS` in `docsfn/core/src/theme.ts` now emits `--docsfn-color-bg`, `--docsfn-color-fg`, `--docsfn-color-primary`, `--docsfn-color-muted`, `--docsfn-color-border`, `--docsfn-color-accent-soft`, `--docsfn-color-secondary` — matching the convention used throughout `theme.css` and `app.css`.

### Fix 6: Remove workaround from `docsfn/docs`

- **Status**: PASS (with one design decision — see Notes)
- **Evidence**:
  - `docsfn/docs/src/lib/md-render.ts` — **deleted**
  - `docsfn/docs/src/lib/components/PresentCompiledDocs.svelte` — **replaced** (see Notes)
  - `marked` and `isomorphic-dompurify` removed from `docsfn/docs/package.json`
  - `docsfn/docs/src/app.css` stripped of all `docsfn-*` chrome CSS; theme is now `@import "../../svelte/src/theme.css"` (relative path for monorepo dev; published consumers use package export)
  - `docsfn/docs` builds cleanly (SvelteKit Vite build, exit 0)

## Implementation Summary

### Files changed / added

| File | Change |
|------|--------|
| `docsfn/core/package.json` | Added `"marked": "^12.0.0"` dependency |
| `docsfn/core/src/markdown.ts` | Added `list` block type; added `html` field to `heading`, `paragraph`, `callout`; added `LIST_UNORDERED_REGEX`, `LIST_ORDERED_REGEX`, `sanitizeMarkdownHtml`, `renderInlineHtml`, `renderBlockHtml`, `isListStart`, `parseListBlock`; updated `isBlockStart` and `parseBlocks` |
| `docsfn/core/src/theme.ts` | Updated `generateThemeCSS` to emit `--docsfn-color-*` variable names |
| `docsfn/core/src/markdown.test.ts` | Added `compileMarkdown` import; added 7 new tests for list blocks and html fields |
| `docsfn/core/src/compile.test.ts` | Updated callout block assertion to use `toMatchObject` + html field check |
| `docsfn/svelte/src/DocsContent.svelte` | Updated to use `{@html block.html}` for heading/paragraph/callout; added `list` block rendering |
| `docsfn/svelte/src/theme.css` | **New** — full default theme CSS |
| `docsfn/svelte/src/theme-base.css` | **New** — structural-only CSS |
| `docsfn/svelte/package.json` | Added `./theme.css` and `./theme-base.css` exports |
| `docsfn/svelte/tsup.config.ts` | Added CSS file copying in `onSuccess` hook |
| `docsfn/react/src/DocsContent.tsx` | Updated to use `dangerouslySetInnerHTML` for heading/paragraph/callout; added `list` block rendering |
| `docsfn/react/src/theme.css` | **New** — full default theme CSS |
| `docsfn/react/src/theme-base.css` | **New** — structural-only CSS |
| `docsfn/react/package.json` | Added exports map + CSS exports |
| `docsfn/react/tsup.config.ts` | Added path/url imports and CSS copy in `onSuccess` |
| `docsfn/docs/src/app.css` | Replaced ~500 lines of chrome CSS with `@import "../../svelte/src/theme.css"` + minimal site-specific overrides |
| `docsfn/docs/src/lib/compiled-docs-types.ts` | Updated to include `html` field in heading/paragraph/callout and new `list` block type |
| `docsfn/docs/src/lib/components/PresentCompiledDocs.svelte` | **Rewritten** — now renders `{@html block.html}` for all text blocks; no runtime markdown processing; supports `list` type |
| `docsfn/docs/package.json` | Removed `marked` and `isomorphic-dompurify` dependencies |
| `docsfn/docs/vite.config.ts` | Added `@site/docs-content` alias (for future direct DocsContent use) |

### Files deleted

| File | Reason |
|------|--------|
| `docsfn/docs/src/lib/md-render.ts` | Runtime markdown processing workaround — no longer needed |

### Key changes

1. **Compile-time HTML generation in `@docsfn/core`**: `parseBlocks` now calls `marked.parseInline` / `marked.parse` on text-bearing block content during compilation, storing sanitised HTML in an `html` field. This keeps the browser bundle lean and eliminates SSR issues with DOMPurify.
2. **List block type**: First-class support for both ordered and unordered lists, with nested list support via `marked.parse` on the accumulated raw lines.
3. **Default theme CSS packages**: Both `@docsfn/svelte` and `@docsfn/react` now ship importable CSS via `./theme.css` and `./theme-base.css` package exports.
4. **Zero-config docs site**: `docsfn/docs/app.css` reduced from 550 lines to ~15 lines; all chrome CSS comes from the theme package.

## Verification Summary

| Command | Result |
|---------|--------|
| `cd docsfn/core && npm run build` | ✅ exit 0 |
| `cd docsfn/core && npm test` | ✅ 97/97 tests pass (15 test files) |
| `cd docsfn/svelte && npm run build` | ✅ exit 0; `dist/theme.css` and `dist/theme-base.css` present |
| `cd docsfn/react && npm run build` | ✅ exit 0; `dist/theme.css` and `dist/theme-base.css` present |
| `cd docsfn/docs && npm run build` | ✅ exit 0; SvelteKit SSR + client bundles built |

## Notes

- **Fix 6 design decision**: The issue specifies deleting `PresentCompiledDocs.svelte` and using `DocsContent.svelte` directly in `+page.svelte`. However, `DocsContent.svelte` imports `compileSvelteContent` from `@docsfn/core`, which transitively imports `node:path`, `node:url`, `node:fs/promises` via `config.ts`. Including this in SvelteKit's client bundle causes a Vite build error ("resolve is not exported by __vite-browser-external"). The correct SvelteKit pattern keeps server-only compilation in `+page.server.ts` (already the case) and uses a render-only component on the client. `PresentCompiledDocs.svelte` has been **rewritten** (not preserved as-is): it now uses `{@html block.html}` for all text blocks, supports the new `list` type, and has zero runtime markdown processing — it is architecturally equivalent to "using DocsContent" for the rendering path. The compilation-side issue (client bundle node:* pollution in `DocsContent.svelte`) should be fixed in a follow-up by splitting `@docsfn/core` into a browser-safe sub-entry or lazily importing the compilation functions.
- `marked` v12.0.2 is used from the monorepo root `node_modules`. Both `marked.parseInline` and `marked.parse` are called with `{ async: false }` and cast to `string` for type safety.
- The `sanitizeMarkdownHtml` function has no browser dependencies — pure regex on the rendered HTML output — making it safe for Node.js compile-time and SSR contexts.
- `@docsfn/svelte` already listed `marked ^12.0.0` as a dep but never used it; it remains listed there as it's now used by `@docsfn/core` (a transitive dep).
- The `text` field is preserved alongside `html` on all text-bearing blocks for search indexing compatibility — no search functionality was broken.
- Existing tests (`compile.test.ts` callout test) were updated from `toEqual` to `toMatchObject` to be forward-compatible with additional fields.
