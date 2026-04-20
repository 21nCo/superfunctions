"""Input validation utilities with canonical BrowseFn errors."""

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import (
    GeocodeOptions,
    GeoLocation,
    GeoSearchOptions,
    GetPageOptions,
    ImageDownloadOptions,
    ImageSearchOptions,
)
from browsefn.utils.url_utils import is_valid_url


def validate_page_options(options: GetPageOptions) -> None:
    if options.timeout is not None and options.timeout <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "Timeout must be positive.")

    if options.wait_for and options.wait_for not in ["load", "domcontentloaded", "networkidle"]:
        raise BrowseFnError("INVALID_ARGUMENT", f"Invalid waitFor value: {options.wait_for}")

    if options.screenshot:
        screenshot = options.screenshot if hasattr(options.screenshot, "format") else None
        if screenshot and screenshot.format and screenshot.format not in ["png", "jpeg"]:
            raise BrowseFnError("INVALID_ARGUMENT", "Screenshot format must be 'png' or 'jpeg'.")
        if screenshot and screenshot.quality is not None and not (0 <= screenshot.quality <= 100):
            raise BrowseFnError("INVALID_ARGUMENT", "Screenshot quality must be between 0 and 100.")


def validate_image_search_options(options: ImageSearchOptions) -> None:
    if options.page is not None and options.page <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "Page must be between 1 and 100.")

    if options.per_page is not None and not (1 <= options.per_page <= 100):
        raise BrowseFnError("INVALID_ARGUMENT", "perPage must be between 1 and 100.")

    if options.filters:
        filters = options.filters
        if filters.min_width is not None and filters.min_width <= 0:
            raise BrowseFnError("INVALID_ARGUMENT", "minWidth must be positive.")
        if filters.min_height is not None and filters.min_height <= 0:
            raise BrowseFnError("INVALID_ARGUMENT", "minHeight must be positive.")
        if filters.max_width is not None and filters.max_width <= 0:
            raise BrowseFnError("INVALID_ARGUMENT", "maxWidth must be positive.")
        if filters.max_height is not None and filters.max_height <= 0:
            raise BrowseFnError("INVALID_ARGUMENT", "maxHeight must be positive.")


def validate_geo_location(location: GeoLocation) -> None:
    if not (-90 <= location.lat <= 90):
        raise BrowseFnError("INVALID_ARGUMENT", "Latitude must be between -90 and 90.")
    if not (-180 <= location.lng <= 180):
        raise BrowseFnError("INVALID_ARGUMENT", "Longitude must be between -180 and 180.")


def validate_geocode_options(options: GeocodeOptions) -> None:
    if options.limit is not None and options.limit <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "Limit must be positive.")


def validate_geo_options(options: GeoSearchOptions) -> None:
    if not options.query:
        raise BrowseFnError("INVALID_ARGUMENT", "Query is required for geo search.")
    if options.radius is not None and options.radius <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "Radius must be positive.")
    if options.limit is not None and options.limit <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "Limit must be positive.")
    if options.center:
        validate_geo_location(options.center)


def validate_download_options(options: ImageDownloadOptions) -> None:
    if options.quality is not None and not (0 <= options.quality <= 100):
        raise BrowseFnError("INVALID_ARGUMENT", "Quality must be between 0 and 100.")
    if options.max_width is not None and options.max_width <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "maxWidth must be positive.")
    if options.max_height is not None and options.max_height <= 0:
        raise BrowseFnError("INVALID_ARGUMENT", "maxHeight must be positive.")

    if options.crop or options.watermark or options.max_width or options.max_height or options.format:
        raise BrowseFnError(
            "INVALID_ARGUMENT",
            "Image transforms are not supported in the Python SDK.",
        )


def validate_url(url: str) -> None:
    if not url:
        raise BrowseFnError("INVALID_ARGUMENT", "Missing required field: url")

    if not is_valid_url(url):
        raise BrowseFnError("INVALID_URL", f"Invalid URL: {url}")
