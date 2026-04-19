# BrowseFn Production Readiness Audit

## Metadata

- timestamp: `2026-04-01T10:12:54Z`
- agent_name: `unknown-agent`
- model: `GPT-5 Codex`
- launcher: `Codex Desktop`
- workspace/project path: `repo root` (target package audited: `browsefn/`)
- OS: `Darwin arm64`
- shell: `zsh`
- git: detached `HEAD`, commit `7adae77`, dirty status `clean`
- repo root: `repo root`
- intent/notes paths audited:
  - user request in thread (production-readiness audit for `browsefn` for external use in `nucleus`, with duplication/shared-package analysis)
  - `browsefn/v0.intent.md`
  - `browsefn/README.md`
  - `browsefn/typescript/README.md`
  - `browsefn/python/README.md`
  - `browsefn/.conduct/IMPLEMENTATION.md`
  - `browsefn/.conduct/QUICKSTART.md`
  - `browsefn/python/TESTING.md`
- spec bundle paths audited:
  - authoritative bundle: `browsefn/SPEC.md`
  - contextual repo-convention references reviewed after the independent audit for duplication/docs alignment only, not for browsefn feature pass/fail:
    - `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/{SPEC.md,REQUIREMENTS.md,INTENT_AUDIT.md,RELEASE_GATE.md,TEST_VECTORS.md}`
    - `.conduct/specs/2026-03-15-fix-ifnaigab-spec/{SPEC.md,REQUIREMENTS.md,INTENT_AUDIT.md,TEST_VECTORS.md}`
- codebase scope audited:
  - included: `browsefn/typescript/`, `browsefn/python/`, `browsefn/.conduct/`, `browsefn/SPEC.md`, root `package.json`, `turbo.json`, `packages/middleware/`, `packages/metrics/`, `packages/python-core/superfunctions/http/`
  - excluded: generated `dist/` output, `node_modules/`, any external `nucleus` repository code
- commands executed during audit: see Appendix

## Audit scope

This was a read-only production-readiness audit of `browsefn` for potential consumption by an external application (`nucleus`). The audit covered:

- TypeScript package readiness: packaging, type safety, router surface, provider registration, runtime semantics
- Python package readiness: packaging, runtime/API consistency, router surface, tests, model behavior
- Spec adherence against `browsefn/SPEC.md`
- Intent adherence against `browsefn/v0.intent.md`, package READMEs, quickstart/implementation notes, and the explicit user request
- Code duplication status and opportunities to reuse existing shared superfunctions packages where that would remove duplicated or incomplete local logic

Verdict: `NO-GO` for production integration today.

## Inputs audited (intent + spec bundles)

### Intent / notes inputs

| Source | Role in audit | Key intent extracted |
| --- | --- | --- |
| user request | authoritative intent | Production readiness for real external use; include duplication/shared-package improvement analysis |
| `browsefn/v0.intent.md` | authoritative intent | webpage fetch, batch metadata, image browse/download, geo lookup and geo search |
| `browsefn/README.md` | authoritative public intent | install/import surface, feature set, provider support, quickstart, performance/reliability claims |
| `browsefn/typescript/README.md` | authoritative TS intent | TS install/import surface, TS-specific provider set and feature claims |
| `browsefn/python/README.md` | authoritative Python intent | Python package availability, async unified SDK, example usage |
| `browsefn/.conduct/IMPLEMENTATION.md` | implementation note | claimed architecture, provider set, component semantics |
| `browsefn/.conduct/QUICKSTART.md` | usage note | external developer setup and expected working examples |
| `browsefn/python/TESTING.md` | usage/testing note | claimed test/install flow and Python verification expectations |

### Spec bundle inputs

| Bundle | Authority | Notes |
| --- | --- | --- |
| `browsefn/SPEC.md` | authoritative for browsefn feature/spec pass-fail | Main feature/spec bundle for web, images, geo, provider management, caching, rate limiting, retry, monitoring, security, testing, documentation |
| `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/*` | contextual only | Used to evaluate whether browsefn duplication and shared-package recommendations align with current repo direction |
| `.conduct/specs/2026-03-15-fix-ifnaigab-spec/*` | contextual only | Used to evaluate browsefn docs quality/externally consumable examples; not used as browsefn feature pass-fail authority |

