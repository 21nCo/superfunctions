from __future__ import annotations

import pytest

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import GetPageOptions, MetadataOptions, PageMetadata, PageResult, ProviderCapabilities
from browsefn.web.scraper import WebScraper


class FakeWebProvider:
    def __init__(self, name: str, *, javascript: bool, screenshots: bool):
        self.name = name
        self.capabilities = ProviderCapabilities(
            formats=["html", "markdown", "text", "json"],
            javascript=javascript,
            screenshots=screenshots,
            cookies=True,
            headers=True,
            selectors=False,
            proxy=True,
        )

    async def get_page(self, url: str, options: GetPageOptions) -> PageResult:
        return PageResult(
            url=url,
            content="body",
            metadata=PageMetadata(
                url=url,
                title=url.rsplit("/", 1)[-1].upper(),
                description="Alpha" if url.endswith("/a") else "Beta",
            ),
            links=["https://example.com/next"] if options.include_links else None,
            images=["https://example.com/image.png"] if options.include_images else None,
            screenshot=b"png-bytes" if options.screenshot else None,
            provider=self.name,
        )

    async def is_available(self) -> bool:
        return True


@pytest.mark.asyncio
async def test_get_page_returns_canonical_page_data():
    scraper = WebScraper()
    scraper.register_provider("puppeteer", FakeWebProvider("puppeteer", javascript=True, screenshots=True))

    page = await scraper.get_page(
        "https://example.com/article",
        GetPageOptions(
            provider="puppeteer",
            format="markdown",
            javascript=True,
            screenshot={"fullPage": True, "format": "png"},
            includeLinks=True,
            includeImages=True,
        ),
    )

    assert page.url == "https://example.com/article"
    assert page.provider == "puppeteer"
    assert page.links == ["https://example.com/next"]
    assert page.images == ["https://example.com/image.png"]
    assert page.screenshot == b"png-bytes"


@pytest.mark.asyncio
async def test_get_page_rejects_unsupported_capabilities():
    scraper = WebScraper()
    scraper.register_provider("cheerio", FakeWebProvider("cheerio", javascript=False, screenshots=False))

    with pytest.raises(BrowseFnError, match="Provider cheerio cannot satisfy javascript or screenshot requirements."):
        await scraper.get_page(
            "https://example.com/article",
            GetPageOptions(provider="cheerio", javascript=True, screenshot=True),
        )


@pytest.mark.asyncio
async def test_get_multiple_metadata_preserves_order_filters_fields_and_reports_progress():
    scraper = WebScraper()
    scraper.register_provider("cheerio", FakeWebProvider("cheerio", javascript=False, screenshots=False))
    progress_calls = []

    results = await scraper.get_multiple_metadata(
        ["https://example.com/a", "https://example.com/b"],
        MetadataOptions(fields=["title", "description"], concurrency=2, onProgress=lambda done, total: progress_calls.append([done, total])),
    )

    assert [result.data.url for result in results] == ["https://example.com/a", "https://example.com/b"]
    assert results[0].data.title == "A"
    assert results[0].data.description == "Alpha"
    assert "image" not in results[0].data.model_dump(exclude_none=True)
    assert progress_calls == [[1, 2], [2, 2]]


@pytest.mark.asyncio
async def test_get_multiple_metadata_rejects_oversized_batches():
    scraper = WebScraper()
    scraper.register_provider("cheerio", FakeWebProvider("cheerio", javascript=False, screenshots=False))

    with pytest.raises(BrowseFnError, match="Metadata batch size exceeds the configured maximum."):
        await scraper.get_multiple_metadata(
            ["https://example.com/1", "https://example.com/2", "https://example.com/3"],
            MetadataOptions(concurrency=3, maxBatchOverride=2),
        )
