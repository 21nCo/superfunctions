# Metadata

- **timestamp**: `2026-04-01T10:35:11Z`
- **agent_name**: `unknown-agent`
- **model**: `GPT-5 Codex`
- **launcher**: `Codex Desktop`
- **workspace**: `repo root`
- **project_path**: `browsefn/`
- **os**: `Darwin arm64`
- **shell**: `zsh`
- **git.branch**: `HEAD (detached)`
- **git.commit**: `7adae77`
- **git.dirty**: `true`
- **spec_folder**: `2026-04-01-audit-fix-gq6dwlwa-spec`
- **spec_path**: `browsefn/.conduct/specs/2026-04-01-audit-fix-gq6dwlwa-spec`
- **spec_type**: `audit-fix`
- **spec_id**: `gq6dwlwa`
- **input_paths**:
  - in-thread user request to produce an audit-fix spec for `browsefn` so it can be used in `nucleus`
  - `browsefn/.conduct/audits/2026-04-01-svro1wy9-full-audit.md`
  - `browsefn/v0.intent.md`
  - `browsefn/SPEC.md`
  - `browsefn/README.md`
  - `browsefn/typescript/README.md`
  - `browsefn/python/README.md`
  - `browsefn/.conduct/IMPLEMENTATION.md`
  - `browsefn/.conduct/QUICKSTART.md`
  - `browsefn/python/TESTING.md`
  - `browsefn/typescript/package.json`
  - `browsefn/typescript/src/index.ts`
  - `browsefn/typescript/src/core/types.ts`
  - `browsefn/typescript/src/core/browse-fn.ts`
  - `browsefn/typescript/src/web/scraper.ts`
  - `browsefn/typescript/src/router/http-router.ts`
  - `browsefn/python/pyproject.toml`
  - `browsefn/python/browsefn/__init__.py`
  - `browsefn/python/browsefn/core/types.py`
  - `browsefn/python/browsefn/core/browse_fn.py`
  - `browsefn/python/browsefn/web/scraper.py`
  - `browsefn/python/browsefn/http/router.py`
  - `packages/http/README.md`
  - `packages/middleware/package.json`
  - `packages/middleware/src/rate-limit.ts`
  - `packages/python-core/pyproject.toml`
  - `packages/python-core/superfunctions/http/__init__.py`
  - `package.json`
  - `turbo.json`
- **related_audit**:
  - `browsefn/.conduct/audits/2026-04-01-svro1wy9-full-audit.md`

# Overview

## Project context

- **Project name**: `BrowseFn`
- **One-sentence goal**: Make `browsefn` production-ready for external consumption in `nucleus` while honoring the full documented BrowseFn feature contract across TypeScript, Python, and the optional HTTP surface.
- **Target users**:
  - application engineers integrating BrowseFn directly into `nucleus`
  - developers embedding BrowseFn as a library in TypeScript or Python applications
  - teams mounting BrowseFn through `@superfunctions/http` or `superfunctions.http`
- **Target environments**:
  - TypeScript on Node.js 18+
  - Python 3.10+
  - optional browser-specific cache support through IndexedDB
  - online operation against public web, image, and geo providers
  - optional HTTP embedding inside server runtimes supported by shared HTTP adapters
- **Languages/packages required**:
  - TypeScript package at `browsefn/typescript`
  - Python package at `browsefn/python`
  - `@superfunctions/http`
  - `@superfunctions/middleware/rate-limit`
  - `superfunctions.http`
- **Existing systems it must integrate with**:
  - `nucleus` as an external consumer
  - the root npm workspace in `package.json`
  - `turbo.json`
  - shared superfunctions HTTP and middleware packages
- **Data model summary**:
  - request configuration records
  - page, metadata, image, download, geo, and metrics result records
  - provider registry entries with canonical IDs and alias maps
  - cache entries keyed by operation, URL, and normalized options