## High-level findings

1. `browsefn` is not currently publishable or integrable as the public TypeScript package its docs advertise. The package metadata, README install/import surface, TypeScript source, and repo naming conventions conflict with each other. The source also fails a transient `tsc` run with real code errors, not just missing local tool installation.
2. The Python implementation is substantially less production-ready than the docs suggest. The test suite does not compile, the metrics model uses aliases inconsistently, the HTTP router passes raw dicts into APIs that expect typed models, and the package metadata/version story is inconsistent.
3. The spec and public docs materially overstate implemented behavior. Firecrawl/Jina providers, custom scraping, storage backends beyond memory, canonical retry/error behavior, production metrics/logging/events, robust image downloading, and full geo provider support are either missing or only partially present.
4. Observability and reliability features are mostly scaffolding. Retry, logging, metrics, and event APIs are instantiated but not wired into request execution. As written, production operators would get empty logs/metrics and no emitted events.
5. Duplication is high for a package this small. `jscpd` found `46` clone blocks across `browsefn/typescript/src` and `browsefn/python/browsefn` with `617` duplicated lines (`8.25%`). The highest-value reductions are already supported by existing shared packages in the monorepo, especially rate limiting and HTTP abstractions.

## Intent Inventory

1. Support fetching a single webpage by URL.
2. Provide a web scrape/crawl interface with multiple providers behind one API.
3. Support batch extraction of webpage metadata for multiple URLs.
4. Support image browse/search behind a provider abstraction.
5. Support image download behind the same abstraction.
6. Support a geo abstraction with multiple map/geocoder providers.
7. Support reverse geocoding from latitude/longitude to an address.
8. Support geo search/place lookup.
9. Be self-hosted and developer-first.
10. Present a unified provider-agnostic interface with fallback behavior.
11. Offer a public TypeScript package that external consumers can install/import as documented.
12. Offer a public Python package that external consumers can install/import as documented.
13. Expose HTTP/router integration for application embedding.
14. Provide caching with TTL and the storage options/public semantics described in docs/spec.
15. Provide rate limiting, retry, and fallback suitable for external app use.
16. Provide metrics, logging, and events for operational visibility.
17. Support documented image search filters and batch-download controls.
18. Support documented geo providers and documented geo operations (geocode, reverse geocode, search, details).
19. Provide accurate quickstart/documentation/examples that work for external consumers and do not depend on private machine setup.
20. Be production-ready enough to embed into another project: buildable, testable, version-consistent, and free of obvious runtime breakage.
21. Avoid needless duplication and reuse existing shared superfunctions packages where they materially improve correctness or maintainability.
22. Follow repository package conventions for naming, layout, and artifact placement.

## Intent → Spec coverage matrix (complete; no sampling)

