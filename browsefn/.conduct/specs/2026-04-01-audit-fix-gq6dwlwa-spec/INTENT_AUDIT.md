# Intent Audit

## Intent Inventory

1. BrowseFn is a self-hosted web browsing and data extraction platform.
2. BrowseFn is developer-first.
3. BrowseFn provides a unified provider-agnostic interface.
4. BrowseFn must be production-ready for external use in `nucleus`.
5. TypeScript consumers install and import `browsefn`.
6. Python consumers install `browsefn`.
7. BrowseFn fetches a single webpage by URL.
8. BrowseFn supports multiple web providers behind one API.
9. The documented web providers include Cheerio, Puppeteer, Playwright, Firecrawl, Jina, and custom providers.
10. Page retrieval supports HTML, Markdown, Text, and JSON output.
11. Page retrieval supports selector filtering.
12. Page retrieval supports wait conditions, headers, cookies, JavaScript, mobile mode, screenshots, proxying, cache overrides, and retry overrides.
13. BrowseFn supports batch metadata extraction for multiple URLs.
14. Metadata extraction supports field filtering.
15. Metadata extraction supports concurrency and progress callbacks.
16. BrowseFn supports custom scraping scripts.
17. BrowseFn supports image browsing and search.
18. The documented image providers are Unsplash, Pixabay, and Pexels.
19. Image search supports orientation, color, order, and filter controls.
20. BrowseFn supports image downloading.
21. BrowseFn supports batch image downloading with concurrency and progress/error callbacks.
22. Download options include destination, filename, size, format, quality, resize, crop, watermark, metadata, and overwrite control.
23. BrowseFn supports reverse geocoding.
24. BrowseFn supports forward geocoding.
25. BrowseFn supports geo search.
26. BrowseFn supports place-details lookup.
27. The documented geo providers are Nominatim, Google Maps, and Mapbox.
28. BrowseFn supports provider fallback.
29. BrowseFn supports rate limiting.
30. BrowseFn supports retry behavior.
31. BrowseFn supports caching with TTL and multiple storage backends.
32. BrowseFn exposes metrics, logs, and events.
33. BrowseFn exposes HTTP/router integration for embedding.
34. Docs and quickstarts must work for external consumers.
35. Docs and committed artifacts must be machine-portable.
36. BrowseFn should reuse shared superfunctions packages when they already solve the problem.
37. BrowseFn should reduce code duplication.
38. BrowseFn must follow repo naming/layout conventions for a function package.
39. BrowseFn must be version-consistent and license-consistent.
40. BrowseFn must enforce security boundaries around URLs, downloads, and secrets.
41. Performance targets and testing strategy are part of the intended contract.
42. Dashboard and CLI names appear in legacy architecture notes without shipped behavior.
43. The audit findings themselves are authoritative input for this corrective spec.

## Coverage Mapping

