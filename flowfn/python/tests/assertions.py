"""Assertion helpers which retain concrete types after checking optional results."""

from typing import Optional, TypeVar

T = TypeVar("T")


def require_value(value: Optional[T]) -> T:
    assert value is not None
    return value