| Intent ID | Intent statement | Spec coverage | Status |
| --- | --- | --- | --- |
| INT-01 | Single webpage fetch by URL | `Core Features -> 1. Web Scraping & Crawling -> Basic Web Scraping` | Covered |
| INT-02 | Multi-provider web abstraction | `Core Features -> 1. Web Scraping & Crawling -> Multi-Provider Support` | Covered |
| INT-03 | Batch metadata extraction | `Core Features -> 2. Batch Metadata Extraction` | Covered |
| INT-04 | Image browse/search abstraction | `Core Features -> 3. Image Browsing & Search` | Covered |
| INT-05 | Image download abstraction | `Core Features -> 4. Image Downloading` | Covered |
| INT-06 | Geo abstraction | `Core Features -> 5. Geolocation Services` | Covered |
| INT-07 | Reverse geocoding | `Core Features -> 5. Geolocation Services -> Reverse Geocoding` | Covered |
| INT-08 | Geo search/place lookup | `Core Features -> 5. Geolocation Services -> Geo Search / Place Details` | Covered |
| INT-09 | Self-hosted, developer-first | `Overview`, `Core Philosophy` | Covered |
| INT-10 | Unified provider-agnostic interface with fallback | `Overview`, `Provider Management`, `Error Handling & Retry -> Provider Fallback` | Covered |
| INT-11 | Public TS package install/import surface | examples throughout `SPEC.md` import `browsefn` directly | Covered, but conflicts with package metadata |
| INT-12 | Public Python package install/import surface | `SPEC.md` does not define Python packaging details; covered only by README | `SPEC MISSING` |
| INT-13 | HTTP/router integration | architecture tree mentions router files, but `SPEC.md` lacks endpoint contract and adapter semantics | `SPEC MISSING` |
| INT-14 | Caching semantics/storage options | `Caching & Performance -> Response Caching` | Covered |
| INT-15 | Rate limiting/retry/fallback | `Caching & Performance -> Rate Limiting`, `Error Handling & Retry` | Covered |
| INT-16 | Metrics/logging/events | `Monitoring & Analytics` | Covered |
| INT-17 | Image filters/batch download controls | `Image Search Options`, `Batch Image Download`, `Download Options` | Covered |
| INT-18 | Geo provider/operation coverage | `Geolocation Services`, `Provider Support Matrix -> Geo Providers` | Covered |
| INT-19 | Accurate external docs/examples | `Documentation Requirements` | Covered at a high level, acceptance details under-specified |
| INT-20 | Production-ready build/test/version consistency | `Performance Targets`, `Testing Strategy` | Partially covered; packaging/version/CI/release gates are under-specified |
| INT-21 | Duplication reduction/shared package reuse | no browsefn-specific section in `browsefn/SPEC.md` | `SPEC MISSING` |
| INT-22 | Repo package naming/layout conventions | no browsefn-specific section in `browsefn/SPEC.md` | `SPEC MISSING` |

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)

### `browsefn/SPEC.md`

| Status | Count |
| --- | ---: |
| PASS | 0 |
| PARTIAL | 7 |
| FAIL | 11 |
| UNVERIFIED | 0 |

Implicit requirement set audited:

- `BF-SPEC-001` public package install/import contract
- `BF-SPEC-002` web scraping provider surface and option schema
- `BF-SPEC-003` custom scraping script support
- `BF-SPEC-004` batch metadata extraction
- `BF-SPEC-005` image search surface
- `BF-SPEC-006` image download and batch download surface
- `BF-SPEC-007` reverse geocode provider support
- `BF-SPEC-008` forward geocode / geo search / place details support
- `BF-SPEC-009` provider management, fallback, and custom providers
- `BF-SPEC-010` caching backends and cache semantics
- `BF-SPEC-011` rate limiting behavior
- `BF-SPEC-012` retry + canonical error behavior
- `BF-SPEC-013` metrics/logging/events
- `BF-SPEC-014` HTTP router/adapter usability
- `BF-SPEC-015` security controls
- `BF-SPEC-016` testing strategy + performance targets
- `BF-SPEC-017` documentation/quickstart accuracy
- `BF-SPEC-018` Python parity and packaging consistency

## Requirement-by-requirement results (tables + per-requirement notes)

