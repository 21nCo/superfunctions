"""
Tests for utility functions.
"""

import re
from cachefn.utils.hash import hash_value, hash_args, generate_key
from cachefn.utils.pattern import glob_to_regex, matches_pattern, filter_by_pattern
from cachefn.utils.serialize import serialize, deserialize, estimate_size
from cachefn.utils.ttl import calculate_expiration, is_expired, get_remaining_ttl
import time


def test_hash_value() -> None:
    """Test value hashing."""
    # Same values should produce same hash
    hash1 = hash_value({"a": 1, "b": 2})
    hash2 = hash_value({"b": 2, "a": 1})
    assert hash1 == hash2

    # Different values should produce different hashes
    hash3 = hash_value({"a": 1, "b": 3})
    assert hash1 != hash3


def test_hash_args() -> None:
    """Test argument hashing."""
    # Same args should produce same hash
    hash1 = hash_args(1, 2, c=3)
    hash2 = hash_args(1, 2, c=3)
    assert hash1 == hash2

    # Different args should produce different hashes
    hash3 = hash_args(1, 2, c=4)
    assert hash1 != hash3


def test_generate_key() -> None:
    """Test cache key generation."""
    key1 = generate_key("func", 1, 2)
    key2 = generate_key("func", 1, 2)
    assert key1 == key2

    # Different args
    key3 = generate_key("func", 1, 3)
    assert key1 != key3

    # No args
    key4 = generate_key("func")
    assert key4 == "func"


def test_glob_to_regex() -> None:
    """Test glob pattern to regex conversion."""
    pattern = glob_to_regex("user:*")
    assert pattern.match("user:123")
    assert pattern.match("user:456")
    assert not pattern.match("post:123")


def test_matches_pattern() -> None:
    """Test pattern matching."""
    # Glob pattern
    assert matches_pattern("user:123", "user:*")
    assert matches_pattern("user:456", "user:*")
    assert not matches_pattern("post:123", "user:*")

    # Regex pattern
    regex = re.compile(r"user:\d+")
    assert matches_pattern("user:123", regex)
    assert not matches_pattern("user:abc", regex)


def test_filter_by_pattern() -> None:
    """Test filtering keys by pattern."""
    keys = ["user:1", "user:2", "post:1", "post:2"]

    # Filter by glob
    user_keys = filter_by_pattern(keys, "user:*")
    assert len(user_keys) == 2
    assert "user:1" in user_keys

    # No pattern - return all
    all_keys = filter_by_pattern(keys, None)
    assert len(all_keys) == 4


def test_serialize_deserialize() -> None:
    """Test serialization and deserialization."""
    data = {"name": "Alice", "age": 30, "active": True}

    # Serialize
    serialized = serialize(data)
    assert isinstance(serialized, str)

    # Deserialize
    deserialized = deserialize(serialized)
    assert deserialized == data


def test_estimate_size() -> None:
    """Test size estimation."""
    # Simple value
    size1 = estimate_size("hello")
    assert size1 > 0

    # Complex value
    size2 = estimate_size({"a": 1, "b": [1, 2, 3]})
    assert size2 > size1


def test_calculate_expiration() -> None:
    """Test expiration calculation."""
    # With TTL
    now = int(time.time() * 1000)
    expires_at = calculate_expiration(1000)
    assert expires_at is not None
    assert expires_at > now
    assert expires_at <= now + 1100  # Some tolerance

    # Without TTL
    expires_at = calculate_expiration(None)
    assert expires_at is None


def test_is_expired() -> None:
    """Test expiration checking."""
    # Not expired
    future = int(time.time() * 1000) + 10000
    assert is_expired(future) is False

    # Expired
    past = int(time.time() * 1000) - 10000
    assert is_expired(past) is True

    # No expiration
    assert is_expired(None) is False


def test_get_remaining_ttl() -> None:
    """Test getting remaining TTL."""
    # With expiration
    future = int(time.time() * 1000) + 5000
    remaining = get_remaining_ttl(future)
    assert remaining is not None
    assert remaining > 0
    assert remaining <= 5000

    # No expiration
    remaining = get_remaining_ttl(None)
    assert remaining is None

    # Expired
    past = int(time.time() * 1000) - 1000
    remaining = get_remaining_ttl(past)
    assert remaining == 0
