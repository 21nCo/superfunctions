# Issue Completion — 2026-03-28

**ID:** `2026-03-28-fdpohq7w`
**Source audits:**
- `2026-03-27-m9k4p2r7-full-audit.md` (5 findings: 2 FAIL + 3 PARTIAL)
- `2026-03-28-omwryphm-full-audit.md` (14 findings: 3 FAIL + 11 PARTIAL)
**Model:** Claude Opus 4.6 via Claude Code CLI
**Scope:** Documentation-only fixes (no implementation changes)

---

## Summary

| Category | Findings | Fixed | Skipped |
| --- | --- | --- | --- |
| FAIL (wrong info) | 5 | 5 | 0 |
| PARTIAL (missing/incomplete) | 14 | 14 | 0 |
| **Total** | **19** | **19** | **0** |

All 19 unique findings across both audit reports have been fixed.

---

## Fixes Applied

### From 2026-03-27 re-audit

| ID | Finding | Fix | File |
| --- | --- | --- | --- |
| NEW-F1 | Svelte DocsSidebar `defaultCollapsedGroups` phantom prop | Removed prop from docs; added note about `expanded` behavior | `api/svelte/components.md` |
| NEW-F2 | Svelte SidebarGroup `defaultCollapsed` phantom prop | Removed prop from docs | `api/svelte/components.md` |
| NEW-P1 | React DocsContent `renderMermaid` undocumented | Added to DocsContentProps table | `api/react/components.md` |
| NEW-P2 | `search.routeScopeOverrides` missing from config | Added full field reference with example | `core-concepts/configuration.md` |
| NEW-P3 | Svelte DocsContent `renderMermaid` status | **Confirmed exists** — added `renderMermaid` to Svelte DocsContent props table | `api/svelte/components.md` |

### From 2026-03-28 audit

| ID | Finding | Fix | File |
| --- | --- | --- | --- |
| F1 | Error code count 17 → 19 | Updated heading to "19 codes", added `DOCS_COMPONENT_UNRESOLVED` and `DOCS_SEARCH_SCOPE_INVALID` to table | `core-concepts/diagnostics.md` |
| F2 | Next.js guide wrong package for blog functions | Changed `@docsfn/react` to `@docsfn/next` for `generateBlogParams`/`getPostData` | `guides/nextjs.md` |
| F3 | Customizing guide claims `SidebarGroup` from `@docsfn/react` | Removed `@docsfn/react` reference; updated import example | `guides/customizing-components.md` |
| P1 | `compileMarkdown` base function missing from table | Added to Pipelines table with note about wrapper relationship | `api/core/markdown.md` |
| P2 | `extractHeadings` undocumented | Added full signature and description | `api/core/markdown.md` |
| P3 | `resolveSearchScopeForRoute` undocumented | Added full signature and description | `api/core/search-runtime.md` |
| P4 | `DocsSearchBodyIndexing` type undocumented | Added type definition | `api/core/search-runtime.md` |
| P5 | `DocsSearchDocumentKind` type undocumented | Added type definition | `api/core/search-runtime.md` |
| P6 | `isCanonicalDocsAnalyticsEventName` + `sanitizeDocsAnalyticsEvent` undocumented | Added to emit pipeline table | `api/core/analytics.md` |
| P7 | Security type shapes undocumented | Added 6 interface field tables | `api/core/security.md` |
| P8 | Analytics input types undocumented | Added field tables for `DocsAnalyticsEmitInput` and `CreateDocsAnalyticsEmitterInput` | `api/core/analytics.md` |
| P9 | Svelte DocsContent 3 undocumented props | Expanded to full props table with `blocks`, `renderMermaid` (+ noted `keyPath`/`nested` are internal recursion props) | `api/svelte/components.md` |
| P10 | provider-fs `watch()` missing `collections` param | Added `collections?` to signature and description | `api/provider-fs/index.md` |
| P11 | React DocsContent `renderMermaid` | Added to props table (same as NEW-P1) | `api/react/components.md` |

### Additional cleanup (found during fix pass)

| Fix | File |
| --- | --- |
| Removed `defaultCollapsedGroups` from SvelteKit guide component checklist | `guides/sveltekit.md` |
| Fixed sidebar concepts doc reference to `defaultCollapsedGroups` | `core-concepts/sidebars.md` |
| Removed `SidebarGroup` from Next.js guide `@docsfn/react` components table | `guides/nextjs.md` |
| Added `DocsSearchDocument` full field table | `api/core/search-runtime.md` |

---

## Files Modified (12 total)

1. `docsfn/docs/content/docs/core-concepts/diagnostics.md`
2. `docsfn/docs/content/docs/core-concepts/configuration.md`
3. `docsfn/docs/content/docs/core-concepts/sidebars.md`
4. `docsfn/docs/content/docs/guides/nextjs.md`
5. `docsfn/docs/content/docs/guides/customizing-components.md`
6. `docsfn/docs/content/docs/guides/sveltekit.md`
7. `docsfn/docs/content/docs/api/svelte/components.md`
8. `docsfn/docs/content/docs/api/react/components.md`
9. `docsfn/docs/content/docs/api/core/markdown.md`
10. `docsfn/docs/content/docs/api/core/analytics.md`
11. `docsfn/docs/content/docs/api/core/security.md`
12. `docsfn/docs/content/docs/api/core/search-runtime.md`
13. `docsfn/docs/content/docs/api/provider-fs/index.md`

---

## Verification

- `grep -r "defaultCollapsedGroups" docs/content/` → **0 matches** (all phantom props removed)
- `grep -r "defaultCollapsed" docs/content/` → **0 matches**
- `grep -r "SidebarGroup.*@docsfn/react" docs/content/` → **0 matches**
- Error code table now lists exactly **19** codes matching `DocsErrorCode` union in `core/src/types.ts`
