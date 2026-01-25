"""
Nominatim geocoding provider (OpenStreetMap)
"""

import httpx
from typing import Optional, List
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
        
        address = GeoAddress(
            formatted=data.get('display_name', ''),
            street=address_data.get('road'),
            streetNumber=address_data.get('house_number'),
            city=address_data.get('city') or address_data.get('town') or address_data.get('village'),
            state=address_data.get('state'),
            country=address_data.get('country'),
            postalCode=address_data.get('postcode'),
            countryCode=address_data.get('country_code'),
            neighborhood=address_data.get('neighbourhood'),
            district=address_data.get('suburb'),
            region=address_data.get('region')
        )
        
        return ReverseGeocodeResult(
            location=location,
            address=address,
            placeId=data.get('place_id'),
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
        
        # Apply bounds if specified
        if options.bounds:
            params['bounded'] = 1
            params['viewbox'] = f"{options.bounds.sw.lng},{options.bounds.sw.lat},{options.bounds.ne.lng},{options.bounds.ne.lat}"
        
        # Apply component filters
        if options.components:
            if options.components.country:
                params['countrycodes'] = options.components.country
        
        headers = {'User-Agent': self.user_agent}
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.endpoint}/search',
                params=params,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()
        
        results = []
        for item in data:
            location = GeoLocation(
                lat=float(item.get('lat', 0)),
                lng=float(item.get('lon', 0))
            )
            
            address_data = item.get('address', {})
            address = GeoAddress(
                formatted=item.get('display_name', ''),
                street=address_data.get('road'),
                streetNumber=address_data.get('house_number'),
                city=address_data.get('city') or address_data.get('town'),
                state=address_data.get('state'),
                country=address_data.get('country'),
                postalCode=address_data.get('postcode'),
                countryCode=address_data.get('country_code')
            )
            
            results.append(ReverseGeocodeResult(
                location=location,
                address=address,
                placeId=item.get('place_id'),
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
        
        # Apply center and radius
        if options.center and options.radius:
            # Nominatim doesn't support radius directly, use viewbox approximation
            # Calculate rough bounding box (simplified)
            lat_offset = options.radius / 111000  # rough degrees
            lng_offset = options.radius / (111000 * abs(options.center.lat))
            
            params['viewbox'] = f"{options.center.lng - lng_offset},{options.center.lat - lat_offset},{options.center.lng + lng_offset},{options.center.lat + lat_offset}"
            params['bounded'] = 1
        
        headers = {'User-Agent': self.user_agent}
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.endpoint}/search',
                params=params,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()
        
        results = []
        for item in data:
            location = GeoLocation(
                lat=float(item.get('lat', 0)),
                lng=float(item.get('lon', 0))
            )
            
            address_data = item.get('address', {})
            address = GeoAddress(
                formatted=item.get('display_name', ''),
                street=address_data.get('road'),
                city=address_data.get('city'),
                state=address_data.get('state'),
                country=address_data.get('country'),
                postalCode=address_data.get('postcode'),
                countryCode=address_data.get('country_code')
            )
            
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
    
    async def get_place_details(self, place_id: str, fields: Optional[List[str]] = None) -> GeoPlace:
        """Get details for a specific place"""
        params = {
            'place_id': place_id,
            'format': 'json',
            'addressdetails': 1
        }
        
        headers = {'User-Agent': self.user_agent}
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.endpoint}/lookup',
                params=params,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()
        
        if not data:
            raise ValueError(f"Place {place_id} not found")
        
        item = data[0] if isinstance(data, list) else data
        
        location = GeoLocation(
            lat=float(item.get('lat', 0)),
            lng=float(item.get('lon', 0))
        )
        
        address_data = item.get('address', {})
        address = GeoAddress(
            formatted=item.get('display_name', ''),
            street=address_data.get('road'),
            city=address_data.get('city'),
            state=address_data.get('state'),
            country=address_data.get('country'),
            postalCode=address_data.get('postcode'),
            countryCode=address_data.get('country_code')
        )
        
        return GeoPlace(
            id=place_id,
            name=item.get('name', ''),
            location=location,
            address=address,
            types=item.get('type', '').split(',') if item.get('type') else None,
            provider=self.name
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
