"""Participants resource."""

from __future__ import annotations

from ..client import RecFnHttpClient
from ..types import _parse_participant


class ParticipantsResource:
    def __init__(self, client: RecFnHttpClient) -> None:
        self._client = client

    async def list(self, bot_id: str) -> dict:
        res = await self._client.request("GET", f"/api/v1/bots/{bot_id}/participants")
        if res.get("ok") and res.get("data"):
            data = res["data"]
            res["data"] = {
                "participants": [_parse_participant(p) for p in data.get("participants", [])],
            }
        return res


def create_participants_resource(client: RecFnHttpClient) -> ParticipantsResource:
    """Create participants resource."""
    return ParticipantsResource(client)