| ID | Statement | Status | Evidence |
| --- | --- | --- | --- |
| BF-SPEC-001 | External consumers can install/import the documented TS package | FAIL | Docs say `npm install browsefn` / `import { browseFn } from 'browsefn'`, but `browsefn/typescript/package.json` publishes `@browsefn/core` and still references `browsefn/ts-sdk` |
| BF-SPEC-002 | Web scraping providers and option schema work as specified | PARTIAL | Cheerio/Puppeteer/Playwright exist, but Firecrawl/Jina are absent, `includeLinks/includeImages` are missing from types, and transient `tsc` reports source errors |
| BF-SPEC-003 | Custom scraping scripts are supported | FAIL | `browsefn/typescript/src/web/scraper.ts` throws `Custom scraping not yet implemented` |
| BF-SPEC-004 | Batch metadata extraction works with concurrency/progress semantics | PARTIAL | TS batch metadata implementation exists; Python omits progress callback and does not use fallback/caching/rate-limit path |
| BF-SPEC-005 | Image search works across documented providers with documented filters | PARTIAL | Unsplash/Pixabay/Pexels search exists in both languages, but there are no provider integration tests and docs overstate production readiness |
| BF-SPEC-006 | Image download and batch download behave as documented | FAIL | TS direct download silently ignores `overwrite: false`; Python providers report success without writing files; transforms/watermarking/metadata handling are missing |
| BF-SPEC-007 | Reverse geocoding supports documented providers | PARTIAL | TS defines Google Maps/Mapbox/Nominatim providers, but `BrowseFn` registers only Nominatim; Python also registers only Nominatim |
| BF-SPEC-008 | Forward geocode / search / details support documented provider set | PARTIAL | Provider classes exist, but registration, naming, and Python router/service contracts are incomplete/broken |
| BF-SPEC-009 | Provider management/fallback/custom providers are supported | PARTIAL | TS `ProviderManager` supports fallback, but Python service methods bypass fallback; config-driven custom provider example is not supported by current types/config loading |
| BF-SPEC-010 | Caching backends and cache semantics match the spec | FAIL | Only in-memory cache exists; `defaultTTL` is referenced but not defined in `CacheConfig`; eviction is FIFO, not LRU; no IndexedDB/file/database backends |
| BF-SPEC-011 | Rate limiting meets documented semantics | PARTIAL | Local fixed-window limiters exist, but they are duplicated, non-persistent, and less complete than repo shared middleware support |
| BF-SPEC-012 | Retry and canonical error behavior work as documented | FAIL | Retry middleware is instantiated but never used; canonical error codes/envelopes do not exist |
| BF-SPEC-013 | Metrics, logging, and events provide operational visibility | FAIL | No request path records metrics or logs; TS/Python event emitters are never called; Python metrics alias usage is broken |
| BF-SPEC-014 | HTTP router/adapters are usable for embedding | FAIL | TS router is part of the broken typecheck surface; Python router passes dicts into typed APIs and will 500 on common paths |
| BF-SPEC-015 | Security controls match the documented/security expectations | FAIL | URL sanitization exists, but there is no SSRF boundary, authz story, credential protection, or download-size/host safety enforcement |
| BF-SPEC-016 | Testing strategy and performance targets are backed by runnable checks | FAIL | No live/provider integration coverage, no browsefn CI gate found, local test tooling is missing, and Python tests do not compile |
| BF-SPEC-017 | Documentation and quickstarts are accurate for outside-world users | FAIL | Package names, paths, versions, status, license, and capability claims conflict across README/spec/implementation notes/testing guide |
| BF-SPEC-018 | Python package reaches feature parity and packaging consistency | FAIL | Python versioning conflicts, router/model APIs break, tests are invalid, and packaging/docs are inconsistent |

Per-requirement notes:

