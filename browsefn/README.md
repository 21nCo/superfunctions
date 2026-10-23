# BrowseFn

BrowseFn is the Superfunctions package for web retrieval, batch metadata extraction, image search/download, and geo lookups behind one SDK contract.

## Status

BrowseFn is an `Alpha` package. Both published packages use the canonical name `browsefn` and the project license is `Apache-2.0`.

## Packages

- TypeScript package: [`browsefn/typescript`](./typescript/)
- Python package: [`browsefn/python`](./python/)

## Supported Surface

### TypeScript

- Web provider IDs: `cheerio`, `puppeteer`, `playwright`, `firecrawl`, `jina`
- Image provider IDs: `unsplash`, `pixabay`, `pexels`
- Geo provider IDs: `nominatim`, `google-maps`, `mapbox`
- Public exports: `browseFn`, `BrowseFn`, provider classes, config/result types, `createBrowseFnRouter`

### Python

- Web provider IDs emitted by the package: `cheerio`
- Accepted Python web aliases: `bs4`, `beautifulsoup`
- Image provider IDs: `unsplash`, `pixabay`, `pexels`
- Geo provider IDs: `nominatim`, `google-maps`, `mapbox`
- Public exports: `browse_fn`, `BrowseFn`, provider classes, config/result types, `create_browsefn_router`

## Installation

### TypeScript

```bash
npm install browsefn
```

Optional browser-provider peer dependencies:

```bash
npm install puppeteer
npm install playwright
```

### Python

```bash
pip install browsefn
```

## Quick Start

### TypeScript

```ts
import { browseFn } from 'browsefn';

const browse = browseFn({
  web: {
    defaultProvider: 'cheerio',
  },
});

const page = await browse.web.getPage('https://example.com', {
  format: 'markdown',
  includeLinks: true,
});

console.log(page.provider);
console.log(page.metadata.title);
```

### Python

```python
import asyncio

from browsefn import BrowseFnConfig, WebConfig, browse_fn


async def main() -> None:
    browse = browse_fn(
        BrowseFnConfig(
            web=WebConfig(defaultProvider="cheerio"),
        )
    )

    page = await browse.web.get_page(
        "https://example.com",
        {"format": "text"},
    )

    print(page.provider)
    print(page.metadata.title)


asyncio.run(main())
```

## Canonical Provider IDs

### Web

- TypeScript: `cheerio`, `puppeteer`, `playwright`, `firecrawl`, `jina`
- Python: `cheerio`

### Images

- `unsplash`, `pixabay`, `pexels`

### Geo

- `nominatim`, `google-maps`, `mapbox`

Legacy aliases such as `googleMaps`, `bs4`, and `beautifulsoup` are normalized before internal use. Emitted provider IDs stay canonical.

## Verification From The Repo Root

```bash
npm --prefix browsefn/typescript run build
python3 -m compileall browsefn/python/browsefn browsefn/python/tests
python3 -m pytest browsefn/python/tests/test_web.py browsefn/python/tests/test_images.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_router.py -q
```

## More Docs

- [TypeScript README](./typescript/README.md)
- [Python README](./python/README.md)
- [Python Testing Guide](./python/TESTING.md)

## Runtime and migration requirements

BrowseFn 0.2.0 requires Node.js **20.19.0 or newer** for the TypeScript package and Python **3.10 or newer** for the Python package. The Node floor is a compatibility change from the earlier source package: synchronous CommonJS loading of the shared ESM router requires Node 20.19, and patched image processing uses Sharp 0.35.5 (which itself requires Node 20.9). ESM and CommonJS remain supported; `createBrowseFnRouter` remains synchronous.

Publish/install `@superfunctions/http@0.3.1` before BrowseFn 0.2.0: it adds the independent `@superfunctions/http/router` export. The optional admin package also requires `@superfunctions/admin@0.1.5`, backed by `@mcpfn/core@0.0.6`; publish that prerequisite graph before the admin package. This branch does not publish packages.

Per-call `retry.count` now means retries **after** the initial attempt and overrides global retry settings; `count: 0` disables retries for that call. `fallbackOnErrors: []` disables fallback, while an omitted policy retains fallback for all provider errors. Configured global quotas now apply across providers. Cache entries now fingerprint full request options, including credentials and TTL; previous cache entries are not reused under the new fingerprints.

