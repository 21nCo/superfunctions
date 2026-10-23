"""Analytics resource."""

from __future__ import annotations

from ..client import RecFnHttpClient


class AnalyticsResource:
    def __init__(self, client: RecFnHttpClient) -> None:
        self._client = client

    async def get(self, recording_id: str) -> dict:
        return await self._client.request(
            "GET",
            f"/api/v1/recordings/{recording_id}/analytics",
        )


def create_analytics_resource(client: RecFnHttpClient) -> AnalyticsResource:
    """Create analytics resource."""
    return AnalyticsResource(client)
