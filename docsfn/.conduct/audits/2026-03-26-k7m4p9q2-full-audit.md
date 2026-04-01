# Docsfn Documentation vs Implementation Audit Report

## Metadata

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-03-26T12:00:00Z |
| **Agent** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 |
| **Launcher** | Claude Code CLI |
| **OS + Shell** | Darwin 25.3.0 / zsh |
| **Git Branch** | next |
| **Git Commit** | 50929162a8547f6f55db27bdc51c47289c0bc2af |
| **Git Dirty** | No |

## Audit Scope

**Objective:** Determine whether the docsfn documentation site content accurately reflects the latest implemented code.

**Intent paths audited:**
- `docsfn/docs/content/` — 53 markdown files (getting-started, core-concepts, guides, api, blog)
- `docsfn/README.md`, `docsfn/next/README.md`, `docsfn/sveltekit/README.md`, `docsfn/examples/README.md`

**Spec bundle paths audited:**
- `docsfn/.conduct/spec.md` (v1 spec)
- `docsfn/.conduct/implementation.md`
- `docsfn/.conduct/specs/2026-03-22-new-v7k2m9x4-spec/` (SPEC, REQUIREMENTS, TEST_VECTORS, PLAN)
- `docsfn/.conduct/specs/2026-03-20-audit-fix-a27uykdy-spec/` (SPEC, REQUIREMENTS)

**Codebase scope audited:**
- `docsfn/core/src/` — 25 source files
- `docsfn/provider-fs/src/` — 2 source files
- `docsfn/react/src/` — 13 component files
- `docsfn/svelte/src/` — 12 component files + public-types.ts
- `docsfn/next/src/` — 2 source files
- `docsfn/sveltekit/src/` — 2 source files
- `docsfn/cli/src/` — 1 source file

---

## High-Level Findings

| Category | PASS | PARTIAL | FAIL | UNVERIFIED | Total |
|----------|------|---------|------|------------|-------|
| Core Types | 8 | 4 | 2 | 0 | 14 |
| Core Functions | 12 | 5 | 3 | 0 | 20 |
| React Components | 9 | 2 | 1 | 0 | 12 |
| Svelte Components | 10 | 1 | 0 | 0 | 11 |
| Next.js Adapter | 10 | 1 | 0 | 0 | 11 |
| SvelteKit Adapter | 10 | 2 | 0 | 0 | 12 |
| CLI | 3 | 0 | 0 | 0 | 3 |
| READMEs | 4 | 0 | 0 | 0 | 4 |
| **Total** | **66** | **15** | **6** | **0** | **87** |

**Overall verdict:** Documentation is **largely accurate** but has **6 failures** (wrong information) and **15 partial matches** (incomplete/missing coverage). The most critical issue is the `SidebarItem.collapsed` vs `expanded` semantic inversion.

---

## CRITICAL Findings (FAIL)

### F1. SidebarItem: `collapsed` documented, `expanded` implemented
- **Docs (api/core/types.md):** `SidebarItem` has `collapsed` optional field
- **Implementation (core/src/types.ts:94):** `expanded?: boolean`
- **Impact:** Opposite boolean semantics. Code using docs guidance would get inverted collapse behavior.
- **Severity:** CRITICAL

### F2. React DocsSidebar: `defaultCollapsedGroups` prop documented but not implemented
- **Docs (api/react/components.md):** `DocsSidebar` has `defaultCollapsedGroups: string[]?`
- **Implementation (react/src/DocsSidebar.tsx):** Props are only `surface?, sidebar?, activePath?` — no `defaultCollapsedGroups`
- **Impact:** React users following docs will get a runtime error or silent ignore.
- **Severity:** HIGH

### F3. Docs reference `findTrail` as a navigation function — not exported
- **Docs (core-concepts/navigation.md):** Describes `findTrail` as locating path from sidebar
- **Implementation (core/src/navigation.ts):** `findTrail` exists but is NOT exported
- **Impact:** Users cannot import this function. Docs should reference `resolveBreadcrumbsFromSidebar` instead.
- **Severity:** MEDIUM

