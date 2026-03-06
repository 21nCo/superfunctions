"""Bots resource."""

from __future__ import annotations

from typing import Any, Optional

from ..client import RecFnHttpClient
from ..types import Bot, BotConfig, _parse_bot


def create_bots_resource(client: RecFnHttpClient) -> object:
    """Create bots resource with typed methods."""

    class BotsResource:
        async def create(
            self,
            meeting_url: str,
            *,
            platform: Optional[str] = None,
            config: Optional[dict[str, Any]] = None,
        ) -> dict[str, Any]:
            res = await client.request(
                "POST",
                "/api/v1/bots",
                body={
                    "meetingUrl": meeting_url,
                    "platform": platform,
                    "config": config,
                },
            )
            if res.get("ok") and res.get("data"):
                res["data"] = _parse_bot(res["data"])
            return res

        async def get(self, bot_id: str) -> dict[str, Any]:
            res = await client.request("GET", f"/api/v1/bots/{bot_id}")
            if res.get("ok") and res.get("data"):
                res["data"] = _parse_bot(res["data"])
            return res

        async def list(
            self,
            *,
            limit: Optional[int] = None,
            cursor: Optional[str] = None,
            status: Optional[str] = None,
            platform: Optional[str] = None,
        ) -> dict[str, Any]:
            params: list[str] = []
            if limit is not None:
                params.append(f"limit={limit}")
            if cursor:
                params.append(f"cursor={cursor}")
            if status:
                params.append(f"status={status}")
            if platform:
                params.append(f"platform={platform}")
            qs = "&".join(params)
            path = f"/api/v1/bots?{qs}" if qs else "/api/v1/bots"
            res = await client.request("GET", path)
            if res.get("ok") and res.get("data"):
                data = res["data"]
                bots = data.get("bots", [])
                res["data"] = {
                    "bots": [_parse_bot(b) for b in bots],
                    "next_cursor": data.get("nextCursor"),
                }
            return res

        async def leave(self, bot_id: str) -> dict[str, Any]:
            return await client.request("POST", f"/api/v1/bots/{bot_id}/leave")

        async def delete(self, bot_id: str) -> dict[str, Any]:
            return await client.request("DELETE", f"/api/v1/bots/{bot_id}")

    return BotsResource()
