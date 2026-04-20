# Requirement IDs

- PKG-001
- API-001
- WEB-001
- WEB-002
- WEB-003
- IMG-001
- IMG-002
- GEO-001
- CACHE-001
- RATE-001
- ERR-001
- OBS-001
- HTTP-001
- PY-001
- SEC-001
- DOC-001
- SHARED-001
- QA-001

## PKG-001

- **Priority**: P0
- **Statement**: BrowseFn MUST present one internally consistent public package contract across TypeScript, Python, documentation, versions, repository paths, and license metadata.
- **Rationale**: `nucleus` cannot safely consume BrowseFn while the package name, version, license, and directory references conflict.
- **Acceptance criteria**:
  - `browsefn/typescript/package.json` publishes as `browsefn`.
  - BrowseFn documentation and metadata use `browsefn/typescript` rather than `browsefn/ts-sdk`.
  - BrowseFn TypeScript and Python package versions match the version exposed in `browsefn/python/browsefn/__init__.py`.
  - BrowseFn package metadata and docs agree on `Apache-2.0`.
  - BrowseFn documentation exposes one accurate Python readiness statement instead of conflicting statuses.
- **Test vectors**: TV-PKG-001, TV-DOC-001
- **Notes**: Workspace membership already exists at the repo root and MUST remain intact.

## API-001

- **Priority**: P0
- **Statement**: BrowseFn MUST expose a canonical, documented SDK surface with normalized provider IDs, alias handling, provider registration, sorted provider listing, and shared router exports in both TypeScript and Python.
- **Rationale**: External consumers need one stable contract instead of language-specific guesswork and doc drift.
- **Acceptance criteria**:
  - TypeScript exports `browseFn`, `BrowseFn`, result/config types, provider classes, and `createBrowseFnRouter`.
  - Python exports `browse_fn`, `BrowseFn`, result/config types, provider classes, and router helpers.
  - Canonical provider IDs match this spec and are emitted consistently.
  - Accepted legacy aliases normalize before internal use.
  - `listProviders()` returns lexicographically sorted canonical provider IDs.
- **Test vectors**: TV-API-001
- **Notes**: Python MAY keep snake_case method names while preserving canonical emitted provider IDs.

## WEB-001

- **Priority**: P0
- **Statement**: `web.getPage()` MUST support the documented provider set, advanced option schema, capability-aware fallback, and canonical `PageResult` semantics.
- **Rationale**: Single-page retrieval is the foundation for metadata, scraping, indexing, and external embedding.
- **Acceptance criteria**:
  - Builtin provider coverage includes `cheerio`, `puppeteer`, `playwright`, `firecrawl`, and `jina`.
  - `GetPageOptions` includes selectors, timeout, headers, cookies, JavaScript, mobile, screenshot, proxy, cache, retry, `includeLinks`, and `includeImages`.
  - Unsupported capabilities produce deterministic fallback or `UNSUPPORTED_PROVIDER_CAPABILITY`.
  - `PageResult.provider` identifies the actual provider used.
  - Requested links and images are included when available.
- **Test vectors**: TV-WEB-001
- **Notes**: Capability checks MUST happen before work is delegated to a provider when possible.

## WEB-002

- **Priority**: P0
- **Statement**: `web.getMultipleMetadata()` MUST provide deterministic batch metadata extraction with ordered results, bounded concurrency, per-item failures, field filtering, and monotonic progress.
- **Rationale**: Batch metadata is a public surface in both the spec and README and must be safe for external callers.
- **Acceptance criteria**:
  - Output order matches input order.
  - The operation returns one result entry per URL even when some URLs fail.
  - Field filtering preserves `url` and excludes unrequested fields.
  - Progress callbacks increase monotonically and end at the total URL count.
  - Oversized batches fail fast with structured validation errors.
- **Test vectors**: TV-WEB-002
- **Notes**: The per-item error payload MUST preserve the URL index position through result ordering.

## WEB-003

- **Priority**: P1
- **Statement**: `web.scrape()` MUST support custom script execution for script-capable browser providers and MUST reject unsupported providers with structured errors.
- **Rationale**: The current public spec advertises custom scraping, and silent omission leaves a hole in the documented contract.
- **Acceptance criteria**:
  - `puppeteer` and `playwright` can execute caller-provided scraping scripts.
  - The custom scrape result resolves to the script return value without transport wrapper mutation.
  - Calling `scrape()` against a provider without script execution support fails with `UNSUPPORTED_PROVIDER_CAPABILITY`.
  - Router surfaces do not accept arbitrary caller scripts.
- **Test vectors**: TV-WEB-003
- **Notes**: This requirement is library-only by design.

## IMG-001

- **Priority**: P0
- **Statement**: BrowseFn MUST support normalized image search across `unsplash`, `pixabay`, and `pexels` with the documented filters and result shape.
- **Rationale**: External callers need one reliable image-search model regardless of upstream provider quirks.
- **Acceptance criteria**:
  - The search surface supports the documented providers and filters.
  - `ImageSearchResult.provider` and each `ImageResult.source.provider` use canonical IDs.
  - Result pagination fields are normalized across providers.
  - Invalid filter values fail with `INVALID_ARGUMENT`.