- **Security model**:
  - no built-in auth for direct library use
  - optional HTTP router surface that MUST support caller-supplied auth middleware
  - provider credentials are caller-owned secrets and MUST NOT be persisted by BrowseFn
  - private-network and loopback access are denied by default on the router surface
- **Performance constraints**:
  - simple page fetch target SHOULD stay under 5s for static pages
  - JS-enabled page fetch target SHOULD stay under 30s
  - metadata extraction target SHOULD stay under 2s per URL excluding upstream throttling
  - image search target SHOULD stay under 3s for 20 results excluding upstream throttling
  - geocoding target SHOULD stay under 1s from cache and under 3s from upstream
- **Non-goals / out of scope**:
  - a BrowseFn dashboard UI
  - a standalone BrowseFn CLI
  - nucleus-specific business workflows, schemas, or UI
  - publishing a credential vault
- **Hard constraints**:
  - the TypeScript package MUST publish as `browsefn`
  - BrowseFn docs MUST not overstate unsupported features
  - the TypeScript router MUST remain based on `@superfunctions/http`
  - the Python router MUST remain based on `superfunctions.http`
  - the TypeScript rate limiter MUST reuse shared middleware instead of owning a separate windowing implementation

## Assumptions

1. `nucleus` will consume BrowseFn primarily as a library and MAY optionally mount the router; no nucleus-specific router contract was provided.
2. Dashboard and CLI directories mentioned in legacy architecture notes do not define enough behavior to become MUST-level deliverables in this spec, so the implementation MUST stop advertising them as shipped public surfaces.
3. Runtime-specific storage adapters MAY be unavailable on some platforms; unsupported storage selections MUST fail fast with structured errors rather than silently degrading.

# Glossary

- **Canonical provider ID**: The normalized provider name emitted by BrowseFn in config validation, results, logs, metrics, and router envelopes.
- **Legacy alias**: An input-only provider or config spelling accepted for compatibility and normalized before internal use.
- **Success envelope**: The router JSON response shape for successful operations.
- **Error envelope**: The router JSON response shape for failed operations.
- **External consumer**: A project outside this repository, including `nucleus`.
- **Capability fallback**: Deterministic movement from one provider to the next because the selected provider is unavailable or lacks a required capability.
- **Typed parity**: The requirement that TypeScript and Python expose matching public concepts, error semantics, and provider IDs even where naming style differs.
- **Shared-package reuse**: Reusing monorepo packages such as `@superfunctions/http`, `@superfunctions/middleware`, and `superfunctions.http` instead of reimplementing equivalent logic inside BrowseFn.

# Goals / Non-goals

## Goals

1. BrowseFn MUST become internally consistent across code, docs, packaging, versions, and licenses.
2. BrowseFn MUST provide a complete public contract for web page retrieval, metadata extraction, image search/download, and geo operations.
3. BrowseFn MUST provide deterministic error semantics, router envelopes, rate limiting, and observability suitable for production use.
4. BrowseFn MUST reduce avoidable duplication and reuse shared superfunctions packages where they already solve the problem.
5. BrowseFn MUST be verifiable locally with repeatable TypeScript, Python, duplication, and documentation checks.

## Non-goals

1. This spec does not define a dashboard UI.
2. This spec does not define a standalone CLI.
3. This spec does not define long-term credential storage or a secrets management system.
4. This spec does not define distributed queues, background jobs, or webhook delivery.

# Public API

## TypeScript API

