"""Shared helpers for image API providers."""

from __future__ import annotations

from typing import List, Optional


from browsefn.core.types import (
    DownloadResult,
    ImageDownloadOptions,
    ImageFilters,
    ImageResult,
    ImageSearchResult,
)
from browsefn.images._download_utils import resolve_download_path, fetch_image_bytes, write_image


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
        from browsefn.utils.validation import validate_download_options
        validate_download_options(options)
        path = resolve_download_path(url, options, default_name="image.jpg")
        if path.exists() and options.overwrite is False:
            return DownloadResult(
                success=False,
                error="Destination file already exists and overwrite is disabled.",
            )

        content = await fetch_image_bytes(url, options)
        write_image(path, content, options.overwrite)
        return DownloadResult(success=True, path=str(path), size=len(content), format=path.suffix.lstrip(".") or None)
    except Exception as error:
        return DownloadResult(success=False, error=str(error))
