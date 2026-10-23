"""Metadata resource."""

from __future__ import annotations

from ..client import RecFnHttpClient


class MetadataResource:
    def __init__(self, client: RecFnHttpClient) -> None:
        self._client = client

    async def get(self, bot_id: str) -> dict:
        return await self._client.request("GET", f"/api/v1/bots/{bot_id}/metadata")


def create_metadata_resource(client: RecFnHttpClient) -> MetadataResource:
    """Create metadata resource."""
    return MetadataResource(client)