```ts
export type CanonicalWebProviderId =
  | "cheerio"
  | "puppeteer"
  | "playwright"
  | "firecrawl"
  | "jina";

export type CanonicalImageProviderId =
  | "unsplash"
  | "pixabay"
  | "pexels";

export type CanonicalGeoProviderId =
  | "nominatim"
  | "google-maps"
  | "mapbox";

export type BrowseFnErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_URL"
  | "UNSUPPORTED_PROVIDER"
  | "UNSUPPORTED_PROVIDER_CAPABILITY"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_NOT_FOUND"
  | "DOWNLOAD_EXISTS"
  | "DOWNLOAD_TOO_LARGE"
  | "SECURITY_POLICY_BLOCKED"
  | "CACHE_ERROR"
  | "INTERNAL_ERROR";

export interface SecurityConfig {
  allowPrivateHosts?: boolean;
  allowedHosts?: string[];
  blockedHosts?: string[];
  maxResponseBytes?: number;
  maxDownloadBytes?: number;
  maxRedirects?: number;
}

export interface BrowseFnConfig {
  web?: WebConfig;
  images?: ImageConfig;
  geo?: GeoConfig;
  cache?: CacheConfig;
  rateLimit?: {
    global?: RateLimitConfig;
    perProvider?: Record<string, RateLimitConfig>;
  };
  retry?: RetryConfig;
  security?: SecurityConfig;
}

export interface DownloadBatchOptions extends ImageDownloadOptions {
  concurrency?: number;
  onProgress?: (completed: number, total: number) => void;
  onError?: (url: string, error: BrowseFnError) => void;
}

export interface MetricsQuery {
  timeRange?: "last-hour" | "last-24h" | "last-7d" | "all";
  groupBy?: "provider";
}

export declare class BrowseFn {
  constructor(config?: BrowseFnConfig);
  web: {
    getPage(url: string, options?: GetPageOptions): Promise<PageResult>;
    getMultipleMetadata(urls: string[], options?: MetadataOptions): Promise<MetadataResult[]>;
    scrape<T>(
      url: string,
      options: GetPageOptions & { script: (page: unknown) => Promise<T> }
    ): Promise<T>;
    listProviders(): Promise<CanonicalWebProviderId[]>;
    registerProvider(name: string, provider: WebProvider): void;
  };
  images: {
    search(query: string, options?: ImageSearchOptions): Promise<ImageSearchResult>;
    download(url: string, options?: ImageDownloadOptions): Promise<DownloadResult>;
    downloadBatch(urls: string[], options?: DownloadBatchOptions): Promise<DownloadResult[]>;
    listProviders(): Promise<CanonicalImageProviderId[]>;
    registerProvider(name: string, provider: ImageProvider): void;
  };
  geo: {
    reverseGeocode(location: GeoLocation, options?: { provider?: string; cache?: boolean }): Promise<ReverseGeocodeResult>;
    geocode(address: string, options?: GeocodeOptions): Promise<ReverseGeocodeResult[]>;
    search(options: GeoSearchOptions): Promise<GeoPlace[]>;
    getPlaceDetails(placeId: string, options?: { provider?: string; fields?: string[]; cache?: boolean }): Promise<GeoPlace>;
    listProviders(): Promise<CanonicalGeoProviderId[]>;
    registerProvider(name: string, provider: GeoProvider): void;
  };
  getMetrics(options?: MetricsQuery): Promise<Metrics>;
  getRateLimitStatus(provider?: string): Promise<RateLimitStatus>;
  getLogs(filter?: { provider?: string; since?: number }): LogRecord[];
  clearCache(): Promise<void>;
  clearMetrics(): void;
  clearLogs(): void;
  on(event: BrowseFnEvent, handler: EventHandler): void;
  off(event: BrowseFnEvent, handler: EventHandler): void;
}

export declare function browseFn(config?: BrowseFnConfig): BrowseFn;
export declare function createBrowseFnRouter(browseFn: BrowseFn): Router;
```

## Python API

```python
class BrowseFn:
    web: WebScraper
    images: ImageBrowser
    geo: GeoService

    async def get_metrics(self, options: MetricsQuery | None = None) -> Metrics: ...
    async def get_rate_limit_status(self, provider: str | None = None) -> RateLimitStatus: ...
    def get_logs(self, filter_opts: dict[str, object] | None = None) -> list[LogRecord]: ...
    async def clear_cache(self) -> None: ...
    def clear_metrics(self) -> None: ...
    def clear_logs(self) -> None: ...
    def on(self, event: BrowseFnEvent, handler: Callable[[EventData], None]) -> None: ...
    def off(self, event: BrowseFnEvent, handler: Callable[[EventData], None]) -> None: ...

def browse_fn(config: BrowseFnConfig | None = None) -> BrowseFn: ...
def create_browsefn_router(browse_fn: BrowseFn) -> list[Route]: ...
```

