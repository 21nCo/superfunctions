# Issue Completion Report

## Metadata

- **Timestamp**: 2026-03-22T20:45:00Z
- **Agent name**: unknown-agent
- **Model**: Claude Sonnet 4.6
- **Launcher**: Cursor
- **Workspace**: `/Users/serro/Documents/dev/n/superfunctions`
- **OS / shell**: darwin / zsh
- **Git**: branch `next`, commit `b69090a`, dirty
- **Issue file**: `docsfn/.conduct/issues/2026-03-22-v8k3m7q2-issue.md`

## Issue Summary

Four bugs prevented docsfn from functioning as a usable documentation framework out of the box:
1. **RC-1**: Three-column layout had no CSS — sidebar and TOC scrolled with main content
2. **RC-2**: Markdown tables were not parsed — pipe-syntax tables appeared as mangled paragraph text
3. **RC-3**: Sidebar groups defaulted to expanded due to inverted `collapsed` boolean; needed to rename to `expanded` with collapsed-by-default semantics
4. **RC-4**: TOC IntersectionObserver used `threshold: 1.0`, which almost never fired, so active heading never highlighted during scroll

## Status: PASS

All four root causes fully resolved. 101/101 core tests pass (4 new table tests added). All packages build cleanly.

---

## Requirements Summary

### RC-1 / Fix 1: Three-column layout CSS

- **Status**: PASS
- **Evidence**: Added `.docsfn-layout`, `.docsfn-container`, `.docsfn-sidebar-col`, `.docsfn-main`, `.docsfn-toc-col` rules to both `svelte/src/theme-base.css` and `react/src/theme-base.css`. Added visual rules (border-right/border-left, background) to both `theme.css` files. Sidebar and TOC are now `position: sticky; top: 0; height: 100vh; overflow-y: auto`. Responsive breakpoints: TOC hidden ≤1279px, sidebar hidden ≤1023px.
- **Test status**: Build-verified. No unit tests for CSS (visual verification required manually).

### RC-2 / Fix 2: Table block support

- **Status**: PASS
- **Evidence**:
  - `CompiledContentBlock` union now includes `{ type: "table"; html: string }`
  - Added `TABLE_ROW_REGEX = /^\|.+\|/`, `isTableStart()`, `parseTableBlock()` to `markdown.ts`
  - `isBlockStart()` now returns `true` for table rows
  - `parseBlocks()` routes table rows to `parseTableBlock()` before paragraph fallback
  - `DocsContent.svelte` renders `{:else if block.type === "table"}{@html block.html}`
  - `DocsContent.tsx` renders `<div dangerouslySetInnerHTML={{ __html: block.html }} />`
  - Table CSS added to both `theme-base.css` (structural) and `theme.css` (visual) in both svelte and react packages
- **Test status**: `src/markdown.test.ts` — 4 new tests all PASS: "parses a markdown table as a table block", "table no longer falls into a paragraph block", "table with alignment syntax", "table mixed with other blocks"

### RC-3 / Fix 3: Sidebar `collapsed` → `expanded`, default collapsed

- **Status**: PASS
- **Evidence**:
  - `SidebarItem.collapsed` renamed to `SidebarItem.expanded` in `docsfn/core/src/types.ts`
  - `SidebarGroup.svelte`: removed `defaultCollapsed` prop; changed `open={!defaultCollapsed && (item.collapsed === false || hasActiveChild)}` to `open={item.expanded === true || hasActiveChild}`
  - `DocsSidebar.svelte`: removed `defaultCollapsedGroups` prop; no longer passes `defaultCollapsed` to `SidebarGroup`
  - `DocsSidebar.tsx`: removed `defaultCollapsedGroups` prop; changed `defaultOpen = defaultCollapsed !== true && (item.collapsed === false || hasActiveChild)` to `defaultOpen = item.expanded === true || hasActiveChild`; removed `defaultCollapsed` from `SidebarGroupProps`
  - `navigation.ts` line 250: updated `collapsed: false` → `expanded: false` (generator-side usage)
- **Test status**: `@docsfn/core` build pass (TypeScript enforces the rename). Existing sidebar tests pass.

### RC-4 / Fix 4: TOC IntersectionObserver threshold