- **Test vectors**: TV-IMG-001
- **Notes**: Provider-specific filter downgrades MUST be documented and surfaced deterministically.

## IMG-002

- **Priority**: P0
- **Statement**: BrowseFn MUST implement real single and batch image downloads, including overwrite protection, transforms, metadata inclusion, progress reporting, and per-item failure semantics.
- **Rationale**: A production consumer cannot trust download results that do not correspond to actual files on disk.
- **Acceptance criteria**:
  - `images.download()` writes the file it reports in `DownloadResult.path`.
  - `overwrite: false` prevents replacing existing files and returns `DOWNLOAD_EXISTS`.
  - `images.downloadBatch()` preserves input order and reports progress monotonically.
  - Transform options are applied or rejected before writing any file.
  - Download results include normalized metadata when requested.
- **Test vectors**: TV-IMG-002
- **Notes**: Returning success without a file write is explicitly forbidden.

## GEO-001

- **Priority**: P0
- **Statement**: BrowseFn MUST provide reverse geocoding, forward geocoding, search, and place details with normalized results across `nominatim`, `google-maps`, and `mapbox`.
- **Rationale**: The public BrowseFn contract treats geo operations as first-class capabilities, not optional placeholders.
- **Acceptance criteria**:
  - Builtin provider coverage includes `nominatim`, `google-maps`, and `mapbox`.
  - `reverseGeocode()`, `geocode()`, and `search()` work for all builtin geo providers.
  - `getPlaceDetails()` works for `google-maps` and `mapbox`.
  - `nominatim` detail behavior is deterministic and documented as partial or unsupported.
  - Results normalize to the canonical `ReverseGeocodeResult` and `GeoPlace` shapes.
- **Test vectors**: TV-GEO-001, TV-GEO-002
- **Notes**: Input aliases such as `googleMaps` MUST normalize to `google-maps`.

## CACHE-001

- **Priority**: P0
- **Statement**: BrowseFn MUST implement consistent cache semantics across memory, IndexedDB, file, and database backends, including alias normalization, invalidation, clearing, and stats.
- **Rationale**: Cache behavior affects correctness, cost, and reproducibility for every BrowseFn operation.
- **Acceptance criteria**:
  - `CacheConfig.ttl` is canonical and `defaultTTL` is only an input alias.
  - Supported backends are `memory`, `indexeddb`, `file`, and `database`.
  - Unsupported backends fail fast instead of silently falling back.
  - Cache stats report hits, misses, size, and hit rate.
  - Cache invalidation and clear behavior are backend-agnostic.
- **Test vectors**: TV-CACHE-001
- **Notes**: Cache keys MUST use normalized provider IDs and normalized URLs.

## RATE-001

- **Priority**: P0
- **Statement**: BrowseFn MUST enforce deterministic global and per-provider rate limits and the TypeScript implementation MUST delegate rate-limit algorithm logic to the shared `@superfunctions/middleware/rate-limit` package.
- **Rationale**: Production rate-limit behavior must be correct, consistent, and not duplicated unnecessarily inside BrowseFn.
- **Acceptance criteria**:
  - BrowseFn supports one global limiter and one limiter per provider.
  - Rate-limit status reports remaining requests, reset time, and total limit.
  - TypeScript rate-limit implementation reuses the shared middleware package instead of owning a parallel algorithm implementation.
  - Rate-limit violations surface as `RATE_LIMITED`.
  - Fallback and retry logic respect rate-limit outcomes.
- **Test vectors**: TV-RATE-001, TV-SHARED-001
- **Notes**: Python MUST match the public contract even if it cannot directly import the TypeScript shared middleware.

## ERR-001

- **Priority**: P0
- **Statement**: BrowseFn MUST expose canonical error codes, structured retry behavior, and deterministic fallback semantics across SDK and router surfaces.
- **Rationale**: External applications need machine-readable failures, not ad hoc strings.
- **Acceptance criteria**:
  - Canonical error codes match this spec.
  - Retry behavior honors configured status codes and backoff mode.
  - Fallback follows the declared provider order and records the actual provider used.
  - Exhausted retries and upstream failures surface structured errors with stable codes.
  - Router status codes map consistently from service-layer errors.
- **Test vectors**: TV-ERR-001, TV-HTTP-001
- **Notes**: Generic `Error.message` output alone does not satisfy this requirement.

## OBS-001

- **Priority**: P0
- **Statement**: BrowseFn MUST collect structured metrics, logs, and events for every completed operation while redacting secrets.
- **Rationale**: Production integration requires observability without leaking credentials or signed URLs.
- **Acceptance criteria**:
  - Metrics report request counts, failures, average duration, and cache hit rate.
  - Logs capture provider, outcome, fallback, and retry context.
  - Supported events include `request`, `response`, `error`, `cache.hit`, `cache.miss`, `rateLimit`, and `provider.fallback`.
  - Logged and emitted data redact API keys, cookies, and authorization headers.
  - Metrics and logs reflect cache hits and misses accurately.