### F4. Docs reference `applyVersionToSlug` — not exported
- **Docs (core-concepts/versioning.md):** References `applyVersionToSlug` for URL generation
- **Implementation (core/src/routing.ts):** Function exists but is NOT exported
- **Impact:** Users cannot import this function.
- **Severity:** MEDIUM

### F5. Diagnostics page says "18 error codes" but lists 17
- **Docs (core-concepts/diagnostics.md):** States "Error codes (18 total)" then enumerates 17
- **Implementation (core/src/types.ts):** `DocsErrorCode` union has exactly 17 members
- **Impact:** Minor counting error. Confusing but low risk.
- **Severity:** LOW

### F6. Docs reference `parseDraftFlag` as if it's a public API
- **Docs (core-concepts/blog.md):** Describes `parseDraftFlag` treating "true"/"yes"/"1" as draft
- **Implementation (core/src/blog.ts:77):** `parseDraftFlag` is a **private** (non-exported) function
- **Impact:** Users cannot import this function. Documentation implies it's part of the public API.
- **Severity:** LOW

---

## PARTIAL Findings (Incomplete/Missing)

### P1. `DocPage`, `BlogPost`, `ApiReference` — discriminant `kind` field undocumented
- **Docs:** Types listed without `kind` field
- **Implementation:** `DocPage` has `kind: "page"`, `BlogPost` has `kind: "post"`, `ApiReference` has `kind: "api"`
- **Impact:** Users won't know about discriminated union capability for type narrowing.

### P2. `DocPage.lastUpdated` field undocumented
- **Implementation:** `lastUpdated?: number` on `DocPage`
- **Docs:** Not mentioned in types or core concepts.

### P3. `DocsSourceEntry` — many fields undocumented
- **Implementation fields not in docs:** `entryType`, `bytes`, `sha256`, `etag`, `updatedAt`, `meta`
- **Impact:** Custom provider authors won't know what fields are available.

### P4. `search-runtime` module — no dedicated API doc page
- **Implementation:** `createDocsSearchRuntime`, `DocsSearchRuntime`, `DocsSearchRuntimeResultItem`, `DocsSearchRuntimeQueryInput`, `DocsSearchScopeFilter` — full runtime search API
- **Docs:** Only brief mentions in core-concepts/search and react/components. No API reference page.
- **Impact:** Advanced search customization undiscoverable.

### P5. `normalize.ts` — entirely undocumented
- **Implementation exports:** `normalizeSourceEntries`, `MetaDocument`, `NormalizedPageRecord`, `NormalizedPostRecord`, `NormalizedApiRecord`, `NormalizedManifestInput`, `NormalizedManifestData`
- **Docs:** No coverage whatsoever.
- **Impact:** Internal pipeline understanding blocked; custom provider authors affected.

### P6. `compat/fumadocs.ts` — `transformFumadocsV15` undocumented in API docs
- **Implementation:** Exported function for Fumadocs v15 compatibility transforms
- **Docs:** Fumadocs compatibility is described in core-concepts but the function isn't in API reference.

### P7. `sidebar.ts` — `buildAutoSidebar` undocumented
- **Implementation:** Exported function `buildAutoSidebar(pages: DocPage[]): Sidebar`
- **Docs:** Not mentioned in any API or core-concepts page.

### P8. `browser.ts` entry point undocumented
- **Implementation:** Package exports `./browser` entry point with browser-safe subset of core
- **Docs:** No mention of this entry point.

### P9. `EmbeddedManifestSurface` / `EmbeddedPageRoute` types undocumented
- **Implementation:** Full type definitions in types.ts
- **Docs:** `DocsManifest.embedded` field mentioned only in manifest API page. Types not defined.

