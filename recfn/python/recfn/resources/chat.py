"""Chat resource."""

from __future__ import annotations

from ..client import RecFnHttpClient


class ChatResource:
    def __init__(self, client: RecFnHttpClient) -> None:
        self._client = client

    async def list(self, bot_id: str) -> dict:
        res = await self._client.request("GET", f"/api/v1/bots/{bot_id}/chat")
        if res.get("ok") and res.get("data"):
            data = res["data"]
            msgs = data.get("messages", [])
            res["data"] = {
                "messages": [
                    {
                        "participant_id": m.get("participantId"),
                        "text": m.get("text", ""),
                        "timestamp": m.get("timestamp", ""),
                    }
                    for m in msgs
                ],
            }
        return res


def create_chat_resource(client: RecFnHttpClient) -> ChatResource:
    """Create chat resource."""
    return ChatResource(client)
