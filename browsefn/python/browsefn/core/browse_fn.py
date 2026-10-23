"""Main BrowseFn class."""

from __future__ import annotations

from time import perf_counter
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Type, TypeVar

from browsefn.utils.security_limits import assert_page_size, DEFAULT_PAGE_BYTES, DEFAULT_DOWNLOAD_BYTES, DEFAULT_REDIRECTS
from browsefn.utils.destination_policy import normalize_security
from browsefn.core.cache_manager import CacheManager
from browsefn.core.errors import BrowseFnError
from browsefn.core.rate_limiter import RateLimiter
from browsefn.core.types import (
    BrowseFnConfig,
    BrowseFnEvent,
    EventData,
    GeocodeOptions,
    GeoLocation,
    GeoSearchOptions,
    GetPageOptions,
    ImageDownloadOptions,
    ImageResult,
    ImageSearchOptions,
    Metrics,
    MetadataOptions,
    RateLimitConfig,
    RateLimitStatus,
    RetryConfig,
)
from browsefn.middleware.logging import Logger
from browsefn.middleware.metrics import MetricsCollector
from browsefn.middleware.retry import RetryMiddleware

T = TypeVar("T")


def _coerce_model(model_type: Type[T], value: Optional[Any]) -> T:
    if isinstance(value, model_type):
        return value
    if value is None:
        return model_type()
    if isinstance(value, dict):
        return model_type(**value)
    return model_type.model_validate(value)


class _ServiceProxy:
    def __init__(self, factory: Callable[[], Any]):
        self._factory = factory
        self._service: Optional[Any] = None

    def _get_service(self) -> Any:
        if self._service is None:
            self._service = self._factory()
        return self._service

    def _resolve_operation_provider(self, requested_provider: Optional[str], fallback: str) -> str:
        if requested_provider:
            return requested_provider

        service = self._get_service()
        configured_provider = getattr(getattr(service, "config", None), "default_provider", None)
        if configured_provider:
            return configured_provider

        provider_manager = getattr(service, "provider_manager", None)
        managed_default = getattr(provider_manager, "default_provider", None)
        if managed_default:
            return managed_default

        providers = getattr(service, "providers", None)
        if providers:
            return next(iter(providers))

        return fallback


class _WebProxy(_ServiceProxy):
    def __init__(self, owner: "BrowseFn", factory: Callable[[], Any]):
        super().__init__(factory)
        self._owner = owner

    def register_provider(self, name: str, provider: Any) -> None:
        self._get_service().register_provider(name, provider)

    async def get_page(self, url: str, options: Optional[Any] = None) -> Any:
        options_model = self._get_service().prepare_options(_coerce_model(GetPageOptions, options))
        provider = self._resolve_operation_provider(options_model.provider, "web")
        cache_enabled = self._owner._cache_enabled(options_model.cache)
        return await self._owner._execute_operation(
            operation="web.get_page",
            provider=provider,
            cache_enabled=cache_enabled,
            cache_method="GET",
            cache_url=url,
            cache_options={**options_model.model_dump(), "provider": provider},
            fn=lambda: self._get_service().get_page(url, options_model),
            validate_result=lambda result: assert_page_size(result.content, options_model.security),
        )

    async def get_multiple_metadata(self, urls: list[str], options: Optional[Any] = None) -> Any:
        options_model = _coerce_model(MetadataOptions, options)
        provider = self._resolve_operation_provider(None, "web")
        return await self._owner._execute_operation(
            operation="web.get_multiple_metadata",
            provider=provider,
            cache_enabled=False,
            cache_method="POST",
            cache_url="metadata-batch",
            cache_options={"urls": urls, "options": options_model.model_dump()},
            fn=lambda: self._get_service().get_multiple_metadata(urls, options_model),
        )


class _ImagesProxy(_ServiceProxy):
    def __init__(self, owner: "BrowseFn", factory: Callable[[], Any]):
        super().__init__(factory)
        self._owner = owner

    def register_provider(self, name: str, provider: Any) -> None:
        self._get_service().register_provider(name, provider)

    async def search(self, query: str, options: Optional[Any] = None) -> Any:
        options_model = _coerce_model(ImageSearchOptions, options or {"query": query})
        provider = self._resolve_operation_provider(options_model.provider, "images")
        return await self._owner._execute_operation(
            operation="images.search",
            provider=provider,
            cache_enabled=self._owner._cache_enabled(options_model.cache),
            cache_method="GET",
            cache_url=f"image-search:{query}",
            cache_options={**options_model.model_dump(), "provider": provider, "query": query},
            fn=lambda: self._get_service().search(query, options_model),
        )

    async def download(self, url: str | ImageResult, options: Optional[Any] = None) -> Any:
        options_model = _coerce_model(ImageDownloadOptions, options)
        provider = self._resolve_operation_provider(options_model.provider, "images")
        return await self._owner._execute_operation(
            operation="images.download",
            provider=provider,
            cache_enabled=False,
            cache_method="GET",
            cache_url=url if isinstance(url, str) else url.url,
            cache_options={"provider": provider, "filename": options_model.filename},
            fn=lambda: self._get_service().download(url, options_model),
        )


