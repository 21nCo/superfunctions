"""Metadata resource."""

from __future__ import annotations

from ..client import RecFnHttpClient


def create_metadata_resource(client: RecFnHttpClient) -> object:
    """Create metadata resource."""

    class MetadataResource:
        async def get(self, bot_id: str) -> dict:
            return await client.request("GET", f"/api/v1/bots/{bot_id}/metadata")

    return MetadataResource()
