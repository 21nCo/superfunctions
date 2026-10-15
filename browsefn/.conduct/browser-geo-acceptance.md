# Browser and geocoder acceptance

Validated 2026-10-15 in the isolated BrowseFn readiness worktree.

## Implemented behavior

- Playwright and Puppeteer forward proxy addresses and credentials to their runtimes. Credentials are separated from the proxy server address.
- Browser extraction and asynchronous scripts finish before browser closure. If extraction and closure both fail, the extraction error is retained. A closure failure after successful extraction rejects the operation.
- Browser page results, metadata, links, and images resolve against the final page URL after redirects.
- Puppeteer uses its normal sandbox defaults; callers may supply explicit launch arguments.
- TypeScript and Python Nominatim radius searches use spherical-cap bounding rectangles. Longitude span accounts for latitude; polar caps cover all longitudes; antimeridian crossings issue two bounded queries, deduplicate, and apply the requested total result limit. These are bounding-box searches, not exact-distance filters.
- TypeScript and Python geocoding forward explicit bounds and country filters. Locality/postcode components use structured `street`, `city`, and `postalcode` parameters without `q`, as required by the [Nominatim Search API](https://nominatim.org/release-docs/latest/api/Search/). Explicit antimeridian bounds are split into two requests.

## Automated evidence

Command from the worktree root:

```sh
npm --prefix browsefn/typescript test -- --run tests/browser-lifecycle.test.ts tests/web-providers.test.ts tests/web-scraper.test.ts tests/redirect-resolution.test.ts tests/nominatim-bounds.test.ts tests/geo-providers.test.ts tests/geocoder.test.ts
```

Result: **40 tests passed across 7 files**. Provider boundary tests use deterministic mocks. They check proxy credentials, delayed extraction, cleanup failures, final URLs, structured query parameters, radius math at the equator/high latitudes/poles, split antimeridian boxes, deduplication, and limits.

```sh
/tmp/sf-browsefn-py312/bin/python -m pytest -q browsefn/python/tests/test_nominatim_bounds.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_web.py browsefn/python/tests/test_redirect_resolution.py
```

Result: **24 tests passed**. The Python redirect test uses a local HTTP server; geographic provider requests are mocked. The suite additionally verifies locality-only, postcode-only, combined structured filters, country-only free-form queries, numeric provider place IDs normalized to strings, and explicit antimeridian geocoding bounds with combined limits.

## Real browser evidence

Executed an esbuild in-memory bundle of the current `PlaywrightProvider` using Playwright from `/Volumes/Dev/n/superfunctions/node_modules/playwright` and the installed `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` executable. A fresh headless browser context contacted an ephemeral loopback HTTP server:

1. `/start` returned HTTP 302 to `/final/page`.
2. The final HTML contained relative `relative` link and `image.png` image paths.
3. `getPage` returned `/final/page`, `/final/relative`, and `/final/image.png` on the server origin.
4. `scrape` waited 25 ms before calling `page.title()` and returned `Acceptance`, proving the browser remained open through asynchronous extraction.

Output: `Real Chrome Playwright acceptance: redirect/final links/images and delayed script passed`.

Provider-owned browser instances and the HTTP server were closed. No personal browser profile, external account, production resource, or live third-party geocoder was used. Real proxy infrastructure and Puppeteer browser execution were not exercised; those boundaries have mock coverage.

## Integrated release validation

After shared storage dependencies were available, ran:

```sh
PATH=/tmp/sf-browsefn-py312/bin:$PATH node browsefn/scripts/verify-release.mjs
```

Exit status **0**. TypeScript build and typecheck passed; **90 TypeScript tests across 14 files** and **69 Python tests** passed; Python compileall passed. Python emitted 18 existing Pydantic deprecation warnings from shared database packages.

The duplication scan passed at **4.956798544793087%**, 545 duplicated lines, 46 clones, 61 source files. The existing 5% threshold and source inclusion rules were unchanged. Genuine repeated code was consolidated into the browser providers' common extraction operations and Nominatim's partition fetching/deduplication/address mapping helpers.

The verifier returned `ok: true` and `readyForNucleus: true`. Full command output: `/tmp/browsefn-release-agent.log`. This proves the local release gate at this snapshot; third-party live-provider verification limits above still apply.