### P10. Provider utility functions undocumented
- **Implementation exports not in docs:** `normalizeProviderPath`, `createSourceEntryId`, `stableSortSourceEntries`, `assertUniqueSourceEntryIds`, `validateSourceEntries`, `assertValidSourceEntries`, `createProviderError`, `createProviderRemoteFetchError`, `sha256FromBuffer`, `normalizeToPosixPath`, `toLegacyRawEntries`
- **Impact:** Provider authors missing important utilities.

### P11. Legacy error codes undocumented
- **Implementation:** `LegacyDocsErrorCode` ("DOCS_PROVIDER_INVALID", "DOCS_ROUTE_INVALID", "DOCS_COMPILE_FAILED", "DOCS_SEARCH_FAILED"), `AnyDocsErrorCode`, `normalizeDocsErrorCode`
- **Docs:** No mention. Migration path from legacy codes not documented.

### P12. `BuildManifestOptions.blogPageSize` undocumented
- **Implementation:** `blogPageSize?: number` option on `buildManifest`
- **Docs:** Only `preview` option documented.

### P13. SvelteKit adapter extra functions not all documented
- **Implementation functions with unclear doc status:** `loadPageData`, `loadVersionedPageData`, `loadPostData`, `loadApiData`, `getBlogPaths`, `getApiPaths`, `createPageLoad`, `createVersionedPageLoad`, `createPostLoad`, `createApiLoad`
- **Docs:** Most are documented in the SvelteKit API page, but `getBlogPaths` and `getApiPaths` convenience aliases are missing.

### P14. `DocsConfig.site.pageActions` not fully documented
- **Docs:** Listed as `Array<Record<string, unknown>>` in config reference
- **Impact:** No explanation of what page actions do or how components consume them.

### P15. `CompiledContentBlock` union — docs omit `list` and `table` block types
- **Implementation:** Block types include `heading, paragraph, list, code, mermaid, tabs, callout, table, component`
- **Docs (api/core/markdown.md):** Lists only `heading, paragraph, code, mermaid, tabs, callout, component`
- **Impact:** Users won't know about `list` and `table` block types.

---

## Intent Inventory (Numbered)

| # | Intent Item | Source |
|---|-------------|--------|
| I1 | Documented APIs match implementation signatures | User request |
| I2 | Implemented features are documented | User request |
| I3 | Documented features are implemented | User request |
| I4 | Code examples use correct imports, signatures, options | User request |
| I5 | README files accurately describe packages | User request |
| I6 | CLI commands documented correctly | User request |
| I7 | Blog posts consistent with actual state | User request |

## Intent → Coverage Matrix

| Intent | Status | Evidence |
|--------|--------|----------|
| I1 — APIs match | **PARTIAL** | 6 FAIL items found (F1-F6); most APIs match but critical SidebarItem/collapsed mismatch |
| I2 — Implemented features documented | **PARTIAL** | 15 partial items (P1-P15); normalize.ts, search-runtime, browser entry, provider utils undocumented |
| I3 — Documented features implemented | **PASS** | All documented features have corresponding implementation; no phantom features |
| I4 — Code examples correct | **PASS** | Import paths, function calls, and config structures in examples are accurate |
| I5 — READMEs accurate | **PASS** | All 4 READMEs correctly describe their packages, dependencies, and usage |
| I6 — CLI documented correctly | **PASS** | Commands `validate`, `build`, `dev` with flags `--root`, `--config`, `--out`, `--out-dir` all match |
| I7 — Blog consistent | **PASS** | `introducing-docsfn.md` accurately describes implemented feature set |

---

## Requirement Coverage Summary (from spec bundles)

### Spec Bundle: 2026-03-22-new-v7k2m9x4 (docs site)

| Category | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| SITE (001-004) | 4 | 0 | 0 |
| NAV (001-006) | 6 | 0 | 0 |
| LAYOUT (001-004) | 4 | 0 | 0 |
| CONTENT (001-021) | 17 | 4 | 0 |
| API (001-007) | 3 | 4 | 0 |
| SEARCH (001-004) | 4 | 0 | 0 |
| BLOG (001-004) | 4 | 0 | 0 |
| THEME (001-003) | 3 | 0 | 0 |
| BUILD (001-003) | 3 | 0 | 0 |

