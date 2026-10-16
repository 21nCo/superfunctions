"""
Nominatim geocoding provider (OpenStreetMap)
"""

import math
import httpx
from typing import Optional, List
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import (
    GeoProvider,
    GeoLocation,
    GeoAddress,
    ReverseGeocodeResult,
    GeocodeOptions,
    GeoSearchOptions,
    GeoPlace,
    ProviderConfig
)


def radius_viewboxes(lat: float, lng: float, radius: float) -> list[tuple[float, float, float, float]]:
    """Spherical-cap rectangles split at the antimeridian."""
    if not all(math.isfinite(v) for v in (lat, lng, radius)) or abs(lat) > 90 or abs(lng) > 180 or radius < 0:
        raise ValueError("Invalid center or radius")
    angle = min(radius / 6371000, math.pi)
    latitude = math.radians(lat)
    south, north = max(-90.0, math.degrees(latitude-angle)), min(90.0, math.degrees(latitude+angle))
    if south <= -90 or north >= 90:
        return [(-180.0, south, 180.0, north)]
    offset = math.degrees(math.asin(min(1.0, math.sin(angle)/math.cos(latitude))))
    west, east = lng-offset, lng+offset
    if west < -180:
        return [(west+360, south, 180.0, north), (-180.0, south, east, north)]
    if east > 180:
        return [(west, south, 180.0, north), (-180.0, south, east-360, north)]
    return [(west, south, east, north)]


class NominatimProvider:
    """OpenStreetMap Nominatim geocoding provider"""

    name = "nominatim"

    def __init__(self, config: Optional[ProviderConfig] = None):
        self.config = config or ProviderConfig()
        self.endpoint = self.config.endpoint or "https://nominatim.openstreetmap.org"
        self.user_agent = self.config.extra.get('user_agent', 'browsefn/1.0')

    async def reverse_geocode(self, location: GeoLocation) -> ReverseGeocodeResult:
        """Convert coordinates to address"""
        params = {
            'lat': location.lat,
            'lon': location.lng,
            'format': 'json',
            'addressdetails': 1
        }

        headers = {'User-Agent': self.user_agent}

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.endpoint}/reverse',
                params=params,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()

        address_data = data.get('address', {})

        address = self._address(data, city=address_data.get('city') or address_data.get('town') or address_data.get('village'), streetNumber=address_data.get('house_number'), neighborhood=address_data.get('neighbourhood'), district=address_data.get('suburb'), region=address_data.get('region'))

        return ReverseGeocodeResult(
            location=location,
            address=address,
            placeId=str(data['place_id']) if data.get('place_id') is not None else None,
            provider=self.name
        )

    async def geocode(self, address: str, options: GeocodeOptions) -> List[ReverseGeocodeResult]:
        """Convert address to coordinates"""
        params = {
            'q': address,
            'format': 'json',
            'addressdetails': 1,
            'limit': options.limit or 5
        }

        boxes = [None]
        if options.bounds:
            sw, ne = options.bounds.sw, options.bounds.ne
            boxes = [(sw.lng, sw.lat, ne.lng, ne.lat)]
            if sw.lng > ne.lng:
                boxes = [(sw.lng, sw.lat, 180, ne.lat), (-180, sw.lat, ne.lng, ne.lat)]

        if options.components:
            components = options.components
            if components.country:
                params['countrycodes'] = components.country
            if components.locality or components.postal_code:
                # Nominatim forbids combining q with structured address fields.
                params.pop('q')
                params['street'] = address
                if components.locality:
                    params['city'] = components.locality
                if components.postal_code:
                    params['postalcode'] = components.postal_code

        data = await self._search_boxes(params, boxes, options.limit or 5)

        results = []
        for item in data:
            location = GeoLocation(
                lat=float(item.get('lat', 0)),
                lng=float(item.get('lon', 0))
            )

            address_data = item.get('address', {})
            address = self._address(item, city=address_data.get('city') or address_data.get('town'), streetNumber=address_data.get('house_number'))

            results.append(ReverseGeocodeResult(
                location=location,
                address=address,
                placeId=str(item['place_id']) if item.get('place_id') is not None else None,
                provider=self.name
            ))

        return results

    async def search(self, options: GeoSearchOptions) -> List[GeoPlace]:
        """Search for places"""
        params = {
            'q': options.query,
            'format': 'json',
            'addressdetails': 1,
            'limit': options.limit or 20
        }

        boxes = [None]
        if options.center is not None and options.radius is not None:
            boxes = radius_viewboxes(options.center.lat, options.center.lng, options.radius)
        data = await self._search_boxes(params, boxes, options.limit or 20)

        results = []
        for item in data:
            location = GeoLocation(
                lat=float(item.get('lat', 0)),
                lng=float(item.get('lon', 0))
            )

            address_data = item.get('address', {})
            address = self._address(item, city=address_data.get('city'))

            place = GeoPlace(
                id=str(item.get('place_id', '')),
                name=item.get('name', ''),
                location=location,
                address=address,
                types=item.get('type', '').split(',') if item.get('type') else None,
                provider=self.name
            )
            results.append(place)

        return results

    @staticmethod
    def _address(item: dict, **fields) -> GeoAddress:
        data = item.get('address', {})
        return GeoAddress(
            formatted=item.get('display_name', ''),
            street=data.get('road'), state=data.get('state'),
            country=data.get('country'), postalCode=data.get('postcode'),
            countryCode=data.get('country_code'), **fields,
        )

    async def _search_boxes(self, params: dict, boxes: list, limit: int) -> list[dict]:
        """Fetch bounded search partitions once and enforce a combined limit."""
        headers = {'User-Agent': self.user_agent}
        data, seen = [], set()
        async with httpx.AsyncClient(timeout=10.0) as client:
            for box in boxes:
                request_params = dict(params)
                if box is not None:
                    request_params.update(viewbox=','.join(map(str, box)), bounded=1)
                response = await client.get(f'{self.endpoint}/search', params=request_params, headers=headers)
                response.raise_for_status()
                for item in response.json():
                    identity = (item.get('place_id'), item.get('lat'), item.get('lon'))
                    if identity not in seen:
                        seen.add(identity)
                        data.append(item)
        return data[:limit]


    async def get_place_details(self, place_id: str, fields: Optional[List[str]] = None) -> GeoPlace:
        """Nominatim does not provide full place-details parity."""
        raise BrowseFnError(
            "UNSUPPORTED_PROVIDER_CAPABILITY",
            "Provider nominatim does not support full place-details retrieval.",
            provider=self.name,
        )

    async def is_available(self) -> bool:
        """Check if Nominatim endpoint is available"""
        try:
            headers = {'User-Agent': self.user_agent}
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    f'{self.endpoint}/status',
                    headers=headers
                )
                return response.status_code == 200
        except Exception:
            return False
