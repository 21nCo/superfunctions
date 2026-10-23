# INTENT AUDIT

## Intent Inventory

1. `docsfn` MUST be production-ready enough to replace the current Fumadocs-based docs sites in this repo.
2. The replacement target explicitly includes `datafn/docs`, `searchfn/docs`, and similar current repo docs apps.
3. Existing docs content MUST migrate with config and site-wiring changes, not broad source rewrites.
4. Root docs pages MUST resolve at `/docs`, not `/docs/index`.
5. Nested docs routes MUST continue to resolve correctly.
6. `meta.json` page ordering and grouping semantics MUST be preserved.
7. Existing MDX component constructs in repo docs, especially `Tabs` / `Tab`, MUST continue to render.
8. Mermaid diagrams MUST continue to render.
9. Page chrome MUST remain rich enough for sidebar, TOC, breadcrumbs, pagination, canonical metadata, edit links, and custom page actions.
10. Search MUST work in production.
11. OpenAPI / API reference content MUST work, including YAML-backed specs.
12. Versioned docs MUST work correctly.
13. The Svelte / SvelteKit path MUST be a real migration path, not a nominal adapter only.
14. Package metadata, build outputs, and type declarations MUST be production-safe.
15. Security and validation boundaries MUST be suitable for future pluggable/CMS-backed docs content.
16. `docsfn` MUST remain a headless, framework-agnostic toolkit and not become a bespoke monolithic SSG.
17. `docsfn` MUST support standalone site kits, embedded page mode, embedded docs-surface mode, blog mode, and API reference mode.
18. `docsfn` MUST integrate with `@uifn/*`, `searchfn`, `watchfn`, `authfn`, and `cachefn`.
19. Determinism, cacheability, and stable manifests/search artifacts are required.
20. The implementation MUST include a phased execution plan and release-gating tests on real fixtures.

## Coverage Matrix

| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| `1` | `Overview`, `Goals / Non-goals`, `Semantics`, `Compatibility / Versioning Strategy` | `MIG-001`, `ROUTE-001`, `ROUTE-002`, `NAV-001`, `MDX-001`, `SEARCH-001`, `NEXT-001`, `SVELTE-001`, `PKG-001`, `TEST-001` | `TV-MIG-001`, `TV-ROUTE-001`, `TV-SEARCH-001`, `TV-NEXT-001`, `TV-SVELTE-001`, `TV-PKG-001`, `TV-TEST-001` |
| `2` | `Overview`, `Semantics` | `MIG-001`, `FS-001`, `TEST-001` | `TV-MIG-001`, `TV-FS-001`, `TV-TEST-001` |
| `3` | `Overview`, `Semantics`, `Security` | `CFG-001`, `MIG-001`, `MDX-001`, `CLI-001` | `TV-CFG-001`, `TV-MIG-001`, `TV-MDX-001`, `TV-CLI-001` |
| `4` | `Semantics` | `ROUTE-001`, `NEXT-001`, `SVELTE-001` | `TV-ROUTE-001`, `TV-NEXT-001`, `TV-SVELTE-001` |
| `5` | `Semantics` | `ROUTE-001`, `ROUTE-002`, `NEXT-001`, `SVELTE-001` | `TV-ROUTE-001`, `TV-ROUTE-002`, `TV-NEXT-001`, `TV-SVELTE-001` |
| `6` | `Semantics` | `NAV-001`, `NAV-002`, `MIG-001` | `TV-NAV-001`, `TV-NAV-002`, `TV-MIG-001` |
| `7` | `Semantics` | `MIG-001`, `MDX-001` | `TV-MIG-001`, `TV-MDX-001` |
| `8` | `Semantics` | `MIG-001`, `MDX-001` | `TV-MIG-001`, `TV-MDX-001` |
| `9` | `Semantics`, `Public API` | `PAGE-001`, `NAV-002`, `NEXT-001`, `SVELTE-001` | `TV-PAGE-001`, `TV-NAV-002`, `TV-NEXT-001`, `TV-SVELTE-001` |
| `10` | `Semantics`, `Data Formats / Protocol` | `SEARCH-001`, `SEARCH-002`, `OBS-001`, `TEST-001` | `TV-SEARCH-001`, `TV-SEARCH-002`, `TV-OBS-001`, `TV-TEST-001` |
| `11` | `Semantics` | `API-001`, `API-002`, `TEST-001` | `TV-API-001`, `TV-API-002`, `TV-TEST-001` |
| `12` | `Semantics`, `Compatibility / Versioning Strategy` | `ROUTE-002`, `NEXT-001`, `SVELTE-001`, `TEST-001` | `TV-ROUTE-002`, `TV-NEXT-001`, `TV-SVELTE-001`, `TV-TEST-001` |
| `13` | `Overview`, `Public API`, `Semantics` | `SVELTE-001`, `EMBED-001`, `PKG-001`, `TEST-001` | `TV-SVELTE-001`, `TV-EMBED-001`, `TV-PKG-001`, `TV-TEST-001` |
| `14` | `Compatibility / Versioning Strategy`, `Public API` | `PKG-001`, `CLI-001`, `NEXT-001`, `SVELTE-001` | `TV-PKG-001`, `TV-CLI-001`, `TV-NEXT-001`, `TV-SVELTE-001` |
| `15` | `Security`, `Observability` | `SEC-001`, `CFG-001`, `CMS-001`, `OBS-001` | `TV-SEC-001`, `TV-CFG-001`, `TV-CMS-001`, `TV-OBS-001` |
| `16` | `Goals / Non-goals`, `Public API`, `Semantics` | `CFG-001`, `CMS-001`, `EMBED-001` | `TV-CFG-001`, `TV-CMS-001`, `TV-EMBED-001` |
| `17` | `Goals / Non-goals`, `Semantics`, `Public API` | `BLOG-001`, `EMBED-001`, `API-001`, `API-002`, `NEXT-001`, `SVELTE-001` | `TV-BLOG-001`, `TV-EMBED-001`, `TV-API-001`, `TV-API-002`, `TV-NEXT-001`, `TV-SVELTE-001` |
| `18` | `Overview`, `Observability`, `Security` | `SEARCH-001`, `OBS-001`, `SEC-001`, `CMS-001` | `TV-SEARCH-001`, `TV-OBS-001`, `TV-SEC-001`, `TV-CMS-001` |
| `19` | `Invariants`, `Data Formats / Protocol` | `DET-001`, `CLI-001`, `SEARCH-001`, `TEST-001` | `TV-DET-001`, `TV-CLI-001`, `TV-SEARCH-001`, `TV-TEST-001` |
| `20` | `PLAN`, `Compatibility / Versioning Strategy` | `TEST-001`, `PKG-001`, `CLI-001` | `TV-TEST-001`, `TV-PKG-001`, `TV-CLI-001` |

## Coverage Result

- No missing intent items.
- Corrective edits made while writing the spec:
  - Added an explicit migration compatibility contract for `meta.json`, `Tabs` / `Tab`, and Mermaid.
  - Added explicit root-index routing semantics.
  - Added a fail-closed configuration and search build contract.
  - Added explicit SvelteKit production requirements, including declaration-file emission and safe compiled-content rendering.
  - Added explicit fixture-based release gating using the current repo docs trees.
