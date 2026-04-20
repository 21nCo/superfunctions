from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace

import pytest

from superfunctions.http import RouteContext

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import GeocodeOptions, GeoAddress, GeoLocation, GetPageOptions, PageMetadata, PageResult, ReverseGeocodeResult
from browsefn.http.router import create_browsefn_router


class MockRequest:
    def __init__(self, *, method: str = "GET", path: str = "/", headers=None, json_body=None):
        self._method = method
        self._path = path
        self._headers = headers or {}
        self._json_body = json_body or {}

    @property
    def method(self) -> str:
        return self._method

    @property
    def path(self) -> str:
        return self._path

    @property
    def headers(self):
        return self._headers

    @property
    def query_params(self):
        return {}

    async def json(self):
        return self._json_body

    async def body(self) -> bytes:
        return b""

    async def text(self) -> str:
        return ""


def _route(routes, path: str):
    return next(route for route in routes if route.path == path)


@pytest.mark.asyncio
async def test_web_page_route_returns_canonical_success_envelope():
    class FakeWeb:
        async def get_page(self, url, options):
            assert isinstance(options, GetPageOptions)
            return PageResult(
                url=url,
                content="hello",
                metadata=PageMetadata(url=url, title="Example"),
                provider="cheerio",
            )

    router = create_browsefn_router(SimpleNamespace(web=FakeWeb(), images=None, geo=None, get_metrics=None))
    route = _route(router, "/web/page")
    request = MockRequest(method="POST", path="/web/page", json_body={"url": "https://example.com", "options": {"format": "text"}})
    context = RouteContext(url="/web/page", method="POST")

    response = await route.handler(request, context)

    assert response.status == 200
    assert response.body["ok"] is True
    assert response.body["data"]["url"] == "https://example.com"
    assert response.body["data"]["provider"] == "cheerio"
    assert response.body["meta"]["provider"] == "cheerio"


@pytest.mark.asyncio
async def test_web_page_route_rejects_missing_url():
    router = create_browsefn_router(SimpleNamespace(web=None, images=None, geo=None, get_metrics=None))
    route = _route(router, "/web/page")

    response = await route.handler(MockRequest(method="POST", path="/web/page", json_body={}), RouteContext(url="/web/page", method="POST"))

    assert response.status == 400
    assert response.body["ok"] is False
    assert response.body["error"]["code"] == "INVALID_ARGUMENT"
    assert response.body["error"]["message"] == "Missing required field: url"


@pytest.mark.asyncio
async def test_geo_geocode_route_converts_query_to_typed_models():
    class FakeGeo:
        async def geocode(self, address, options):
            assert isinstance(options, GeocodeOptions)
            assert options.provider == "googleMaps"
            assert options.limit == 1
            return [
                ReverseGeocodeResult(
                    location=GeoLocation(lat=37.422, lng=-122.084),
                    address=GeoAddress(formatted=address),
                    provider="google-maps",
                )
            ]

    router = create_browsefn_router(SimpleNamespace(web=None, images=None, geo=FakeGeo(), get_metrics=None))
    route = _route(router, "/geo/geocode")
    request = MockRequest(method="GET", path="/geo/geocode")
    context = RouteContext(
        url="/geo/geocode",
        method="GET",
        query={"address": "1600 Amphitheatre Parkway", "provider": "googleMaps", "limit": "1"},
    )

    response = await route.handler(request, context)

    assert response.status == 200
    assert response.body["ok"] is True
    assert response.body["data"]["results"][0]["provider"] == "google-maps"


@pytest.mark.asyncio
async def test_geo_reverse_route_validates_bad_latitude():
    router = create_browsefn_router(SimpleNamespace(web=None, images=None, geo=None, get_metrics=None))
    route = _route(router, "/geo/reverse")
    request = MockRequest(method="GET", path="/geo/reverse")
    context = RouteContext(url="/geo/reverse", method="GET", query={"lat": "north", "lng": "-74.0060"})

    response = await route.handler(request, context)

    assert response.status == 400
    assert response.body["ok"] is False
    assert response.body["error"]["code"] == "INVALID_ARGUMENT"
    assert response.body["error"]["message"] == "lat must be a number."