- `BF-SPEC-001`: `browsefn/typescript/package.json:2,44-48` conflicts with `browsefn/README.md:45-53` and `browsefn/typescript/README.md:17-36`. This fails both installability expectations and the repo convention that function packages use simple names like `browsefn`.
- `BF-SPEC-002`: `browsefn/SPEC.md:99-103,196-202` promises Firecrawl/Jina and `includeImages/includeLinks`, but code only implements Cheerio/Puppeteer/Playwright and the extra fields are missing from `GetPageOptions`; `browsefn/typescript/src/web/providers/cheerio.ts:67-69` and the transient compiler run confirmed the mismatch.
- `BF-SPEC-003`: `browsefn/typescript/src/web/scraper.ts:145-158` leaves the advertised custom scraping API unimplemented.
- `BF-SPEC-004`: TS `getMultipleMetadata` is reasonable in shape (`browsefn/typescript/src/web/scraper.ts:78-139`), but Python `browsefn/python/browsefn/web/scraper.py:37-112` omits fallback/caching/rate limiting and intentionally drops the progress callback.
- `BF-SPEC-005`: Search provider implementations exist in both languages (`browsefn/typescript/src/images/providers/*.ts`, `browsefn/python/browsefn/images/providers/*.py`), but the audit found no integration coverage and several surrounding readiness issues that keep this at PARTIAL.
- `BF-SPEC-006`: TS direct download catches its own overwrite error and then proceeds (`browsefn/typescript/src/images/browser.ts:170-176`), so `overwrite: false` does not protect existing files. Python providers return `success=True` and a filename string without writing the file (`browsefn/python/browsefn/images/providers/unsplash.py:122-140`, `pixabay.py:118-130`, `pexels.py:118-130`).
- `BF-SPEC-007`: TS defines `GoogleMapsProvider` and `MapboxProvider`, but `BrowseFn` only registers Nominatim (`browsefn/typescript/src/core/browse-fn.ts:118-122`). Python mirrors the same limitation (`browsefn/python/browsefn/core/browse_fn.py:90-95`).
- `BF-SPEC-008`: TS geo provider naming conflicts with the spec (`googleMaps` in `browsefn/SPEC.md:520,577,657` vs `google-maps` in `browsefn/typescript/src/geo/providers/google-maps.ts:16-19`). Python router/service calls are also malformed (`browsefn/python/browsefn/http/router.py:99-100,117,144,158-160` vs `browsefn/python/browsefn/geo/geocoder.py:14-33`).
- `BF-SPEC-009`: TS fallback support is implemented in `browsefn/typescript/src/core/provider-manager.ts`, but Python services call `get_provider(...)` directly (`browsefn/python/browsefn/web/scraper.py:37-41`, `images/browser.py:14-25`, `geo/geocoder.py:14-33`), so no fallback path is exercised there. The spec’s config-based custom provider example also does not match the current `providers?: Record<string, ProviderConfig>` typing.
- `BF-SPEC-010`: The cache surface is materially incomplete. `browsefn/typescript/src/core/cache-manager.ts:70` uses `defaultTTL`, but `browsefn/typescript/src/core/types.ts` defines only `ttl`; only memory storage exists despite the advertised `indexeddb` / `file` / `database` options.
- `BF-SPEC-011`: Local limiters exist (`browsefn/typescript/src/core/rate-limiter.ts`, `browsefn/python/browsefn/core/rate_limiter.py`), but they are simple in-memory fixed-window counters. The repo already contains a more complete shared limiter at `packages/middleware/src/rate-limit.ts`.
- `BF-SPEC-012`: Retry middleware is created in both language entrypoints (`browsefn/typescript/src/core/browse-fn.ts:58-61`, `browsefn/python/browsefn/core/browse_fn.py:48-51`) but never invoked by the request paths. `SPEC.md` error-code examples (`RATE_LIMIT`, `TIMEOUT`, `PROVIDER_ERROR`) are unsupported.
- `BF-SPEC-013`: The only `emit(...)` occurrences are the method definitions themselves (`browsefn/typescript/src/core/browse-fn.ts:146`, `browsefn/python/browsefn/core/browse_fn.py:108`). No metrics recording or logging calls occur in request execution paths. Python metrics also use aliases incorrectly, confirmed by a direct model check raising `ValueError: "Metrics" object has no field "cacheHitRate"`.
- `BF-SPEC-014`: TS router typechecks only after package/tooling fixes and source fixes; Python router currently serializes models poorly and passes dicts into typed service methods. This is not safe to embed in another application as-is.
- `BF-SPEC-015`: `sanitizeUrl` only restricts protocols (`browsefn/typescript/src/utils/validation.ts:77-85`); there are no private-network/loopback guards, no credential storage strategy, and no auth/authz middleware on the router surfaces.
- `BF-SPEC-016`: Verification posture is weak. `npm test`, `npm run typecheck`, and `npm run build` in `browsefn/typescript/` all fail immediately because local tooling is absent. `pytest` is not present in the environment, and `python3 -m compileall` fails because `browsefn/python/tests/test_middleware.py:65` has an indentation error. I did not find a browsefn-specific CI or release gate.
- `BF-SPEC-017`: Public docs contradict each other: `browsefn/README.md:95-110` still points at `ts-sdk/` and says the Python SDK is “coming soon”, while `browsefn/python/README.md:14` says Alpha and `browsefn/python/TESTING.md:5` says “fully implemented”.
- `BF-SPEC-018`: Python packaging is inconsistent. `browsefn/python/pyproject.toml:7` is `0.0.1`, but `browsefn/python/browsefn/__init__.py:84` exports `0.1.0`. The package depends on `sfns>=0.1.0` while its router imports `superfunctions.http`, which is a repo-local shared package name.

