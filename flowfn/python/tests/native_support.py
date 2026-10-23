"""Concrete adapter types shared by the native integration fixtures."""

from typing import Union

from flowfn.adapters.postgres import PostgresAdapter
from flowfn.adapters.redis import RedisAdapter


class RedisFixtureAdapter(RedisAdapter):
    test_url: str


class PostgresFixtureAdapter(PostgresAdapter):
    test_url: str


NativeAdapter = Union[RedisFixtureAdapter, PostgresFixtureAdapter]
NativeAdapters = tuple[NativeAdapter, NativeAdapter]
