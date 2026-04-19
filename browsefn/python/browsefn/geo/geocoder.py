from typing import Dict, List, Optional

from browsefn.core.errors import BrowseFnError
from browsefn.core.provider_manager import ProviderManager
from browsefn.core.provider_registry import normalize_geo_provider_id, sort_provider_ids
from browsefn.core.types import GeocodeOptions, GeoConfig, GeoLocation, GeoPlace, GeoProvider, GeoSearchOptions, ReverseGeocodeResult
from browsefn.utils.validation import validate_geocode_options, validate_geo_location, validate_geo_options


class GeoService:
    def __init__(self, config: Optional[GeoConfig] = None):
        self.config = config or GeoConfig()
        self.providers: Dict[str, GeoProvider] = {}
        self.provider_manager = ProviderManager(
            self.providers,
            normalize_geo_provider_id(self.config.default_provider),
        )

    def register_provider(self, name: str, provider: GeoProvider):
        canonical_name = normalize_geo_provider_id(name) or name
        self.provider_manager.register_provider(canonical_name, provider)
        if not self.provider_manager.default_provider:
            self.provider_manager.default_provider = canonical_name

    async def reverse_geocode(self, location: GeoLocation, provider_name: Optional[str] = None) -> ReverseGeocodeResult:
        validate_geo_location(location)
        requested_provider = normalize_geo_provider_id(provider_name)

        async def executor(provider: GeoProvider, canonical_name: str) -> ReverseGeocodeResult:
            result = await provider.reverse_geocode(location)
            result.provider = canonical_name
            return result

        return await self.provider_manager.execute_with_fallback(requested_provider, executor)

    async def geocode(self, address: str, options: Optional[GeocodeOptions] = None) -> List[ReverseGeocodeResult]:
        options = options or GeocodeOptions()
        validate_geocode_options(options)
        requested_provider = normalize_geo_provider_id(options.provider)

        async def executor(provider: GeoProvider, canonical_name: str) -> List[ReverseGeocodeResult]:
            results = await provider.geocode(address, options)
            for result in results:
                result.provider = canonical_name
            return results

        return await self.provider_manager.execute_with_fallback(requested_provider, executor)

    async def search(self, options: GeoSearchOptions) -> List[GeoPlace]:
        validate_geo_options(options)
        requested_provider = normalize_geo_provider_id(options.provider)

        async def executor(provider: GeoProvider, canonical_name: str) -> List[GeoPlace]:
            results = await provider.search(options)
            for result in results:
                result.provider = canonical_name
            return results

        return await self.provider_manager.execute_with_fallback(requested_provider, executor)

    async def get_place_details(
        self,
        place_id: str,
        provider_name: Optional[str] = None,
        fields: Optional[List[str]] = None,
    ) -> GeoPlace:
        requested_provider = normalize_geo_provider_id(provider_name)

        async def executor(provider: GeoProvider, canonical_name: str) -> GeoPlace:
            result = await provider.get_place_details(place_id, fields)
            result.provider = canonical_name
            return result

        return await self.provider_manager.execute_with_fallback(requested_provider, executor)

    def list_providers(self) -> List[str]:
        return sort_provider_ids(self.providers.keys())