Python method names MAY remain snake_case, but emitted provider IDs, error codes, and router envelopes MUST match the canonical forms defined in this spec.

## Router endpoints

| Method | Path | Success payload |
| --- | --- | --- |
| `POST` | `/web/page` | `PageResult` |
| `POST` | `/web/metadata` | `{ results: MetadataResult[] }` |
| `GET` | `/images/search` | `ImageSearchResult` |
| `POST` | `/images/download` | `DownloadResult` |
| `GET` | `/geo/reverse` | `ReverseGeocodeResult` |
| `GET` | `/geo/geocode` | `{ results: ReverseGeocodeResult[] }` |
| `GET` | `/geo/search` | `{ results: GeoPlace[] }` |
| `GET` | `/geo/places/:id` | `GeoPlace` |
| `GET` | `/metrics` | `Metrics` |

# Data formats / protocol

## Canonical provider IDs and accepted aliases

| Namespace | Canonical ID | Accepted legacy aliases |
| --- | --- | --- |
| web | `cheerio` | none |
| web | `puppeteer` | none |
| web | `playwright` | none |
| web | `firecrawl` | none |
| web | `jina` | `jina-ai` |
| images | `unsplash` | none |
| images | `pixabay` | none |
| images | `pexels` | none |
| geo | `nominatim` | none |
| geo | `google-maps` | `googleMaps` |
| geo | `mapbox` | none |
| python web | `bs4` | `beautifulsoup` |

Alias handling is input-only. All outputs, logs, metrics, and documentation MUST use canonical IDs except that Python MAY retain the `bs4` provider name for its built-in BeautifulSoup provider.

## Canonical success envelope

```ts
export interface BrowseFnSuccessEnvelope<T> {
  ok: true;
  data: T;
  meta: {
    requestId: string;
    provider?: string;
    cached?: boolean;
    durationMs?: number;
    fallbackFrom?: string;
  };
}
```

## Canonical error envelope

```ts
export interface BrowseFnErrorEnvelope {
  ok: false;
  error: {
    code: BrowseFnErrorCode;
    message: string;
    provider?: string;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
  };
  meta: {
    requestId: string;
  };
}
```

The router MUST never return bare `{ success: true }` or `{ error: "..." }` payloads after this spec is implemented.

## Canonical request shapes

```ts
interface WebPageRequestBody {
  url: string;
  options?: GetPageOptions;
}

interface WebMetadataRequestBody {
  urls: string[];
  options?: MetadataOptions;
}

interface ImageDownloadRequestBody {
  url: string;
  options?: ImageDownloadOptions;
}
```

`PageResult.screenshot` MUST be serialized in router responses as:

```ts
interface RouterScreenshot {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
}
```

## Canonical config rules

1. `CacheConfig.ttl` is the canonical field. `defaultTTL` MAY be accepted as a legacy alias but MUST normalize to `ttl`.
2. `WebConfig.providers`, `ImageConfig.providers`, and `GeoConfig.providers` MUST accept either builtin provider config objects or already-instantiated provider objects.
3. `GetPageOptions` MUST include `includeLinks?: boolean` and `includeImages?: boolean`.
4. `MetadataOptions.fields` MUST preserve the declared order of fields in the result payload where the underlying result format preserves field order.

# Semantics

## Packaging and public contract

1. The TypeScript package MUST publish as `browsefn`.
2. The Python package MUST publish as `browsefn`.
3. TypeScript, Python, README, quickstart, implementation notes, and tests MUST agree on one version string and one license string.
4. The path `browsefn/typescript` is canonical. BrowseFn docs MUST NOT reference `browsefn/ts-sdk`.

## Web page retrieval

