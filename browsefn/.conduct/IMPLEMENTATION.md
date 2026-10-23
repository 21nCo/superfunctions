# BrowseFn Implementation Notes

## Package Contract

- TypeScript package name: `browsefn`
- Python package name: `browsefn`
- Version: `0.1.0`
- License: `Apache-2.0`

## Runtime Surface

### TypeScript

- Factory: `browseFn(config?)`
- Main class: `BrowseFn`
- Router export: `createBrowseFnRouter`
- Canonical web ids: `cheerio`, `puppeteer`, `playwright`, `firecrawl`, `jina`
- Canonical image ids: `unsplash`, `pixabay`, `pexels`
- Canonical geo ids: `nominatim`, `google-maps`, `mapbox`

### Python

- Factory: `browse_fn(config=None)`
- Main class: `BrowseFn`
- Router export: `create_browsefn_router`
- Canonical emitted web id: `cheerio`
- Accepted Python web aliases: `bs4`, `beautifulsoup`
- Canonical image ids: `unsplash`, `pixabay`, `pexels`
- Canonical geo ids: `nominatim`, `google-maps`, `mapbox`

## Shared Infrastructure

- TypeScript router uses `@superfunctions/http`
- Python router uses `superfunctions.http`
- TypeScript rate limiting delegates to `@superfunctions/middleware/rate-limit`
- Alias normalization is centralized in:
  - TypeScript: `browsefn/typescript/src/core/provider-registry.ts`
  - Python: `browsefn/python/browsefn/core/provider_registry.py`

## Notes By Surface

### Web

- `getPage()` supports typed options including `includeLinks`, `includeImages`, `headers`, `cookies`, `proxy`, `retry`, and `screenshot`
- TypeScript documents the full canonical provider matrix
- Python currently exposes the static provider path through the canonical emitted id `cheerio`
- Batch metadata extraction preserves order and supports bounded concurrency plus progress callbacks

### Images

- Search surface normalizes provider output across `unsplash`, `pixabay`, and `pexels`
- Download results must correspond to real files on disk
- Overwrite collisions return `DOWNLOAD_EXISTS`
- Batch downloads preserve input order and report monotonic progress

### Geo

- Reverse geocoding, forward geocoding, and search normalize to the shared result models
- `googleMaps` input is normalized to `google-maps`
- `nominatim` full place-details retrieval is deterministically unsupported

### Router

- Success payloads use `{"ok": true, "data": ..., "meta": ...}`
- Error payloads use `{"ok": false, "error": ..., "meta": ...}`
- Router validation converts raw request payloads into typed models before provider code runs

## Repo-Root Verification

```bash
npm --prefix browsefn/typescript run build
npm --prefix browsefn/typescript run typecheck
python3 -m compileall browsefn/python/browsefn browsefn/python/tests
python3 -m pytest browsefn/python/tests/test_web.py browsefn/python/tests/test_images.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_router.py -q
```
