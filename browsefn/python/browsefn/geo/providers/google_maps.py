"""
Google Maps geocoding provider
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
    ProviderConfig,
    OpeningHours
)


class GoogleMapsProvider:
    """Google Maps Geocoding API provider"""
    
    name = "google-maps"
    
    def __init__(self, config: Optional[ProviderConfig] = None):
        self.config = config or ProviderConfig()
        self.api_key = self.config.api_key
        self.base_url = "https://maps.googleapis.com/maps/api"
    
    async def reverse_geocode(self, location: GeoLocation) -> ReverseGeocodeResult:
        """Convert coordinates to address"""
        if not self.api_key:
            raise ValueError("Google Maps API key is required")
        
        params = {
            'latlng': f'{location.lat},{location.lng}',
            'key': self.api_key
        }
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/geocode/json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        if data['status'] != 'OK':
            raise Exception(f"Google Maps API error: {data['status']}")
        
        result = data['results'][0]
        components = {c['types'][0]: c for c in result.get('address_components', [])}
        
        address = GeoAddress(
            formatted=result.get('formatted_address', ''),
            street=components.get('route', {}).get('long_name'),
            streetNumber=components.get('street_number', {}).get('long_name'),
            city=components.get('locality', {}).get('long_name') or 
                 components.get('administrative_area_level_2', {}).get('long_name'),
            state=components.get('administrative_area_level_1', {}).get('long_name'),
            country=components.get('country', {}).get('long_name'),
            postalCode=components.get('postal_code', {}).get('long_name'),
            countryCode=components.get('country', {}).get('short_name'),
            neighborhood=components.get('neighborhood', {}).get('long_name'),
            district=components.get('sublocality', {}).get('long_name')
        )
        
        return ReverseGeocodeResult(
            location=location,
            address=address,
            placeId=result.get('place_id'),
            provider=self.name
        )
    
    async def geocode(self, address: str, options: GeocodeOptions) -> List[ReverseGeocodeResult]:
        """Convert address to coordinates"""
        if not self.api_key:
            raise ValueError("Google Maps API key is required")
        
        params = {
            'address': address,
            'key': self.api_key
        }
        
        # Apply component filters
        if options.components:
            filters = []
            if options.components.country:
                filters.append(f'country:{options.components.country}')
            if options.components.postal_code:
                filters.append(f'postal_code:{options.components.postal_code}')
            if filters:
                params['components'] = '|'.join(filters)
        
        # Apply bounds
        if options.bounds:
            params['bounds'] = f"{options.bounds.sw.lat},{options.bounds.sw.lng}|{options.bounds.ne.lat},{options.bounds.ne.lng}"
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/geocode/json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        if data['status'] != 'OK':
            raise Exception(f"Google Maps API error: {data['status']}")
        
        results = []
        for result in data['results'][:options.limit or 5]:
            loc_data = result.get('geometry', {}).get('location', {})
            location = GeoLocation(
                lat=loc_data.get('lat', 0),
                lng=loc_data.get('lng', 0)
            )
            
            components = {c['types'][0]: c for c in result.get('address_components', [])}
            address = GeoAddress(
                formatted=result.get('formatted_address', ''),
                street=components.get('route', {}).get('long_name'),
                streetNumber=components.get('street_number', {}).get('long_name'),
                city=components.get('locality', {}).get('long_name'),
                state=components.get('administrative_area_level_1', {}).get('long_name'),
                country=components.get('country', {}).get('long_name'),
                postalCode=components.get('postal_code', {}).get('long_name'),
                countryCode=components.get('country', {}).get('short_name')
            )
            
            results.append(ReverseGeocodeResult(
                location=location,
                address=address,
                placeId=result.get('place_id'),
                provider=self.name
            ))
        
        return results
    
    async def search(self, options: GeoSearchOptions) -> List[GeoPlace]:
        """Search for places"""
        if not self.api_key:
            raise ValueError("Google Maps API key is required")
        
        params = {
            'query': options.query,
            'key': self.api_key
        }
        
        # Add location bias if center provided
        if options.center:
            params['location'] = f'{options.center.lat},{options.center.lng}'
            if options.radius:
                params['radius'] = options.radius
        
        # Add type filter
        if options.types:
            # Map generic types to Google types
            type_map = {
                'address': 'street_address',
                'city': 'locality',
                'country': 'country',
                'poi': 'point_of_interest',
                'postcode': 'postal_code'
            }
            google_type = type_map.get(options.types[0], options.types[0])
            params['type'] = google_type
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/place/textsearch/json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        if data['status'] != 'OK':
            raise Exception(f"Google Maps API error: {data['status']}")
        
        results = []
        for result in data['results'][:options.limit or 20]:
            loc_data = result.get('geometry', {}).get('location', {})
            location = GeoLocation(
                lat=loc_data.get('lat', 0),
                lng=loc_data.get('lng', 0)
            )
            
            address = GeoAddress(
                formatted=result.get('formatted_address', '')
            )
            
            place = GeoPlace(
                id=result.get('place_id', ''),
                name=result.get('name', ''),
                location=location,
                address=address,
                types=result.get('types'),
                rating=result.get('rating'),
                provider=self.name
            )
            results.append(place)
        
        return results
    
    async def get_place_details(self, place_id: str, fields: Optional[List[str]] = None) -> GeoPlace:
        """Get details for a specific place"""
        if not self.api_key:
            raise ValueError("Google Maps API key is required")
        
        # Default fields
        requested_fields = fields or ['name', 'formatted_address', 'geometry', 'rating', 'opening_hours']
        
        params = {
            'place_id': place_id,
            'fields': ','.join(requested_fields),
            'key': self.api_key
        }
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/place/details/json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        if data['status'] != 'OK':
            raise Exception(f"Google Maps API error: {data['status']}")
        
        result = data['result']
        loc_data = result.get('geometry', {}).get('location', {})
        location = GeoLocation(
            lat=loc_data.get('lat', 0),
            lng=loc_data.get('lng', 0)
        )
        
        address = GeoAddress(
            formatted=result.get('formatted_address', '')
        )
        
        # Parse opening hours if available
        opening_hours = None
        if 'opening_hours' in result:
            opening_hours = OpeningHours(
                open=result['opening_hours'].get('open_now', False),
                periods=None  # Simplified - full implementation would parse periods
            )
        
        return GeoPlace(
            id=place_id,
            name=result.get('name', ''),
            location=location,
            address=address,
            types=result.get('types'),
            rating=result.get('rating'),
            reviews=result.get('user_ratings_total'),
            photos=[p.get('photo_reference') for p in result.get('photos', [])],
            website=result.get('website'),
            phone=result.get('formatted_phone_number'),
            openingHours=opening_hours,
            provider=self.name
        )
    
    async def is_available(self) -> bool:
        """Check if Google Maps API is available"""
        return bool(self.api_key)