## Spec conflicts / spec gaps (explicit)

### Conflicts

1. Package naming conflict:
   - Docs/spec examples use `browsefn`.
   - TypeScript package metadata publishes `@browsefn/core`.
   - Repo conventions in the supplied `AGENTS.md` say function packages should use the simple package name (`browsefn`).
2. Directory-layout conflict:
   - Docs and package metadata refer to `browsefn/ts-sdk`.
   - Actual implementation directory is `browsefn/typescript`.
3. Provider-set conflict:
   - `browsefn/SPEC.md` and `browsefn/typescript/README.md` mention Firecrawl and Jina AI.
   - Implementation only ships Cheerio/Puppeteer/Playwright for web scraping.
4. Geo provider naming conflict:
   - `browsefn/SPEC.md` uses `googleMaps`.
   - Code uses `google-maps`.
5. License conflict:
   - `browsefn/README.md`, `browsefn/typescript/README.md`, `browsefn/SPEC.md`, and Python metadata say Apache-2.0.
   - `browsefn/typescript/package.json` says MIT.
6. Python-status conflict:
   - `browsefn/README.md` says Python SDK is “coming soon”.
   - `browsefn/python/README.md` says Alpha.
   - `browsefn/python/TESTING.md` says “fully implemented”.
7. Version conflict:
   - `browsefn/python/pyproject.toml` is `0.0.1`.
   - `browsefn/python/browsefn/__init__.py` exposes `0.1.0`.

### Gaps

1. No browsefn-specific spec section defines packaging/version/license/release-gate expectations for external consumption.
2. No browsefn-specific spec section defines canonical HTTP response envelopes or error-code taxonomy for the router surface.
3. No browsefn-specific spec section covers duplication-reduction or shared-package adoption, despite the user explicitly asking for it and the repo having shared packages that already cover some of browsefn’s duplicated logic.
4. The main spec promises security considerations but does not translate them into explicit acceptance criteria (for example SSRF boundaries, credential handling, and download-size caps).

## Cross-cutting audits (security/determinism/limits/errors/compat)

### Security / authz / validation boundaries

- Positive:
  - TS URL sanitization rejects non-HTTP(S) protocols (`browsefn/typescript/src/utils/validation.ts:77-85`).
  - Basic option validation exists in both languages.
- Risks:
  - No SSRF protection for loopback/private networks, DNS rebinding, or host allowlists.
  - No auth/authz boundary exists on the TS or Python router endpoints.
  - API keys are kept as plain config values with no secure storage story despite the spec’s “encryption at rest” claim.
  - Download paths/files have no size limits, content-type verification, or path safety checks beyond `path.join`.
  - Nominatim user-agent handling is inconsistent: TS requires `userAgent` structurally; Python defaults to `browsefn/1.0`, which may not match production policy needs.

### Determinism invariants

- Provider ordering is deterministic in TS fallback order, but Python service entrypoints bypass fallback entirely and therefore do not satisfy the documented provider-fallback behavior.
- Observability is non-deterministic from an operator perspective because logs/metrics/events are never emitted on the execution path.
- Python metrics models use snake_case fields while the rest of the code/tests/docs use camelCase aliases; direct verification confirmed alias-style attribute access fails.

