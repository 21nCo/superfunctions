"""Shared helpers for image API providers."""

from __future__ import annotations

from typing import List, Optional

import httpx

from browsefn.core.types import (
    DownloadResult,
    ImageDownloadOptions,
    ImageFilters,
    ImageResult,
    ImageSearchResult,
)


def passes_dimension_filters(
    filters: Optional[ImageFilters],
    *,
    width: int,
    height: int,
) -> bool:
    if not filters:
        return True
    if filters.min_width and width < filters.min_width:
        return False
    if filters.min_height and height < filters.min_height:
        return False
    if filters.max_width and width > filters.max_width:
        return False
    if filters.max_height and height > filters.max_height:
        return False
    return True


def build_search_result(
    *,
    query: str,
    total: int,
    page: int,
    per_page: int,
    results: List[ImageResult],
    provider: str,
) -> ImageSearchResult:
    return ImageSearchResult(
        query=query,
        total=total,
        page=page,
        perPage=per_page,
        results=results,
        nextPage=page + 1 if results else None,
        provider=provider,
    )


async def download_image(url: str, options: ImageDownloadOptions) -> DownloadResult:
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            return DownloadResult(
                success=True,
                path=options.filename or "image.jpg",
                size=len(response.content),
                format="jpeg",
            )
    except Exception as error:
        return DownloadResult(success=False, error=str(error))
