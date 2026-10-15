from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions, ImageResult, ImageSearchOptions, ImageSearchResult, ImageSource
from browsefn.images.browser import ImageBrowser
from browsefn.images.providers.unsplash import UnsplashProvider


JPEG_BYTES = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffc00011080001000103012200021101031101ffda0008010100003f00ffd9"
)


class FakeImageProvider:
    name = "unsplash"

    async def search(self, query: str, options: ImageSearchOptions) -> ImageSearchResult:
        return ImageSearchResult(
            query=query,
            total=1,
            page=1,
            perPage=options.per_page or 20,
            results=[
                ImageResult(
                    id="img-1",
                    url="https://images.example.com/a.jpg",
                    thumbnail="https://images.example.com/a-thumb.jpg",
                    width=1920,
                    height=1080,
                    source=ImageSource(provider="unsplash", url="https://images.example.com/a.jpg"),
                )
            ],
            provider="unsplash",
        )

    async def is_available(self) -> bool:
        return True


@pytest.mark.asyncio
async def test_image_search_normalizes_provider_output():
    browser = ImageBrowser()
    browser.register_provider("unsplash", FakeImageProvider())

    result = await browser.search(
        "mountain landscape",
        ImageSearchOptions(provider="unsplash", perPage=20, orientation="landscape"),
    )

    assert result.provider == "unsplash"
    assert result.perPage == 20
    assert result.results[0].source.provider == "unsplash"


@pytest.mark.asyncio
async def test_image_search_validates_filters():
    browser = ImageBrowser()
    browser.register_provider("unsplash", FakeImageProvider())

    with pytest.raises(BrowseFnError, match="perPage must be between 1 and 100."):
        await browser.search("mountain landscape", ImageSearchOptions(provider="unsplash", perPage=0))


@pytest.mark.asyncio
async def test_image_download_writes_real_file_and_metadata(tmp_path: Path):
    browser = ImageBrowser()
    browser.register_provider("unsplash", FakeImageProvider())

    with patch("browsefn.images.browser.fetch_image_bytes", new=AsyncMock(return_value=JPEG_BYTES)):
        result = await browser.download(
            "https://images.example.com/a.jpg",
            ImageDownloadOptions(
                provider="unsplash",
                destination=str(tmp_path),
                filename="a.jpg",
                overwrite=False,
                metadata=True,
            ),
        )

    assert result.success is True
    assert Path(result.path).exists()
    assert Path(result.path).read_bytes() == JPEG_BYTES
    assert result.metadata.format == "jpeg"


@pytest.mark.asyncio
async def test_image_download_rejects_existing_file_when_overwrite_disabled(tmp_path: Path):
    browser = ImageBrowser()
    browser.register_provider("unsplash", FakeImageProvider())
    target = tmp_path / "a.jpg"
    target.write_bytes(b"existing")

    with pytest.raises(BrowseFnError, match="Destination file already exists and overwrite is disabled."):
        await browser.download(
            "https://images.example.com/a.jpg",
            ImageDownloadOptions(provider="unsplash", destination=str(tmp_path), filename="a.jpg", overwrite=False),
        )


@pytest.mark.asyncio
async def test_image_download_rejects_paths_outside_destination(tmp_path: Path):
    browser = ImageBrowser()
    browser.register_provider("unsplash", FakeImageProvider())

    with pytest.raises(BrowseFnError, match="Destination filename must stay within the destination directory."):
        await browser.download(
            "https://images.example.com/a.jpg",
            ImageDownloadOptions(provider="unsplash", destination=str(tmp_path), filename="../escape.jpg"),
        )


@pytest.mark.asyncio
async def test_image_download_batch_preserves_order_and_reports_progress(tmp_path: Path):
    browser = ImageBrowser()
    browser.register_provider("unsplash", FakeImageProvider())
    progress_calls = []

    with patch("browsefn.images.browser.fetch_image_bytes", new=AsyncMock(return_value=JPEG_BYTES)):
        results = await browser.download_batch(
            [
                "https://images.example.com/a.jpg",
                "https://images.example.com/b.jpg",
            ],
            ImageDownloadOptions(
                provider="unsplash",
                destination=str(tmp_path),
                concurrency=2,
                onProgress=lambda done, total: progress_calls.append([done, total]),
            ),
        )

    assert [Path(result.path).name for result in results] == ["a.jpg", "b.jpg"]
    assert progress_calls == [[1, 2], [2, 2]]


@pytest.mark.asyncio
async def test_provider_download_writes_real_file(tmp_path: Path):
    provider = UnsplashProvider()

    with patch("browsefn.images.providers._shared.fetch_image_bytes", new=AsyncMock(return_value=JPEG_BYTES)):
        result = await provider.download(
            "https://images.example.com/a.jpg",
            ImageDownloadOptions(destination=str(tmp_path), filename="provider.jpg"),
        )

    assert result.success is True
    assert Path(result.path).exists()
    assert Path(result.path).read_bytes() == JPEG_BYTES
