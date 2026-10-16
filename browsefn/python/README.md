# BrowseFn Python

The Python package published from this directory is `browsefn`.

Requires Python **>=3.10**. See [0.2 migration notes](../.conduct/migration-0.2.md) for retry, fallback and cache behavior changes.

## Install

```bash
pip install browsefn
```

## Public Exports

```python
from browsefn import (
    browse_fn,
    BrowseFn,
    BrowseFnConfig,
    WebConfig,
    ImageConfig,
    GeoConfig,
    BeautifulSoupProvider,
    UnsplashProvider,
    PixabayProvider,
    PexelsProvider,
    NominatimProvider,
    GoogleMapsProvider,
    MapboxProvider,
    create_browsefn_router,
)
```

## Canonical Provider IDs

- Web ids emitted by the Python package: `cheerio`
- Accepted Python web aliases: `bs4`, `beautifulsoup`
- Image ids: `unsplash`, `pixabay`, `pexels`
- Geo ids: `nominatim`, `google-maps`, `mapbox`

## Example

```python
import asyncio

from browsefn import BrowseFnConfig, WebConfig, browse_fn


async def main() -> None:
    browse = browse_fn(
        BrowseFnConfig(
            web=WebConfig(defaultProvider="cheerio"),
            cache={"enabled": True, "ttl": 60_000},
        )
    )

    page = await browse.web.get_page(
        "https://example.com",
        {
            "format": "text",
            "includeLinks": True,
        },
    )

    print(page.provider)
    print(page.metadata.title)


asyncio.run(main())
```

## Router

The Python router uses `superfunctions.http` and returns canonical BrowseFn envelopes.

```python
from browsefn import browse_fn, create_browsefn_router

browse = browse_fn()
routes = create_browsefn_router(browse)
```

## Repo-Root Verification

```bash
python3 -m compileall browsefn/python/browsefn browsefn/python/tests
python3 -m pytest browsefn/python/tests/test_web.py browsefn/python/tests/test_images.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_router.py -q
```

## Related Files

- [Package overview](../README.md)
- [Testing guide](./TESTING.md)
