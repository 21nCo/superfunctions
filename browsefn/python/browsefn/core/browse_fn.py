"""
Main BrowseFn class
"""

from typing import Optional, Dict, Set, Callable, Any
from browsefn.core.types import (
    BrowseFnConfig,
    BrowseFnEvent,
    Metrics,
    RateLimitStatus
)
from browsefn.core.cache_manager import CacheManager
from browsefn.core.rate_limiter import RateLimiter
from browsefn.web.scraper import WebScraper
from browsefn.images.browser import ImageBrowser
from browsefn.geo.geocoder import GeoService
from browsefn.middleware.retry import RetryMiddleware
from browsefn.middleware.logging import Logger
from browsefn.middleware.metrics import MetricsCollector

# Import providers
from browsefn.web.providers.bs4 import BeautifulSoupProvider
from browsefn.images.providers.unsplash import UnsplashProvider
from browsefn.images.providers.pixabay import PixabayProvider
from browsefn.images.providers.pexels import PexelsProvider
from browsefn.geo.providers.nominatim import NominatimProvider


class BrowseFn:
    """Main BrowseFn SDK class"""
    
    def __init__(self, config: Optional[BrowseFnConfig] = None):
        self.config = config or BrowseFnConfig()
        
        # Initialize cache manager
        self.cache_manager: Optional[CacheManager] = None
        if self.config.cache and self.config.cache.enabled:
            self.cache_manager = CacheManager(self.config.cache)
            self.cache = self.cache_manager
        
        # Initialize rate limiter
        self.rate_limiter: Optional[RateLimiter] = None
        if self.config.rate_limit:
            global_config = self.config.rate_limit.get('global')
            per_provider = self.config.rate_limit.get('perProvider', {})
            self.rate_limiter = RateLimiter(global_config, per_provider)
        
        # Initialize retry middleware
        self.retry_middleware: Optional[RetryMiddleware] = None
        if self.config.retry and self.config.retry.enabled:
            self.retry_middleware = RetryMiddleware(self.config.retry)
        
        # Initialize logger and metrics
        self.logger = Logger()
        self.metrics_collector = MetricsCollector()
        
        # Event handlers
        self.event_handlers: Dict[BrowseFnEvent, Set[Callable]] = {}
        
        # Initialize web scraper
        self.web = WebScraper(self.config.web)
        
        # Register web providers
        if self.config.web and self.config.web.providers:
            if 'bs4' in self.config.web.providers or 'beautifulsoup' in self.config.web.providers:
                self.web.register_provider('bs4', BeautifulSoupProvider())
        else:
            # Register default BS4 provider
            self.web.register_provider('bs4', BeautifulSoupProvider())
        
        # Initialize image browser
        self.images = ImageBrowser(self.config.images)
        
        # Register image providers
        if self.config.images and self.config.images.providers:
            providers_config = self.config.images.providers
            if 'unsplash' in providers_config:
                provider = UnsplashProvider(providers_config['unsplash'])
                self.images.register_provider('unsplash', provider)
            if 'pixabay' in providers_config:
                provider = PixabayProvider(providers_config['pixabay'])
                self.images.register_provider('pixabay', provider)
            if 'pexels' in providers_config:
                provider = PexelsProvider(providers_config['pexels'])
                self.images.register_provider('pexels', provider)
        
        # Initialize geocoder
        self.geo = GeoService(self.config.geo)
        
        # Register geo providers
        if self.config.geo and self.config.geo.providers:
            providers_config = self.config.geo.providers
            if 'nominatim' in providers_config:
                provider = NominatimProvider(providers_config['nominatim'])
                self.geo.register_provider('nominatim', provider)
    
    def on(self, event: BrowseFnEvent, handler: Callable) -> None:
        """Register event handler"""
        if event not in self.event_handlers:
            self.event_handlers[event] = set()
        self.event_handlers[event].add(handler)
    
    def off(self, event: BrowseFnEvent, handler: Callable) -> None:
        """Unregister event handler"""
        if event in self.event_handlers:
            self.event_handlers[event].discard(handler)
    
    def emit(self, event: BrowseFnEvent, data: Any) -> None:
        """Emit event to all handlers"""
        if event in self.event_handlers:
            for handler in self.event_handlers[event]:
                handler(data)
    
    async def get_metrics(self, options: Optional[Dict[str, Any]] = None) -> Metrics:
        """Get performance metrics"""
        metrics = self.metrics_collector.get_metrics(options)
        
        # Add cache hit rate if cache is enabled
        if self.cache_manager:
            cache_stats = await self.cache_manager.get_stats()
            metrics.cacheHitRate = cache_stats.hit_rate
        
        return metrics
    
    def get_rate_limit_status(self, provider: str) -> RateLimitStatus:
        """Get rate limit status for a provider"""
        if not self.rate_limiter:
            return RateLimitStatus(
                remaining=float('inf'),
                reset_at=0,
                limit=float('inf')
            )
        return self.rate_limiter.get_status(provider)
    
    def get_logs(self, filter_opts: Optional[Dict[str, Any]] = None) -> list:
        """Get logs with optional filtering"""
        return self.logger.get_logs(filter_opts)
    
    async def clear_cache(self) -> None:
        """Clear all cache"""
        if self.cache_manager:
            await self.cache_manager.clear()
    
    def clear_metrics(self) -> None:
        """Clear all metrics"""
        self.metrics_collector.clear()
    
    def clear_logs(self) -> None:
        """Clear all logs"""
        self.logger.clear()


def browse_fn(config: Optional[BrowseFnConfig] = None) -> BrowseFn:
    """Factory function for creating BrowseFn instances"""
    return BrowseFn(config)

