"""Static HTML provider for the canonical Python web surface."""

from datetime import datetime
import json
from typing import Dict, Optional

import httpx

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import (
    GetPageOptions,
    PageMetadata,
    PageResult,
    ProviderCapabilities,
)
from browsefn.utils.html_utils import extract_images, extract_links, extract_metadata, extract_text, html_to_markdown


class BeautifulSoupProvider:
    """Static HTML provider exposed under the canonical `cheerio` id."""

    name = "cheerio"
    capabilities = ProviderCapabilities(
        formats=["html", "markdown", "text", "json"],
        javascript=False,
        screenshots=False,
        cookies=True,
        headers=True,
        selectors=False,
        proxy=True,
    )

    async def get_page(self, url: str, options: GetPageOptions) -> PageResult:
        start_time = datetime.now()
        timeout = (options.timeout or 30000) / 1000
        headers = options.headers or {}
        cookies = {
            cookie.name: cookie.value
            for cookie in (options.cookies or [])
        } or None

        client_config: Dict[str, object] = {
            "timeout": timeout,
            "headers": headers,
            "follow_redirects": True,
        }
        if options.proxy:
            client_config["proxy"] = options.proxy

        async with httpx.AsyncClient(**client_config) as client:
            response = await client.get(url, cookies=cookies)
            response.raise_for_status()
            html_content = response.text

        metadata_dict = extract_metadata(html_content)
        metadata = PageMetadata(
            url=url,
            title=metadata_dict.get("title"),
            description=metadata_dict.get("description"),
            keywords=metadata_dict.get("keywords"),
            author=metadata_dict.get("author"),
            favicon=metadata_dict.get("favicon"),
            openGraph=metadata_dict.get("openGraph"),
            twitter=metadata_dict.get("twitter"),
        )

        content_format = options.format or "html"
        if content_format == "html":
            content = html_content
        elif content_format == "markdown":
            content = html_to_markdown(html_content)
        elif content_format == "text":
            content = extract_text(html_content)
        elif content_format == "json":
            content = json.dumps(
                {
                    "title": metadata.title,
                    "description": metadata.description,
                    "links": extract_links(html_content, url),
                    "images": extract_images(html_content, url),
                }
            )
        else:
            raise BrowseFnError("INVALID_ARGUMENT", f"Invalid format: {content_format}")

        duration = (datetime.now() - start_time).total_seconds() * 1000

        return PageResult(
            url=url,
            content=content,
            metadata=metadata,
            links=extract_links(html_content, url) if options.include_links else None,
            images=extract_images(html_content, url) if options.include_images else None,
            provider=self.name,
            duration=duration,
        )

    async def is_available(self) -> bool:
        return True
