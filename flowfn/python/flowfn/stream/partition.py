"""Versioned routing shared with the TypeScript stream adapters."""
from __future__ import annotations

import hashlib
from typing import Protocol, runtime_checkable

PARTITION_ROUTING = 'sha256-utf8-u32be-v1'


def validate_partitions(count: int) -> None:
    if type(count) is not int or not 1 <= count <= 2147483647:
        raise ValueError('Stream partitions must be an integer between 1 and 2147483647')


def partition_for(count: int, identity: str, key: str | None, explicit: int | None) -> int:
    validate_partitions(count)
    value = identity if key is None else key
    try:
        encoded = value.encode('utf-8')
    except (AttributeError, UnicodeError) as error:
        raise ValueError('Stream partition key must be valid Unicode') from error
    if explicit is not None:
        if type(explicit) is not int or not 0 <= explicit < count:
            raise ValueError('Stream partition is outside the configured range')
        return explicit
    return int.from_bytes(hashlib.sha256(encoded).digest()[:4], 'big') % count


@runtime_checkable
class PartitionedStreams(Protocol):
    async def configure_stream(self, stream: str, partitions: int | None = None) -> int | None: ...
