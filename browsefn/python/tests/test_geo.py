from __future__ import annotations

import pytest

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import GeoAddress, GeocodeOptions, GeoLocation, GeoPlace, GeoSearchOptions, ReverseGeocodeResult
from browsefn.geo.geocoder import GeoService
from browsefn.geo.providers.nominatim import NominatimProvider


class FakeGeoProvider:
    def __init__(self, name: str):
        self.name = name

    async def reverse_geocode(self, location: GeoLocation) -> ReverseGeocodeResult:
        return ReverseGeocodeResult(
            location=location,
            address=GeoAddress(formatted="New York, NY, USA"),
            provider=self.name,
        )

    async def geocode(self, address: str, options: GeocodeOptions):
        return [
            ReverseGeocodeResult(
                location=GeoLocation(lat=40.7128, lng=-74.0060),
                address=GeoAddress(formatted=address),
                provider=self.name,
            )
        ]

    async def search(self, options: GeoSearchOptions):
        return [
            GeoPlace(
                id="place-123",
                name="Coffee 1",
                location=GeoLocation(lat=40.7128, lng=-74.0060),
                address=GeoAddress(formatted="1 Main St"),
                provider=self.name,
            ),
            GeoPlace(
                id="place-456",
                name="Coffee 2",
                location=GeoLocation(lat=40.7130, lng=-74.0065),
                address=GeoAddress(formatted="2 Main St"),
                provider=self.name,
            ),
        ]

    async def get_place_details(self, place_id: str, fields=None):
        return GeoPlace(
            id=place_id,
            name="Coffee 1",
            location=GeoLocation(lat=40.7128, lng=-74.0060),
            address=GeoAddress(formatted="1 Main St"),
            rating=4.5,
            provider=self.name,
        )

    async def is_available(self) -> bool:
        return True


@pytest.mark.asyncio
async def test_reverse_geocode_normalizes_googlemaps_alias():
    service = GeoService()
    service.register_provider("google-maps", FakeGeoProvider("google-maps"))

    result = await service.reverse_geocode(GeoLocation(lat=40.7128, lng=-74.0060), "googleMaps")

    assert result.provider == "google-maps"
    assert result.address.formatted == "New York, NY, USA"


@pytest.mark.asyncio
async def test_reverse_geocode_validates_coordinates():
    service = GeoService()
    service.register_provider("nominatim", FakeGeoProvider("nominatim"))

    with pytest.raises(BrowseFnError, match="Latitude must be between -90 and 90."):
        await service.reverse_geocode(GeoLocation(lat=120.0, lng=-74.0060), "nominatim")


@pytest.mark.asyncio
async def test_geo_search_and_place_details_normalize_to_geo_place():
    service = GeoService()
    service.register_provider("mapbox", FakeGeoProvider("mapbox"))

    results = await service.search(
        GeoSearchOptions(
            query="coffee shops",
            center=GeoLocation(lat=40.7128, lng=-74.0060),
            provider="mapbox",
            limit=2,
        )
    )
    details = await service.get_place_details("place-123", "mapbox", ["name", "address", "rating"])

    assert [result.id for result in results] == ["place-123", "place-456"]
    assert all(result.provider == "mapbox" for result in results)
    assert details.id == "place-123"
    assert details.provider == "mapbox"
    assert details.rating == 4.5


@pytest.mark.asyncio
async def test_nominatim_place_details_are_deterministically_unsupported():
    service = GeoService()
    service.register_provider("nominatim", NominatimProvider())

    with pytest.raises(BrowseFnError, match="Provider nominatim does not support full place-details retrieval."):
        await service.get_place_details("place-123", "nominatim", ["name"])
