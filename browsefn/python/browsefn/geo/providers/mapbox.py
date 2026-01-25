"""
Mapbox geocoding provider
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


class MapboxProvider:
    """Mapbox Geocoding API provider"""
    
    name = "mapbox"
    
    def __init__(self, config: Optional[ProviderConfig] = None):
        self.config = config or ProviderConfig()
        self.api_key = self.config.api_key
        self.base_url = "https://api.mapbox.com/geocoding/v5/mapbox.places"
    
    async def reverse_geocode(self, location: GeoLocation) -> ReverseGeocodeResult:
        """Convert coordinates to address"""
        if not self.api_key:
            raise ValueError("Mapbox API key is required")
        
        params = {'access_token': self.api_key}
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/{location.lng},{location.lat}.json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        if not data.get('features'):
            raise Exception("No results found")
        
        result = data['features'][0]
        
        # Parse address components from context
        components = {}
        for ctx in result.get('context', []):
            ctx_type = ctx.get('id', '').split('.')[0]
            components[ctx_type] = ctx.get('text')
        
        address = GeoAddress(
            formatted=result.get('place_name', ''),
            street=result.get('text') if result.get('place_type', [''])[0] == 'address' else None,
            city=components.get('place'),
            state=components.get('region'),
            country=components.get('country'),
            postalCode=components.get('postcode')
        )
        
        return ReverseGeocodeResult(
            location=location,
            address=address,
            placeId=result.get('id'),
            provider=self.name
        )
    
    async def geocode(self, address: str, options: GeocodeOptions) -> List[ReverseGeocodeResult]:
        """Convert address to coordinates"""
        if not self.api_key:
            raise ValueError("Mapbox API key is required")
        
        params = {
            'access_token': self.api_key,
            'limit': options.limit or 5
        }
        
        # Apply bounds
        if options.bounds:
            bbox = f"{options.bounds.sw.lng},{options.bounds.sw.lat},{options.bounds.ne.lng},{options.bounds.ne.lat}"
            params['bbox'] = bbox
        
        # Apply country filter
        if options.components and options.components.country:
            params['country'] = options.components.country.lower()
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/{address}.json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        results = []
        for result in data.get('features', []):
            coords = result.get('center', [0, 0])
            location = GeoLocation(
                lat=coords[1],
                lng=coords[0]
            )
            
            # Parse address components
            components = {}
            for ctx in result.get('context', []):
                ctx_type = ctx.get('id', '').split('.')[0]
                components[ctx_type] = ctx.get('text')
            
            address = GeoAddress(
                formatted=result.get('place_name', ''),
                street=result.get('text') if result.get('place_type', [''])[0] == 'address' else None,
                city=components.get('place'),
                state=components.get('region'),
                country=components.get('country'),
                postalCode=components.get('postcode')
            )
            
            results.append(ReverseGeocodeResult(
                location=location,
                address=address,
                placeId=result.get('id'),
                provider=self.name
            ))
        
        return results
    
    async def search(self, options: GeoSearchOptions) -> List[GeoPlace]:
        """Search for places"""
        if not self.api_key:
            raise ValueError("Mapbox API key is required")
        
        params = {
            'access_token': self.api_key,
            'limit': options.limit or 20
        }
        
        # Add proximity bias if center provided
        if options.center:
            params['proximity'] = f'{options.center.lng},{options.center.lat}'
        
        # Add type filter
        if options.types:
            # Map generic types to Mapbox types
            type_map = {
                'address': 'address',
                'city': 'place',
                'country': 'country',
                'poi': 'poi',
                'postcode': 'postcode'
            }
            mapbox_type = type_map.get(options.types[0], 'poi')
            params['types'] = mapbox_type
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/{options.query}.json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        results = []
        for result in data.get('features', []):
            coords = result.get('center', [0, 0])
            location = GeoLocation(
                lat=coords[1],
                lng=coords[0]
            )
            
            # Parse address components
            components = {}
            for ctx in result.get('context', []):
                ctx_type = ctx.get('id', '').split('.')[0]
                components[ctx_type] = ctx.get('text')
            
            address = GeoAddress(
                formatted=result.get('place_name', ''),
                city=components.get('place'),
                state=components.get('region'),
                country=components.get('country')
            )
            
            place = GeoPlace(
                id=result.get('id', ''),
                name=result.get('text', ''),
                location=location,
                address=address,
                types=result.get('place_type'),
                provider=self.name
            )
            results.append(place)
        
        return results
    
    async def get_place_details(self, place_id: str, fields: Optional[List[str]] = None) -> GeoPlace:
        """Get details for a specific place"""
        if not self.api_key:
            raise ValueError("Mapbox API key is required")
        
        # Mapbox doesn't have a separate place details endpoint
        # We'll fetch the place by ID
        params = {'access_token': self.api_key}
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/{place_id}.json',
                params=params
            )
            response.raise_for_status()
            data = response.json()
        
        if not data.get('features'):
            raise ValueError(f"Place {place_id} not found")
        
        result = data['features'][0]
        coords = result.get('center', [0, 0])
        location = GeoLocation(
            lat=coords[1],
            lng=coords[0]
        )
        
        # Parse address components
        components = {}
        for ctx in result.get('context', []):
            ctx_type = ctx.get('id', '').split('.')[0]
            components[ctx_type] = ctx.get('text')
        
        address = GeoAddress(
            formatted=result.get('place_name', ''),
            city=components.get('place'),
            state=components.get('region'),
            country=components.get('country')
        )
        
        return GeoPlace(
            id=place_id,
            name=result.get('text', ''),
            location=location,
            address=address,
            types=result.get('place_type'),
            provider=self.name
        )
    
    async def is_available(self) -> bool:
        """Check if Mapbox API is available"""
        return bool(self.api_key)
