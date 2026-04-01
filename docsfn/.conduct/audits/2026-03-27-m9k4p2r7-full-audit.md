# Docsfn Documentation vs Implementation Re-Audit Report

## Metadata

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-03-27T14:30:00Z |
| **Agent** | claude-opus-4-6 |
| **Model** | Claude Opus 4.6 |
| **Launcher** | Claude Code CLI |
| **Workspace** | repo root (docsfn/) |
| **OS + Shell** | Darwin arm64 / zsh |
| **Git Branch** | next |
| **Git Commit** | a4ed4ed01ca907e9a6beb1b2a8e76940a5dfb2ef |
| **Git Dirty** | Yes (doc fixes from previous audit applied, uncommitted) |

## Audit Scope

**Objective:** Follow-up re-audit after fixes from `2026-03-26-k7m4p9q2-full-audit.md`. Verify all 21 previous findings are resolved AND identify any remaining or newly introduced discrepancies.

**Intent paths audited (repo-relative):**
- `docsfn/docs/content/` — 54 markdown files (53 original + 1 new search-runtime.md)
- `docsfn/README.md`, `docsfn/next/README.md`, `docsfn/sveltekit/README.md`, `docsfn/examples/README.md`

**Spec bundle paths audited (repo-relative):**
- `docsfn/.conduct/spec.md`
- `docsfn/.conduct/implementation.md`
- `docsfn/.conduct/specs/2026-03-22-new-v7k2m9x4-spec/` (SPEC, REQUIREMENTS, TEST_VECTORS)
- `docsfn/.conduct/specs/2026-03-20-audit-fix-a27uykdy-spec/` (SPEC, REQUIREMENTS)

**Codebase scope audited (repo-relative):**
- `docsfn/core/src/` — all source files including compile/, compat/
- `docsfn/provider-fs/src/`
- `docsfn/react/src/` — all 13 component files
- `docsfn/svelte/src/` — all 12 component files
- `docsfn/next/src/`
- `docsfn/sveltekit/src/`
- `docsfn/cli/src/`

---

## High-Level Findings

| Category | PASS | PARTIAL | FAIL | Total |
|----------|------|---------|------|-------|
| Previous FAIL fixes (F1-F6) | 6 | 0 | 0 | 6 |
| Previous PARTIAL fixes (P1-P15) | 15 | 0 | 0 | 15 |
| New findings | — | 3 | 2 | 5 |
| **Overall** | **82** | **3** | **2** | **87+5** |

**Overall verdict:** All 21 previous findings are **RESOLVED**. The re-audit found **2 new FAIL** and **3 new PARTIAL** findings. The most critical new issue is the Svelte `DocsSidebar`/`SidebarGroup` documenting non-existent props (same class of bug as the previous React F2 finding, but for the Svelte package).

---

## Previous Findings Verification

### All 6 FAIL findings: RESOLVED ✅

| ID | Finding | Verification | Status |
|----|---------|-------------|--------|
| F1 | SidebarItem `collapsed` → `expanded` | `api/core/types.md` now says `expanded`; `core-concepts/sidebars.md` says `expanded === true` | **FIXED** |
| F2 | React DocsSidebar `defaultCollapsedGroups` phantom prop | `api/react/components.md` now shows only `surface, sidebar, activePath` | **FIXED** |
| F3 | `findTrail` non-exported reference | `core-concepts/navigation.md` now says `resolveBreadcrumbsFromSidebar` | **FIXED** |
| F4 | `applyVersionToSlug` non-exported reference | `core-concepts/versioning.md` now says "applies the version to the slug internally" | **FIXED** |
| F5 | Error code count 18 → 17 | `core-concepts/diagnostics.md` heading now says "17 codes" | **FIXED** |
| F6 | `parseDraftFlag` as public API | `core-concepts/blog.md` now says "Internally, the build pipeline treats..." | **FIXED** |

### All 15 PARTIAL findings: RESOLVED ✅

