"""
Input validation utilities
"""

from typing import Any
from browsefn.core.types import (
    GetPageOptions,
    ImageSearchOptions,
    GeoSearchOptions,
    ImageDownloadOptions,
    GeocodeOptions
)
from browsefn.utils.url_utils import is_valid_url


def validate_page_options(options: GetPageOptions) -> None:
    """Validate GetPageOptions"""
    if options.timeout and options.timeout <= 0:
        raise ValueError("Timeout must be positive")
    
    if options.format and options.format not in ['html', 'markdown', 'text', 'json']:
        raise ValueError(f"Invalid format: {options.format}")
    
    if options.wait_for and options.wait_for not in ['load', 'domcontentloaded', 'networkidle']:
        raise ValueError(f"Invalid waitFor value: {options.wait_for}")
    
    if isinstance(options.screenshot, dict):
        if options.screenshot.get('format') and options.screenshot['format'] not in ['png', 'jpeg']:
            raise ValueError("Screenshot format must be 'png' or 'jpeg'")
        
        if options.screenshot.get('quality'):
            quality = options.screenshot['quality']
            if not (0 <= quality <= 100):
                raise ValueError("Screenshot quality must be between 0 and 100")


def validate_image_search_options(options: ImageSearchOptions) -> None:
    """Validate ImageSearchOptions"""
    if options.page and options.page <= 0:
        raise ValueError("Page must be positive")
    
    if options.per_page and options.per_page <= 0:
        raise ValueError("perPage must be positive")
    
    if options.orientation and options.orientation not in ['landscape', 'portrait', 'square']:
        raise ValueError(f"Invalid orientation: {options.orientation}")
    
    if options.order_by and options.order_by not in ['relevant', 'latest', 'popular']:
        raise ValueError(f"Invalid orderBy: {options.order_by}")
    
    if options.filters:
        filters = options.filters
        if filters.min_width and filters.min_width <= 0:
            raise ValueError("minWidth must be positive")
        if filters.min_height and filters.min_height <= 0:
            raise ValueError("minHeight must be positive")
        if filters.license and filters.license not in ['free', 'premium', 'editorial']:
            raise ValueError(f"Invalid license: {filters.license}")


def validate_geo_options(options: GeoSearchOptions) -> None:
    """Validate GeoSearchOptions"""
    if not options.query:
        raise ValueError("Query is required for geo search")
    
    if options.radius and options.radius <= 0:
        raise ValueError("Radius must be positive")
    
    if options.limit and options.limit <= 0:
        raise ValueError("Limit must be positive")
    
    if options.center:
        if not (-90 <= options.center.lat <= 90):
            raise ValueError("Latitude must be between -90 and 90")
        if not (-180 <= options.center.lng <= 180):
            raise ValueError("Longitude must be between -180 and 180")


def validate_download_options(options: ImageDownloadOptions) -> None:
    """Validate ImageDownloadOptions"""
    if options.size and options.size not in ['small', 'medium', 'large', 'original']:
        raise ValueError(f"Invalid size: {options.size}")
    
    if options.format and options.format not in ['jpeg', 'png', 'webp']:
        raise ValueError(f"Invalid format: {options.format}")
    
    if options.quality and not (0 <= options.quality <= 100):
        raise ValueError("Quality must be between 0 and 100")
    
    if options.max_width and options.max_width <= 0:
        raise ValueError("maxWidth must be positive")
    
    if options.max_height and options.max_height <= 0:
        raise ValueError("maxHeight must be positive")


def validate_url(url: str) -> None:
    """Validate URL"""
    if not url:
        raise ValueError("URL is required")
    
    if not is_valid_url(url):
        raise ValueError(f"Invalid URL: {url}")
