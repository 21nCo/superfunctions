"""Webhooks resource."""

from __future__ import annotations

from typing import Optional

from ..client import RecFnHttpClient


def create_webhooks_resource(client: RecFnHttpClient) -> object:
    """Create webhooks resource."""

    class WebhooksResource:
        async def create(
            self,
            url: str,
            events: list[str],
            *,
            secret: Optional[str] = None,
        ) -> dict:
            body: dict = {"url": url, "events": events}
            if secret is not None:
                body["secret"] = secret
            return await client.request("POST", "/api/v1/webhooks", body=body)

        async def list(self) -> dict:
            return await client.request("GET", "/api/v1/webhooks")

        async def delete(self, webhook_id: str) -> dict:
            return await client.request(
                "DELETE",
                f"/api/v1/webhooks/{webhook_id}",
            )

    return WebhooksResource()
