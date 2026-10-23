# BrowseFn Quickstart

This quickstart uses repository-relative commands only.

## TypeScript Setup

```bash
npm --prefix browsefn/typescript install
npm --prefix browsefn/typescript run build
```

Install optional browser-provider peers only if you plan to use them:

```bash
npm --prefix browsefn/typescript install puppeteer
npm --prefix browsefn/typescript install playwright
```

## Python Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e "browsefn/python[test]"
```

The shared Python HTTP abstractions used by the router live in `packages/python-core/`, so the repo-local tests load both package roots from `browsefn/python/tests/conftest.py`.

## TypeScript Example

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
  includeImages: true,
});

console.log(page.provider);
console.log(page.metadata.title);
```

## Python Example

```python
import asyncio

from browsefn import BrowseFnConfig, GeoConfig, browse_fn


async def main() -> None:
    browse = browse_fn(
        BrowseFnConfig(
            geo=GeoConfig(defaultProvider="nominatim"),
        )
    )

    result = await browse.geo.reverse_geocode(
        {"lat": 40.7128, "lng": -74.0060},
        "nominatim",
    )

    print(result.provider)
    print(result.address.formatted)


asyncio.run(main())
```

## Examples In This Repo

```bash
npx tsx browsefn/typescript/examples/basic-web-scraping.ts
npx tsx browsefn/typescript/examples/geocoding.ts
npx tsx browsefn/typescript/examples/image-search.ts
npx tsx browsefn/typescript/examples/with-puppeteer.ts
```

The image example expects an `UNSPLASH_ACCESS_KEY` environment variable. The browser example expects `puppeteer` to be installed.

## Repo-Root Verification

```bash
npm --prefix browsefn/typescript run build
python3 -m compileall browsefn/python/browsefn browsefn/python/tests
python3 -m pytest browsefn/python/tests/test_web.py browsefn/python/tests/test_images.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_router.py -q
```
