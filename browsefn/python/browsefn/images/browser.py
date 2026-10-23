from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse


from browsefn.core.errors import BrowseFnError
from browsefn.core.provider_manager import ProviderManager
from browsefn.core.provider_registry import normalize_image_provider_id, sort_provider_ids
from browsefn.core.types import ImageConfig, ImageDownloadOptions, ImageResult, ImageProvider, ImageSearchOptions, ImageSearchResult
from browsefn.core.types import DownloadResult
from browsefn.images._transform import transform_image
from browsefn.images._selection import ImageSelection
from browsefn.utils.security_limits import resolve_download_options
from browsefn.utils.destination_policy import merge_security, normalize_security
from browsefn.core.types import DestinationSecurity
from browsefn.images._download_utils import resolve_download_path, fetch_image_bytes, write_image
from browsefn.utils.validation import validate_download_options, validate_image_search_options, validate_url


class ImageBrowser:
    def __init__(self, config: Optional[ImageConfig] = None, security: Optional[DestinationSecurity] = None):
        self.security = normalize_security(security)
        self.selection = ImageSelection()
        self.config = config or ImageConfig()
        self.providers: Dict[str, ImageProvider] = {}
        self.provider_manager = ProviderManager(
            self.providers,
            normalize_image_provider_id(self.config.default_provider),
        )

    def register_provider(self, name: str, provider: ImageProvider):
        canonical_name = normalize_image_provider_id(name) or name
        self.provider_manager.register_provider(canonical_name, provider)
        if not self.provider_manager.default_provider:
            self.provider_manager.default_provider = canonical_name

    async def search(self, query: str, options: Optional[ImageSearchOptions] = None) -> ImageSearchResult:
        options = options or ImageSearchOptions()
        validate_image_search_options(options)
        requested_provider = normalize_image_provider_id(options.provider)

        async def executor(provider: ImageProvider, provider_name: str) -> ImageSearchResult:
            result = await provider.search(query, options)
            result.provider = provider_name
            for item in result.results:
                item.source.provider = provider_name
            return result

        result = await self.provider_manager.execute_with_fallback(requested_provider, executor)
        self.selection.remember(result.results)
        return result

    async def download(self, url: str | ImageResult, options: Optional[ImageDownloadOptions] = None) -> DownloadResult:
        options = options or ImageDownloadOptions()
        override = options.security if options.security is not None else (DestinationSecurity(allowPrivateHosts=options.allow_private_hosts) if "allow_private_hosts" in options.model_fields_set else None)
        options = options.model_copy(update={"security": merge_security(self.security, override)})
        options = resolve_download_options(options)
        url, options = self.selection.resolve(url, options)
        validate_url(url)
        validate_download_options(options)
        provider_name = normalize_image_provider_id(options.provider) or self.provider_manager.default_provider
        if provider_name:
            await self.provider_manager.is_available(provider_name)

        path = resolve_download_path(url, options)

        if path.exists() and options.overwrite is False:
            raise BrowseFnError(
                "DOWNLOAD_EXISTS",
                "Destination file already exists and overwrite is disabled.",
            )

        start = datetime.now()
        content = await fetch_image_bytes(url, options)
        content, metadata = await transform_image(content, options)
        write_image(path, content, options.overwrite)
        duration = (datetime.now() - start).total_seconds() * 1000
        return DownloadResult(
            success=True,
            path=str(path),
            size=len(content),
            format=metadata.format,
            width=metadata.width,
            height=metadata.height,
            metadata=metadata if options.metadata else None,
            duration=duration,
        )

    async def download_batch(
        self,
        urls: List[str],
        options: Optional[ImageDownloadOptions] = None,
    ) -> List[DownloadResult]:
        options = options or ImageDownloadOptions()
        override = options.security if options.security is not None else (DestinationSecurity(allowPrivateHosts=options.allow_private_hosts) if "allow_private_hosts" in options.model_fields_set else None)
        options = options.model_copy(update={"security": merge_security(self.security, override)})
        options = resolve_download_options(options)
        concurrency = max(1, options.concurrency or 5)
        progress_callback = options.on_progress if callable(options.on_progress) else None
        semaphore = asyncio.Semaphore(concurrency)
        results: List[Optional[DownloadResult]] = [None] * len(urls)
        completed = 0

        async def worker(index: int, url: str) -> None:
            nonlocal completed
            async with semaphore:
                item_options = ImageDownloadOptions(**options.model_dump())
                if not item_options.filename:
                    item_options.filename = Path(urlparse(url).path).name or f"download-{index}"
                try:
                    results[index] = await self.download(url, item_options)
                except Exception as error:
                    message = error.message if isinstance(error, BrowseFnError) else str(error)
                    results[index] = DownloadResult(success=False, error=message)
                completed += 1
                if progress_callback:
                    progress_callback(completed, len(urls))

        await asyncio.gather(*(worker(index, url) for index, url in enumerate(urls)))
        return [result for result in results if result is not None]

    def list_providers(self) -> List[str]:
        return sort_provider_ids(self.providers.keys())
