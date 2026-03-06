"""Analytics resource."""

from __future__ import annotations

from ..client import RecFnHttpClient


def create_analytics_resource(client: RecFnHttpClient) -> object:
    """Create analytics resource."""

    class AnalyticsResource:
        async def get(self, recording_id: str) -> dict:
            return await client.request(
                "GET",
                f"/api/v1/recordings/{recording_id}/analytics",
            )

    return AnalyticsResource()