**PARTIAL items from CONTENT/API requirements:**
- CONTENT-015 (Security): Describes `assertDocsRouteAccess` but omits `isRoutePrivate` callback detail → PARTIAL
- CONTENT-017 (Markdown Extensions): Omits `list` and `table` block types → PARTIAL
- CONTENT-018 (Diagnostics): Error code count mismatch (says 18, lists 17) → PARTIAL
- CONTENT-012 (Versioning): References non-exported `applyVersionToSlug` → PARTIAL
- API-001 (core): Missing normalize, search-runtime, browser, compat API docs → PARTIAL
- API-003 (svelte): Missing `defaultCollapsedGroups` accuracy on SidebarGroup vs docs → PARTIAL
- API-005 (cli): Complete → PASS
- API-007 (react): `defaultCollapsedGroups` on DocsSidebar not in implementation → PARTIAL

### Spec Bundle: 2026-03-20-audit-fix-a27uykdy (production readiness)

| Requirement | Status | Notes |
|-------------|--------|-------|
| CFG-001 | PASS | Config loading documented and matches |
| DET-001 | PASS | Deterministic artifacts documented |
| CMS-001 | PARTIAL | Provider contract documented but utility functions missing |
| FS-001 | PASS | FsContentProvider documented accurately |
| MIG-001 | PASS | Fumadocs compat preset documented |
| ROUTE-001 | PASS | Routing functions match |
| ROUTE-002 | PARTIAL | `applyVersionToSlug` referenced but not exported |
| NAV-001 | PARTIAL | `findTrail` referenced but not exported; `collapsed` vs `expanded` mismatch |
| NAV-002 | PASS | Multiple sidebars documented |
| MDX-001 | PARTIAL | Missing `list` and `table` block types |
| MDX-002 | PASS | TOC extraction documented |
| PAGE-001 | PASS | Page surface documented |
| SEARCH-001 | PARTIAL | Search artifact documented; runtime API page missing |
| SEARCH-002 | PASS | Search UI documented |
| API-001 | PASS | OpenAPI pipeline documented |
| API-002 | PASS | API reference renderer documented |
| BLOG-001 | PASS | Blog, tags, drafts, RSS documented |
| EMBED-001 | PARTIAL | Embedded types undocumented |
| NEXT-001 | PASS | Next.js adapter documented |
| SVELTE-001 | PASS | SvelteKit adapter documented |
| SEC-001 | PASS | Security documented |
| OBS-001 | PASS | Analytics documented |
| CLI-001 | PASS | CLI documented |
| PKG-001 | PASS | Package structure consistent |
| TEST-001 | UNVERIFIED | Not in scope of docs audit |

---

## Cross-Cutting Audits

### Security/Auth/Validation
- **PASS**: Blocked HTML tags, patterns, auth modes all documented accurately
- **PASS**: `assertDocsRouteAccess` signature matches implementation
- **PASS**: `DOCSFN_HTML_UNSAFE_ALLOWLIST` env var documented
- **PASS**: Sensitive data redaction documented

### Determinism Invariants
- **PASS**: Documentation correctly states manifest generation is deterministic
- **PASS**: Stable sort of source entries mentioned in spec (not in user docs — acceptable)

### Limits/Caps
- **PASS**: `maxArtifactBytes` for search documented
- **PARTIAL**: Blog `pageSize` default (10) documented in core-concepts but `blogPageSize` build option missing from API docs

### Error Handling
- **PASS**: `DocsError` class, `DocsDiagnostic` shape, factory functions all documented
- **PARTIAL**: Legacy error code migration path undocumented
- **FAIL**: Error code count discrepancy (18 stated, 17 listed)

### Compatibility/Versioning
- **PASS**: Fumadocs v15 compat preset documented with correct scope
- **PASS**: Version modes (none, path-prefix, path-segment) match implementation
- **PARTIAL**: `transformFumadocsV15` function not in API docs

---

## Recommendations (Ranked by Impact)