| Intent ID | Intent statement | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- | --- |
| 1 | Self-hosted browsing/data extraction platform | Overview, Goals / Non-goals | PKG-001, API-001 | TV-PKG-001, TV-API-001 |
| 2 | Developer-first | Overview, Goals / Non-goals | DOC-001, QA-001 | TV-DOC-001, TV-QA-001 |
| 3 | Unified provider-agnostic interface | Public API, Data formats / protocol, Invariants | API-001, ERR-001 | TV-API-001, TV-ERR-001 |
| 4 | Production-ready for `nucleus` | Overview, Goals / Non-goals, Compatibility / versioning strategy | PKG-001, QA-001 | TV-PKG-001, TV-QA-001 |
| 5 | TS install/import as `browsefn` | Public API, Packaging and public contract | PKG-001 | TV-PKG-001 |
| 6 | Python install as `browsefn` | Public API, Packaging and public contract | PKG-001, PY-001 | TV-PKG-001, TV-PY-001 |
| 7 | Single webpage fetch by URL | Public API, Semantics -> Web page retrieval | WEB-001 | TV-WEB-001 |
| 8 | Multiple web providers behind one API | Public API, Data formats / protocol, Semantics -> Web page retrieval | API-001, WEB-001 | TV-API-001, TV-WEB-001 |
| 9 | Web providers include Cheerio/Puppeteer/Playwright/Firecrawl/Jina/custom | Public API, Semantics -> Web page retrieval, Custom scraping | WEB-001, WEB-003 | TV-WEB-001, TV-WEB-003 |
| 10 | HTML/Markdown/Text/JSON output | Public API, Semantics -> Web page retrieval | WEB-001 | TV-WEB-001 |
| 11 | Selector filtering | Public API, Semantics -> Web page retrieval | WEB-001 | TV-WEB-001 |
| 12 | waitFor/headers/cookies/JS/mobile/screenshot/proxy/cache/retry overrides | Public API, Semantics -> Web page retrieval | WEB-001, ERR-001, CACHE-001 | TV-WEB-001, TV-ERR-001, TV-CACHE-001 |
| 13 | Batch metadata extraction | Public API, Semantics -> Batch metadata extraction | WEB-002 | TV-WEB-002 |
| 14 | Metadata field filtering | Data formats / protocol, Semantics -> Batch metadata extraction | WEB-002 | TV-WEB-002 |
| 15 | Metadata concurrency and progress callbacks | Semantics -> Batch metadata extraction, Limits / caps | WEB-002 | TV-WEB-002 |
| 16 | Custom scraping scripts | Public API, Semantics -> Custom scraping | WEB-003 | TV-WEB-003 |
| 17 | Image browsing and search | Public API, Semantics -> Image search and download | IMG-001 | TV-IMG-001 |
| 18 | Image providers Unsplash/Pixabay/Pexels | Public API, Semantics -> Image search and download | IMG-001 | TV-IMG-001 |
| 19 | Image search filters | Public API, Semantics -> Image search and download | IMG-001 | TV-IMG-001 |
| 20 | Image downloading | Public API, Semantics -> Image search and download | IMG-002 | TV-IMG-002 |
| 21 | Batch image downloading with callbacks | Public API, Semantics -> Image search and download | IMG-002 | TV-IMG-002 |
| 22 | Download option coverage | Public API, Semantics -> Image search and download, Security | IMG-002, SEC-001 | TV-IMG-002, TV-SEC-001 |
| 23 | Reverse geocoding | Public API, Semantics -> Geo | GEO-001 | TV-GEO-001 |
| 24 | Forward geocoding | Public API, Semantics -> Geo | GEO-001 | TV-GEO-001 |
| 25 | Geo search | Public API, Semantics -> Geo | GEO-001 | TV-GEO-002 |
| 26 | Place-details lookup | Public API, Semantics -> Geo | GEO-001 | TV-GEO-002 |
| 27 | Geo providers Nominatim/Google Maps/Mapbox | Public API, Data formats / protocol, Semantics -> Geo | API-001, GEO-001 | TV-API-001, TV-GEO-001, TV-GEO-002 |
| 28 | Provider fallback | Semantics -> Rate limiting, retry, and fallback, Invariants | ERR-001 | TV-ERR-001 |
| 29 | Rate limiting | Public API, Semantics -> Rate limiting, retry, and fallback | RATE-001 | TV-RATE-001 |
| 30 | Retry behavior | Public API, Semantics -> Rate limiting, retry, and fallback | ERR-001 | TV-ERR-001 |
| 31 | Caching with TTL and multiple storage backends | Public API, Data formats / protocol, Semantics -> Cache | CACHE-001 | TV-CACHE-001 |
| 32 | Metrics, logs, and events | Public API, Observability | OBS-001 | TV-OBS-001 |
| 33 | HTTP/router embedding | Public API, Data formats / protocol, Semantics -> Router semantics | HTTP-001 | TV-HTTP-001, TV-PY-001 |
| 34 | External-consumer docs and quickstarts | Overview, Goals / Non-goals, Compatibility / versioning strategy | DOC-001 | TV-DOC-001 |
| 35 | Machine-portable docs/artifacts | Overview, Compatibility / versioning strategy, Undefined / Explicitly user-deferred only | DOC-001 | TV-DOC-001 |
| 36 | Reuse shared superfunctions packages | Overview, Semantics -> Rate limiting, retry, and fallback, Router semantics | RATE-001, SHARED-001 | TV-RATE-001, TV-SHARED-001 |
| 37 | Reduce code duplication | Goals / Non-goals, Compatibility / versioning strategy | SHARED-001 | TV-SHARED-001 |
| 38 | Follow repo naming/layout conventions | Overview, Packaging and public contract | PKG-001, DOC-001 | TV-PKG-001, TV-DOC-001 |
| 39 | Version/license consistency | Overview, Packaging and public contract, Compatibility / versioning strategy | PKG-001 | TV-PKG-001 |
| 40 | Security boundaries | Security, Limits / caps | SEC-001 | TV-SEC-001, TV-OBS-001 |
| 41 | Performance targets and testing strategy | Overview, Limits / caps, Plan | QA-001 | TV-QA-001 |
| 42 | Dashboard/CLI only appear as legacy architecture notes | Overview -> Assumptions, Undefined / Explicitly user-deferred only | DOC-001 | TV-DOC-001 |
| 43 | Audit findings are authoritative input | Metadata, Overview, Plan | PKG-001 through QA-001 | All vectors |

## Coverage status

No missing intent items.
