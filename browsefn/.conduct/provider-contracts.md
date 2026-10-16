# Web provider contracts

Protocol mappings checked against official documentation/source on 2026-10-15. The Python built-in web provider remains `cheerio` (BeautifulSoup); Firecrawl, Jina and local browser adapters described below are TypeScript built-ins. Custom providers remain supported in both SDKs.

## Firecrawl v1

[Scrape API](https://docs.firecrawl.dev/api-reference/v1-endpoint/scrape): BrowseFn requests HTML for extraction and additionally Markdown when requested. Text/JSON are derived from HTML, not sent as unsupported scrape formats. Target headers/cookies are sent in the JSON body; API authorization remains separate. Include/exclude selectors map to includeTags/excludeTags and are applied locally to the returned document. Screenshots use screenshot or screenshot@fullPage format and the returned URL is downloaded with the same DNS/redirect/size checks as image downloads, then decoded/re-encoded for requested PNG/JPEG quality.

Firecrawl's proxy field accepts `basic`, `enhanced`, or `auto`, not an arbitrary proxy server URL. Configure `waitForMs` on the provider for its numeric wait delay. Browser `waitFor` lifecycle events and `javascript: false` are not expressible in this API and produce UNSUPPORTED_PROVIDER_CAPABILITY; use Puppeteer/Playwright for lifecycle events and Cheerio for static HTML. Explicit errors replace previously ignored options. Configured timeout aborts the API request as well as being sent to Firecrawl. Service success:false responses fail rather than returning empty content.

## Jina Reader

[Request options](https://github.com/jina-ai/reader/blob/main/src/dto/crawler-options.ts), [response formatter](https://github.com/jina-ai/reader/blob/main/src/services/snapshot-formatter.ts), and [POST endpoint](https://github.com/jina-ai/reader/blob/main/src/api/crawler.ts): BrowseFn POSTs the complete target URL, preserving HTTPS, with Accept application/json and respondWith html. The returned data.html is actual HTML; formats, links, images and selectors derive from it. Target customHeader, cookie strings, proxyUrl and mobile viewport are supported. API Authorization is never overwritten by target headers. `javascript: false` selects the curl engine; other requests select browser.

`waitFor: networkidle` maps to network-idle. Load/domcontentloaded have no equivalent Jina setting and raise a capability error. Screenshots make a second service request (screenshot/pageshot); returned screenshotUrl/pageshotUrl is securely downloaded and encoded. This may incur another provider charge and the two captures need not be an identical page instant. The API requests share an AbortSignal deadline; screenshot-byte download has its own bounded 30-second image-transfer deadline. Provider-specific endpoint overrides now identify the POST endpoint, not the old URL-prefix concatenation.

## Static HTML and limits

TypeScript Cheerio uses an Undici ProxyAgent when a proxy URL is supplied, closing it after body consumption. It supports HTTP(S) proxy transport; it does not execute JavaScript or take screenshots. Python BeautifulSoup uses HTTPX proxy support and domain-scoped cookies, applies selectors, and emits structured Markdown with html2text. Neither static provider emulates mobile rendering or browser lifecycle events.

Remote contracts are tested with documented JSON fixtures, request assertions, decoded screenshot bytes and failure envelopes. Local HTTP/proxy tests exercise real transports. No credentials or paid provider requests were used; provider entitlement, production rate limits and live service behavior remain external acceptance checks. Screenshot CDN URLs must be public HTTP(S); local/private URLs are rejected by image download policy.

## User-Agent rotation

Configure `web.userAgents: ['app-a/1.0', 'app-b/1.0']` (Python accepts the same alias). Each logical page request chooses the next value round-robin before cache identity is computed; retries/fallbacks retain that request's value. A per-call User-Agent header, matched case-insensitively, wins and does not advance the rotation. Empty lists disable rotation. Browser adapters send it as a target request header; remote providers map it to target headers, never API authentication headers. Rotation does not promise a different browser fingerprint, IP address, or permission to bypass site policy.
