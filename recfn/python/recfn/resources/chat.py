"""Chat resource."""

from __future__ import annotations

from ..client import RecFnHttpClient


def create_chat_resource(client: RecFnHttpClient) -> object:
    """Create chat resource."""

    class ChatResource:
        async def list(self, bot_id: str) -> dict:
            res = await client.request("GET", f"/api/v1/bots/{bot_id}/chat")
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

    return ChatResource()