### Limits / caps

- Cache eviction is FIFO, not LRU, despite the implementation notes claiming LRU.
- No persistent or storage-backed cache exists even though docs/spec promise memory + IndexedDB + file + database.
- No quota or cap exists for batch image download disk usage.
- No provider-specific backoff or limiter persistence exists; all rate limits reset with process restarts.
- `jscpd` duplication numbers are high enough that bug-fix surface is wider than it should be for a package of this size.

### Error handling + canonical envelopes

- TS router returns `{ success: true, ... }` on success and `{ error: message }` on failure, but without canonical error codes or envelope helpers.
- Python router mirrors that simplistic envelope and additionally passes malformed objects into typed service methods, which will surface as generic `500` errors instead of structured validation failures.
- `SPEC.md` examples mention `error.code` values like `RATE_LIMIT`, `TIMEOUT`, and `PROVIDER_ERROR`; no implementation emits them.

### Compatibility / versioning / migrations

- TS package naming violates both docs and repo conventions.
- Python version export and packaging version differ.
- License metadata differs across TS vs Python/docs/spec.
- No migration guidance exists because the package has not stabilized its public surface enough yet.
- `browsefn/python/TESTING.md` embeds machine-specific absolute paths, which makes the artifact non-portable for other developers.

### Code duplication and shared-package alignment

`jscpd` summary from `npx jscpd browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console`:

- TypeScript: `28` clones, `374` duplicated lines (`9.31%`)
- Python: `18` clones, `243` duplicated lines (`7.01%`)
- Total: `46` clones, `617` duplicated lines (`8.25%`)

Highest-value duplication clusters:

1. Web providers:
   - `browsefn/typescript/src/web/providers/puppeteer.ts`
   - `browsefn/typescript/src/web/providers/playwright.ts`
2. Geo providers:
   - `browsefn/typescript/src/geo/providers/google-maps.ts`
   - `browsefn/typescript/src/geo/providers/mapbox.ts`
   - `browsefn/python/browsefn/geo/providers/*.py`
3. Image providers:
   - `browsefn/typescript/src/images/providers/*.ts`
   - `browsefn/python/browsefn/images/providers/*.py`
4. Router handler boilerplate:
   - `browsefn/typescript/src/router/http-router.ts`
   - `browsefn/python/browsefn/http/router.py`

Shared superfunctions package reuse opportunities:

- `packages/middleware/src/rate-limit.ts`
  - Existing shared limiter already supports fixed-window, sliding-window, token-bucket, persistence, and deterministic reset semantics.
  - This is a better fit than the two duplicated local in-memory rate limiters.
- `packages/http/` and `packages/python-core/superfunctions/http/`
  - BrowseFn is already partially aligned here. Keep using these abstractions instead of creating more router-specific local types.
  - The Python dependency story should align explicitly with the local `superfunctions` package naming rather than drifting to `sfns`.
- `packages/metrics/`
  - The repo already exposes a shared emitter abstraction. BrowseFn should either adopt that for outward metrics emission or deliberately scope a local aggregator with clearer rationale. The current bespoke collectors add duplicated surface without integrating with shared telemetry.

Recommendations on extraction scope:

- Use existing shared packages now for rate limiting and telemetry emission semantics.
- Do not create a new top-level shared package yet for image/geo provider response mapping unless another function actually needs it; first deduplicate within browsefn itself with local internal helpers.

## Recommendations (ranked)

1. Fix the public packaging contract before any `nucleus` integration work.
   - Targets: `INT-11`, `INT-19`, `INT-20`, `INT-22`, `BF-SPEC-001`, `BF-SPEC-017`, `BF-SPEC-018`
   - Actions: rename/publish the TS package as `browsefn`, align directory metadata away from `ts-sdk`, resolve license/version conflicts, and make README install/import examples match reality.