- **Status**: PASS
- **Evidence**:
  - `DocsToc.svelte`: `threshold: 1.0` → `threshold: 0`; callback now uses `for...of` with `break` on first intersecting heading (topmost wins)
  - `DocsToc.tsx`: `threshold: 1` → `threshold: 0`; same break-on-first-match pattern
- **Test status**: Build-verified (no unit tests for browser IntersectionObserver behavior).

---

## Implementation Summary

### Files changed

| File | Change |
|------|--------|
| `docsfn/core/src/markdown.ts` | Added `table` to `CompiledContentBlock`; added `TABLE_ROW_REGEX`, `isTableStart()`, `parseTableBlock()`; updated `isBlockStart()` and `parseBlocks()` |
| `docsfn/core/src/markdown.test.ts` | Added 4 new table block tests (`describe("compileMarkdown – table blocks")`) |
| `docsfn/core/src/types.ts` | Renamed `SidebarItem.collapsed` to `SidebarItem.expanded` |
| `docsfn/core/src/navigation.ts` | Updated `collapsed: false` → `expanded: false` in sidebar builder |
| `docsfn/svelte/src/theme-base.css` | Added three-column layout rules; added table structural CSS |
| `docsfn/svelte/src/theme.css` | Added layout visual rules (sidebar border, toc border); added table visual CSS |
| `docsfn/svelte/src/DocsContent.svelte` | Added `{:else if block.type === "table"}{@html block.html}` branch |
| `docsfn/svelte/src/SidebarGroup.svelte` | Removed `defaultCollapsed` prop; changed `open` to use `item.expanded === true` |
| `docsfn/svelte/src/DocsSidebar.svelte` | Removed `defaultCollapsedGroups` prop; removed `defaultCollapsed` pass-through |
| `docsfn/svelte/src/DocsToc.svelte` | Changed `threshold: 1.0` → `threshold: 0`; first-intersecting wins |
| `docsfn/react/src/theme-base.css` | Added three-column layout rules; added table structural CSS |
| `docsfn/react/src/theme.css` | Added layout visual rules; added table visual CSS |
| `docsfn/react/src/DocsContent.tsx` | Added `table` branch in `renderBlock()` |
| `docsfn/react/src/DocsSidebar.tsx` | Removed `defaultCollapsedGroups`/`defaultCollapsed`; `defaultOpen = item.expanded === true || hasActiveChild` |
| `docsfn/react/src/DocsToc.tsx` | Changed `threshold: 1` → `threshold: 0`; first-intersecting wins |

---

## Verification Summary

| Command | Result |
|---------|--------|
| `cd docsfn/core && npm run build` | ✅ exit 0 |
| `cd docsfn/core && npm test -- --run` | ✅ 101/101 tests pass (15 test files) — 4 new table tests added |
| `cd docsfn/svelte && npm run build` | ✅ exit 0 |
| `cd docsfn/react && npm run build` | ✅ exit 0 |
| `cd docsfn/docs && npm run build` | ✅ exit 0 (126.90 kB server bundle) |

---

## Notes

- The `collapsed` → `expanded` rename is a **breaking API change** for `SidebarItem`. Any external consumers setting `collapsed: false` on sidebar items will need to update to `expanded: true`. Since docsfn is pre-1.0, this is acceptable.
- `navigation.ts` had a hardcoded `collapsed: false` used in the sidebar builder (auto-generated groups). This was updated to `expanded: false` — meaning auto-generated groups now correctly default to collapsed (only active-child groups open).
- The `process is not defined` bug (from `security.ts`) was already fixed in the current session (typeof guard added). That fix is already in the codebase.
- Table CSS uses `border-collapse: collapse` and full-width layout. The `marked` library handles GFM table parsing via `renderBlockHtml()` which calls `marked.parse()` with the table markdown.
- The three-column layout CSS in `theme-base.css` uses `display: grid; grid-template-columns: 16rem 1fr 14rem` on `.docsfn-container`. On mobile (≤1023px), the sidebar column is hidden via `display: none` (mobile drawer from `DocsLayout.svelte`'s scoped styles takes over).
- `DocsLayout.svelte` already has the mobile toolbar and backdrop in scoped styles from the previous issue fix. The new layout CSS in `theme-base.css` complements this for desktop.