class _GeoProxy(_ServiceProxy):
    def __init__(self, owner: "BrowseFn", factory: Callable[[], Any]):
        super().__init__(factory)
        self._owner = owner

    def register_provider(self, name: str, provider: Any) -> None:
        self._get_service().register_provider(name, provider)

    async def reverse_geocode(self, location: Any, provider_name: Optional[str] = None) -> Any:
        location_model = _coerce_model(GeoLocation, location)
        provider = self._resolve_operation_provider(provider_name, "geo")
        return await self._owner._execute_operation(
            operation="geo.reverse_geocode",
            provider=provider,
            cache_enabled=True,
            cache_method="GET",
            cache_url=f"{location_model.lat},{location_model.lng}",
            cache_options={"provider": provider},
            fn=lambda: self._get_service().reverse_geocode(location_model, provider_name),
        )

    async def geocode(self, address: str, options: Optional[Any] = None) -> Any:
        options_model = _coerce_model(GeocodeOptions, options)
        provider = self._resolve_operation_provider(options_model.provider, "geo")
        return await self._owner._execute_operation(
            operation="geo.geocode",
            provider=provider,
            cache_enabled=self._owner._cache_enabled(options_model.cache),
            cache_method="GET",
            cache_url=address,
            cache_options={**options_model.model_dump(), "provider": provider},
            fn=lambda: self._get_service().geocode(address, options_model),
        )

    async def search(self, options: Any) -> Any:
        options_model = _coerce_model(GeoSearchOptions, options)
        provider = self._resolve_operation_provider(options_model.provider, "geo")
        return await self._owner._execute_operation(
            operation="geo.search",
            provider=provider,
            cache_enabled=self._owner._cache_enabled(options_model.cache),
            cache_method="GET",
            cache_url=options_model.query,
            cache_options={**options_model.model_dump(), "provider": provider},
            fn=lambda: self._get_service().search(options_model),
        )

    async def get_place_details(
        self,
        place_id: str,
        provider_name: Optional[str] = None,
        fields: Optional[list[str]] = None,
    ) -> Any:
        provider = self._resolve_operation_provider(provider_name, "geo")
        return await self._owner._execute_operation(
            operation="geo.get_place_details",
            provider=provider,
            cache_enabled=True,
            cache_method="GET",
            cache_url=place_id,
            cache_options={"provider": provider, "fields": fields or []},
            fn=lambda: self._get_service().get_place_details(place_id, provider_name, fields),
        )


