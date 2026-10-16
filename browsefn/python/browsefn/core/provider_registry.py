"""Canonical provider identifiers and alias normalization helpers."""

from typing import Iterable, Optional

WEB_PROVIDER_IDS = ("cheerio", "firecrawl", "jina", "playwright", "puppeteer")
PYTHON_WEB_PROVIDER_IDS = ("cheerio",)
IMAGE_PROVIDER_IDS = ("pexels", "pixabay", "unsplash")
GEO_PROVIDER_IDS = ("google-maps", "mapbox", "nominatim")

_WEB_PROVIDER_ALIASES = {
    "cheerio": "cheerio",
    "firecrawl": "firecrawl",
    "jina": "jina",
    "jina-ai": "jina",
    "playwright": "playwright",
    "puppeteer": "puppeteer",
}

_PYTHON_WEB_PROVIDER_ALIASES = {
    "beautifulsoup": "cheerio",
    "bs4": "cheerio",
    "cheerio": "cheerio",
}

_IMAGE_PROVIDER_ALIASES = {
    "pexels": "pexels",
    "pixabay": "pixabay",
    "unsplash": "unsplash",
}

_GEO_PROVIDER_ALIASES = {
    "google-maps": "google-maps",
    "googlemaps": "google-maps",
    "googleMaps": "google-maps",
    "mapbox": "mapbox",
    "nominatim": "nominatim",
}


def _normalize_key(name: Optional[str]) -> Optional[str]:
    return name.strip().lower() if name else None


def normalize_web_provider_id(name: Optional[str]) -> Optional[str]:
    key = _normalize_key(name)
    return _WEB_PROVIDER_ALIASES.get(key) if key else None


def normalize_python_web_provider_id(name: Optional[str]) -> Optional[str]:
    key = _normalize_key(name)
    return _PYTHON_WEB_PROVIDER_ALIASES.get(key) if key else None


def normalize_image_provider_id(name: Optional[str]) -> Optional[str]:
    key = _normalize_key(name)
    return _IMAGE_PROVIDER_ALIASES.get(key) if key else None


def normalize_geo_provider_id(name: Optional[str]) -> Optional[str]:
    key = _normalize_key(name)
    return _GEO_PROVIDER_ALIASES.get(key) if key else None


def sort_provider_ids(ids: Iterable[str]) -> list[str]:
    return sorted(ids)
