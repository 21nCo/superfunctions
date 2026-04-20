# Full Documentation Audit — 2026-03-28

**ID:** `2026-03-28-omwryphm`
**Scope:** All docsfn packages — docs vs implementation (excluding previously reported drifts)
**Model:** Claude Opus 4.6 via Claude Code CLI
**Packages audited:** core, provider-fs, react, svelte, next, sveltekit, cli

---

## Summary

| Severity | Count |
| --- | --- |
| **FAIL** (wrong information) | 3 |
| **PARTIAL** (missing / incomplete) | 11 |
| **PASS** | 3 packages (next, sveltekit, cli) |
| **Total new findings** | 14 |

---

## FAIL — Wrong information in docs

### F1 — Error code count says 17 but implementation has 19

**Location:** `docs/content/docs/core-concepts/diagnostics.md` line 29
**Documented:** "Error codes (17 codes)" — table lists 17 codes
**Actual:** `core/src/types.ts` lines 315-334 defines **19** `DocsErrorCode` values
**Missing from table:**
- `DOCS_COMPONENT_UNRESOLVED`
- `DOCS_SEARCH_SCOPE_INVALID`

Both codes are in the union type but absent from the docs table and count.

---

### F2 — Next.js guide attributes blog functions to `@docsfn/react` instead of `@docsfn/next`

**Location:** `docs/content/docs/guides/nextjs.md` line 240
**Documented:** "Use **`generateBlogParams`**, **`getPostData`** / **`getPostDataOrThrow`**, and **`BlogList`** from **`@docsfn/react`**"
**Actual:** `generateBlogParams` and `getPostData`/`getPostDataOrThrow` are exported from `@docsfn/next` (route-helpers.ts), NOT `@docsfn/react`. Only `BlogList` is from `@docsfn/react`.
**Note:** The reference table on line 258 of the same guide correctly says `@docsfn/next`. The prose contradicts the table.

---

### F3 — Customizing guide claims `SidebarGroup` importable from `@docsfn/react`

**Location:** `docs/content/docs/guides/customizing-components.md` lines 51, 124
**Documented:** "import **`SidebarGroup`** from **`@docsfn/svelte`** or **`@docsfn/react`**" and example `import { DocsContent, SidebarGroup, TopBar } from "@docsfn/react";`
**Actual:** `react/src/index.ts` does NOT export `SidebarGroup`. It is an internal component. Only `@docsfn/svelte` exports it.

---

## PARTIAL — Missing or incomplete documentation

### P1 — `compileMarkdown` base function not in markdown.md function table

**Location:** `docs/content/docs/api/core/markdown.md` lines 10-13
**Issue:** The Pipelines table only lists `compileSvelteContent` and `compileReactContent`. The base `compileMarkdown(input: CompileMarkdownInput): CompiledContentArtifact` function is exported from both `@docsfn/core` and `@docsfn/core/browser` but not listed in the function table. `CompileMarkdownInput` is mentioned on line 15 but the function itself is missing.

---

### P2 — `extractHeadings` function undocumented

**Location:** Not in any doc file
**Source:** `core/src/markdown.ts` line 697 — `export function extractHeadings(markdown: string): DocHeading[]`
**Re-exported from:** `@docsfn/core` (via index.ts → markdown.ts) and `@docsfn/core/browser` (line 91)
**Issue:** Public utility function completely absent from docs.

---

### P3 — `resolveSearchScopeForRoute` function undocumented

**Location:** Not in any doc file
**Source:** `core/src/search.ts` line 195 — `export function resolveSearchScopeForRoute(input: { route: string; kind: DocsSearchDocumentKind; routeScopeOverrides?: DocsSearchRouteScopeOverride[]; }): DocsSearchScope`
**Re-exported from:** `@docsfn/core` (via index.ts → search.ts)
**Issue:** Public function for resolving search scope per-route, completely absent from docs.

---

### P4 — `DocsSearchBodyIndexing` type undocumented

**Location:** Not in any doc file
**Source:** `core/src/search.ts` line 14 — `export type DocsSearchBodyIndexing = "full" | "summary" | "disabled"`
**Issue:** Public type that controls body indexing granularity. Referenced implicitly in diagnostics common-scenarios but never formally defined.

---

### P5 — `DocsSearchDocumentKind` type undocumented

**Location:** Not in any doc file
**Source:** `core/src/search.ts` line 15 — `export type DocsSearchDocumentKind = "page" | "api" | "post"`
**Issue:** Public type used in search scope resolution. Not documented.

---

### P6 — `isCanonicalDocsAnalyticsEventName` and `sanitizeDocsAnalyticsEvent` undocumented

