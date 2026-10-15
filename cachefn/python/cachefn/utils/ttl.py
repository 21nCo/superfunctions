"""
TTL (Time-To-Live) utilities for cache entries.
"""

import time
from typing import Optional


def calculate_expiration(ttl: Optional[int]) -> Optional[int]:
    """
    Calculate expiration timestamp from TTL.

    Args:
        ttl: Time-to-live in milliseconds, or None for no expiration

    Returns:
        Expiration timestamp in milliseconds, or None
    """
    if ttl is None:
        return None

    return int(time.time() * 1000) + ttl


def is_expired(expires_at: Optional[int]) -> bool:
    """
    Check if an entry has expired.

    Args:
        expires_at: Expiration timestamp in milliseconds, or None

    Returns:
        True if expired, False otherwise
    """
    if expires_at is None:
        return False

    return int(time.time() * 1000) >= expires_at


def get_remaining_ttl(expires_at: Optional[int]) -> Optional[int]:
    """
    Get remaining TTL for an entry.

    Args:
        expires_at: Expiration timestamp in milliseconds, or None

    Returns:
        Remaining TTL in milliseconds, or None if no expiration
    """
    if expires_at is None:
        return None

    remaining = expires_at - int(time.time() * 1000)
    return max(0, remaining)
