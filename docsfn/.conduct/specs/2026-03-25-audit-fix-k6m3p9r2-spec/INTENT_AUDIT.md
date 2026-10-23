# INTENT AUDIT

## Intent Inventory

1. `docsfn` MUST be production-ready enough to replace Fumadocs across repo docs sites.
2. The replacement target explicitly includes `datafn/docs`, `searchfn/docs`, and similar sibling docs apps.
3. `docsfn/docs` MUST be the real dogfood bar.
4. React/Next MUST be a usable migration path.
5. Svelte/SvelteKit MUST be a usable migration path.
6. Migration MUST not require broad source rewrites.
7. Root docs pages MUST resolve at `/docs`.
8. Nested docs routes MUST resolve correctly.
9. Versioned docs MUST remain consistent between build-time and runtime helpers.
10. `meta.json` ordering/grouping/root/hidden semantics MUST remain intact.
11. Fumadocs Tabs/Tab syntax MUST render functionally after migration.
12. Mermaid fences MUST render functionally after migration.
13. Custom component blocks MUST render through explicit mappings or fail closed.
14. Rich docs chrome MUST remain available: top nav, sidebars, breadcrumbs, pagination, TOC, edit metadata.
15. Search MUST work across docs, api, and blog with truthful scopes.
16. Search UI MUST remain keyboard accessible.
17. Hand-written API reference pages and OpenAPI-generated routes MUST both work.
18. Blog and RSS MUST continue to work.
19. Embedded page and embedded docs-surface modes MUST continue to work.
20. Unsafe HTML, auth gates, and redaction MUST remain fail-closed.
21. Artifacts and proof outputs MUST be deterministic.
22. Package exports, types, and peer ranges MUST match documented imports.
23. Public guides and READMEs MUST use only supported import paths.
24. Public commands MUST not contain machine-specific absolute paths.
25. Example apps MUST be real proof apps, not raw-source placeholders.
26. Release-gate checks MUST catch renderer regressions.
27. Dogfood and example loaders MUST not recompile immutable page content per request.
28. A clean repo checkout MUST be sufficient to run documented bootstrap and verification commands.

## Coverage Matrix

| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| `1` | `Overview`, `Goals / Non-goals`, `Semantics`, `Compatibility / versioning strategy` | `CFG-001`, `CONTENT-001`, `REACT-001`, `SVELTE-001`, `SITE-001`, `GATE-001`, `BUILD-001` | `TV-CFG-001`, `TV-CONTENT-001`, `TV-REACT-001`, `TV-SVELTE-001`, `TV-SITE-001`, `TV-GATE-001`, `TV-BUILD-001` |
| `2` | `Overview`, `Semantics` | `CFG-001`, `EXAMPLE-001`, `GATE-001` | `TV-CFG-001`, `TV-EXAMPLE-001`, `TV-GATE-001` |
| `3` | `Overview`, `Semantics` | `SITE-001`, `DOCS-001`, `CACHE-001` | `TV-SITE-001`, `TV-DOCS-001`, `TV-CACHE-001` |
| `4` | `Overview`, `Public API`, `Semantics` | `REACT-001`, `PKG-001`, `EXAMPLE-001`, `TEST-001` | `TV-REACT-001`, `TV-PKG-001`, `TV-EXAMPLE-001`, `TV-TEST-001` |
| `5` | `Overview`, `Public API`, `Semantics` | `SVELTE-001`, `PKG-001`, `EXAMPLE-001`, `TEST-001` | `TV-SVELTE-001`, `TV-PKG-001`, `TV-EXAMPLE-001`, `TV-TEST-001` |
| `6` | `Overview`, `Semantics` | `CFG-001`, `CONTENT-001`, `API-001`, `SEARCH-001` | `TV-CFG-001`, `TV-CONTENT-001`, `TV-API-001`, `TV-SEARCH-001` |
| `7` | `Semantics`, `Compatibility / versioning strategy` | `CFG-001`, `ROUTE-001` | `TV-CFG-001`, `TV-ROUTE-001` |
| `8` | `Semantics` | `ROUTE-001` | `TV-ROUTE-001` |
| `9` | `Semantics`, `Compatibility / versioning strategy` | `CFG-001`, `ROUTE-001` | `TV-CFG-001`, `TV-ROUTE-001` |
| `10` | `Semantics` | `CFG-001`, `ROUTE-001` | `TV-CFG-001`, `TV-ROUTE-001` |
| `11` | `Public API`, `Semantics`, `Invariants` | `CONTENT-001`, `REACT-001`, `SVELTE-001`, `TEST-001` | `TV-CONTENT-001`, `TV-REACT-001`, `TV-SVELTE-001`, `TV-TEST-001` |
| `12` | `Public API`, `Semantics`, `Security` | `CONTENT-001`, `REACT-001`, `SVELTE-001`, `SEC-001`, `TEST-001` | `TV-CONTENT-001`, `TV-REACT-001`, `TV-SVELTE-001`, `TV-SEC-001`, `TV-TEST-001` |
| `13` | `Public API`, `Semantics`, `Security` | `CONTENT-001`, `REACT-001`, `SVELTE-001`, `SEC-001` | `TV-CONTENT-001`, `TV-REACT-001`, `TV-SVELTE-001`, `TV-SEC-001` |
| `14` | `Semantics` | `ROUTE-001`, `SITE-001`, `EXAMPLE-001` | `TV-ROUTE-001`, `TV-SITE-001`, `TV-EXAMPLE-001` |
| `15` | `Public API`, `Semantics`, `Invariants` | `SEARCH-001`, `API-001`, `SITE-001` | `TV-SEARCH-001`, `TV-API-001`, `TV-SITE-001` |
| `16` | `Semantics` | `SEARCH-001`, `TEST-001` | `TV-SEARCH-001`, `TV-TEST-001` |
| `17` | `Semantics` | `API-001`, `ROUTE-001`, `SEARCH-001` | `TV-API-001`, `TV-ROUTE-001`, `TV-SEARCH-001` |
| `18` | `Semantics` | `BLOG-001`, `SITE-001`, `EXAMPLE-001` | `TV-BLOG-001`, `TV-SITE-001`, `TV-EXAMPLE-001` |
| `19` | `Semantics` | `EMBED-001`, `EXAMPLE-001`, `TEST-001` | `TV-EMBED-001`, `TV-EXAMPLE-001`, `TV-TEST-001` |
| `20` | `Security`, `Observability` | `SEC-001` | `TV-SEC-001` |
| `21` | `Invariants`, `Observability` | `CFG-001`, `CACHE-001`, `GATE-001` | `TV-CFG-001`, `TV-CACHE-001`, `TV-GATE-001` |
| `22` | `Public API`, `Compatibility / versioning strategy` | `PKG-001`, `SVELTE-001`, `DOCS-001` | `TV-PKG-001`, `TV-SVELTE-001`, `TV-DOCS-001` |
| `23` | `Semantics`, `Compatibility / versioning strategy` | `DOCS-001`, `PKG-001` | `TV-DOCS-001`, `TV-PKG-001` |
| `24` | `Semantics`, `Observability` | `DOCS-001`, `BUILD-001` | `TV-DOCS-001`, `TV-BUILD-001` |
| `25` | `Semantics` | `EXAMPLE-001`, `TEST-001`, `GATE-001` | `TV-EXAMPLE-001`, `TV-TEST-001`, `TV-GATE-001` |
| `26` | `Semantics`, `Observability` | `TEST-001`, `GATE-001` | `TV-TEST-001`, `TV-GATE-001` |
| `27` | `Semantics` | `CACHE-001`, `SITE-001`, `EXAMPLE-001` | `TV-CACHE-001`, `TV-SITE-001`, `TV-EXAMPLE-001` |
| `28` | `Overview`, `Observability` | `GATE-001`, `BUILD-001`, `DOCS-001` | `TV-GATE-001`, `TV-BUILD-001`, `TV-DOCS-001` |

## Coverage Result

- No missing intent items.
- Corrective edits made while writing the spec:
  - added a public search-scope override contract so hand-written API pages can truthfully index as `api`
  - made browser-safe Svelte public exports explicit
  - made raw-source fallback explicitly forbidden
  - added compiled-content cache requirements for dogfood/examples
  - added docs contract validation and clean-checkout bootstrap as first-class production requirements
