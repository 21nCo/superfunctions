"""
URL utility functions
"""

from typing import Dict, Optional, Any
from urllib.parse import urlparse, urljoin, parse_qs, urlencode, urlunparse
import re


def is_valid_url(url: str) -> bool:
    """Check if URL is valid"""
    try:
        result = urlparse(url)
        return all([result.scheme, result.netloc])
    except Exception:
        return False


def normalize_url(url: str) -> str:
    """Normalize URL by adding protocol and removing fragments"""
    # Add protocol if missing
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url
    
    parsed = urlparse(url)
    
    # Remove fragment
    normalized = urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path,
        parsed.params,
        parsed.query,
        ''  # Remove fragment
    ))
    
    return normalized


def get_domain(url: str) -> str:
    """Extract domain from URL"""
    parsed = urlparse(url)
    return parsed.netloc


def build_url(base: str, params: Optional[Dict[str, Any]] = None) -> str:
    """Build URL with query parameters"""
    if not params:
        return base
    
    parsed = urlparse(base)
    
    # Merge existing query params with new ones
    existing_params = parse_qs(parsed.query)
    merged_params = {**existing_params, **params}
    
    # Build query string
    query = urlencode(merged_params, doseq=True)
    
    built = urlunparse((
        parsed.scheme,
        parsed.netloc,
        parsed.path,
        parsed.params,
        query,
        parsed.fragment
    ))
    
    return built


def resolve_url(base_url: str, relative_url: str) -> str:
    """Resolve relative URL against base URL"""
    return urljoin(base_url, relative_url)
