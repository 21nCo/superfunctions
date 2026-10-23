"""Utility helper functions for secfn."""

import math
import secrets
import time
from typing import Any, Dict, Optional


def generate_id(prefix: str) -> str:
    """Generate unique ID with prefix.
    
    Args:
        prefix: Prefix for the ID (e.g., 'secret', 'role', 'event')
        
    Returns:
        Unique ID string in format: prefix_timestamprandom
    """
    timestamp = format(int(time.time() * 1000), "x")
    random_str = secrets.token_hex(5)[:7]
    return f"{prefix}_{timestamp}{random_str}"


def calculate_entropy(text: str) -> float:
    """Calculate Shannon entropy of a string.
    
    Args:
        text: String to calculate entropy for
        
    Returns:
        Shannon entropy value (higher = more random)
    """
    if not text:
        return 0.0

    # Count character frequencies
    frequencies: Dict[str, int] = {}
    for char in text:
        frequencies[char] = frequencies.get(char, 0) + 1

    # Calculate entropy
    length = len(text)
    entropy = 0.0
    for count in frequencies.values():
        probability = count / length
        entropy -= probability * math.log2(probability)

    return entropy


def redact_secret(secret: str, visible_chars: int = 4) -> str:
    """Redact a secret for logging, showing only first few characters.
    
    Args:
        secret: Secret string to redact
        visible_chars: Number of characters to show at start
        
    Returns:
        Redacted string like "sk_l***"
    """
    if len(secret) <= visible_chars:
        return "*" * len(secret)

    return secret[:visible_chars] + "***"


def is_expired(expires_at: Optional[int]) -> bool:
    """Check if a timestamp has expired.
    
    Args:
        expires_at: Expiration timestamp in milliseconds, or None
        
    Returns:
        True if expired, False otherwise
    """
    if expires_at is None:
        return False

    now = int(time.time() * 1000)
    return now >= expires_at


def sanitize_for_log(data: Dict[str, Any]) -> Dict[str, Any]:
    """Remove sensitive fields from data for logging.
    
    Args:
        data: Dictionary that may contain sensitive data
        
    Returns:
        Sanitized copy of the dictionary
    """
    sensitive_fields = {"value", "key", "password", "secret", "token", "masterKey"}

    sanitized = {}
    for key, value in data.items():
        if key in sensitive_fields:
            sanitized[key] = "***REDACTED***"
        elif isinstance(value, dict):
            sanitized[key] = sanitize_for_log(value)
        else:
            sanitized[key] = value

    return sanitized