- **Test vectors**: TV-OBS-001
- **Notes**: Secret redaction applies to both success and failure paths.

## HTTP-001

- **Priority**: P0
- **Statement**: BrowseFn MUST expose a router contract built on shared superfunctions HTTP abstractions with canonical envelopes, strict validation, and consistent status-code mapping.
- **Rationale**: The router is the stable embedding surface for server applications and must not bypass validation or type conversion.
- **Acceptance criteria**:
  - The TypeScript router uses `@superfunctions/http`.
  - The Python router uses `superfunctions.http`.
  - Router endpoints match the paths and payloads defined in this spec.
  - Success and error payloads always use the canonical envelopes.
  - Router validation rejects malformed requests before invoking provider code.
- **Test vectors**: TV-HTTP-001, TV-PY-001
- **Notes**: Screenshot bytes MUST be serialized explicitly rather than leaking binary buffers into JSON.

## PY-001

- **Priority**: P0
- **Statement**: The Python BrowseFn package MUST provide typed, working parity for the documented web, image, geo, metrics, and router behaviors instead of remaining a partially wired placeholder.
- **Rationale**: Current docs and code conflict on whether the Python package exists, is alpha, or is fully implemented.
- **Acceptance criteria**:
  - Python models, services, and router conversions use consistent field aliases and internal attribute access.
  - Python tests compile and pass for the documented public surface.
  - The Python package supports the documented web, image, and geo operations.
  - The Python router converts dict-like input into typed models before service invocation.
  - Python version metadata matches package metadata and docs.
- **Test vectors**: TV-PY-001, TV-PKG-001
- **Notes**: This requirement does not require Python method names to match TypeScript casing.

## SEC-001

- **Priority**: P0
- **Statement**: BrowseFn MUST enforce explicit SSRF, path-safety, redirect, payload-size, and secret-handling boundaries suitable for production use.
- **Rationale**: External HTTP fetching and file writes are high-risk surfaces that cannot remain loosely validated.
- **Acceptance criteria**:
  - Private-network and loopback destinations are blocked by default on the router surface.
  - Download paths reject traversal and remain inside the destination root.
  - Redirect counts and payload-size caps are enforced before completion.
  - Credentials never appear in logs, metrics, or emitted events.
  - Allowing private hosts requires explicit opt-in configuration.
- **Test vectors**: TV-SEC-001, TV-OBS-001
- **Notes**: This requirement applies to both direct fetches and provider-specific requests.

## DOC-001

- **Priority**: P0
- **Statement**: BrowseFn documentation, quickstarts, examples, and testing guides MUST accurately describe the supported public surface and MUST remain machine-portable.
- **Rationale**: Production readiness includes documentation that external consumers can actually follow.
- **Acceptance criteria**:
  - BrowseFn docs use the canonical package names, provider IDs, paths, and readiness claims.
  - BrowseFn docs do not contain absolute machine-specific filesystem paths.
  - BrowseFn docs do not advertise unspecified dashboard or CLI surfaces.
  - Example code uses real imports and real APIs exposed by the package.
  - Verification commands run from repository-relative paths.
- **Test vectors**: TV-DOC-001
- **Notes**: Contradictory status labels such as “coming soon” and “fully implemented” are not allowed.

## SHARED-001

- **Priority**: P1
- **Statement**: BrowseFn MUST reduce avoidable duplication by reusing shared superfunctions packages where available and by extracting repeated BrowseFn logic into single per-language modules where no shared package exists.
- **Rationale**: The audit found unnecessary duplication and incomplete local implementations where shared packages already exist.
- **Acceptance criteria**:
  - TypeScript router code continues to use `@superfunctions/http`.
  - TypeScript rate limiting delegates algorithm/state management to `@superfunctions/middleware/rate-limit`.
  - Python router code continues to use `superfunctions.http`.
  - Canonical provider alias normalization is implemented once per language rather than repeated across providers.
  - Combined duplication across `browsefn/typescript/src` and `browsefn/python/browsefn` is reduced to `<= 5.0%` under the documented `jscpd` command.
- **Test vectors**: TV-SHARED-001
- **Notes**: “Single per-language module” allows small wrappers but forbids repeated copies of the same algorithm.

## QA-001

- **Priority**: P0
- **Statement**: BrowseFn MUST ship with a complete local verification gate covering TypeScript build/typecheck/tests, Python compile/tests, docs portability, router smoke checks, and duplication thresholds.
- **Rationale**: Audit findings must be prevented from returning, not just patched once.
- **Acceptance criteria**:
  - TypeScript build, typecheck, and tests are runnable locally from the repo root.
  - Python install, compile, and tests are runnable locally from the repo root.
  - The duplication check is runnable locally from the repo root.
  - Docs portability and stale-claim checks are runnable locally from the repo root.
  - The final production gate documents a single pass/fail command set for BrowseFn release readiness.
- **Test vectors**: TV-QA-001, TV-DOC-001, TV-SHARED-001
- **Notes**: CI integration is recommended but local verifiability is the minimum bar in this spec.
