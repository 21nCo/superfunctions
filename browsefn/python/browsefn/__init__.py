"""BrowseFn - Self-hosted web browsing and data extraction platform"""

from browsefn.core.browse_fn import browse_fn, BrowseFn
from browsefn.core.types import (
    BrowseFnConfig, WebConfig, ImageConfig, GeoConfig,
    GetPageOptions, ImageSearchOptions, GeoSearchOptions,
    PageResult, ImageSearchResult, ReverseGeocodeResult,
    RateLimitConfig, CacheConfig, RetryConfig
)
from browsefn.core.cache_manager import CacheManager
from browsefn.core.rate_limiter import RateLimiter
from browsefn.core.provider_manager import ProviderManager

# Web providers
from browsefn.web.providers.bs4 import BeautifulSoupProvider

# Image providers
from browsefn.images.providers.unsplash import UnsplashProvider
from browsefn.images.providers.pixabay import PixabayProvider
from browsefn.images.providers.pexels import PexelsProvider

# Geo providers
from browsefn.geo.providers.nominatim import NominatimProvider

# Middleware
from browsefn.middleware.retry import RetryMiddleware
from browsefn.middleware.logging import Logger
from browsefn.middleware.metrics import MetricsCollector

# Utilities
from browsefn.utils import url_utils, html_utils, validation

__all__ = [
    # Main exports
    "browse_fn",
    "BrowseFn",
    
    # Config types
    "BrowseFnConfig",
    "WebConfig",
    "ImageConfig",
    "GeoConfig",
    "RateLimitConfig",
    "CacheConfig",
    "RetryConfig",
    
    # Option types
    "GetPageOptions",
    "ImageSearchOptions",
    "GeoSearchOptions",
    
    # Result types
    "PageResult",
    "ImageSearchResult",
    "ReverseGeocodeResult",
    
    # Core classes
    "CacheManager",
    "RateLimiter",
    "ProviderManager",
    
    # Web providers
    "BeautifulSoupProvider",
    
    # Image providers
    "UnsplashProvider",
    "PixabayProvider",
    "PexelsProvider",
    
    # Geo providers
    "NominatimProvider",
    
    # Middleware
    "RetryMiddleware",
    "Logger",
    "MetricsCollector",
    
    # Utilities
    "url_utils",
    "html_utils",
    "validation",
]

__version__ = "0.1.0"

