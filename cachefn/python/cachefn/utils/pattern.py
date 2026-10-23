"""
Pattern matching utilities for cache keys.
"""

import fnmatch
import re
from typing import Optional


def glob_to_regex(pattern: str) -> re.Pattern[str]:
    """
    Convert a glob pattern to a regex pattern.

    Args:
        pattern: Glob pattern (e.g., 'user:*', 'session:*:data')

    Returns:
        Compiled regex pattern
    """
    # Convert glob to regex
    regex_pattern = fnmatch.translate(pattern)
    return re.compile(regex_pattern)


def matches_pattern(key: str, pattern: str | re.Pattern[str]) -> bool:
    """
    Check if a key matches a pattern.

    Args:
        key: Cache key to check
        pattern: Glob pattern string or compiled regex

    Returns:
        True if key matches pattern
    """
    if isinstance(pattern, str):
        # Convert glob to regex
        regex = glob_to_regex(pattern)
        return bool(regex.match(key))
    else:
        # Already a regex
        return bool(pattern.match(key))


def filter_by_pattern(keys: list[str], pattern: Optional[str | re.Pattern[str]] = None) -> list[str]:
    """
    Filter keys by a pattern.

    Args:
        keys: List of cache keys
        pattern: Optional glob pattern or regex to filter by

    Returns:
        Filtered list of keys
    """
    if pattern is None:
        return keys

    return [key for key in keys if matches_pattern(key, pattern)]
