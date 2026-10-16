"""BrowseFn - Self-hosted web browsing and data extraction platform."""

from importlib import import_module
from typing import Any, Dict, Tuple

__version__ = "0.2.0"

_EXPORTS: Dict[str, Tuple[str, str]] = {
    "browse_fn": ("browsefn.core.browse_fn", "browse_fn"),
    "BrowseFn": ("browsefn.core.browse_fn", "BrowseFn"),
    "BrowseFnError": ("browsefn.core.errors", "BrowseFnError"),
    "BrowseFnErrorCode": ("browsefn.core.errors", "BrowseFnErrorCode"),
    "create_success_envelope": ("browsefn.core.errors", "create_success_envelope"),
    "create_error_envelope": ("browsefn.core.errors", "create_error_envelope"),
    "BrowseFnConfig": ("browsefn.core.types", "BrowseFnConfig"),
    "WebConfig": ("browsefn.core.types", "WebConfig"),
    "ImageConfig": ("browsefn.core.types", "ImageConfig"),
    "GeoConfig": ("browsefn.core.types", "GeoConfig"),
    "RateLimitConfig": ("browsefn.core.types", "RateLimitConfig"),
    "CacheConfig": ("browsefn.core.types", "CacheConfig"),
    "RetryConfig": ("browsefn.core.types", "RetryConfig"),
    "GetPageOptions": ("browsefn.core.types", "GetPageOptions"),
    "ImageSearchOptions": ("browsefn.core.types", "ImageSearchOptions"),
    "GeoSearchOptions": ("browsefn.core.types", "GeoSearchOptions"),
    "PageResult": ("browsefn.core.types", "PageResult"),
    "ImageSearchResult": ("browsefn.core.types", "ImageSearchResult"),
    "ReverseGeocodeResult": ("browsefn.core.types", "ReverseGeocodeResult"),
    "CacheManager": ("browsefn.core.cache_manager", "CacheManager"),
    "RateLimiter": ("browsefn.core.rate_limiter", "RateLimiter"),
    "ProviderManager": ("browsefn.core.provider_manager", "ProviderManager"),
    "create_browsefn_router": ("browsefn.http.router", "create_browsefn_router"),
    "BeautifulSoupProvider": ("browsefn.web.providers.bs4", "BeautifulSoupProvider"),
    "UnsplashProvider": ("browsefn.images.providers.unsplash", "UnsplashProvider"),
    "PixabayProvider": ("browsefn.images.providers.pixabay", "PixabayProvider"),
    "PexelsProvider": ("browsefn.images.providers.pexels", "PexelsProvider"),
    "NominatimProvider": ("browsefn.geo.providers.nominatim", "NominatimProvider"),
    "GoogleMapsProvider": ("browsefn.geo.providers.google_maps", "GoogleMapsProvider"),
    "MapboxProvider": ("browsefn.geo.providers.mapbox", "MapboxProvider"),
    "RetryMiddleware": ("browsefn.middleware.retry", "RetryMiddleware"),
    "Logger": ("browsefn.middleware.logging", "Logger"),
    "MetricsCollector": ("browsefn.middleware.metrics", "MetricsCollector"),
    "WEB_PROVIDER_IDS": ("browsefn.core.provider_registry", "WEB_PROVIDER_IDS"),
    "IMAGE_PROVIDER_IDS": ("browsefn.core.provider_registry", "IMAGE_PROVIDER_IDS"),
    "GEO_PROVIDER_IDS": ("browsefn.core.provider_registry", "GEO_PROVIDER_IDS"),
    "normalize_web_provider_id": ("browsefn.core.provider_registry", "normalize_web_provider_id"),
    "normalize_python_web_provider_id": ("browsefn.core.provider_registry", "normalize_python_web_provider_id"),
    "normalize_image_provider_id": ("browsefn.core.provider_registry", "normalize_image_provider_id"),
    "normalize_geo_provider_id": ("browsefn.core.provider_registry", "normalize_geo_provider_id"),
    "sort_provider_ids": ("browsefn.core.provider_registry", "sort_provider_ids"),
    "url_utils": ("browsefn.utils", "url_utils"),
    "html_utils": ("browsefn.utils", "html_utils"),
    "validation": ("browsefn.utils", "validation"),
}

__all__ = ["__version__", *_EXPORTS.keys()]


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f"module 'browsefn' has no attribute {name!r}")

    module_name, attribute_name = _EXPORTS[name]
    module = import_module(module_name)
    value = getattr(module, attribute_name)
    globals()[name] = value
    return value
