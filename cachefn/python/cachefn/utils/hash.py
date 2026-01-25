"""
Hashing utilities for cache keys and arguments.
"""

import hashlib
import json
from typing import Any


def hash_value(value: Any) -> str:
    """
    Generate a hash for any value.

    Args:
        value: Value to hash

    Returns:
        Hex digest of the hash
    """
    # Convert value to JSON string for consistent hashing
    try:
        json_str = json.dumps(value, sort_keys=True, default=str)
    except (TypeError, ValueError):
        # Fallback to string representation
        json_str = str(value)

    return hashlib.sha256(json_str.encode()).hexdigest()[:16]


def hash_args(*args: Any, **kwargs: Any) -> str:
    """
    Generate a hash for function arguments.

    Args:
        *args: Positional arguments
        **kwargs: Keyword arguments

    Returns:
        Hex digest of the combined hash
    """
    combined = {"args": args, "kwargs": kwargs}
    return hash_value(combined)


def generate_key(prefix: str, *args: Any, **kwargs: Any) -> str:
    """
    Generate a cache key from a prefix and arguments.

    Args:
        prefix: Key prefix (e.g., function name)
        *args: Positional arguments
        **kwargs: Keyword arguments

    Returns:
        Generated cache key
    """
    if not args and not kwargs:
        return prefix

    arg_hash = hash_args(*args, **kwargs)
    return f"{prefix}:{arg_hash}"