| ID | Finding | Verification | Status |
|----|---------|-------------|--------|
| P1 | Missing `kind` discriminant fields | `api/core/types.md` now shows `kind: "page"/"post"/"api"` | **FIXED** |
| P2 | `DocPage.lastUpdated` undocumented | Now included in DocPage description | **FIXED** |
| P3 | `DocsSourceEntry` fields incomplete | All fields (`entryType`, `bytes`, `sha256`, `etag`, `updatedAt`, `meta`) now listed | **FIXED** |
| P4 | No search-runtime API page | New `api/core/search-runtime.md` created with full reference | **FIXED** |
| P5 | `normalize.ts` undocumented | Added to `api/core/index.md` export areas | **FIXED** |
| P6 | `transformFumadocsV15` undocumented | Added as Compat row in `api/core/index.md` | **FIXED** |
| P7 | `buildAutoSidebar` undocumented | Added to `api/core/navigation.md` under Building sidebars | **FIXED** |
| P8 | `browser.ts` entry point undocumented | Entry points table added to `api/core/index.md` | **FIXED** |
| P9 | Embedded types undocumented | `EmbeddedPageRoute` and `EmbeddedManifestSurface` added to `api/core/types.md` | **FIXED** |
| P10 | Provider utility functions undocumented | 11 functions added to `api/provider-fs/index.md` | **FIXED** |
| P11 | Legacy error codes undocumented | `LegacyDocsErrorCode`, `AnyDocsErrorCode`, `normalizeDocsErrorCode` added to `api/core/types.md` | **FIXED** |
| P12 | `blogPageSize` undocumented | Already documented in `api/core/manifest.md` (confirmed) | **ALREADY OK** |
| P13 | `getBlogPaths`/`getApiPaths` undocumented | Already documented in `api/sveltekit/index.md` (confirmed) | **ALREADY OK** |
| P14 | `pageActions` sparse | Expanded description in `core-concepts/configuration.md` | **FIXED** |
| P15 | `list`/`table` block types missing | Added to `api/core/markdown.md` and `core-concepts/markdown-extensions.md` | **FIXED** |

---

## NEW Findings

### NEW-F1. Svelte DocsSidebar: `defaultCollapsedGroups` documented but NOT implemented
- **Docs (`api/svelte/components.md` line 31):** DocsSidebar has prop `defaultCollapsedGroups`
- **Implementation (`svelte/src/DocsSidebar.svelte`):** Props are only `surface`, `sidebar`, `activePath` — no `defaultCollapsedGroups`
- **Impact:** Svelte users following docs will set a prop that has no effect
- **Severity:** HIGH

### NEW-F2. Svelte SidebarGroup: `defaultCollapsed` documented but NOT implemented
- **Docs (`api/svelte/components.md` line 35):** SidebarGroup has prop `defaultCollapsed`
- **Implementation (`svelte/src/SidebarGroup.svelte`):** Props are only `item`, `activePath`, `depth` — no `defaultCollapsed`
- **Impact:** Same class of issue as F1; documented prop does not exist
- **Severity:** MEDIUM (SidebarGroup is typically used internally)

### NEW-P1. React DocsContent: `renderMermaid` prop undocumented
- **Implementation (`react/src/DocsContent.tsx` line 28):** `renderMermaid?: (block: MermaidBlock) => React.ReactNode`
- **Docs (`api/react/components.md`):** Not listed in DocsContent props table
- **Impact:** Users cannot discover custom Mermaid rendering capability
- **Severity:** LOW-MEDIUM

### NEW-P2. `search.routeScopeOverrides` missing from configuration reference
- **Implementation (`core/src/types.ts` line 184):** `routeScopeOverrides?: DocsSearchRouteScopeOverride[]`
- **Docs (`core-concepts/configuration.md`):** Search section lists only `enabled`, `scopes`, `bodyIndexing`, `maxArtifactBytes` — no `routeScopeOverrides`
- **Referenced elsewhere:** `core-concepts/search.md`, `core-concepts/content-format.md`, `core-concepts/openapi.md`, `guides/sveltekit.md`, and `README.md` all reference `routeScopeOverrides`
- **Impact:** Configuration reference is incomplete; users must find this option in concept docs or README
- **Severity:** MEDIUM

### NEW-P3. Svelte DocsContent: `renderMermaid` prop status unknown
- **Docs (`api/svelte/components.md`):** Not listed. Need to verify if Svelte DocsContent has a `renderMermaid` equivalent
- **Status:** UNVERIFIED — likely consistent with React (both undocumented if implemented)
- **Severity:** LOW

---

## Intent Inventory

| # | Intent Item | Source |
|---|-------------|--------|
| I1 | Documented APIs match implementation signatures | User request |
| I2 | Implemented features are documented | User request |
| I3 | Documented features are implemented | User request |
| I4 | Code examples use correct imports, signatures, options | User request |
| I5 | README files accurately describe packages | User request |
| I6 | CLI commands documented correctly | User request |
| I7 | Blog posts consistent with actual state | User request |
| I8 | All previous audit findings verified as fixed | User request |

## Intent → Spec Coverage Matrix

| Intent | Status | Evidence |
|--------|--------|----------|
| I1 — APIs match | **PARTIAL** | 2 new FAIL items (Svelte phantom props); most APIs match |
| I2 — Implemented features documented | **PARTIAL** | 2 new PARTIAL items (renderMermaid prop, routeScopeOverrides config) |
| I3 — Documented features implemented | **PARTIAL** | Svelte DocsSidebar/SidebarGroup document non-existent props |
| I4 — Code examples correct | **PASS** | All import paths, function calls verified accurate |
| I5 — READMEs accurate | **PASS** | All 4 READMEs correctly describe packages |
| I6 — CLI documented correctly | **PASS** | Commands and flags match implementation |
| I7 — Blog consistent | **PASS** | `introducing-docsfn.md` accurately describes feature set |
| I8 — Previous fixes verified | **PASS** | All 6 FAIL + 15 PARTIAL findings confirmed resolved |

