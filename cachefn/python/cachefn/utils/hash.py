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

    def encode(item: Any, active: set[int]) -> Any:
        if item is None:
            return ["none"]
        if type(item) in (str, bool, int):
            return [type(item).__name__, item]
        if type(item) is float:
            return ["float", item.hex()]
        if type(item) is bytes:
            return ["bytes", item.hex()]
        if type(item) not in (list, tuple, dict, set, frozenset):
            raise TypeError("Unsupported cache key value; supply a custom key_generator")
        identity = id(item)
        if identity in active:
            raise ValueError("Circular cache key value; supply a custom key_generator")
        active.add(identity)
        try:
            if isinstance(item, dict):
                values = [[encode(k, active), encode(v, active)] for k, v in item.items()]
                values.sort(key=lambda pair: json.dumps(pair[0]))
            else:
                values = [encode(v, active) for v in item]
                if isinstance(item, (set, frozenset)):
                    values.sort(key=json.dumps)
            return [type(item).__name__, values]
        finally:
            active.remove(identity)

    payload = json.dumps(encode(value, set()), ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


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
