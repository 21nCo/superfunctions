# Plan

## Architecture sketch

### Docs structure

1. Keep the existing `docs/` Next.js + Fumadocs workspace.
2. Replace the current `shared`, `shared-packages`, `migrations`, and release-note-centric grouping with a category-driven docs tree.
3. Add two machine-readable sources:
   - `docs/lib/package-catalog.ts`
   - `docs/lib/ecosystem-catalog.ts`
4. Drive validation from those catalogs so nav, coverage, and content depth stay aligned.

### Content model

1. `Start Here` pages:
   - `index.mdx`
   - `getting-started.mdx`
   - `choosing-packages.mdx`
   - `ecosystem.mdx`
2. Category overview pages:
   - `authentication/index.mdx`
   - `http/index.mdx`
   - `middleware-runtime/index.mdx`
   - `data-storage/index.mdx`
   - `python/index.mdx`
   - `tooling/index.mdx`
3. Package pages grouped beneath those categories.

### Validation model

1. `check:catalog`
   - validates category coverage, order, and catalog completeness
2. `check:content`
   - validates required pages, required headings, page depth, banned phrases, and example validity
3. `check:snippets`
   - validates real package imports in fenced code blocks
4. `check:links`
   - validates internal docs routes

## Dependency graph

1. Catalog design comes first:
   - category taxonomy
   - package-to-category mapping
   - ecosystem link catalog
2. Start Here pages depend on:
   - final site identity
   - ecosystem catalog
3. Category overview pages depend on:
   - package catalog
   - final sidebar grouping
4. Package page rewrites depend on:
   - category structure
   - canonical README/source material
5. Final QA depends on:
   - complete page set
   - integrated scripts in `docs/package.json`

## Phases overview

| Phase | Goal | Delivered capability | Verification method |
|---|---|---|---|
| 00 | Define catalogs and docs contract | machine-readable package/ecosystem mapping + QA script scaffolding | `npm -w docs run check:catalog` |
| 01 | Rebrand and reframe the root site | site title + Start Here pages + ecosystem framing | `npm -w docs run build` + manual sidebar review |
| 02 | Implement Authentication & OAuth docs group | category overview + full auth/oauth package docs | `npm -w docs run check:content` |
| 03 | Implement HTTP docs group | category overview + core HTTP + adapter pages | `npm -w docs run check:content` |
| 04 | Implement Middleware & Runtime docs group | overview + middleware/runtime package docs | `npm -w docs run check:content` |
| 05 | Implement Data & Storage docs group | overview + db/storage/files package docs | `npm -w docs run check:content` |
| 06 | Implement Python + Tooling docs groups | overview + Python integration pages + tooling pages | `npm -w docs run check:content` |
| 07 | Remove irrelevant legacy docs surfaces and finalize QA | cleaned nav/routes + full local verification suite passing | full docs verification suite |

## Definition of Done

No phase is complete unless its verification steps pass.

The spec is complete only when:

1. All P0 requirements pass their referenced test vectors.
2. The sidebar no longer exposes `Shared Packages`, `migrations`, or release-note/deprecation sections.
3. Every shared package page satisfies the required page contract and content-depth rules.
4. The ecosystem page covers every top-level function in scope.
5. `npm -w docs run build`, `check:catalog`, `check:content`, `check:snippets`, and `check:links` all pass locally.