1. `web.getPage()` MUST sanitize and normalize URLs before network access.
2. `web.getPage()` MUST support builtin providers `cheerio`, `puppeteer`, `playwright`, `firecrawl`, and `jina`.
3. If a selected provider lacks a required capability such as JavaScript execution or screenshotting, BrowseFn MUST either:
   - move to the next provider in the deterministic fallback chain, or
   - fail with `UNSUPPORTED_PROVIDER_CAPABILITY` when no suitable fallback exists.
4. `PageResult.links` and `PageResult.images` MUST be present when `includeLinks` or `includeImages` is requested.
5. `PageResult.provider` MUST be the canonical provider ID that actually served the result.

## Batch metadata extraction

1. `web.getMultipleMetadata()` MUST preserve input order in its result array.
2. The operation MUST continue past per-URL failures and return one `MetadataResult` per input URL.
3. The operation MUST support concurrency limits and monotonic progress callbacks.
4. Field filtering MUST remove only non-requested metadata keys and MUST always preserve the `url` field.

## Custom scraping

1. `web.scrape()` MUST support browser-page scripting with at least `puppeteer` and `playwright`.
2. When the selected provider cannot execute a caller script, BrowseFn MUST fail with `UNSUPPORTED_PROVIDER_CAPABILITY`.
3. The router surface does not expose caller-defined scripts. Custom scraping is library-only.

## Image search and download

1. BrowseFn MUST support image search through `unsplash`, `pixabay`, and `pexels`.
2. Search filters MUST normalize into a canonical result model regardless of provider quirks.
3. `images.download()` MUST physically write the file it claims to have downloaded.
4. `images.downloadBatch()` MUST preserve input order, report progress monotonically, and surface per-item failures without aborting unrelated items.
5. `overwrite: false` MUST block writes to existing files with `DOWNLOAD_EXISTS`.
6. Crop, resize, format conversion, watermark, and metadata inclusion options MUST either be applied or rejected before writing any output file with a structured `INVALID_ARGUMENT` error.

## Geo

1. BrowseFn MUST support reverse geocoding, forward geocoding, geo search, and place details across `nominatim`, `google-maps`, and `mapbox`.
2. `getPlaceDetails()` MUST support full detail retrieval for `google-maps` and `mapbox`.
3. `getPlaceDetails()` on `nominatim` MUST either return a partial normalized record when the upstream can provide it or fail with `UNSUPPORTED_PROVIDER_CAPABILITY`.
4. The geo surface MUST normalize provider-specific fields into one `GeoPlace` model.

## Cache

1. BrowseFn MUST support `memory`, `indexeddb`, `file`, and `database` cache backends.
2. Selecting an unsupported backend for the active runtime MUST fail fast with `INVALID_ARGUMENT` or `UNSUPPORTED_PROVIDER_CAPABILITY`; BrowseFn MUST NOT silently change the backend.
3. Cache keys MUST be derived from the canonical operation name, normalized URL, normalized provider ID, and normalized options.
4. Cache stats MUST include hits, misses, size, and hit rate.
5. Cache invalidation and cache clearing MUST behave consistently across backends.

## Rate limiting, retry, and fallback

1. The TypeScript implementation MUST reuse `@superfunctions/middleware/rate-limit` for windowing and persistence logic.
2. BrowseFn MUST support one global limiter and one limiter per provider.
3. The fallback chain MUST be deterministic and MUST honor the declared provider order.
4. Retry MUST respect configured status-code filters and backoff mode.
5. Exhausted retries MUST surface a canonical error instead of a bare exception string.

## Router semantics

1. The TypeScript router MUST be built with `@superfunctions/http`.
2. The Python router MUST be built with `superfunctions.http`.
3. Router input validation MUST occur before invoking service methods.
4. Router responses MUST always use the canonical success or error envelope.
5. Router code MUST translate service-layer errors to HTTP status codes consistently:
   - `400` for `INVALID_ARGUMENT` and `INVALID_URL`
   - `403` for `SECURITY_POLICY_BLOCKED`
   - `404` for `UPSTREAM_NOT_FOUND`
   - `409` for `DOWNLOAD_EXISTS`
   - `429` for `RATE_LIMITED`
   - `502` for `PROVIDER_ERROR` and `PROVIDER_UNAVAILABLE`
   - `504` for `UPSTREAM_TIMEOUT`
   - `500` for `CACHE_ERROR` and `INTERNAL_ERROR`

