"""Participants resource."""

from __future__ import annotations

from ..client import RecFnHttpClient
from ..types import _parse_participant


def create_participants_resource(client: RecFnHttpClient) -> object:
    """Create participants resource."""

    class ParticipantsResource:
        async def list(self, bot_id: str) -> dict:
            res = await client.request("GET", f"/api/v1/bots/{bot_id}/participants")
            if res.get("ok") and res.get("data"):
                data = res["data"]
                res["data"] = {
                    "participants": [_parse_participant(p) for p in data.get("participants", [])],
                }
            return res

    return ParticipantsResource()
