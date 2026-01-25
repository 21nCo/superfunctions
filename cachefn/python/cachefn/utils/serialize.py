"""
Serialization utilities for cache values.
"""

import json
import sys
from typing import Any


def serialize(value: Any) -> str:
    """
    Serialize a value to a JSON string.

    Args:
        value: Value to serialize

    Returns:
        JSON string representation
    """
    return json.dumps(value, default=str)


def deserialize(data: str) -> Any:
    """
    Deserialize a JSON string to a value.

    Args:
        data: JSON string to deserialize

    Returns:
        Deserialized value
    """
    return json.loads(data)


def estimate_size(value: Any) -> int:
    """
    Estimate the size of a value in bytes.

    Args:
        value: Value to estimate size for

    Returns:
        Estimated size in bytes
    """
    try:
        # Use sys.getsizeof for a rough estimate
        return sys.getsizeof(value)
    except Exception:
        # Fallback to string length
        return len(str(value))
