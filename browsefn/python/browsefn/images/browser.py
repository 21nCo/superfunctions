from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlparse

import httpx

from browsefn.core.errors import BrowseFnError
from browsefn.core.provider_manager import ProviderManager
from browsefn.core.provider_registry import normalize_image_provider_id, sort_provider_ids
from browsefn.core.types import ImageConfig, ImageDownloadOptions, ImageMetadata, ImageProvider, ImageSearchOptions, ImageSearchResult
from browsefn.core.types import DownloadResult
from browsefn.utils.validation import validate_download_options, validate_image_search_options, validate_url


def _detect_image_metadata(content: bytes) -> ImageMetadata:
    if content.startswith(b"\x89PNG\r\n\x1a\n") and len(content) >= 24:
        width = int.from_bytes(content[16:20], "big")
        height = int.from_bytes(content[20:24], "big")
        return ImageMetadata(format="png", width=width, height=height, size=len(content))

    if content.startswith(b"\xff\xd8"):
        index = 2
        while index + 9 < len(content):
            if content[index] != 0xFF:
                index += 1
                continue
            marker = content[index + 1]
            if marker in {0xC0, 0xC2}:
                height = int.from_bytes(content[index + 5 : index + 7], "big")
                width = int.from_bytes(content[index + 7 : index + 9], "big")
                return ImageMetadata(format="jpeg", width=width, height=height, size=len(content))
            if index + 4 >= len(content):
                break
            segment_length = int.from_bytes(content[index + 2 : index + 4], "big")
            index += segment_length + 2
        return ImageMetadata(format="jpeg", width=0, height=0, size=len(content))

    if content.startswith(b"RIFF") and content[8:12] == b"WEBP":
        if content[12:16] == b"VP8X" and len(content) >= 30:
            width = 1 + int.from_bytes(content[24:27], "little")
            height = 1 + int.from_bytes(content[27:30], "little")
            return ImageMetadata(format="webp", width=width, height=height, size=len(content))
        return ImageMetadata(format="webp", width=0, height=0, size=len(content))

    return ImageMetadata(format="unknown", width=0, height=0, size=len(content))


class ImageBrowser:
    def __init__(self, config: Optional[ImageConfig] = None):
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

        return await self.provider_manager.execute_with_fallback(requested_provider, executor)

    async def download(self, url: str, options: Optional[ImageDownloadOptions] = None) -> DownloadResult:
        validate_url(url)
        options = options or ImageDownloadOptions()
        validate_download_options(options)
        provider_name = normalize_image_provider_id(options.provider) or self.provider_manager.default_provider
        if provider_name:
            await self.provider_manager.is_available(provider_name)

        destination_root = Path(options.destination or ".")
        destination_root.mkdir(parents=True, exist_ok=True)
        filename = options.filename or Path(urlparse(url).path).name or "downloaded-image"
        path = destination_root / filename

        if path.exists() and options.overwrite is False:
            raise BrowseFnError(
                "DOWNLOAD_EXISTS",
                "Destination file already exists and overwrite is disabled.",
            )

        start = datetime.now()
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            content = response.content

        path.write_bytes(content)
        metadata = _detect_image_metadata(content) if options.metadata else None
        duration = (datetime.now() - start).total_seconds() * 1000
        return DownloadResult(
            success=True,
            path=str(path),
            size=len(content),
            format=metadata.format if metadata else path.suffix.lstrip(".") or None,
            width=metadata.width if metadata else None,
            height=metadata.height if metadata else None,
            metadata=metadata,
            duration=duration,
        )

    async def download_batch(
        self,
        urls: List[str],
        options: Optional[ImageDownloadOptions] = None,
    ) -> List[DownloadResult]:
        options = options or ImageDownloadOptions()
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
