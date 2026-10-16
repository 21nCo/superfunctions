# BrowseFn 0.2 migration

The TypeScript and Python SDKs move together from source version 0.1.0 to 0.2.0; the bundled admin dependency follows 0.2.0. This minor pre-1.0 release explicitly changes runtime and previously ignored policy behavior. It is not a claim that either version has been published.

- Node minimum: 20.19.0. The CJS entrypoint synchronously consumes the shared HTTP router ESM export; Node's synchronous ESM support at this floor preserves the public synchronous router factory. Middleware loads lazily inside async rate-limit operations. Sharp 0.35.5 requires Node 20.9; BrowseFn's stricter minimum covers both.
- Python minimum: 3.10, matching shared-core. Python 3.9 is not supported.
- Shared prerequisite: publish `@superfunctions/http@0.3.1` (additive `./router` export) before BrowseFn. A fresh consumer must install the required dependency graph; local workspaces alone do not prove registry availability.
- Retry: per-call count excludes the initial attempt and overrides global settings; zero means no retries. HTTP response codes survive normalization. Python onRetry now runs before a retry. Global maxAttempts includes the initial attempt.
- Fallback: an omitted fallbackOnErrors policy retains automatic fallback; an empty list prevents it. Canonical error codes and legacy TIMEOUT/RATE_LIMIT/NOT_FOUND aliases are accepted. Policies now actually control execution.
- Limits: global request quota is shared across providers; provider quotas additionally apply. Existing callers that relied on independent global buckets must configure provider quotas explicitly.
- Both SDKs cache identity includes all request options and hashes option data. This prevents cross-credential reads and plain credentials in keys, but cached response bodies and URL prefixes are not encrypted. Invalidate old persistent caches during migration if they contain sensitive content; old entries are not matched by new keys. Custom key generators remain the application's responsibility.
- HTML-to-Markdown now preserves document order, lists, links and code instead of reordering or flattening content. TypeScript keeps tables as HTML within Markdown; Python uses the already-declared html2text dependency. Selectors retain all matching elements, including element wrappers.
- Firecrawl/Jina now follow their actual wire protocols. Invalid vendor-specific combinations raise a capability error and can fall back to a compatible browser provider. See provider-contracts.md.

Validation includes tarball-only ESM and CommonJS consumers on exact Node 20.19.0, shared-router declarations under NodeNext TypeScript, actual localhost scraping, a CONNECT proxy, persistent cache credential isolation and expiration, and decoded screenshot/image output. Paid provider fixture tests verify protocol mapping; no paid service calls were made.

See credential-storage.md for legacy-cache cleanup, credential URL cache bypass, log redaction and SecFn composition.