**Location:** `docs/content/docs/api/core/analytics.md` — emit pipeline table only lists `maybeEmitAnalyticsEvent` and `createDocsAnalyticsEmitter`
**Source:** `core/src/analytics.ts` lines 106, 112
**Missing functions:**
- `isCanonicalDocsAnalyticsEventName(value: string): value is DocsAnalyticsEventName` — type guard
- `sanitizeDocsAnalyticsEvent(event: DocsAnalyticsEvent): DocsAnalyticsEvent | null` — sanitization helper

---

### P7 — Security type shapes undocumented

**Location:** `docs/content/docs/api/core/security.md`
**Issue:** Functions are documented but input/output TYPE interfaces are not defined:
- `SourceTrustPolicy` (line 22 of security.ts)
- `AssertSourceEntriesTrustedInput` (line 27)
- `AssertCompiledContentTrustedInput` (line 32)
- `AssertDocsRouteAccessInput` (line 38)
- `DocsRouteAccessResult` (line 47)
- `ResolveUnsafeHtmlAllowlistInput` (line 18)

Users can see the function names but not the shape of what they accept/return without reading source.

---

### P8 — Analytics type shapes undocumented

**Location:** `docs/content/docs/api/core/analytics.md`
**Issue:** `DocsAnalyticsEvent` fields are listed in prose ("Fields include…") but the following types have no field-level documentation:
- `DocsAnalyticsEmitInput` (line 25 of analytics.ts)
- `CreateDocsAnalyticsEmitterInput` (line 33)

---

### P9 — Svelte `DocsContent` has 3 undocumented props

**Location:** `docs/content/docs/api/svelte/components.md`
**Source:** `svelte/src/DocsContent.svelte` lines 15, 24, 25
**Missing props:**
- `blocks: CompiledContentBlock[] | undefined` — allows passing pre-compiled blocks directly, bypassing `compiled` artifact
- `keyPath: string` (default `"root"`) — key prefix for recursive rendering
- `nested: boolean` (default `false`) — suppresses `page-actions` slot when true

`keyPath` and `nested` may be intentionally internal, but `blocks` is a meaningful API alternative to `compiled`.

---

### P10 — provider-fs `watch()` signature missing `collections` parameter

**Location:** `docs/content/docs/api/provider-fs/index.md`
**Issue:** Documentation shows `watch({ config, onChange })` but actual `DocsProviderWatchInput` includes `collections?: DocsCollection[]` as a third parameter.

---

### P11 — React `DocsContent` missing `renderMermaid` in props table

**Location:** `docs/content/docs/api/react/components.md` lines 85-97
**Source:** `react/src/DocsContent.tsx` line 28 — `renderMermaid?: (block: MermaidBlock) => React.ReactNode`
**Issue:** The DocsContentProps table lists 7 props but omits `renderMermaid`.

> **Note:** This was identified in the previous re-audit as NEW-P1. Included here for completeness since it remains unfixed.

---

## PASS — Fully aligned packages

### @docsfn/next — PASS ✓

All 15 functions, 8 types, 5 convenience aliases, and 8 re-exports are accurately documented with correct signatures, parameter types, return types, and defaults. Zero discrepancies.

### @docsfn/sveltekit — PASS ✓

All 39 exports (28 functions + 11 types) are correctly documented. Load factories, static generation helpers, surface resolution, and re-exports all match implementation.

### @docsfn/cli — PASS ✓

All 3 commands (`validate`, `build`, `dev`), all flags (`--root`, `--config`, `--out`, `--out-dir`), defaults, exit codes, artifact outputs, and pipeline stages match documentation exactly. Integration guides reference CLI correctly.

---

## Previously reported (not re-audited)

The following findings from prior audits remain open and were excluded from this audit's scope:

- **NEW-F1** (prior): Svelte DocsSidebar `defaultCollapsedGroups` phantom prop
- **NEW-F2** (prior): Svelte SidebarGroup `defaultCollapsed` phantom prop
- **NEW-P2** (prior): `search.routeScopeOverrides` missing from configuration reference
- **NEW-P3** (prior): Svelte DocsContent `renderMermaid` equivalent needs verification

---

## Methodology

1. Launched 9 parallel audit agents covering: core types, core functions, provider-fs, react, svelte, next, sveltekit, cli, and conceptual docs
2. Each agent read all source files in its package and compared every export against documentation
3. Manually verified every finding via grep/read against source and docs before including in report
4. Filtered out false positives (e.g., internal-only utilities not re-exported, already-documented items)
5. Excluded all findings from previous audit reports (2026-03-26 and 2026-03-27)
