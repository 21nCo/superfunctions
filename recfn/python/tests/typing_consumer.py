"""Strict installed-wheel public resource consumer; no external services."""
import asyncio
from typing import Any, AsyncIterator, Optional
from unittest.mock import patch

from recfn import RecFn, RecFnHttpClient


async def main() -> None:
    calls: list[str] = []

    async def request(
        self: RecFnHttpClient,
        method: str,
        path: str,
        *,
        body: Optional[dict[str, Any]] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        calls.append(path)
        return {"ok": True, "data": {}}

    client = RecFn("https://local.invalid", "fixture")
    with patch.object(RecFnHttpClient, "request", request):
        await client.bots.get("bot")
        await client.recordings.list("bot")
        await client.participants.list("bot")
        await client.chat.list("bot")
        await client.analytics.get("recording")
        await client.metadata.get("bot")
        await client.calendars.list()
        await client.webhooks.list()
        await client.transcripts.transcribe("recording")
    stream: AsyncIterator[tuple[str, Any]] = client.transcripts.stream("bot")
    assert hasattr(stream, "__aiter__")
    assert len(calls) == 9
    assert calls[0] == "/api/v1/bots/bot"
    assert calls[-1] == "/api/v1/recordings/recording/transcribe"


if __name__ == "__main__":
    asyncio.run(main())