class BrowseFn:
    """Main BrowseFn SDK class."""

    def __init__(self, config: Optional[BrowseFnConfig] = None):
        self.config = config or BrowseFnConfig()
        self.config.security = normalize_security(self.config.security)

        self.cache_manager: Optional[CacheManager] = None
        if self.config.cache and self.config.cache.enabled:
            self.cache_manager = CacheManager(self.config.cache)
        self.cache = self.cache_manager

        self.rate_limiter: Optional[RateLimiter] = None
        if self.config.rate_limit:
            global_config = self._coerce_rate_limit(self.config.rate_limit.get("global"))
            per_provider_raw = self.config.rate_limit.get("perProvider") or self.config.rate_limit.get("per_provider") or {}
            per_provider = {
                provider: self._coerce_rate_limit(rate_config)
                for provider, rate_config in per_provider_raw.items()
                if self._coerce_rate_limit(rate_config) is not None
            }
            self.rate_limiter = RateLimiter(global_config, per_provider)

        self.retry_middleware: Optional[RetryMiddleware] = None
        if self.config.retry and self.config.retry.enabled:
            retry_config = self.config.retry if isinstance(self.config.retry, RetryConfig) else RetryConfig(**self.config.retry)
            self.retry_middleware = RetryMiddleware(retry_config)

        self.logger = Logger()
        for service_config in (self.config.web, self.config.images, self.config.geo):
            if service_config:
                self.logger.register_secrets(service_config.model_dump())
        self.metrics_collector = MetricsCollector()
        self.event_handlers: Dict[BrowseFnEvent, Set[Callable[[Any], None]]] = {}

        self._web_proxy = _WebProxy(self, self._build_web_service)
        self._images_proxy = _ImagesProxy(self, self._build_images_service)
        self._geo_proxy = _GeoProxy(self, self._build_geo_service)

    @property
    def web(self) -> _WebProxy:
        return self._web_proxy

    @property
    def images(self) -> _ImagesProxy:
        return self._images_proxy

    @property
    def geo(self) -> _GeoProxy:
        return self._geo_proxy

    def _build_web_service(self) -> Any:
        from browsefn.web.providers.bs4 import BeautifulSoupProvider
        from browsefn.web.scraper import WebScraper

        service = WebScraper(self.config.web, self.config.security)
        if self.config.web and self.config.web.providers:
            if any(name in self.config.web.providers for name in ("bs4", "beautifulsoup", "cheerio")):
                service.register_provider("cheerio", BeautifulSoupProvider())
        else:
            service.register_provider("cheerio", BeautifulSoupProvider())
        return service

    def _build_images_service(self) -> Any:
        from browsefn.images.browser import ImageBrowser
        from browsefn.images.providers.pexels import PexelsProvider
        from browsefn.images.providers.pixabay import PixabayProvider
        from browsefn.images.providers.unsplash import UnsplashProvider

        service = ImageBrowser(self.config.images, self.config.security)
        if self.config.images and self.config.images.providers:
            providers_config = self.config.images.providers
            if "unsplash" in providers_config:
                service.register_provider("unsplash", UnsplashProvider(providers_config["unsplash"]))
            if "pixabay" in providers_config:
                service.register_provider("pixabay", PixabayProvider(providers_config["pixabay"]))
            if "pexels" in providers_config:
                service.register_provider("pexels", PexelsProvider(providers_config["pexels"]))
        return service

    def _build_geo_service(self) -> Any:
        from browsefn.geo.geocoder import GeoService
        from browsefn.geo.providers.google_maps import GoogleMapsProvider
        from browsefn.geo.providers.mapbox import MapboxProvider
        from browsefn.geo.providers.nominatim import NominatimProvider

        service = GeoService(self.config.geo)
        if self.config.geo and self.config.geo.providers:
            providers_config = self.config.geo.providers
            if "nominatim" in providers_config:
                service.register_provider("nominatim", NominatimProvider(providers_config["nominatim"]))
            if "google-maps" in providers_config or "googleMaps" in providers_config:
                config = providers_config.get("google-maps") or providers_config.get("googleMaps")
                service.register_provider("google-maps", GoogleMapsProvider(config))
            if "mapbox" in providers_config:
                service.register_provider("mapbox", MapboxProvider(providers_config["mapbox"]))
        else:
            service.register_provider("nominatim", NominatimProvider())
        return service

    def _coerce_rate_limit(self, value: Any) -> Optional[RateLimitConfig]:
        if value is None:
            return None
        if isinstance(value, RateLimitConfig):
            return value
        if isinstance(value, dict):
            return RateLimitConfig(**value)
        return RateLimitConfig.model_validate(value)

    def _cache_enabled(self, option: Any) -> bool:
        if not self.cache_manager:
            return False
        if option is False:
            return False
        return True

    async def _execute_operation(
        self,
        *,
        operation: str,
        provider: str,
        cache_enabled: bool,
        cache_method: str,
        cache_url: str,
        cache_options: Optional[Dict[str, Any]],
        fn: Callable[[], Awaitable[T]],
        validate_result: Optional[Callable[[Any], None]] = None,
    ) -> T:
        timestamp = perf_counter() * 1000
        release_secrets = self.logger.register_secrets(cache_options)
        try:
            self.logger.info("request", {"operation": operation, "provider": provider, "url": cache_url})
            self.emit("request", EventData(timestamp=timestamp, provider=provider, url=cache_url))

            if cache_enabled and self.cache_manager:
                cached = await self.cache_manager.get(cache_method, cache_url, cache_options)
                if cached is not None:
                    if validate_result:
                        validate_result(cached)
                    self.logger.info("cache.hit", {"operation": operation, "provider": provider, "url": cache_url})
                    self.emit("cache.hit", EventData(timestamp=perf_counter() * 1000, provider=provider, url=cache_url))
                    self.metrics_collector.record_request(provider, 0.0, True)
                    self.logger.info("response", {"operation": operation, "provider": provider, "cached": True})
                    self.emit("response", EventData(timestamp=perf_counter() * 1000, provider=provider, url=cache_url, duration=0.0))
                    return cached

                self.logger.info("cache.miss", {"operation": operation, "provider": provider, "url": cache_url})
                self.emit("cache.miss", EventData(timestamp=perf_counter() * 1000, provider=provider, url=cache_url))

            if self.rate_limiter:
                try:
                    await self.rate_limiter.enforce(provider)
                except BrowseFnError as error:
                    self.logger.warn("rateLimit", {"operation": operation, "provider": provider, "error": error.message})
                    self.emit("rateLimit", EventData(timestamp=perf_counter() * 1000, provider=provider, url=cache_url))
                    raise

            start = perf_counter()
            try:
                per_call_retry = operation == "web.get_page" and cache_options and cache_options.get("retry") is not None
                if self.retry_middleware and not per_call_retry:
                    result = await self.retry_middleware.execute(fn, {"provider": provider, "operation": operation})
                else:
                    result = await fn()
            except Exception as error:
                duration = (perf_counter() - start) * 1000
                self.metrics_collector.record_request(provider, duration, False)
                error_message = error.message if isinstance(error, BrowseFnError) else str(error)
                self.logger.error(
                    "error",
                    {"operation": operation, "provider": provider, "error": error_message, "durationMs": duration},
                )
                self.emit("error", EventData(timestamp=perf_counter() * 1000, provider=provider, url=cache_url, duration=duration))
                raise

            duration = (perf_counter() - start) * 1000
            if validate_result:
                validate_result(result)
            if cache_enabled and self.cache_manager:
                await self.cache_manager.set(cache_method, cache_url, result, cache_options)

            self.metrics_collector.record_request(provider, duration, True)
            self.logger.info(
                "response",
                {"operation": operation, "provider": getattr(result, "provider", provider), "durationMs": duration},
            )
            self.emit(
                "response",
                EventData(
                    timestamp=perf_counter() * 1000,
                    provider=getattr(result, "provider", provider),
                    url=cache_url,
                    duration=duration,
                ),
            )
            return result
        finally:
            release_secrets()

    def get_security_limits(self) -> Dict[str, int]:
        """Trusted constructor limits used by routers as request-body ceilings."""
        policy = self.config.security
        return {"maxResponseBytes": policy.max_response_bytes if policy and policy.max_response_bytes is not None else DEFAULT_PAGE_BYTES,
                "maxDownloadBytes": policy.max_download_bytes if policy and policy.max_download_bytes is not None else DEFAULT_DOWNLOAD_BYTES,
                "maxRedirects": policy.max_redirects if policy and policy.max_redirects is not None else DEFAULT_REDIRECTS}

    def on(self, event: BrowseFnEvent, handler: Callable[[Any], None]) -> None:
        if event not in self.event_handlers:
            self.event_handlers[event] = set()
        self.event_handlers[event].add(handler)

    def off(self, event: BrowseFnEvent, handler: Callable[[Any], None]) -> None:
        if event in self.event_handlers:
            self.event_handlers[event].discard(handler)

    def emit(self, event: BrowseFnEvent, data: Any) -> None:
        if event in self.event_handlers:
            for handler in self.event_handlers[event]:
                handler(data)

    async def get_metrics(self, options: Optional[Dict[str, Any]] = None) -> Metrics:
        metrics = self.metrics_collector.get_metrics(options)
        if self.cache_manager:
            cache_stats = await self.cache_manager.get_stats()
            metrics.cache_hit_rate = cache_stats.hit_rate
        return metrics

    def get_rate_limit_status(self, provider: str) -> RateLimitStatus:
        if not self.rate_limiter:
            return RateLimitStatus(remaining=float("inf"), reset_at=0, limit=float("inf"))
        return self.rate_limiter.get_status(provider)

    def get_logs(self, filter_opts: Optional[Dict[str, Any]] = None) -> list[Any]:
        return self.logger.get_logs(filter_opts)

    async def clear_cache(self) -> None:
        if self.cache_manager:
            await self.cache_manager.clear()

    def clear_metrics(self) -> None:
        self.metrics_collector.clear()

    def clear_logs(self) -> None:
        self.logger.clear()


def browse_fn(config: Optional[BrowseFnConfig] = None) -> BrowseFn:
    """Factory function for creating BrowseFn instances."""
    return BrowseFn(config)