See [provider protocol limits](#web-provider-contracts) and [0.2 migration notes](#browsefn-02-migration) for remote-provider and cache details.

Configure `web.userAgents` for deterministic target User-Agent rotation. Explicit per-call User-Agent headers take precedence. See [credential storage](#credential-handling-and-deployment-storage) for credential URL cache bypass, legacy-cache cleanup, log redaction and SecFn integration.

## BrowseFn 0.2 migration

The TypeScript and Python SDKs move together from source version 0.1.0 to 0.2.0; the bundled admin dependency follows 0.2.0. This minor pre-1.0 release explicitly changes runtime and previously ignored policy behavior. It is not a claim that either version has been published.

- Node minimum: 20.19.0. The CJS entrypoint synchronously consumes the shared HTTP router ESM export; Node's synchronous ESM support at this floor preserves the public synchronous router factory. Middleware loads lazily inside async rate-limit operations. Sharp 0.35.5 requires Node 20.9; BrowseFn's stricter minimum covers both.
- Python minimum: 3.10, matching shared-core. Python 3.9 is not supported.
- Shared prerequisite: publish `@superfunctions/http@0.3.1` (additive `./router` export) before BrowseFn. A fresh consumer must install the required dependency graph; local workspaces alone do not prove registry availability.
- Retry: per-call count excludes the initial attempt and overrides global settings; zero means no retries. HTTP response codes survive normalization. Python onRetry now runs before a retry. Global maxAttempts includes the initial attempt.
- Fallback: an omitted fallbackOnErrors policy retains automatic fallback; an empty list prevents it. Canonical error codes and legacy TIMEOUT/RATE_LIMIT/NOT_FOUND aliases are accepted. Policies now actually control execution.
- Limits: global request quota is shared across providers; provider quotas additionally apply. Existing callers that relied on independent global buckets must configure provider quotas explicitly.
- Both SDKs cache identity includes all request options and hashes option data. This prevents cross-credential reads and plain credentials in keys, but cached response bodies and URL prefixes are not encrypted. Invalidate old persistent caches during migration if they contain sensitive content; old entries are not matched by new keys. Custom key generators remain the application's responsibility.
- HTML-to-Markdown now preserves document order, lists, links and code instead of reordering or flattening content. TypeScript keeps tables as HTML within Markdown; Python uses the already-declared html2text dependency. Selectors retain all matching elements, including element wrappers.
- Firecrawl/Jina now follow their actual wire protocols. Invalid vendor-specific combinations raise a capability error and can fall back to a compatible browser provider. See #web-provider-contracts.

## Web provider contracts

Protocol mappings checked against official documentation/source on 2026-10-15. The Python built-in web provider remains `cheerio` (BeautifulSoup); Firecrawl, Jina and local browser adapters described below are TypeScript built-ins. Custom providers remain supported in both SDKs.

### Firecrawl v1

[Scrape API](https://docs.firecrawl.dev/api-reference/v1-endpoint/scrape): BrowseFn requests HTML for extraction and additionally Markdown when requested. Text/JSON are derived from HTML, not sent as unsupported scrape formats. Target headers/cookies are sent in the JSON body; API authorization remains separate. Include/exclude selectors map to includeTags/excludeTags and are applied locally to the returned document. Screenshots use screenshot or screenshot@fullPage format and the returned URL is downloaded with the same DNS/redirect/size checks as image downloads, then decoded/re-encoded for requested PNG/JPEG quality.

Firecrawl's proxy field accepts `basic`, `enhanced`, or `auto`, not an arbitrary proxy server URL. Configure `waitForMs` on the provider for its numeric wait delay. Browser `waitFor` lifecycle events and `javascript: false` are not expressible in this API and produce UNSUPPORTED_PROVIDER_CAPABILITY; use Puppeteer/Playwright for lifecycle events and Cheerio for static HTML. Explicit errors replace previously ignored options. Configured timeout aborts the API request as well as being sent to Firecrawl. Service success:false responses fail rather than returning empty content.

### Jina Reader

[Request options](https://github.com/jina-ai/reader/blob/main/src/dto/crawler-options.ts), [response formatter](https://github.com/jina-ai/reader/blob/main/src/services/snapshot-formatter.ts), and [POST endpoint](https://github.com/jina-ai/reader/blob/main/src/api/crawler.ts): BrowseFn POSTs the complete target URL, preserving HTTPS, with Accept application/json and respondWith html. The returned data.html is actual HTML; formats, links, images and selectors derive from it. Target customHeader, cookie strings, proxyUrl and mobile viewport are supported. API Authorization is never overwritten by target headers. `javascript: false` selects the curl engine; other requests select browser.

`waitFor: networkidle` maps to network-idle. Load/domcontentloaded have no equivalent Jina setting and raise a capability error. Screenshots make a second service request (screenshot/pageshot); returned screenshotUrl/pageshotUrl is securely downloaded and encoded. This may incur another provider charge and the two captures need not be an identical page instant. The API requests share an AbortSignal deadline; screenshot-byte download has its own bounded 30-second image-transfer deadline. Provider-specific endpoint overrides now identify the POST endpoint, not the old URL-prefix concatenation.

### Static HTML and limits

TypeScript Cheerio uses an Undici ProxyAgent when a proxy URL is supplied, closing it after body consumption. It supports HTTP(S) proxy transport; it does not execute JavaScript or take screenshots. Python BeautifulSoup uses HTTPX proxy support and domain-scoped cookies, applies selectors, and emits structured Markdown with html2text. Neither static provider emulates mobile rendering or browser lifecycle events.

Remote contracts are tested with documented JSON fixtures, request assertions, decoded screenshot bytes and failure envelopes. Local HTTP/proxy tests exercise real transports. No credentials or paid provider requests were used; provider entitlement, production rate limits and live service behavior remain external acceptance checks. Screenshot CDN URLs must be public HTTP(S); local/private URLs are rejected by image download policy.

### User-Agent rotation

Configure `web.userAgents: ['app-a/1.0', 'app-b/1.0']` (Python accepts the same alias). Each logical page request chooses the next value round-robin before cache identity is computed; retries/fallbacks retain that request's value. A per-call User-Agent header, matched case-insensitively, wins and does not advance the rotation. Empty lists disable rotation. Browser adapters send it as a target request header; remote providers map it to target headers, never API authentication headers. Rotation does not promise a different browser fingerprint, IP address, or permission to bypass site policy.

## Credential handling and deployment storage

BrowseFn accepts provider credentials in process memory; it does not implement a credential database or write provider configuration to cache, logs or artifacts. Default cache option identities use SHA-256, so Authorization/cookies are not persisted as key text. TypeScript uses browser-compatible synchronous @noble/hashes to retain the public synchronous memory-cache has() API; Python uses hashlib. URLs containing userinfo or recognized credential query names (including token, access_token, api_key, key, secret and password) bypass caching because response metadata would otherwise retain that URL. Custom cache key generators are trusted application code and must not return secrets.

Known provider/request credentials and credential URL fields are redacted from SDK-maintained logs, including error messages. Rotation and cache keys never log raw header options. Regression tests send requests through local HTTP fixtures, scan actual persistent cache files and SDK logs, and exercise provider failure messages containing known credentials. This is not a general data-loss prevention scanner: unrecognized secret names, arbitrary content returned by a provider, and application-written logging still need application policy. Do not put credentials into arbitrary URL parameters; prefer supported authentication headers/configuration.

Response caches hold caller-requested content in plaintext, including private page content if the caller enables caching. A site can echo a credential into its content; BrowseFn cannot safely rewrite arbitrary page content without changing the result. Disable cache for sensitive pages or protect the backing store with deployment encryption/access controls. On upgrade clear pre-0.2 persistent caches, whose option keys could contain headers/cookies. New SDKs do not match those historical keys. There is no automatic migration of plaintext legacy records.

For credentials that must persist, use the existing SecFn service or a deployment secret manager. The repository's `secfn/server/README.md` configures `createSecFnServer({ encryption: { masterKey, keyId }, ... })`; its encrypted vault owns persistence and authorization. The existing read-only runtime API is documented in `secfn/runtime/README.md`:

```ts
import { createSecFnRuntime } from '@secfn/runtime';
import { browseFn } from 'browsefn';

const secrets = createSecFnRuntime({
  endpoint: process.env.SECFN_ENDPOINT!,
  apiKey: process.env.SECFN_RUNTIME_TOKEN!,
  tenantId: 'my-tenant',
  environment: 'production',
});
const browse = browseFn({
  web: { providers: { firecrawl: { apiKey: await secrets.get('FIRECRAWL_API_KEY') } } },
});
```

This is server-side application composition, not a new BrowseFn dependency or credential-store feature. Deploy/publish SecFn and its prerequisites separately; do not embed these tokens in browser bundles. Python deployments can inject values from their existing secret manager into ProviderConfig in memory.

## Persistent cache contract

The cache now implements the existing memory, file, indexeddb and database configuration choices. Cache operations prune expired entries, preserve replacement-at-capacity, and evict least recently used entries. Exact TTL boundaries expire entries. Invalid TTL and capacity values are rejected. Stored/returned memory objects are detached from caller mutations.

### Configuration

TypeScript:

```ts
new CacheManager({ enabled: true, storage: 'file', directory: '/private/cache', name: 'retrieval', ttl: 60000, maxSize: 100 });
new CacheManager({ enabled: true, storage: 'indexeddb', name: 'retrieval' });
new CacheManager({ enabled: true, storage: 'database', database: sharedAdapter, name: 'retrieval' });
```

Python:

```python
CacheManager(CacheConfig(enabled=True, storage='file', directory='/private/cache', name='retrieval'))
CacheManager(CacheConfig(enabled=True, storage='database', database=shared_adapter, name='retrieval'))
```

- Default persistent identity is `browsefn`; default file directory is `.browsefn-cache` relative to process working directory. Select explicit directory/name in deployed applications. Cache names are hashed for file paths and compared exactly for IndexedDB/database isolation.
- TypeScript file storage uses `@superfunctions/storage-local` streams, a namespace lock, private temporary files, flush and atomic rename. Writers in different processes coordinate through the lock directory. A crashed process can leave its lock directory; operations time out after five seconds rather than stealing an uncertain lock. An operator may remove a stranded lock only after verifying no writer owns it. Local-filesystem behavior is intended; network-filesystem locking semantics have not been validated.
- Python file storage uses OS advisory locking, private temporary files, fsync and atomic replacement. POSIX behavior is tested; Windows locking is implemented but unvalidated. Both runtimes store separate file formats and do not claim cross-language cache-file interchange.
- IndexedDB TS uses one readwrite transaction for each operation and waits for transaction commit. `indexedDB` can optionally inject a factory for embedding/testing. Native browser IndexedDB is tested below; Node without a factory receives an actionable unavailable error.
- Ordinary CPython has no native browser IndexedDB. Its `indexeddb` choice requires an explicit `backend` bridge implementing async `transaction(name, callback)`. The callback receives the previous encoded string or None and returns `(new_encoded_string, result)`; the bridge must atomically commit the string and return `result`, aborting on callback failure. The supplied bridge contract is tested with a serialized test bridge; there is no bundled Pyodide/native bridge or claim of browser-Python runtime acceptance.
- Database storage uses the existing shared adapter, one named snapshot row and atomic numeric-revision conditional updates checked by affected-row count. Concurrent conflicts retry up to 32 times, then fail explicitly. Unique insertion protects first-writer races. TS wraps incoming adapters internally with its owned schema; applications do not pass adapterSchema. Primitive Python schema uses the shared database protocol; Python currently has no shared schema-wrapper primitive.
- Provision `browsefn_cache` with unique/primary `id`, non-null TEXT `value`, and non-null BIGINT `revision`. TS schema is `CacheManager.databaseSchema`; Python is `CacheManager.database_schema()`. SQL/ORM migrations remain application-owned. Names are SHA-256 hashed before entering database ids, and numeric revision predicates enforce conditional replacement regardless of text collation. TS row identities are prefixed `typescript:`, Python identities `python:`; encodings are intentionally distinct. Read/write/stat operations serialize a complete cache snapshot, appropriate for bounded local caches; this is not an indexed high-volume cache service.
- Persistence preserves bytes and supported BrowseFn result models (Python), Uint8Array/Date/bigint/undefined (TS), and nested primitive data. Functions and unknown Python model classes fail rather than serialize lossy values. Corrupt/unknown format fails explicitly and is not overwritten.
- Synchronous `has()` remains supported for memory. Persistent storage requires `await hasAsync()` / `await has_async()`; sync use throws an actionable error instead of reporting an unloaded persisted key absent. Other existing async operations retain their signatures. Statistics counts are manager-local; size reflects persisted, unexpired records.
- Python minimum metadata is corrected to >=3.10 because the already-required shared core distribution requires >=3.10. This is an explicit correction of an unsatisfiable >=3.9 installation claim, not proof of Python3.9 compatibility.

## HTTP destination policy

The TypeScript and Python HTTP routers enforce a public-destination policy for
`/web/page`, `/web/metadata`, and `/images/download`. Request bodies cannot enable
private hosts. Page and metadata routes disable cache reads/writes to prevent
caller-selected cache keys from crossing the policy boundary.

Protected static page requests resolve all DNS answers, reject any non-public
answer, connect to a checked address, and repeat validation on every redirect.
They default to at most five redirects and 10 MiB of response bytes; trusted global security limits can change these ceilings. Requests ask for
identity encoding; servers returning encoded bodies are rejected. The whole
request deadline includes DNS, redirects and body transfer. Proxies are rejected
because an untrusted proxy can resolve the destination differently. Python
protected static requests also reject cookies pending a bounded cookie policy.

**Migration:** Protected TypeScript Playwright and Puppeteer requests require a
trusted, explicitly provisioned Linux Docker worker, configured as described
below. Unconfigured browser, hosted and custom providers fail closed with
`SECURITY_POLICY_BLOCKED`. Hosted-provider remote network access is a separate
boundary that a local DNS check cannot certify. Python currently implements only
the static local web provider. The hostname policy below covers exact private-host exceptions and deny rules;
full SEC-001 acceptance remains unfinished.

Trusted in-process callers can select the checked transport with
`security: { allowPrivateHosts: false }`, or explicitly permit private hosts with
`security: { allowPrivateHosts: true }`. Python accepts the same option through
`GetPageOptions(security={"allowPrivateHosts": True})`. Calls without `security`
retain the legacy direct-library provider behavior, which is not a security
boundary for untrusted URLs. Do not forward arbitrary request options to direct
library methods. Protected direct calls should also disable caching; the HTTP
routers enforce this automatically.

## Exact hostname policy

Both SDKs accept a global `security` policy in `BrowseFnConfig`, and per-call
`security` on page, metadata and image download options. `SecurityConfig` and
`DestinationSecurity` expose `allowPrivateHosts`, `allowedHosts` and
`blockedHosts` in this checkpoint.

`allowedHosts` contains **exact private-host exceptions**, not an exclusive
allowlist: other public hosts remain accessible. `blockedHosts` denies an exact
host even when it is also allowed or `allowPrivateHosts` is true. Rules match
hostnames, not URL prefixes or ports; all ports for the exact host share the rule.
There is no suffix or subdomain matching. A hostname exception explicitly trusts
that name's resolved addresses, including private addresses; the actual socket
still uses a checked, pinned answer and each new destination is checked again.

```ts
const browse = browseFn({
  security: {
    allowedHosts: ['internal.example'],
    blockedHosts: ['metadata.internal.example'],
  },
});
// Trusted direct call; only internal.example gets the private-host exception.
const page = await browse.web.getPage('http://internal.example/status', { cache: false });
```

Python accepts `BrowseFnConfig(security={"allowedHosts": ["internal.example"],
"blockedHosts": ["metadata.internal.example"]})`; snake_case aliases are also
accepted. Names are normalized to lowercase IDNA ASCII, one trailing dot is
removed, and IPv6 literals are canonicalized. Wildcards, CIDRs, URL schemes,
credentials, paths, ports, zone IDs and ambiguous numeric IPv4 spellings are
rejected. Use canonical IPv4 literals; bracketed IPv6 is accepted. Malformed
arrays and rule entries fail before DNS or a target connection.

Per-call allowed-host lists replace global lists when supplied (`[]` removes
exceptions); omitted lists inherit the defaults. Blocked-host lists are combined,
so a call cannot remove a global deny rule. Per-call `allowPrivateHosts` overrides
the global boolean. Effective policy is part of page-cache identity, preventing
an allowed cached response from satisfying a later denied policy. Hostname rules
also apply to direct image transfers and all redirect destinations.

HTTP routes force `allowPrivateHosts: false` and `allowedHosts: []`, preserving
global deny rules. Request-body rules and the legacy image `allowPrivateHosts`
flag cannot weaken that boundary. On trusted direct image calls, nested
`security` takes precedence over the legacy flag. Browser calls with nonempty hostname rules fail closed, even when broad private
access is also enabled. CONNECT authority checks alone do not prove per-request
hostname enforcement across encrypted connection reuse. Browser HTTP/2
coalescing/ORIGIN handling needs further enforcement and multi-origin TLS
acceptance before those rules can be enabled. The existing isolated browser path
without hostname rules remains available. Unsupported protected providers remain
denied.

### Configurable transfer limits

Both SDKs accept `security.maxResponseBytes` (default 10 MiB),
`security.maxDownloadBytes` (default 25 MiB) and `security.maxRedirects`
(default 5). Bytes must be positive safe integers; redirects must be a
nonnegative safe integer. Zero redirects rejects the first redirect before
contacting its target. Python uses snake_case attributes and accepts camelCase
constructor aliases; `None` means omitted there.

```ts
const browse = browseFn({
  security: { maxResponseBytes: 2 * 1024 * 1024,
    maxDownloadBytes: 8 * 1024 * 1024, maxRedirects: 2 }
});
```

A per-call limit can tighten an explicitly configured global limit, but cannot
raise it. When neither is configured, the default applies; an explicitly
configured value may exceed the default. Legacy image `maxPayloadBytes` and
`maxRedirects` also tighten the effective image ceiling. Routers inherit trusted
global limits and discard body-supplied destination policy. Their image body
limits can only tighten these trusted ceilings. The separate 10 MiB encoded
router screenshot ceiling remains unchanged.

Static page/metadata transports enforce these limits while receiving each hop,
before retaining bytes beyond the cap. Each final decoded HTML and formatted
page content is also bounded in UTF-8 bytes before cache insertion or return.
Cache identity includes policy and cached page content is rechecked. These are
body/content bounds, not a cap on the full JSON envelope or peak process memory.
Compressed protected static responses remain unsupported. Images enforce their
cap on transfer, transform input, watermarks and encoded transformed output
before file publication; pixel decompression and encoder intermediate allocations
are not bounded by the encoded-byte limit.

Explicit page `maxResponseBytes` or `maxRedirects` is currently unsupported for
Playwright, Puppeteer, Firecrawl and Jina: calls fail before browser launch or
vendor requests. The isolated browser path without these explicit page limits
remains available, including when only `maxDownloadBytes` is configured. Its
existing fixed broker/output bounds do not establish a configurable browser
response/redirect contract. Python implements the static provider; protected
custom providers remain denied. The full browser/global-limit contract remains
open. Legacy direct static calls without any protected page policy still allocate
the fetch response before checking decoded output; use global security limits
for bounded transport. Arbitrary caller-managed cache key generators must preserve
policy identity to retain original transfer/redirect provenance; the returned
content cap is checked even on colliding keys.

See [configurable-limit evidence](./.conduct/configurable-limits-readiness.md),
[hostname policy evidence](./.conduct/hostname-policy-readiness.md) and
[payload-cap evidence](./.conduct/payload-cap-readiness.md).

Browser-rendered HTML and formatted content are each limited to 10 MiB of UTF-8
bytes. HTML is checked before parsing, formatting and screenshot capture, but
`page.content()` has already materialized the browser protocol response. HTTP
routers limit base64 screenshot output to 10 MiB; raw screenshot size is checked
before base64 allocation, while existing encoded strings are checked as UTF-8.
Oversized output returns HTTP 413. These are output limits, not bounds on all
intermediate browser or image-processing allocations.

## Isolated browser destinations

The TypeScript browser providers can enforce the router's public-destination
policy while retaining JavaScript rendering, screenshots, headers, cookies and
trusted in-process page callbacks. Provision the worker image explicitly on a
Docker daemon that runs Linux containers:

```bash
docker build -f browsefn/docker/browser-worker.Dockerfile -t browsefn-browser:1.57.0 .
npm install playwright@1.57.0
# Needed only when selecting Puppeteer:
PUPPETEER_SKIP_DOWNLOAD=true npm install puppeteer@24.33.0
```

The supplied image pins the Playwright base digest and installs Playwright 1.57.0
and Puppeteer Core 24.33.0. Keep the host Playwright version aligned with the
image. Runtime uses `--pull=never`; missing Docker, an absent image, incompatible
browser versions or failed startup produces an error rather than host-native
execution. Image provisioning and updates are the deployment operator's task.

```ts
import { browseFn, createBrowseFnRouter } from 'browsefn';

const browse = browseFn({
  web: {
    defaultProvider: 'playwright',
    providers: {
      playwright: {
        browser: 'chromium', // also firefox or webkit
        isolation: { dockerImage: 'browsefn-browser:1.57.0' },
      },
    },
  },
});
const router = createBrowseFnRouter(browse);
// Adapt router with the application's @superfunctions/http adapter.
const page = await browse.web.getPage('https://example.com', {
  security: { allowPrivateHosts: false },
  cache: false,
  screenshot: true,
});
```

Use the same `isolation` configuration under `providers.puppeteer` to select
Puppeteer. Configuration is server-owned; the HTTP body cannot choose an image,
turn off isolation or enable private destinations. Direct trusted calls with
`allowPrivateHosts: true`, or legacy calls without `security`, use the existing
host-native browser behavior. Do not expose that path to untrusted callers.

Each protected request gets a disposable container with `--network=none`, no host
mounts, a read-only root filesystem, no Linux capabilities and a non-root user.
Only its own loopback network exists. Browser control and proxy streams cross a
bounded stdin/stdout broker. The host proxy checks every resolved address and
connects to the checked IP; redirects, subresources, service workers and
WebSockets must pass that proxy. TLS CONNECT forwards encrypted bytes without
replacing certificate validation. The container cannot open an alternate host or
internet TCP/UDP route. This requires the Docker/Linux boundary; native browser
launch on an unsupported platform is never silently substituted. Docker Desktop
with Linux containers was exercised locally; a production Linux host was not.

Protected mode is headless and owns proxy configuration; caller proxies and
`headless: false` are rejected. Puppeteer host `executablePath` and `args` apply
only to host-native calls; the protected worker uses its provisioned executable
and fixed arguments. Browser Chromium sandbox behavior is separate from the
container network boundary (the Puppeteer worker uses `--no-sandbox`). Treat the
image, Docker daemon, host and application callbacks as trusted; this is not an
isolation guarantee against a compromised daemon, kernel or hostile local user.
Do not expose the Docker socket to request handlers or put credentials in image
layers. Worker stdout/stderr are not retained in Docker logs.

Resource limits apply per browser operation: 32 broker peers, bounded concurrent
proxy requests and DNS lookups, 10 MiB per plaintext HTTP request/response,
20 MiB aggregate bytes per CONNECT/WebSocket tunnel, 1 GiB container memory,
2 CPUs, 256 processes, and 256 MiB each for temporary storage and shared memory.
Exceeding transport limits fails the request; exhausting the worker peer limit
terminates the worker. These limits can reject large or unusually concurrent
pages. Encrypted response expansion is bounded by container memory and the
operation deadline, not a decoded-body byte counter. Browser redirects use the
browser's redirect limits; the static transport's five-hop limit does not apply.

The operation deadline includes initial DNS checking, worker startup, navigation
and page callback results. A late DNS answer cannot create a proxy connection.
Node's outstanding DNS work and arbitrary trusted callback side effects cannot
be forcibly cancelled. Cleanup may extend beyond the operation deadline: it
removes only the owned container and checks that the daemon reports it absent.
If absence cannot be confirmed, the call fails with a cleanup error rather than
reporting success. A host-process crash or inaccessible Docker daemon still
requires operator reconciliation of `browsefn-<UUID>` containers; `--rm` is not a
host-crash recovery service. No cross-process admission controller is included.

See [browser isolation evidence](./.conduct/browser-isolation-readiness.md) for
owned-fixture coverage and remaining release gates.

## Image download security policy

The built-in TypeScript downloader and Python browser/provider downloaders now use a shared helper within each SDK. These helpers are specialized network/file transfer policy, not framework HTTP adapters.

- HTTP(S) only; credentials in URLs rejected; every redirect is revalidated. Default maximum is five redirects, 25 MiB, and a 30-second overall deadline (including DNS and body transfer).
- Socket lookup in Node validates every DNS answer and hands only those checked addresses to the connection. Python resolves each hop, validates every answer, and connects to a checked IP while preserving the original Host header and TLS SNI/certificate hostname. Python disables environment proxy inheritance and keepalive pooling so pinned IP connections cannot reuse a TLS identity across redirect hostnames.
- Default policy rejects private, loopback, link-local, carrier NAT, multicast, documentation/reserved IPv4, and non-global/transition/documentation IPv6 ranges. It is deliberately conservative. `allowPrivateHosts` (`allow_private_hosts` in Python) explicitly opts into private targets; protocol/redirect/size bounds still apply.
- Payload length is checked against both headers and streamed bytes. Redirect/error streams are closed. Identity encoding is requested; unsolicited compressed HTTP encodings are rejected rather than expanding an unbounded decompression stream. Completed bytes remain buffered up to the configured cap for metadata and publication.
- A unique 0600 temporary file is written and synced in the destination directory. Atomic hard-link publication enforces `overwrite=false` even when concurrent callers raced past the initial existence check. Atomic replacement for overwrite never follows the final destination symlink or truncates another hardlink's target. Failed publication cleans up the temporary file.

### Trust boundaries and limits

The application must own the destination directory and its ancestors; untrusted local users must not be able to rename those directories or substitute ancestor symlinks during a download. This is not a sandbox for a hostile shared filesystem. Final-component symlink/hardlink targets are protected. Atomic no-overwrite publication requires a filesystem supporting hardlinks within the directory; unsupported filesystems fail without claiming success.

Custom TypeScript `ImageProvider.download` implementations remain a trusted extension point and retain their existing transform/provider functionality. They control their own network and filesystem I/O; the built-in downloader's policy cannot constrain arbitrary provider code. The initial lexical filename validation and successful-result path requirement still apply. Applications handling untrusted URLs must use the built-in downloader or a provider implementing equivalent policy. No built-in TypeScript image provider supplies a custom download implementation.

Python's built-in providers all use the shared protected helper. Provider errors remain unsuccessful `DownloadResult`s; browser download errors raise as before. New Python options accept both camelCase and snake_case and reject invalid size/redirect limits.

Image transformations implement resizing, cropping, quality/format conversion, text/image watermarks, and provider size selection; see #image-transformation-and-size-selection-contract for the exact contract and decoded-image evidence. Live third-party image-service credentials and public HTTPS integration were not exercised; local HTTP acceptance verifies transport and file policy. TLS verification remains enabled in both SDKs.

## Image transformation and size-selection contract

Both SDKs implement SPEC.md image downloads with sharp 0.35.5 (TypeScript) and Pillow 12.3.0 (Python; supported dependency range >=11.3,<13). These are package dependencies, not optional runtime promises. Python >=3.10 remains the declared minimum.

### Processing order and output

The built-in downloader fetches with the existing DNS/redirect/stream policy, validates a static JPEG/PNG/WebP, normalizes EXIF orientation when transforming, crops, resizes, composites watermarks, and encodes. Crop coordinates are measured on the oriented image and must fit entirely inside it. Resize preserves aspect ratio, fits inside maxWidth/maxHeight, and never enlarges. Untransformed images are fully decoded for validation, then retain their original bytes.

`format` encodes JPEG, PNG, or WebP. `quality` is 0–100 (rounded; zero maps to the encoder minimum 1). JPEG/WebP use encoder quality. PNG quality requests palette quantization/fidelity; omit quality for ordinary lossless PNG encoding. JPEG flattens alpha onto white. Returned format/dimensions/size describe the encoded bytes, not the source. Metadata is returned only when requested. Auto-generated filenames use the requested format extension; an explicit filename is preserved.

Watermarks accept text, an image, or both (image first, then text). Positions are top-left/top-right/bottom-left/bottom-right/center; default bottom-right. Opacity defaults to 0.5 and is multiplied by existing alpha; zero is transparent. Image marks fit inside the output without enlargement. Text uses the runtime's default sans font at 24px and fits into the image; text rendering/font coverage is not promised to be pixel-identical across platforms or SDKs. TypeScript escapes Pango markup so text is literal. Python uses Pillow's bundled default font. Input text is capped at 4096 characters.

Watermark images can be local filesystem paths (trusted application input) or HTTP(S) URLs. Remote marks use the same private-host, DNS, redirect, byte-limit, and deadline enforcement as source downloads. Other URI schemes are rejected. Local mark reads are bounded by maxPayloadBytes. Images are limited to 40 million decoded pixels, static frames, and supported formats; corrupt/truncated payloads fail before publication. Encoded output is also capped by maxPayloadBytes. CPU processing is not part of the network's 30-second deadline; callers should bound batch concurrency for large images.

### Provider size selection

`images.download` accepts the existing URL string or an `ImageResult`. For results, `size` selects the exact corresponding `downloads` URL. A requested provider size missing from the result fails explicitly. In particular, Pixabay original is only available when its API supplies imageURL; largeImageURL is not mislabeled as original.

Each ImageBrowser remembers up to 1000 URL aliases from its searches, including source-page URLs and download URLs. Existing string callers can search then download a returned URL with `size`; the remembered provider URL is selected. The selected URL still passes the protected downloader's checks. Explicit ImageResult input avoids dependence on this bounded per-instance lookup.

A direct URL with no known search result uses size as a local bounding box: small=640×640, medium=1280×1280, large=2048×2048; original preserves dimensions. Explicit maxWidth/maxHeight override the corresponding preset dimension. Selecting a provider URL suppresses this fallback bounding box; explicit crop/resize/format/watermark options still apply.

Custom TypeScript provider.download remains trusted and receives the selected URL plus the original options (including size), preserving provider-specific transforms. Python built-in provider.download methods share the transformation pipeline as well as secure fetch/write helpers. Public facade event/log contexts retain string URLs for the new ImageResult input.

## BrowseFn Release Gate

Run these commands from the repository root before using `browsefn` in `nucleus`.

### Canonical Command List

1. `npm --prefix browsefn/typescript run build`
2. `npm --prefix browsefn/typescript run typecheck`
3. `npm --prefix browsefn/typescript run test -- --run`
4. `python3 -m compileall browsefn/python/browsefn browsefn/python/tests`
5. `python3 -m pytest browsefn/python/tests -q`
6. `npx --yes jscpd@5.4.1 browsefn/typescript/src browsefn/python/browsefn --min-lines 5 --min-tokens 50 --reporters console`
7. `node browsefn/scripts/verify-release.mjs`

### Pass Criteria

- All seven commands exit `0`.
- The duplication scan reports total duplicated lines `<= 5.0%`.
- `node browsefn/scripts/verify-release.mjs` ends with JSON containing:
  - `"ok": true`
  - `"readyForNucleus": true`

### External-Consumption Notes

- TypeScript package identity: `browsefn`
- Python package identity: `browsefn`
- TypeScript HTTP surface: `createBrowseFnRouter`
- Python HTTP surface: `create_browsefn_router`
- TypeScript provider-id source of truth: `browsefn/typescript/src/core/provider-registry.ts`
- Python provider-id source of truth: `browsefn/python/browsefn/core/provider_registry.py`

### Recommended Operator Flow

1. Run `node browsefn/scripts/verify-release.mjs`.
2. If it fails, fix the failing step and rerun the same command.
3. If it passes, BrowseFn is ready for external consumption in `nucleus`.

### Acceptance beyond the source gate

The script checks source compilation, tests and duplication; its historical readyForNucleus flag is not proof of published dependency availability, paid-provider entitlement, deployed router authorization or hosted CI. The 0.2 package/runtime and credential evidence is recorded in the migration/provider/credential sections above. Run isolated tarball/wheel consumers and an appropriate native browser before releasing storage changes.

## Isolated installed-package verification

Build the required shared packages in dependency order (`observability`, `db`, `http`, `middleware`, `storage`, `storage-local`, `mcpfn/core`, `admin`), then build `browsefn/typescript` and `browsefn/admin`. From the repository root, run:

```bash
node browsefn/scripts/packed-runtime-acceptance.mjs
```

This creates separate temporary production-only consumers for BrowseFn core and BrowseFn admin, installs local tarballs rather than workspace aliases, audits each graph, checks ESM/CommonJS routers and real localhost scraping on exact Node 20.19.0, and checks NodeNext declarations. The admin consumer additionally checks provider listing and rejects a mismatched tenant scope. It removes temporary consumers afterward. Set `BROWSEFN_NODE` to an explicit Node binary to exercise another runtime; the default downloads/uses Node 20.19.0 through npm exec.

Core requires the additive `@superfunctions/http@0.3.1` router export. The optional admin graph requires `@superfunctions/admin@0.1.5` and `@mcpfn/core@0.0.6`. Local tarball success does not imply those versions are already published. Publish prerequisites before dependent packages; deployments must configure router authorization and secret storage separately.
