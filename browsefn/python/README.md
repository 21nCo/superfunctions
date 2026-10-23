# BrowseFn Python

The Python package published from this directory is `browsefn`.

Requires Python **>=3.10**. See [0.2 migration notes](../README.md#browsefn-02-migration) for retry, fallback and cache behavior changes.

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


## HTTP destination policy

The router forces public destinations for page, metadata and image download
requests; body options cannot opt into private hosts. Page/metadata requests use
no cache. Static HTML uses checked DNS answers pinned to each connection and
revalidates every redirect (five by default), with a default 10 MiB body limit and an overall
timeout. Encoded responses, proxies and cookies are rejected on protected static
requests. Non-static/custom providers fail closed pending enforced egress
isolation; this does not complete browser-provider security or SEC-001.

For trusted direct use, `GetPageOptions(security={"allowPrivateHosts": False},
cache=False)` selects protected static transport. Set `allowPrivateHosts` to
`True` only for an explicitly trusted private destination. Omitting `security`
keeps legacy direct-library behavior and provides no untrusted-URL boundary.
See the root BrowseFn README for the migration limits and remaining work.


Global `BrowseFnConfig(security={"maxResponseBytes": 2097152,
"maxDownloadBytes": 8388608, "maxRedirects": 2})` configures static page/metadata
and image transfers. Defaults are 10 MiB, 25 MiB and five redirects. A per-call
limit can tighten an explicit global limit; explicitly configured limits may
exceed defaults. Zero redirects prohibits following the first redirect. Positive
safe-integer byte limits and nonnegative safe-integer redirect limits are
validated before requests. Python `None` means omitted. Legacy image
`maxPayloadBytes`/`maxRedirects` tighten any configured ceiling. Routers inherit
trusted global limits while prohibiting private-destination overrides.

Decoded HTML, formatted UTF-8 content and cached page content are also checked.
Image input, watermark and encoded output are checked before publication, but
encoded caps do not bound pixel/encoder intermediate memory. Protected custom
providers remain unsupported; the full browser/global-limit contract is open.
See the root README's configurable transfer limits for cache identity and legacy
transport boundaries.
