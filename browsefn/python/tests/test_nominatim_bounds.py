from unittest.mock import AsyncMock, patch
import httpx
import pytest
from browsefn.core.types import GeoLocation, GeoSearchOptions
from browsefn.geo.providers.nominatim import NominatimProvider, radius_viewboxes


def test_latitude_scaling():
    equator = radius_viewboxes(0, 0, 1000)[0]
    assert equator[0] == pytest.approx(-0.0089932, rel=1e-5)
    assert radius_viewboxes(60, 0, 1000)[0][2] == pytest.approx(equator[2]*2, rel=1e-6)


@pytest.mark.parametrize('lat', [90, -90, 89.99, -89.99])
def test_polar_caps(lat):
    west, south, east, north = radius_viewboxes(lat, 30, 10000)[0]
    assert west == -180 and east == 180 and -90 <= south <= north <= 90


@pytest.mark.parametrize('lng', [179.999, -179.999])
def test_antimeridian(lng):
    boxes = radius_viewboxes(0, lng, 1000)
    assert len(boxes) == 2
    assert sum(b[2]-b[0] for b in boxes) == pytest.approx(0.0179864, rel=1e-5)
    assert all(-180 <= b[0] <= b[2] <= 180 for b in boxes)


def test_zero_and_global_radius():
    assert radius_viewboxes(0, 0, 0) == [(0, 0, 0, 0)]
    assert radius_viewboxes(0, 0, 30000000) == [(-180, -90, 180, 90)]


@pytest.mark.asyncio
async def test_search_queries_both_boxes_and_deduplicates():
    response = httpx.Response(200, json=[{'place_id':1,'lat':'0','lon':'179.999'}], request=httpx.Request('GET','https://example.com'))
    client = AsyncMock()
    client.get.return_value = response
    client.__aenter__.return_value = client
    with patch('browsefn.geo.providers.nominatim.httpx.AsyncClient', return_value=client):
        result = await NominatimProvider().search(GeoSearchOptions(query='cafe', center=GeoLocation(lat=0,lng=179.999), radius=1000))
    assert len(result) == 1 and client.get.call_count == 2
    assert all(c.kwargs['params']['bounded'] == 1 for c in client.get.call_args_list)


@pytest.mark.asyncio
@pytest.mark.parametrize('components,expected', [
    ({'country': 'us'}, {'q': '10 Main Street', 'countrycodes': 'us'}),
    ({'locality': 'Boston'}, {'street': '10 Main Street', 'city': 'Boston'}),
    ({'postalCode': '02110'}, {'street': '10 Main Street', 'postalcode': '02110'}),
    ({'country': 'us', 'locality': 'Boston', 'postalCode': '02110'},
     {'street': '10 Main Street', 'countrycodes': 'us', 'city': 'Boston', 'postalcode': '02110'}),
])
async def test_geocode_components(components, expected):
    from browsefn.core.types import GeocodeOptions
    response = httpx.Response(200, json=[{'place_id': 123, 'lat': '42', 'lon': '-71'}], request=httpx.Request('GET', 'https://example.com'))
    client = AsyncMock()
    client.get.return_value = response
    client.__aenter__.return_value = client
    with patch('browsefn.geo.providers.nominatim.httpx.AsyncClient', return_value=client):
        results = await NominatimProvider().geocode('10 Main Street', GeocodeOptions(components=components))
    params = client.get.call_args.kwargs['params']
    assert all(params[key] == value for key, value in expected.items())
    if 'street' in expected:
        assert 'q' not in params
    assert results[0].place_id == '123'


@pytest.mark.asyncio
async def test_geocode_antimeridian_bounds_and_total_limit():
    from browsefn.core.types import GeocodeOptions
    response = httpx.Response(200, json=[{'place_id': 123, 'lat': '0', 'lon': '179.5'}], request=httpx.Request('GET', 'https://example.com'))
    client = AsyncMock()
    client.get.return_value = response
    client.__aenter__.return_value = client
    with patch('browsefn.geo.providers.nominatim.httpx.AsyncClient', return_value=client):
        results = await NominatimProvider().geocode('Main Street', GeocodeOptions(
            bounds={'sw': {'lat': -1, 'lng': 179}, 'ne': {'lat': 1, 'lng': -179}}, limit=1,
        ))
    assert len(results) == 1
    assert client.get.call_count == 2
    boxes = [list(map(float, call.kwargs['params']['viewbox'].split(','))) for call in client.get.call_args_list]
    assert boxes == [[179, -1, 180, 1], [-180, -1, -179, 1]]