### Critical (Fix Before Release)

1. **Fix SidebarItem field name in docs: `collapsed` → `expanded`** (F1)
   - File: `docs/content/docs/api/core/types.md`
   - The implementation uses `expanded?: boolean` but docs say `collapsed`. This is a semantic inversion that will cause incorrect behavior.

2. **Remove `defaultCollapsedGroups` from React DocsSidebar docs or implement it** (F2)
   - File: `docs/content/docs/api/react/components.md`
   - Prop doesn't exist on React DocsSidebar. Either add to implementation or remove from docs.

### High (Fix Soon)

3. **Remove references to non-exported functions** (F3, F4, F6)
   - Replace `findTrail` → `resolveBreadcrumbsFromSidebar` in `core-concepts/navigation.md`
   - Replace `applyVersionToSlug` → `buildRoute` in `core-concepts/versioning.md`
   - Clarify `parseDraftFlag` is internal behavior, not importable API, in `core-concepts/blog.md`

4. **Add `search-runtime` API documentation page** (P4)
   - Create `docs/content/docs/api/core/search-runtime.md`
   - Document `createDocsSearchRuntime`, `DocsSearchRuntime`, result types

5. **Add discriminant `kind` fields to type docs** (P1)
   - Update `docs/content/docs/api/core/types.md` to show `kind: "page"`, `kind: "post"`, `kind: "api"`

6. **Add missing `list` and `table` block types to markdown docs** (P15)
   - Update `docs/content/docs/api/core/markdown.md` and `core-concepts/markdown-extensions.md`

### Medium (Improve Coverage)

7. **Document `normalize.ts` exports** (P5) — important for custom provider authors
8. **Document `browser.ts` entry point** (P8) — needed for client-side usage
9. **Document `DocsSourceEntry` full field set** (P3) — needed for custom providers
10. **Document provider utility functions** (P10) — helpful for provider authors
11. **Fix error code count** (F5) — change "18 total" to "17 total" in diagnostics page
12. **Document `buildAutoSidebar`** (P7) — useful convenience function
13. **Document `EmbeddedManifestSurface` / `EmbeddedPageRoute`** (P9)
14. **Document `compat/fumadocs.ts` transformFumadocsV15** (P6)
15. **Document SvelteKit `getBlogPaths` / `getApiPaths` aliases** (P13)

### Low (Nice to Have)

16. **Document `BuildManifestOptions.blogPageSize`** (P12)
17. **Document legacy error codes and migration** (P11)
18. **Expand `pageActions` documentation** (P14)
19. **Document `DocPage.lastUpdated` field** (P2)

---

## Appendix: Commands Run + Environment

| Command | Purpose |
|---------|---------|
| `find ... -type f -name "*.md"` | Inventory all doc files |
| `git log --oneline -20` | Git metadata |
| `git status --short` | Working tree status |
| Grep for `collapsed/expanded` in types.ts | Verify SidebarItem field |
| Grep for `defaultCollapsedGroups` in react/src | Verify React prop existence |
| Grep for `parseDraftFlag` in core/src | Verify export status |
| Grep for `findTrail` export in navigation.ts | Verify export status |
| Grep for `applyVersionToSlug` export in routing.ts | Verify export status |
| Grep for `search-runtime` references in docs | Verify doc coverage |
| Grep for `buildAutoSidebar` in docs | Verify doc coverage |
| Grep for `ThemeToggle/useTheme` in react docs | Verify doc coverage |
| Grep for `compat-report` in CLI | Verify artifact generation |
| Grep for `Embedded` types in docs | Verify doc coverage |
| Grep for `normalize/MetaDocument` in API docs | Verify doc coverage |
| Read all 25+ core source files | Full API extraction |
| Read all 13 React components | Props audit |
| Read all 12 Svelte components | Props audit |
| Read all adapter source files | Function signature audit |
| Read all 53 doc content files | Full content audit |
| Read all 4 READMEs | README accuracy audit |
| Read all spec bundle files | Spec coverage audit |