2. Make the TypeScript source typecheck cleanly and remove the broken public API promises.
   - Targets: `INT-01` through `INT-18`, `BF-SPEC-002`, `BF-SPEC-003`, `BF-SPEC-006`, `BF-SPEC-010`, `BF-SPEC-014`
   - Actions: fix current compiler errors, decide whether Firecrawl/Jina/custom scrape are in-scope now, and either implement or remove them from the spec/docs.
3. Repair the Python contract end to end or explicitly downgrade it from “usable SDK” status.
   - Targets: `INT-12`, `INT-13`, `INT-18`, `INT-19`, `INT-20`, `BF-SPEC-014`, `BF-SPEC-017`, `BF-SPEC-018`
   - Actions: fix the router/service model conversions, resolve Pydantic alias usage, make tests syntactically valid, and align version metadata.
4. Replace duplicated local rate-limit behavior with the shared middleware implementation and rationalize telemetry.
   - Targets: `INT-15`, `INT-16`, `INT-21`, `BF-SPEC-011`, `BF-SPEC-013`
   - Actions: adopt `packages/middleware/src/rate-limit.ts` in TS, design the Python equivalent around the shared `superfunctions` ecosystem, and either use `packages/metrics/` or remove the half-wired local collectors until a real telemetry contract exists.
5. Harden download and network safety before exposing this package to a production app.
   - Targets: `INT-05`, `INT-15`, `INT-20`, `BF-SPEC-006`, `BF-SPEC-015`
   - Actions: enforce overwrite semantics, actually persist Python downloads, add size/content-type caps, and define SSRF/network boundary rules.
6. Add runnable gates.
   - Targets: `INT-20`, `INT-21`, `BF-SPEC-016`
   - Actions: add browsefn-specific build/typecheck/test targets to CI, include a Python compile/test step, and add a duplication guard tuned to browsefn’s source paths.
7. Deduplicate provider mapping/normalization internally.
   - Targets: `INT-21`, `BF-SPEC-005`, `BF-SPEC-007`, `BF-SPEC-008`
   - Actions: extract shared helper functions inside browsefn for provider result mapping before considering wider package extraction.
8. Rewrite public docs only after the supported surface is decided.
   - Targets: `INT-19`, `BF-SPEC-017`
   - Actions: remove contradictory status claims, strip machine-specific paths, and ensure examples use the actual package name and currently supported providers.

## Appendix: commands run + environment details

Environment details:

- repo root: `repo root`
- target package: `browsefn/`
- OS: `Darwin arm64`
- shell: `zsh`
- git commit: `7adae77`
- git branch state: detached `HEAD`

Commands run during the audit (expressed repository-relative):

```text
git status --short --branch
git rev-parse --short HEAD
git diff --stat
find browsefn -maxdepth 3 ...
find .conduct/specs -maxdepth 2 -type f | sort
rg --files browsefn
rg -n "browsefn|..." ...
sed -n '...' browsefn/... .conduct/specs/...
nl -ba browsefn/... | sed -n '...'
wc -l browsefn/... .conduct/specs/...
npm test -- --run            (from browsefn/typescript; failed: vitest not installed locally)
npm run typecheck            (from browsefn/typescript; failed: tsc not installed locally)
npm run build                (from browsefn/typescript; failed: tsup not installed locally)
npx -y -p typescript@5.6.3 tsc --noEmit -p browsefn/typescript/tsconfig.json
pytest                       (from browsefn/python; failed: pytest unavailable in local env)
python3 -m compileall browsefn/python/browsefn browsefn/python/tests
npx jscpd browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console
python3 inline checks for Pydantic alias behavior in browsefn/python/browsefn/core/types.py
```

Verification notes:

- I could not run the normal TS or Python test commands end to end in this local environment because the package-local toolchains were not installed.
- I compensated with a transient TypeScript compiler run, Python compile checks, direct model-behavior probes, and static code review.
- The failures cited above are still production-significant because several are source-level errors or doc/package inconsistencies independent of the local missing toolchain.
