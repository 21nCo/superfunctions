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

Publish/install `@superfunctions/http@0.3.1` before BrowseFn 0.2.0: it adds the independent `@superfunctions/http/router` export. Other shared dependency versions are unchanged. This branch does not publish packages.

Per-call `retry.count` now means retries **after** the initial attempt and overrides global retry settings; `count: 0` disables retries for that call. `fallbackOnErrors: []` disables fallback, while an omitted policy retains fallback for all provider errors. Configured global quotas now apply across providers. Cache entries now fingerprint full request options, including credentials and TTL; previous cache entries are not reused under the new fingerprints.

See [provider protocol limits](./.conduct/provider-contracts.md) and [0.2 migration notes](./.conduct/migration-0.2.md) for remote-provider and cache details.

Configure `web.userAgents` for deterministic target User-Agent rotation. Explicit per-call User-Agent headers take precedence. See [credential storage](./.conduct/credential-storage.md) for credential URL cache bypass, legacy-cache cleanup, log redaction and SecFn integration.
