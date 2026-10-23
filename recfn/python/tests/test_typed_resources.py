"""Resource wiring and collection contracts exposed to typed consumers."""
from dataclasses import replace
from typing import Any, cast

import pytest

from recfn import RecFn
from recfn.client import RecFnHttpClient
from recfn.types import AggregateBotDetail, ApiError, MeetingMetadata, Participant


def test_default_collections_are_independent_and_keep_legacy_normalization() -> None:
    first = AggregateBotDetail("a", "ns", "url", "zoom", "joined", {})
    second = AggregateBotDetail("b", "ns", "url", "zoom", "joined", {})
    first.participants.append(Participant("p", "a", "Person"))
    assert second.participants == []
    assert first.recordings is not second.recordings
    assert first.chat_messages is not second.chat_messages
    first_error = ApiError("ERROR", "first")
    second_error = ApiError("ERROR", "second")
    first_error.details["reason"] = "first"
    assert second_error.details == {}
    # Untyped callers historically supplied None; post-init normalization remains.
    legacy = replace(first, participants=cast(list[Participant], None))
    assert legacy.participants == []
    metadata = MeetingMetadata("m", "b")
    assert metadata.chat_messages == []
    assert metadata.chat_messages is not MeetingMetadata("other", "b").chat_messages


@pytest.mark.asyncio
async def test_resources_keep_their_own_client_and_request_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str, str]] = []

    async def request(self: RecFnHttpClient, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        calls.append((self.base_url, method, path))
        return {"ok": True, "data": {}}

    monkeypatch.setattr(RecFnHttpClient, "request", request)
    first = RecFn("https://first.example", "first")
    second = RecFn("https://second.example", "second")
    await first.bots.get("bot")
    await first.recordings.list("bot")
    await first.participants.list("bot")
    await first.chat.list("bot")
    await first.analytics.get("recording")
    await first.metadata.get("bot")
    await first.calendars.list()
    await first.webhooks.list()
    await first.transcripts.transcribe("recording", language="en")
    await second.bots.get("other")
    assert [call[0] for call in calls] == ["https://first.example"] * 9 + ["https://second.example"]
    assert calls[0][1:] == ("GET", "/api/v1/bots/bot")
    assert calls[8][1:] == ("POST", "/api/v1/recordings/recording/transcribe")
    assert calls[9][1:] == ("GET", "/api/v1/bots/other")
