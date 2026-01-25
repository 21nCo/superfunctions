from typing import Dict, Optional, List
from browsefn.core.types import GeoConfig, GeoLocation, ReverseGeocodeResult, GeocodeOptions, GeoSearchOptions, GeoPlace, GeoProvider
from browsefn.core.provider_manager import ProviderManager

class GeoService:
    def __init__(self, config: Optional[GeoConfig] = None):
        self.config = config or GeoConfig()
        self.providers: Dict[str, GeoProvider] = {}
        self.provider_manager = ProviderManager(self.providers, self.config.default_provider)

    def register_provider(self, name: str, provider: GeoProvider):
        self.provider_manager.register_provider(name, provider)

    async def reverse_geocode(self, location: GeoLocation, provider_name: Optional[str] = None) -> ReverseGeocodeResult:
        provider = self.provider_manager.get_provider(provider_name)
        return await provider.reverse_geocode(location)

    async def geocode(self, address: str, options: Optional[GeocodeOptions] = None) -> List[ReverseGeocodeResult]:
        options = options or GeocodeOptions()
        provider = self.provider_manager.get_provider(options.provider)
        return await provider.geocode(address, options)

    async def search(self, options: GeoSearchOptions) -> List[GeoPlace]:
        provider = self.provider_manager.get_provider(options.provider)
        if hasattr(provider, 'search'):
            return await provider.search(options)
        raise NotImplementedError(f"Provider {provider.name} does not support search")

    async def get_place_details(self, place_id: str, provider_name: Optional[str] = None, fields: Optional[List[str]] = None) -> GeoPlace:
        provider = self.provider_manager.get_provider(provider_name)
        if hasattr(provider, 'get_place_details'):
            return await provider.get_place_details(place_id, fields)
        raise NotImplementedError(f"Provider {provider.name} does not support get_place_details")
