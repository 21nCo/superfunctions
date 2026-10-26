"""Web scraping service with canonical provider selection and metadata batching."""

import asyncio
from datetime import datetime
from typing import Any, Dict, List, Optional

from browsefn.utils.security_limits import assert_page_size
from browsefn.utils.destination_policy import merge_security, normalize_security, requires_protected_transport
from browsefn.core.types import DestinationSecurity
from browsefn.core.errors import BrowseFnError
from browsefn.core.provider_manager import ProviderManager
from browsefn.core.provider_registry import (
    normalize_python_web_provider_id,
    normalize_web_provider_id,
    sort_provider_ids,
)
from browsefn.core.types import (
    GetPageOptions,
    RetryConfig,
    MetadataOptions,
    MetadataResult,
    PageMetadata,
    PageResult,
    WebConfig,
    WebProvider,
)
from browsefn.web.providers.bs4 import BeautifulSoupProvider
from browsefn.middleware.retry import RetryMiddleware
from browsefn.utils.validation import validate_page_options, validate_url


class WebScraper:
    """Web scraping service with fallback and batch metadata support."""

    MAX_METADATA_BATCH = 100

    def __init__(self, config: Optional[WebConfig] = None, security: Optional[DestinationSecurity] = None):
        self.security = normalize_security(security)
        self.config = config or WebConfig()
        self._user_agent_index = 0
        if any(not value.strip() or "\r" in value or "\n" in value for value in self.config.user_agents or []):
            raise BrowseFnError("INVALID_ARGUMENT", "userAgents must contain non-empty valid header values.")
        self.providers: Dict[str, WebProvider] = {}
        self.provider_manager = ProviderManager(
            self.providers,
            self._normalize_provider_id(self.config.default_provider),
            [self._normalize_provider_id(name) for name in (self.config.fallback_chain or []) if self._normalize_provider_id(name)],
            self.config.fallback_on_errors,
        )

    def _normalize_provider_id(self, name: Optional[str]) -> Optional[str]:
        return normalize_web_provider_id(name) or normalize_python_web_provider_id(name)

    def _required_capabilities(self, options: GetPageOptions) -> Dict[str, bool]:
        return {
            "javascript": bool(options.javascript),
            "screenshots": bool(options.screenshot),
            "selectors": bool(options.selectors and (options.selectors.include or options.selectors.exclude)),
            "headers": bool(options.headers),
            "cookies": bool(options.cookies),
            "proxy": bool(options.proxy),
        }

    def _assert_provider_capabilities(self, provider_name: str, provider: WebProvider, options: GetPageOptions) -> None:
        required = self._required_capabilities(options)
        missing = [
            capability
            for capability, enabled in required.items()
            if enabled and not getattr(provider.capabilities, capability, False)
        ]
        if not missing:
            return

        if "javascript" in missing or "screenshots" in missing:
            raise BrowseFnError(
                "UNSUPPORTED_PROVIDER_CAPABILITY",
                f"Provider {provider_name} cannot satisfy javascript or screenshot requirements.",
                provider=provider_name,
            )

        capability = missing[0]
        raise BrowseFnError(
            "UNSUPPORTED_PROVIDER_CAPABILITY",
            f"Provider {provider_name} cannot satisfy {capability} requirements.",
            provider=provider_name,
        )

    def register_provider(self, name: str, provider: WebProvider) -> None:
        canonical_name = self._normalize_provider_id(name) or name
        self.provider_manager.register_provider(canonical_name, provider)
        if not self.provider_manager.default_provider:
            self.provider_manager.default_provider = canonical_name

    def prepare_options(self, options: GetPageOptions) -> GetPageOptions:
        options = options.model_copy(update={"security": merge_security(self.security, options.security)})
        agents = self.config.user_agents or []
        if not agents or any(key.lower() == "user-agent" for key in options.headers or {}):
            return options
        value = agents[self._user_agent_index % len(agents)]
        self._user_agent_index += 1
        return options.model_copy(update={"headers": {**(options.headers or {}), "User-Agent": value}})

    async def get_page(self, url: str, options: Optional[GetPageOptions] = None) -> PageResult:
        validate_url(url)
        options = self.prepare_options(options or GetPageOptions())
        validate_page_options(options)
        requested_provider = self._normalize_provider_id(options.provider)

        def assert_destination_policy(provider: WebProvider) -> None:
            if requires_protected_transport(options.security) and type(provider) is not BeautifulSoupProvider:
                raise BrowseFnError("SECURITY_POLICY_BLOCKED", "Provider cannot enforce the active destination policy.")

        async def executor(provider: WebProvider, provider_name: str) -> PageResult:
            self._assert_provider_capabilities(provider_name, provider, options)
            result = await provider.get_page(url, options)
            assert_page_size(result.content, options.security)
            result.provider = provider_name
            return result

        async def execute():
            return await self.provider_manager.execute_with_fallback(requested_provider, executor, before_provider=assert_destination_policy)
        if options.retry:
            return await RetryMiddleware(RetryConfig(enabled=True, maxAttempts=options.retry.count + 1, delay=options.retry.delay, backoff="linear")).execute(execute)
        return await execute()

    async def get_multiple_metadata(
        self,
        urls: List[str],
        options: Optional[MetadataOptions] = None,
    ) -> List[MetadataResult]:
        if not isinstance(urls, list) or any(not isinstance(url, str) for url in urls):
            raise BrowseFnError("INVALID_ARGUMENT", "Metadata URLs must be an array of strings.")
        urls = list(urls)
        options = options or MetadataOptions()
        for name in ("max_batch_override", "concurrency"):
            value = getattr(options, name)
            if value is not None and (type(value) is not int or not 1 <= value <= self.MAX_METADATA_BATCH):
                raise BrowseFnError("INVALID_ARGUMENT", "Metadata bounds must be integers between 1 and 100.")
        options = options.model_copy(update={"fields": list(options.fields) if options.fields is not None else None, "security": merge_security(self.security, options.security)})
        max_batch = options.max_batch_override if options.max_batch_override is not None else self.MAX_METADATA_BATCH
        if len(urls) > max_batch:
            raise BrowseFnError(
                "INVALID_ARGUMENT",
                "Metadata batch size exceeds the configured maximum.",
            )

        concurrency = max(1, options.concurrency or 5)
        semaphore = asyncio.Semaphore(concurrency)
        progress_callback = options.on_progress if callable(options.on_progress) else None
        ordered_results: List[Optional[MetadataResult]] = [None] * len(urls)
        completed = 0

        async def fetch_metadata(index: int, url: str) -> None:
            nonlocal completed
            async with semaphore:
                start_time = datetime.now()
                try:
                    page_result = await self.get_page(
                        url,
                        GetPageOptions(format="html", timeout=options.timeout or 10000, cache=options.cache, security=options.security),
                    )
                    metadata_dict = page_result.metadata.model_dump()
                    if options.fields:
                        metadata_dict = {
                            key: value
                            for key, value in metadata_dict.items()
                            if key in options.fields or key == "url"
                        }
                    metadata = PageMetadata(**metadata_dict)
                    ordered_results[index] = MetadataResult(
                        success=True,
                        data=metadata,
                        cached=page_result.cached,
                        duration=(datetime.now() - start_time).total_seconds() * 1000,
                        provider=page_result.provider,
                    )
                except Exception as error:
                    ordered_results[index] = MetadataResult(
                        success=False,
                        error=str(error),
                        duration=(datetime.now() - start_time).total_seconds() * 1000,
                    )
                completed += 1
                if progress_callback:
                    progress_callback(completed, len(urls))

        await asyncio.gather(*(fetch_metadata(index, url) for index, url in enumerate(urls)))
        return [result for result in ordered_results if result is not None]

    def list_providers(self) -> List[str]:
        return sort_provider_ids(self.providers.keys())