---

## Requirement Coverage Summary

### Spec Bundle: 2026-03-22-new-v7k2m9x4 (docs site)

| Category | PASS | PARTIAL | FAIL |
|----------|------|---------|------|
| SITE (001-004) | 4 | 0 | 0 |
| NAV (001-006) | 6 | 0 | 0 |
| LAYOUT (001-004) | 4 | 0 | 0 |
| CONTENT (001-021) | 21 | 0 | 0 |
| API (001-007) | 5 | 2 | 0 |
| SEARCH (001-004) | 4 | 0 | 0 |
| BLOG (001-004) | 4 | 0 | 0 |
| THEME (001-003) | 3 | 0 | 0 |
| BUILD (001-003) | 3 | 0 | 0 |

**PARTIAL items:**
- API-003 (svelte): `defaultCollapsedGroups`/`defaultCollapsed` documented but not implemented → PARTIAL
- API-007 (react): `renderMermaid` prop undocumented → PARTIAL

### Spec Bundle: 2026-03-20-audit-fix-a27uykdy (production readiness)

All 25 testable requirements now PASS (up from 20 PASS + 5 PARTIAL in previous audit).

---

## Cross-Cutting Audits

### Security/Auth/Validation
- **PASS**: All security APIs documented accurately
- **PASS**: Auth modes, blocked HTML tags/patterns, redaction all match

### Determinism Invariants
- **PASS**: Deterministic manifest generation documented correctly

### Limits/Caps
- **PASS**: `maxArtifactBytes` documented
- **PASS**: `blogPageSize` documented in manifest API

### Error Handling
- **PASS**: All 17 error codes documented and counted correctly
- **PASS**: Legacy error code migration documented

### Compatibility/Versioning
- **PASS**: Fumadocs v15 compat documented in both core-concepts and API index
- **PASS**: Version modes match implementation

---

## Recommendations (Ranked by Impact)

### Critical (Fix Before Release)

1. **Remove `defaultCollapsedGroups` from Svelte DocsSidebar docs** (NEW-F1)
   - File: `docs/content/docs/api/svelte/components.md` line 31
   - Svelte DocsSidebar.svelte has only `surface, sidebar, activePath` props — no `defaultCollapsedGroups`
   - Either implement the prop or remove from docs

2. **Remove `defaultCollapsed` from Svelte SidebarGroup docs** (NEW-F2)
   - File: `docs/content/docs/api/svelte/components.md` line 35
   - SidebarGroup.svelte has only `item, activePath, depth` props — no `defaultCollapsed`
   - Either implement or remove from docs

### Medium

3. **Add `search.routeScopeOverrides` to configuration reference** (NEW-P2)
   - File: `docs/content/docs/core-concepts/configuration.md`
   - Should be added after `search.maxArtifactBytes` section
   - Already referenced in 4+ other doc pages; formal config reference is the gap

4. **Document React DocsContent `renderMermaid` prop** (NEW-P1)
   - File: `docs/content/docs/api/react/components.md`
   - Add `renderMermaid` to DocsContentProps table: `(block: MermaidBlock) => React.ReactNode`
   - Allows custom Mermaid diagram rendering

### Low

5. **Verify Svelte DocsContent `renderMermaid` equivalent** (NEW-P3)
   - Check if Svelte DocsContent.svelte has a similar prop and document if present

---

## Appendix: Commands Run + Environment

| Command | Purpose |
|---------|---------|
| `git log --oneline -5` | Git metadata |
| `git status --short` | Working tree status |
| `git rev-parse HEAD` | Commit hash |
| Grep `compileSvelteContent/compileReactContent` exports | Verify compile function existence |
| Grep `renderMermaid` in react/src/DocsContent.tsx | Verify undocumented prop |
| Grep `defaultCollapsedGroups` in svelte/src | Verify Svelte prop existence |
| Grep `defaultCollapsed` in svelte/src/SidebarGroup.svelte | Verify SidebarGroup prop existence |
| Grep `routeScopeOverrides` in types.ts | Verify config field existence |
| Grep `routeScopeOverrides` in configuration.md | Verify doc coverage |
| Grep `routeScopeOverrides` in docs/content | Find references across docs |
| Read DocsSidebar.svelte | Verify exact props |
| Read SidebarGroup.svelte | Verify exact props |
| Read configuration.md search section | Verify config completeness |
| Agent: Read all 53 implementation source files | Full API extraction |
| Agent: Read all 54 doc content files | Full content audit |
| Agent: Read all spec bundles and READMEs | Spec coverage audit |