# Invariants

1. `listProviders()` MUST return canonical provider IDs in lexicographic order.
2. Batch operations MUST preserve input order in output order.
3. Provider fallback order MUST never vary for the same config and the same availability state.
4. `ok: true` responses MUST omit `error`. `ok: false` responses MUST omit `data`.
5. Metrics, logs, and events MUST use canonical provider IDs.
6. Cache hits MUST not change the logical payload apart from `cached`, `durationMs`, and envelope metadata.
7. BrowseFn docs MUST not advertise unsupported providers, unsupported backends, or unspecified surfaces.

# Security

1. The router surface MUST reject loopback, link-local, multicast, and RFC1918 private-network targets by default.
2. Direct library usage MAY opt into private hosts through explicit `security.allowPrivateHosts` or `security.allowedHosts`.
3. BrowseFn MUST redact API keys, authorization headers, cookies, and signed URLs from logs, errors, metrics tags, and events.
4. Download destinations MUST reject path traversal and MUST remain inside the resolved destination root.
5. BrowseFn MUST cap redirects, response size, and download size before exhausting memory or disk.
6. BrowseFn MUST not persist provider credentials to disk, cache, or logs.

# Limits / caps

1. `web.getMultipleMetadata()` MUST reject batches larger than `100` URLs with `INVALID_ARGUMENT`.
2. `images.downloadBatch()` MUST reject batches larger than `50` URLs with `INVALID_ARGUMENT`.
3. `ImageSearchOptions.perPage` MUST be between `1` and `100`.
4. `GeocodeOptions.limit` and `GeoSearchOptions.limit` MUST be between `1` and `50`.
5. The default max response body for page and metadata fetches MUST be `10 MiB`.
6. The default max image download size MUST be `25 MiB`.
7. Router screenshot payloads MUST reject outputs larger than `10 MiB` after encoding.
8. In-process log retention MUST default to the most recent `1000` records.
9. Performance targets from the legacy BrowseFn spec remain SHOULD-level operational targets and are not allowed to weaken correctness requirements.

# Observability

1. BrowseFn MUST record total requests, success count, failure count, average response time, and cache hit rate.
2. Metrics MUST be queryable globally and grouped by provider.
3. BrowseFn MUST emit at least these events: `request`, `response`, `error`, `cache.hit`, `cache.miss`, `rateLimit`, `provider.fallback`.
4. Every emitted event MUST contain a timestamp and SHOULD include provider and duration where relevant.
5. Logging MUST record one structured entry per completed operation and MUST preserve enough data to diagnose fallback, retries, and cache behavior without exposing secrets.

# Compatibility / versioning strategy

1. The first compliant implementation release MUST synchronize the TypeScript package version, Python package version, exported Python `__version__`, and version references in BrowseFn docs.
2. BrowseFn MUST use `Apache-2.0` consistently across its own package metadata and documentation.
3. Legacy aliases such as `googleMaps`, `defaultTTL`, and `beautifulsoup` MAY be accepted for compatibility, but BrowseFn MUST normalize them internally and MUST NOT emit them in new docs or outputs.
4. Any future breaking change to canonical provider IDs, router envelopes, error codes, or package names MUST require an explicit major-version bump and accompanying docs update.

# Undefined / Explicitly user-deferred only

The following items are Undefined in this spec and therefore NOT required:

1. A BrowseFn dashboard UI.
2. A standalone BrowseFn CLI.
3. Webhook delivery or background job orchestration.
4. Long-term encrypted credential storage owned by BrowseFn.
5. Automatic user-agent rotation beyond a caller-specified static user agent.
